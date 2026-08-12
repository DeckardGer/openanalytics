import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MigrationError,
  checksumOf,
  loadMigrations,
  planMigrations,
} from '@openanalytics/migrations'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Docs snapshot 01 §3.6 lists the legacy migration failures this must prevent:
 * a journal that drifted from disk, two files claiming version `0002`, and a
 * history that could not rebuild an empty database.
 */

let dir: string

async function write(filename: string, sql: string): Promise<void> {
  await writeFile(join(dir, filename), sql, 'utf8')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oa-migrations-'))
})

describe('migration discovery', () => {
  it('loads files in version order', async () => {
    await write('0002_second.sql', 'SELECT 2;')
    await write('0001_first.sql', 'SELECT 1;')
    await write('0010_tenth.sql', 'SELECT 10;')

    const files = await loadMigrations(dir)
    expect(files.map((file) => file.version)).toEqual(['0001', '0002', '0010'])
  })

  it('rejects a malformed filename', async () => {
    await write('add-users.sql', 'SELECT 1;')
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError)
  })

  it('rejects two files claiming the same version', async () => {
    // The exact legacy defect: which one ran depended on directory order.
    await write('0002_stripe_connections.sql', 'SELECT 1;')
    await write('0002_usage_counters.sql', 'SELECT 2;')

    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration version 0002/)
  })

  it('treats a missing directory as no migrations', async () => {
    await expect(loadMigrations(join(dir, 'nope'))).resolves.toEqual([])
  })

  it('computes a checksum that ignores line-ending differences', async () => {
    expect(checksumOf('CREATE TABLE a();\n')).toBe(checksumOf('CREATE TABLE a();\r\n'))
  })
})

describe('migration planning', () => {
  it('returns only unapplied migrations', async () => {
    await write('0001_first.sql', 'SELECT 1;')
    await write('0002_second.sql', 'SELECT 2;')
    const files = await loadMigrations(dir)

    const pending = planMigrations(files, [
      {
        version: '0001',
        name: 'first',
        checksum: files[0]!.checksum,
        appliedAt: new Date(),
      },
    ])

    expect(pending.map((file) => file.version)).toEqual(['0002'])
  })

  it('detects an edit to an already-applied migration', async () => {
    // The database in front of you no longer matches the file that describes it.
    await write('0001_first.sql', 'SELECT 1;')
    const files = await loadMigrations(dir)

    expect(() =>
      planMigrations(files, [
        {
          version: '0001',
          name: 'first',
          checksum: checksumOf('SELECT 999;'),
          appliedAt: new Date(),
        },
      ]),
    ).toThrow(/Checksum drift/)
  })

  it('detects a ledger entry whose file has disappeared', async () => {
    expect(() =>
      planMigrations(
        [],
        [{ version: '0001', name: 'gone', checksum: 'abc', appliedAt: new Date() }],
      ),
    ).toThrow(/missing from disk/)
  })

  it('refuses to apply a migration out of order', async () => {
    // Applying 0001 after 0002 already ran produces a history that cannot be
    // replayed on an empty environment.
    await write('0001_first.sql', 'SELECT 1;')
    await write('0002_second.sql', 'SELECT 2;')
    const files = await loadMigrations(dir)

    expect(() =>
      planMigrations(files, [
        {
          version: '0002',
          name: 'second',
          checksum: files[1]!.checksum,
          appliedAt: new Date(),
        },
      ]),
    ).toThrow(/Out-of-order/)
  })

  it('plans every migration against an empty ledger', async () => {
    await write('0001_first.sql', 'SELECT 1;')
    await write('0002_second.sql', 'SELECT 2;')
    const files = await loadMigrations(dir)

    expect(planMigrations(files, [])).toHaveLength(2)
  })
})
