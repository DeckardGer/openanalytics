import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImportRunFailure } from '@openanalytics/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openZipArchive, writeStreamToFile } from '../../apps/worker/src/imports/archive.ts'
import type { ArchiveBudgets } from '../../apps/worker/src/imports/archive.ts'
import { buildZip } from '../support/import-fixtures.ts'

/**
 * The budgeted ZIP walker (ADR-0032, D6.3).
 *
 * Every fixture here is a **real ZIP** — local headers, central directory, EOCD,
 * written byte by byte by `buildZip` — because what is being proven is that the
 * container parser refuses hostile input, and a mocked archive would prove only
 * that the mock returns what it was told to.
 *
 * The six refusals, and why each earns a test rather than a code review:
 *
 * 1. **The ratio bomb.** A few hundred compressed bytes that inflate to
 *    megabytes of the same byte. The budget must trip *during* inflation, which
 *    is the only place it can: after inflation the memory is already gone. Both
 *    halves are separately asserted — one oversize entry (`entry_too_large`) and
 *    several merely-large ones (`zip_bomb`).
 * 2. **The entry count**, refused from the central directory **before any byte
 *    is inflated**. That ordering is the whole reason the reader reads the
 *    directory instead of walking local headers.
 * 3. **Nested archives**, refused rather than skipped: skipping would hide the
 *    real payload from an operator reading the entry list.
 * 4. **Non-CSV entries**, for the same reason.
 * 5. **A row with no newline**, which is a memory bomb needing no compression
 *    trick at all.
 * 6. **Zip64**, refused outright. Half-implemented zip64 is where container
 *    parsers get their offset-confusion bugs, and nothing this system accepts
 *    can reach the boundary — `IMPORT_MAX_ARCHIVE_BYTES` is 256 MiB.
 */

const BUDGETS: ArchiveBudgets = {
  maxEntries: 32,
  maxEntryBytes: 1_000_000,
  maxTotalUncompressedBytes: 2_000_000,
  maxRowBytes: 1_024,
}

let directory: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'oa-archive-test-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

let counter = 0
async function archiveOf(bytes: Buffer): Promise<string> {
  counter += 1
  const path = join(directory, `fixture-${String(counter)}.zip`)
  await writeFile(path, bytes)
  return path
}

async function open(bytes: Buffer, budgets: Partial<ArchiveBudgets> = {}) {
  return await openZipArchive({
    path: await archiveOf(bytes),
    budgets: { ...BUDGETS, ...budgets },
  })
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const line of lines) out.push(line)
  return out
}

async function categoryOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ImportRunFailure) return error.category
    throw error
  }
  throw new Error('expected an ImportRunFailure')
}

describe('ZIP walker — reading a real archive', () => {
  it('enumerates entries and yields their lines', async () => {
    const archive = await open(
      buildZip([
        { name: 'a.csv', content: 'date,visitors\n2024-01-01,5\n2024-01-02,7\n' },
        { name: 'b.csv', content: 'x\ny\n' },
      ]),
    )
    try {
      expect(archive.entries.map((entry) => entry.name)).toEqual(['a.csv', 'b.csv'])
      const first = archive.entries[0]
      if (!first) throw new Error('no entry')
      expect(await collect(archive.readLines(first))).toEqual([
        'date,visitors',
        '2024-01-01,5',
        '2024-01-02,7',
      ])
    } finally {
      await archive.close()
    }
  })

  it('reads a stored (uncompressed) member and a CRLF one', async () => {
    const archive = await open(
      buildZip([{ name: 'a.csv', content: 'one\r\ntwo\r\n', stored: true }]),
    )
    try {
      const entry = archive.entries[0]
      if (!entry) throw new Error('no entry')
      expect(entry.method).toBe(0)
      expect(await collect(archive.readLines(entry))).toEqual(['one', 'two'])
    } finally {
      await archive.close()
    }
  })

  it('keeps a final line that has no trailing newline', async () => {
    // A writer that omits the terminator is common, and dropping the last line
    // would silently lose the last day of an export.
    const archive = await open(buildZip([{ name: 'a.csv', content: 'first\nlast' }]))
    try {
      const entry = archive.entries[0]
      if (!entry) throw new Error('no entry')
      expect(await collect(archive.readLines(entry))).toEqual(['first', 'last'])
    } finally {
      await archive.close()
    }
  })

  it('skips macOS resource forks rather than refusing the archive', async () => {
    // An export a customer re-zipped on a Mac is a legitimate archive; failing
    // it `unexpected_entry` would be a support ticket about a correct file.
    const archive = await open(
      buildZip([
        { name: '__MACOSX/._a.csv', content: 'junk' },
        { name: 'a.csv', content: 'one\n' },
      ]),
    )
    try {
      expect(archive.entries.map((entry) => entry.name)).toEqual(['a.csv'])
    } finally {
      await archive.close()
    }
  })
})

describe('ZIP walker — budgets', () => {
  it('refuses a high-ratio entry from the directory, before inflating it', async () => {
    // ~1 MiB of one byte compresses to a few hundred bytes: the classic bomb
    // shape. A truthful directory declares the inflated size, so the cheap
    // pre-check refuses it and not one byte is decompressed.
    const bomb = Buffer.alloc(1_048_576, 0x41)
    const bytes = buildZip([{ name: 'bomb.csv', content: bomb }])
    expect(bytes.length).toBeLessThan(10_000)

    expect(await categoryOf(async () => await open(bytes, { maxEntryBytes: 64_000 }))).toBe(
      'entry_too_large',
    )
  })

  it('refuses a bomb whose directory LIES about its size, during inflation', async () => {
    // The directory understates the member, so the pre-check passes and only a
    // budget counting bytes as they arrive can stop it. This is the case the
    // pre-check cannot cover and the reason the stream budget exists: an archive
    // is allowed to say anything about itself.
    const bomb = Buffer.from(`${'A'.repeat(99)}\n`.repeat(10_000), 'utf8')
    const archive = await open(
      buildZip([{ name: 'bomb.csv', content: bomb, declaredUncompressedSize: 128 }]),
      { maxEntryBytes: 64_000 },
    )
    try {
      const entry = archive.entries[0]
      if (!entry) throw new Error('no entry')
      expect(entry.declaredUncompressedSize).toBe(128)
      expect(await categoryOf(async () => await collect(archive.readLines(entry)))).toBe(
        'entry_too_large',
      )
    } finally {
      await archive.close()
    }
  })

  it('refuses the archive as `zip_bomb` when the entries only breach the total', async () => {
    // Each member is inside `maxEntryBytes`; together they are not. Only a
    // budget that accumulates across entries catches this.
    // Lines, not one 400 KB blob: without newlines the row budget would fire
    // first and the test would prove the wrong refusal.
    const chunk = Buffer.from(`${'B'.repeat(99)}\n`.repeat(4_000), 'utf8')
    const archive = await open(
      buildZip([
        { name: 'a.csv', content: chunk },
        { name: 'b.csv', content: chunk },
        { name: 'c.csv', content: chunk },
      ]),
      { maxEntryBytes: 500_000, maxTotalUncompressedBytes: 900_000 },
    )
    try {
      const category = await categoryOf(async () => {
        for (const entry of archive.entries) await collect(archive.readLines(entry))
      })
      expect(category).toBe('zip_bomb')
    } finally {
      await archive.close()
    }
  })

  it('refuses too many entries before inflating anything', async () => {
    const members = Array.from({ length: 33 }, (_unused, index) => ({
      name: `f${String(index)}.csv`,
      content: 'x\n',
    }))
    expect(await categoryOf(async () => await open(buildZip(members), { maxEntries: 32 }))).toBe(
      'too_many_entries',
    )
  })

  it('refuses a nested archive', async () => {
    expect(
      await categoryOf(
        async () =>
          await open(
            buildZip([
              { name: 'a.csv', content: 'x\n' },
              { name: 'inner.zip', content: 'PK' },
            ]),
          ),
      ),
    ).toBe('nested_archive')
  })

  it('refuses a non-CSV entry', async () => {
    expect(
      await categoryOf(async () => await open(buildZip([{ name: 'notes.txt', content: 'x' }]))),
    ).toBe('unexpected_entry')
  })

  it('refuses an entry name that escapes the archive', async () => {
    expect(
      await categoryOf(async () => await open(buildZip([{ name: '../evil.csv', content: 'x' }]))),
    ).toBe('unexpected_entry')
  })

  it('refuses a row longer than the row budget', async () => {
    // No newline for 4 KiB against a 1 KiB budget: an entry with no line breaks
    // at all would otherwise grow the pending buffer without bound.
    const archive = await open(buildZip([{ name: 'a.csv', content: 'z'.repeat(4_096) }]), {
      maxRowBytes: 1_024,
    })
    try {
      const entry = archive.entries[0]
      if (!entry) throw new Error('no entry')
      expect(await categoryOf(async () => await collect(archive.readLines(entry)))).toBe(
        'row_too_long',
      )
    } finally {
      await archive.close()
    }
  })
})

describe('ZIP walker — malformed containers', () => {
  it('refuses a zip64 archive rather than half-reading it', async () => {
    expect(
      await categoryOf(
        async () => await open(buildZip([{ name: 'a.csv', content: 'x\n', zip64Sentinel: true }])),
      ),
    ).toBe('malformed_archive')
  })

  it('refuses a file that is not a ZIP at all', async () => {
    expect(await categoryOf(async () => await open(Buffer.from('not a zip file at all')))).toBe(
      'malformed_archive',
    )
  })

  it('refuses an empty archive', async () => {
    expect(await categoryOf(async () => await open(buildZip([])))).toBe('empty_archive')
  })

  it('refuses an encrypted entry rather than skipping it', async () => {
    // Bit 0 of the general-purpose flags. Skipping would import as though the
    // encrypted report simply was not in the archive, which is a silently
    // incomplete import rather than a refused one.
    expect(
      await categoryOf(
        async () =>
          await open(buildZip([{ name: 'a.csv', content: 'x\n', generalPurposeFlags: 0x0001 }])),
      ),
    ).toBe('malformed_archive')
  })

  it('finds the LAST end-of-central-directory record, not a decoy in the comment', async () => {
    // The EOCD signature is four bytes and may occur inside the archive comment.
    // A forward scan would stop at the decoy and read a directory offset out of
    // arbitrary bytes; the reader scans backwards, so the real record wins.
    const decoy = Buffer.alloc(30)
    decoy.writeUInt32LE(0x06054b50, 4)
    const archive = await open(
      buildZip([{ name: 'a.csv', content: 'one\ntwo\n' }], { comment: decoy }),
    )
    try {
      expect(archive.entries.map((entry) => entry.name)).toEqual(['a.csv'])
      const entry = archive.entries[0]
      if (!entry) throw new Error('no entry')
      expect(await collect(archive.readLines(entry))).toEqual(['one', 'two'])
    } finally {
      await archive.close()
    }
  })

  it('refuses an entry whose two records name different files', async () => {
    // The directory decides what an entry *is* and the local header decides
    // where its bytes are, so a divergence lets an archive show one filename to
    // the adapter and hand a different member to the parser.
    const archive = await open(
      buildZip([{ name: 'a.csv', content: 'x\n', localNameOverride: 'b.csv' }]),
    )
    try {
      const entry = archive.entries[0]
      if (!entry) throw new Error('no entry')
      expect(await categoryOf(async () => await collect(archive.readLines(entry)))).toBe(
        'malformed_archive',
      )
    } finally {
      await archive.close()
    }
  })

  it('refuses a stored entry whose produced bytes do not match the directory', async () => {
    // Nothing validates a stored member — the bytes are passed through verbatim
    // — so a directory that overstates the size would otherwise yield a silently
    // truncated report. The budgets are wide here so the size check, not a
    // budget, is what fires.
    const archive = await open(
      buildZip([
        { name: 'a.csv', content: 'one\ntwo\n', stored: true, declaredUncompressedSize: 99_999 },
      ]),
    )
    try {
      const entry = archive.entries[0]
      if (!entry) throw new Error('no entry')
      expect(await categoryOf(async () => await collect(archive.readLines(entry)))).toBe(
        'malformed_archive',
      )
    } finally {
      await archive.close()
    }
  })

  it('refuses a central directory larger than the entry budget could fill', async () => {
    // The directory is read whole, so its *declared* size is an allocation the
    // archive gets to choose. Without a ceiling a tiny file could name a 4 GiB
    // directory and the refusal would arrive as an allocation failure rather
    // than as a category.
    const bytes = buildZip([{ name: 'a.csv', content: 'x\n' }])
    // The EOCD is the last 22 bytes; its directory-size field is at offset 12.
    bytes.writeUInt32LE(0x7fff_0000, bytes.length - 22 + 12)
    expect(await categoryOf(async () => await open(bytes, { maxEntries: 4 }))).toBe(
      'malformed_archive',
    )
  })

  it('refuses an entry whose deflate stream is corrupt', async () => {
    // The header says deflate and the bytes are not one. That is the archive's
    // problem, not an outage: it must end the run with a category rather than
    // throwing something the executor would retry forever.
    const archive = await open(
      buildZip([{ name: 'a.csv', content: 'hello world hello world\n', corruptPayload: true }]),
    )
    try {
      const entry = archive.entries[0]
      if (!entry) throw new Error('no entry')
      expect(await categoryOf(async () => await collect(archive.readLines(entry)))).toBe(
        'malformed_archive',
      )
    } finally {
      await archive.close()
    }
  })
})

describe('the download ceiling', () => {
  it('stops writing once the archive budget is passed', async () => {
    const path = join(directory, 'download.bin')
    async function* body(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(64)
      yield new Uint8Array(64)
      yield new Uint8Array(64)
    }
    expect(await categoryOf(async () => await writeStreamToFile(body(), path, 100))).toBe(
      'entry_too_large',
    )
  })

  it('reports what it wrote when the stream fits', async () => {
    const path = join(directory, 'download-ok.bin')
    async function* body(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(10)
      yield new Uint8Array(5)
    }
    expect(await writeStreamToFile(body(), path, 100)).toBe(15)
  })
})
