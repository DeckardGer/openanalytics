import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Shared migration discovery and checksum logic.
 *
 * Docs snapshot 01 §3.6 is the reason this exists at all: the legacy journal
 * drifted from the files on disk, two different `0002` migrations existed, and a
 * fresh database could not be built from the recorded history. Here the ledger
 * stores a checksum per applied version, and a mismatch stops the run — an
 * already-applied migration that has since been edited means the schema in front
 * of you is not the schema the file describes.
 *
 * Docs snapshot 05, D-214: production changes are forward-only
 * expand → migrate/backfill → contract. There is deliberately no `down` runner;
 * an automatic destructive rollback is not a production strategy.
 */

export interface MigrationFile {
  /** Zero-padded numeric prefix, e.g. `0001`. */
  readonly version: string
  readonly name: string
  readonly filename: string
  readonly sql: string
  readonly checksum: string
}

export interface AppliedMigration {
  readonly version: string
  readonly name: string
  readonly checksum: string
  readonly appliedAt: Date
}

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/

export function checksumOf(sql: string): string {
  // Line endings are normalized so a Windows checkout does not report drift
  // against a ledger written from Linux CI.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

/**
 * Loads migrations from disk in version order.
 *
 * Rejects duplicate versions and malformed names outright. A duplicate version
 * is exactly the legacy failure mode: two files claim the same slot and which
 * one ran depends on directory iteration order.
 */
export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const sqlFiles = entries.filter((entry) => entry.endsWith('.sql')).sort()
  const migrations: MigrationFile[] = []
  const seen = new Map<string, string>()

  for (const filename of sqlFiles) {
    const match = FILENAME_PATTERN.exec(basename(filename))
    if (!match) {
      throw new MigrationError(
        `Migration filename "${filename}" must match NNNN_snake_case_name.sql`,
      )
    }

    const version = match[1] as string
    const name = match[2] as string

    const previous = seen.get(version)
    if (previous !== undefined) {
      throw new MigrationError(
        `Duplicate migration version ${version}: "${previous}" and "${filename}"`,
      )
    }
    seen.set(version, filename)

    const sql = await readFile(join(directory, filename), 'utf8')
    migrations.push({ version, name, filename, sql, checksum: checksumOf(sql) })
  }

  return migrations
}

/**
 * Compares files on disk against the ledger.
 *
 * Returns what still needs to run. Throws on drift: a changed checksum, or a
 * migration recorded as applied that no longer exists on disk.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationFile[] {
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]))

  for (const row of applied) {
    const file = files.find((candidate) => candidate.version === row.version)
    if (!file) {
      throw new MigrationError(
        `Migration ${row.version} (${row.name}) is recorded as applied but is missing from disk. ` +
          `The ledger and the repository disagree about this database's history.`,
      )
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Checksum drift on migration ${row.version} (${row.name}).\n` +
          `  ledger: ${row.checksum}\n` +
          `  file:   ${file.checksum}\n` +
          `An applied migration was edited. Add a new forward migration instead.`,
      )
    }
  }

  const pending = files.filter((file) => !appliedByVersion.has(file.version))

  // Applying 0005 while 0003 is missing would produce a database whose history
  // cannot be replayed on an empty environment.
  const firstPending = pending[0]
  if (firstPending !== undefined) {
    const lastApplied = applied
      .map((row) => row.version)
      .sort()
      .at(-1)
    if (lastApplied !== undefined && firstPending.version < lastApplied) {
      throw new MigrationError(
        `Migration ${firstPending.version} is pending but ${lastApplied} is already applied. ` +
          `Out-of-order migrations cannot be reproduced from empty.`,
      )
    }
  }

  return pending
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}
