import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@openanalytics/clickhouse'
import { describe, expect, it } from 'vitest'

/**
 * Every ClickHouse migration splits into the statements it appears to contain.
 *
 * This exists because of a defect that reached review in M12 CP5 and would have
 * failed the CP7 deploy with nothing in any suite noticing.
 *
 * `splitStatements` splits on the terminator **first** and strips `--` lines
 * from each fragment **afterwards**. That ordering is fine for SQL and lethal
 * for prose: a terminator inside a comment cuts the file there, and the
 * fragments either side are comment text with a bit of DDL attached. The runner
 * then sends the first fragment to ClickHouse, it fails, and the whole migration
 * run aborts — so a file whose DDL is perfectly valid never executes.
 *
 * The CP5 draft of `0018_revenue_rollups.sql` had eight such terminators in its
 * header. It split into **eight** fragments, seven of them English sentences,
 * with `CREATE TABLE revenue_1h` swallowed entirely. Nothing caught it: the
 * ClickHouse-gated suites are skipped without a server, the migration-order
 * guard reads `CREATE TABLE` with a regexp rather than through the runner, and
 * `pnpm run verify` is green either way. The first signal would have been a
 * production deploy that stopped applying migrations.
 *
 * Two assertions, and they are deliberately different questions:
 *
 * 1. **No comment line contains the terminator.** The cheap, mechanical
 *    invariant — an author can obey it without knowing why, and the message says
 *    why.
 * 2. **Every fragment the runner produces begins with a DDL keyword.** The
 *    property that actually matters, checked through the runner's own exported
 *    function rather than a copy of it, so it stays true if the splitter ever
 *    changes.
 *
 * Always-run: this is a statement about files, so it belongs in the unit project
 * rather than in the CH-gated migration project that skips without a server.
 * That is the entire point — the defect it guards is invisible to every suite
 * that needs infrastructure.
 */

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/

/** The keywords a ClickHouse migration statement may begin with. */
const DDL_START = /^\s*(CREATE|ALTER|DROP|RENAME|OPTIMIZE|INSERT|SET)\b/iu

async function migrationFiles(): Promise<{ name: string; sql: string }[]> {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((entry) => FILENAME.test(entry)).sort()
  return await Promise.all(
    entries.map(async (name) => ({
      name,
      sql: await readFile(`${MIGRATIONS_DIR}${name}`, 'utf8'),
    })),
  )
}

/** The statement terminator, spelled once so this file does not trip its own rule. */
const TERMINATOR = String.fromCharCode(59)

describe('ClickHouse migration files split into statements', () => {
  it('has at least the migrations this milestone shipped', async () => {
    // A guard on the guard: a glob that silently matched nothing would make every
    // assertion below vacuous.
    const files = await migrationFiles()
    expect(files.length).toBeGreaterThanOrEqual(18)
    expect(files.map((file) => file.name)).toContain('0018_revenue_rollups.sql')
  })

  it('puts no statement terminator in any comment line', async () => {
    for (const file of await migrationFiles()) {
      const offenders = file.sql
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(
          (entry) => entry.line.trimStart().startsWith('--') && entry.line.includes(TERMINATOR),
        )

      expect(
        offenders.map((entry) => `${file.name}:${entry.number}`),
        `${file.name} has a statement terminator inside a comment. splitStatements() ` +
          `splits on it BEFORE stripping comments, so the file shatters into prose ` +
          `fragments and the migration run aborts on the first one. Use an em dash or a ` +
          `full stop in prose instead.`,
      ).toEqual([])
    }
  })

  it('produces only DDL statements from every file, through the runner’s own splitter', async () => {
    for (const file of await migrationFiles()) {
      const statements = splitStatements(file.sql)
      expect(statements.length, `${file.name} produced no statements`).toBeGreaterThan(0)
      for (const [index, statement] of statements.entries()) {
        expect(
          DDL_START.test(statement),
          `${file.name} statement ${index} is not DDL — it starts with ` +
            `${JSON.stringify(statement.slice(0, 80))}. That is comment prose the splitter ` +
            `cut loose, and ClickHouse would reject it.`,
        ).toBe(true)
      }
    }
  })

  it('produces exactly the two rollup tables from 0018', async () => {
    // The specific regression, named. Two CREATEs, in order, and nothing else.
    const file = (await migrationFiles()).find((entry) => entry.name === '0018_revenue_rollups.sql')
    expect(file).toBeDefined()
    const statements = splitStatements((file as { sql: string }).sql)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS revenue_1h\b/u)
    expect(statements[1]).toMatch(/^CREATE TABLE IF NOT EXISTS revenue_1d\b/u)
    for (const statement of statements) {
      expect(statement).toContain('ReplacingMergeTree(generation)')
      expect(statement).toContain('non_replicated_deduplication_window = 1000')
    }
  })
})
