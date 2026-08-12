import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createInflateRaw } from 'node:zlib'
import { ImportRunFailure } from '@openanalytics/domain'

/**
 * The budgeted ZIP walker (ADR-0032, D6.3).
 *
 * The collector's `body.ts` pattern at file scale: every limit is enforced
 * **during** inflation rather than checked afterwards, so a hostile archive
 * fails with a category instead of an OOM. Nothing here trusts a number the
 * archive states about itself.
 *
 * ## Why this is hand-rolled and not a library
 *
 * The repository is dependency-averse — the Stripe adapter is SDK-free — and the
 * usual counter-argument, "security-sensitive parsing should not be hand-rolled
 * hubris", does not apply the way it looks like it does here. **The
 * decompression is not hand-rolled**: it is `node:zlib`'s `inflateRaw`, the same
 * battle-tested C library every ZIP package in the ecosystem also delegates to.
 * What this file implements is the *container* format — fixed-width little-
 * endian structs at known offsets — and a budget enforcer around the inflate
 * stream.
 *
 * That second half is the part a library would not have given us anyway. `yauzl`
 * (the mature, minimal, widely-used candidate) hands back a `Readable` per entry
 * and leaves every one of D6's budgets to the caller: per-entry uncompressed cap,
 * total uncompressed cap, per-row cap, and the decision to stop mid-inflate. So
 * adopting it would have replaced ~150 lines of struct reading with a
 * dependency, and left the security-critical code — the part that decides when
 * to stop reading a bomb — exactly where it is now. It would also have added a
 * transitive dependency to the *worker*, the process that holds the ClickHouse
 * ingest credential and the bucket keys.
 *
 * The correctness risk that argument leaves open is real and is answered by the
 * shape of the reader rather than by care:
 *
 * - **The central directory is the authority, not the local headers.** The
 *   directory is read first, in full, so the entry count is known and refused
 *   *before* a single byte is inflated. A reader that walked local headers
 *   forwards (which is what a "streaming ZIP reader" usually means) would have to
 *   start inflating to discover how many entries it was going to get.
 * - **Zip64 is refused, not partially supported.** Any sentinel value that means
 *   "the real number is in an extra field" ends the run. Half-implemented zip64
 *   is where container parsers get their offset-confusion bugs, and no export
 *   this system accepts can reach the 4 GiB / 65 535-entry boundary anyway:
 *   `IMPORT_MAX_ARCHIVE_BYTES` is 256 MiB and `IMPORT_MAX_ENTRIES` is 32.
 * - **Only stored and deflate are read.** Every other method — including the
 *   encrypted flag — is a refusal rather than a fallback.
 *
 * The zip64 refusal, the ratio bomb, the nested archive, the entry-count breach
 * and the oversize row each have a test that builds the archive byte by byte.
 */

/** Local file header, central directory entry, end of central directory. */
const SIGNATURE_LOCAL = 0x04034b50
const SIGNATURE_CENTRAL = 0x02014b50
const SIGNATURE_EOCD = 0x06054b50
/** The zip64 locator that sits immediately before a zip64 EOCD. Its presence is
 * a refusal on its own, because it means the 32-bit record we read is a
 * placeholder. */
const SIGNATURE_ZIP64_LOCATOR = 0x07064b50

/** The 32-bit sentinels that mean "look in the zip64 extra field". */
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

const EOCD_MIN_SIZE = 22
/** A ZIP comment is a `u16` length, so the EOCD can start at most this far from
 * the end of the file. */
const MAX_COMMENT_SIZE = U16_MAX

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

/** Extensions that would make an entry a second archive. Refused rather than
 * ignored: a parser that silently skipped them would let an attacker hide the
 * real payload from an operator reading the entry list, and a future adapter
 * that "helpfully" unwrapped one would inherit an unbounded recursion. */
const NESTED_ARCHIVE_EXTENSIONS = [
  '.zip',
  '.gz',
  '.gzip',
  '.tar',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.zst',
  '.lz4',
  '.br',
]

export interface ArchiveBudgets {
  /** `IMPORT_MAX_ENTRIES`. */
  readonly maxEntries: number
  /** `IMPORT_MAX_ENTRY_BYTES`, uncompressed, per entry. */
  readonly maxEntryBytes: number
  /** `IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES`, across every entry read. */
  readonly maxTotalUncompressedBytes: number
  /** `IMPORT_MAX_ROW_BYTES`, per line. */
  readonly maxRowBytes: number
}

export interface ArchiveEntry {
  /** As stored in the archive, normalised to forward slashes and without a
   * leading directory component. Never used as a filesystem path — nothing here
   * writes an entry anywhere — but normalised so the adapter's pattern matches
   * `imported_visitors_x_y.csv` whether or not the exporter nested it. */
  readonly name: string
  /** The name exactly as the archive stated it, for the operator log. */
  readonly rawName: string
  readonly compressedSize: number
  /** What the central directory *claims*. Never trusted as a bound — the real
   * enforcement counts bytes as they inflate. */
  readonly declaredUncompressedSize: number
  readonly method: number
  readonly localHeaderOffset: number
}

/**
 * A file already on local disk, opened for entry-by-entry reading.
 *
 * A path rather than a stream, because the ZIP central directory is at the *end*
 * of the file: enumerating entries needs random access, and the alternative
 * (buffer the whole archive to find its index) is the thing the streamed
 * download exists to avoid.
 */
export interface ZipArchive {
  readonly entries: readonly ArchiveEntry[]
  /** The entry's text, one line at a time, with every budget enforced as the
   * bytes inflate. */
  readLines(entry: ArchiveEntry): AsyncIterable<string>
  close(): Promise<void>
}

function fail(
  category: ConstructorParameters<typeof ImportRunFailure>[0],
  message: string,
  detail: Record<string, unknown> = {},
): never {
  throw new ImportRunFailure(category, message, detail)
}

/** Read exactly `length` bytes at `position`, or fail: a short read means the
 * file is truncated where the format says a record must be. */
async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) {
    fail('malformed_archive', 'archive is truncated', { position, length, bytesRead })
  }
  return buffer
}

/**
 * Normalise an entry name and refuse the ones that are not a flat CSV.
 *
 * Path traversal is refused even though nothing here writes an entry to disk.
 * The name reaches a log line, an adapter's pattern match and (later) an export
 * manifest, and "we do not currently write it anywhere" is a property of today's
 * code rather than of the format.
 */
function normaliseEntryName(rawName: string): string {
  const unified = rawName.replace(/\\/g, '/')
  if (unified.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(unified)) {
    fail('unexpected_entry', 'archive entry name escapes the archive', { entries: 1 })
  }
  const lastSlash = unified.lastIndexOf('/')
  return lastSlash === -1 ? unified : unified.slice(lastSlash + 1)
}

function assertReadableEntry(entry: ArchiveEntry, budgets: ArchiveBudgets): void {
  const lower = entry.name.toLowerCase()
  if (NESTED_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    fail('nested_archive', 'archive contains a nested archive', { entry: entry.name })
  }
  if (!lower.endsWith('.csv')) {
    fail('unexpected_entry', 'archive contains a non-CSV entry', { entry: entry.name })
  }
  // A cheap pre-check against what the directory claims. It is not the bound —
  // the directory can lie and the inflate loop is what actually stops — but a
  // truthful oversize entry is refused before any of it is decompressed.
  if (entry.declaredUncompressedSize > budgets.maxEntryBytes) {
    fail('entry_too_large', 'archive entry declares more than the entry budget', {
      entry: entry.name,
      declared: entry.declaredUncompressedSize,
      limit: budgets.maxEntryBytes,
    })
  }
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    fail('malformed_archive', 'archive entry uses an unsupported compression method', {
      entry: entry.name,
      method: entry.method,
    })
  }
}

/**
 * Find the end-of-central-directory record.
 *
 * Scanned backwards from the end over at most `EOCD_MIN_SIZE + MAX_COMMENT_SIZE`
 * bytes, which is the whole space the format allows the record to hide in. The
 * scan is backwards on purpose: the signature is four bytes and can occur inside
 * compressed data, so a forward scan would find a decoy in the payload first.
 *
 * **A signature alone is not the record.** The archive comment follows the EOCD,
 * so a comment containing the signature sits *after* the real record and a plain
 * backwards scan picks the decoy — the mirror image of the forward-scan problem,
 * and the one a backwards scan is usually assumed to have solved. The
 * disambiguator is the record's own comment-length field: it must account for
 * exactly the bytes between the end of the record and the end of the file.
 * A decoy is inside the comment, so its declared length cannot match the
 * distance to EOF except by a deliberate construction that would then *be* a
 * well-formed trailing record.
 */
async function findEndOfCentralDirectory(
  handle: FileHandle,
  fileSize: number,
): Promise<{ buffer: Buffer; offset: number; absolute: number }> {
  const window = Math.min(fileSize, EOCD_MIN_SIZE + MAX_COMMENT_SIZE)
  const start = fileSize - window
  const buffer = Buffer.allocUnsafe(window)
  const { bytesRead } = await handle.read(buffer, 0, window, start)
  const scanned = buffer.subarray(0, bytesRead)

  for (let offset = scanned.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (scanned.readUInt32LE(offset) !== SIGNATURE_EOCD) continue
    const commentLength = scanned.readUInt16LE(offset + 20)
    if (commentLength !== scanned.length - (offset + EOCD_MIN_SIZE)) continue
    return { buffer: scanned, offset, absolute: start + offset }
  }
  fail('malformed_archive', 'not a ZIP archive: no end-of-central-directory record')
}

export interface OpenZipArchiveInput {
  readonly path: string
  readonly budgets: ArchiveBudgets
}

/**
 * Open an archive and enumerate its entries, inflating nothing.
 *
 * Every structural refusal happens here, which is what makes the `validating`
 * run state meaningful: by the time it advances to `processing`, the archive is
 * known to be a flat, non-nested, non-zip64 ZIP of at most `maxEntries` CSVs
 * that the adapter recognises. The caller supplies the last of those checks —
 * this file has no idea what a report is — but it happens before any inflation
 * for the same reason the rest do.
 */
export async function openZipArchive(input: OpenZipArchiveInput): Promise<ZipArchive> {
  const { budgets } = input
  const handle = await open(input.path, 'r')

  try {
    const stat = await handle.stat()
    const fileSize = stat.size
    if (fileSize < EOCD_MIN_SIZE) {
      fail('malformed_archive', 'file is too small to be a ZIP archive', { size: fileSize })
    }

    const eocd = await findEndOfCentralDirectory(handle, fileSize)
    const record = eocd.buffer

    // A zip64 locator sits immediately before the EOCD when the archive is
    // zip64. Its presence means the 32-bit fields below are placeholders, so the
    // refusal has to come before they are read rather than after.
    //
    // Read from the **file**, not from the scan window. The window starts at
    // `fileSize - 65557`, so an EOCD found near its start has its preceding 20
    // bytes outside the buffer — and reading them out of the window would either
    // fall off the front or, worse, read whatever compressed data happened to sit
    // at that offset and compare it against the locator signature. The archive is
    // already on local disk, so a 20-byte positioned read costs nothing.
    if (eocd.absolute >= 20) {
      const locator = await readExact(handle, eocd.absolute - 20, 4)
      if (locator.readUInt32LE(0) === SIGNATURE_ZIP64_LOCATOR) {
        fail('malformed_archive', 'zip64 archives are not supported')
      }
    }

    const totalEntries = record.readUInt16LE(eocd.offset + 10)
    const directorySize = record.readUInt32LE(eocd.offset + 12)
    const directoryOffset = record.readUInt32LE(eocd.offset + 16)

    if (totalEntries === U16_MAX || directorySize === U32_MAX || directoryOffset === U32_MAX) {
      fail('malformed_archive', 'zip64 archives are not supported')
    }
    if (totalEntries === 0) {
      fail('empty_archive', 'archive contains no entries')
    }
    // **Before any inflation.** This is the whole reason the central directory is
    // read rather than the local headers walked: the count is knowable up front.
    if (totalEntries > budgets.maxEntries) {
      fail('too_many_entries', 'archive contains more entries than the budget allows', {
        entries: totalEntries,
        limit: budgets.maxEntries,
      })
    }
    if (directoryOffset + directorySize > fileSize) {
      fail('malformed_archive', 'central directory lies outside the file')
    }
    // The directory is read whole into memory, so its *declared* size is an
    // allocation an archive gets to choose. `maxEntries` already bounds the entry
    // count, and this bounds what those entries may claim to occupy: 46 fixed
    // bytes plus three `u16`-bounded variable fields (name, extra, comment) each.
    // Without it a 22-byte file could name a 4 GiB directory and the refusal
    // would arrive as an allocation failure rather than as a category — the
    // truncated-read check below only fires *after* the buffer exists.
    const directoryCeiling = budgets.maxEntries * (46 + 3 * U16_MAX)
    if (directorySize > directoryCeiling) {
      fail('malformed_archive', 'central directory is larger than the entry budget admits', {
        declared: directorySize,
        limit: directoryCeiling,
      })
    }

    const directory = await readExact(handle, directoryOffset, directorySize)
    const entries: ArchiveEntry[] = []
    let cursor = 0

    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > directory.length) {
        fail('malformed_archive', 'central directory is truncated')
      }
      if (directory.readUInt32LE(cursor) !== SIGNATURE_CENTRAL) {
        fail('malformed_archive', 'central directory entry has a bad signature')
      }

      const generalPurpose = directory.readUInt16LE(cursor + 8)
      const method = directory.readUInt16LE(cursor + 10)
      const compressedSize = directory.readUInt32LE(cursor + 20)
      const uncompressedSize = directory.readUInt32LE(cursor + 24)
      const nameLength = directory.readUInt16LE(cursor + 28)
      const extraLength = directory.readUInt16LE(cursor + 30)
      const commentLength = directory.readUInt16LE(cursor + 32)
      const localHeaderOffset = directory.readUInt32LE(cursor + 42)

      // Bit 0 is the encryption flag. An encrypted entry cannot be read and must
      // not be silently skipped: the archive would then import as though the
      // encrypted report simply was not there.
      if ((generalPurpose & 0x0001) !== 0) {
        fail('malformed_archive', 'archive contains an encrypted entry')
      }
      if (
        compressedSize === U32_MAX ||
        uncompressedSize === U32_MAX ||
        localHeaderOffset === U32_MAX
      ) {
        fail('malformed_archive', 'zip64 archives are not supported')
      }

      const end = cursor + 46 + nameLength
      if (end > directory.length) fail('malformed_archive', 'central directory is truncated')
      const rawName = directory.toString('utf8', cursor + 46, end)
      cursor = end + extraLength + commentLength

      // Directory entries carry no data. They still counted towards
      // `maxEntries` above, which is correct: they are entries an archive made
      // us read.
      if (rawName.endsWith('/')) continue

      const name = normaliseEntryName(rawName)
      // macOS' Archive Utility writes an `__MACOSX/._name` resource fork beside
      // every real member. Skipped rather than refused: an export a customer
      // re-zipped on a Mac is a legitimate archive, and failing it
      // `unexpected_entry` would be a support ticket about a file that is
      // correct. They still counted towards `maxEntries`.
      if (rawName.startsWith('__MACOSX/') || name.startsWith('._')) continue

      entries.push({
        name,
        rawName,
        compressedSize,
        declaredUncompressedSize: uncompressedSize,
        method,
        localHeaderOffset,
      })
    }

    if (entries.length === 0) fail('empty_archive', 'archive contains no readable entries')
    for (const entry of entries) assertReadableEntry(entry, budgets)

    // Shared across every entry read from this archive, which is what makes the
    // *total* budget a total rather than a per-entry limit applied twice.
    const totals = { uncompressed: 0 }

    return {
      entries,
      readLines(entry: ArchiveEntry): AsyncIterable<string> {
        return readEntryLines(input.path, handle, entry, budgets, totals)
      },
      async close(): Promise<void> {
        await handle.close()
      },
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/**
 * Where an entry's bytes actually start.
 *
 * The local header has to be read even though the central directory already
 * described the entry, because only the local header knows how long *its* name
 * and extra fields are — the two records are allowed to differ, and using the
 * directory's lengths here is a classic way to read an entry at the wrong
 * offset. The signature check is what catches an offset the directory got wrong
 * or lied about.
 */
async function resolveDataOffset(handle: FileHandle, entry: ArchiveEntry): Promise<number> {
  const header = await readExact(handle, entry.localHeaderOffset, 30)
  if (header.readUInt32LE(0) !== SIGNATURE_LOCAL) {
    fail('malformed_archive', 'archive entry has a bad local header', { entry: entry.name })
  }
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)

  // **The two records must name the same file.**
  //
  // The central directory is what this reader trusts for everything the adapter
  // sees — which report an entry is, how big it claims to be — while the *data*
  // is found through the local header. An archive whose two records disagree is
  // therefore an archive that can present one filename for the decision and a
  // different member for the bytes, which is the classic container-confusion
  // shape. No legitimate writer produces it.
  const localName = await readExact(handle, entry.localHeaderOffset + 30, nameLength)
  if (localName.toString('utf8') !== entry.rawName) {
    fail('malformed_archive', 'archive entry names differ between its two records', {
      entry: entry.name,
    })
  }

  return entry.localHeaderOffset + 30 + nameLength + extraLength
}

/**
 * Inflate one entry and yield its lines, counting every byte.
 *
 * Three budgets, all enforced *as the bytes arrive*:
 *
 * - **per entry** — a single high-ratio member (the classic bomb: a few KB that
 *   inflates to gigabytes of the same byte) trips `entry_too_large` after
 *   `maxEntryBytes` have been produced, never after it has finished;
 * - **total** — many merely-large entries that individually pass trip
 *   `zip_bomb`;
 * - **per row** — an entry with no line breaks at all would otherwise grow the
 *   pending buffer without bound, which is a memory bomb that needs no
 *   compression trick at all.
 *
 * The throw propagates out of the `for await`, which closes the iterator, which
 * destroys the inflate stream and the underlying read — so a refused bomb stops
 * being decompressed rather than being decompressed into a discarded buffer.
 */
async function* readEntryLines(
  path: string,
  handle: FileHandle,
  entry: ArchiveEntry,
  budgets: ArchiveBudgets,
  totals: { uncompressed: number },
): AsyncIterable<string> {
  const start = await resolveDataOffset(handle, entry)
  const end = start + entry.compressedSize - 1
  // A *path*-based stream with its own descriptor, deliberately not
  // `handle.createReadStream()`. A `FileHandle` read stream closes the handle
  // when it ends, so the second report of an archive would read from a closed
  // file — which is how this reads to an operator as "file closed" rather than
  // as a budget or format problem. The handle stays for the header and
  // directory reads, which are random-access and short.
  const source = entry.compressedSize === 0 ? null : createReadStream(path, { start, end })

  let entryBytes = 0
  let pending: Buffer = Buffer.alloc(0)

  const consume = function* (chunk: Buffer): Generator<string> {
    entryBytes += chunk.length
    totals.uncompressed += chunk.length
    if (entryBytes > budgets.maxEntryBytes) {
      fail('entry_too_large', 'archive entry inflates past the entry budget', {
        entry: entry.name,
        limit: budgets.maxEntryBytes,
      })
    }
    if (totals.uncompressed > budgets.maxTotalUncompressedBytes) {
      fail('zip_bomb', 'archive inflates past the total budget', {
        entry: entry.name,
        limit: budgets.maxTotalUncompressedBytes,
      })
    }

    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    for (;;) {
      const newline = pending.indexOf(0x0a)
      if (newline === -1) break
      const line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      yield decodeLine(line, entry, budgets)
    }
    if (pending.length > budgets.maxRowBytes) {
      fail('row_too_long', 'archive entry contains a row past the row budget', {
        entry: entry.name,
        limit: budgets.maxRowBytes,
      })
    }
  }

  if (source === null) {
    // No compressed bytes at all. That is a legitimate empty member, and only an
    // empty one — a directory claiming content for an entry with nothing in it is
    // the same lie the size check below refuses.
    if (entry.declaredUncompressedSize !== 0) {
      fail('malformed_archive', 'archive entry does not match its declared size', {
        entry: entry.name,
        declared: entry.declaredUncompressedSize,
        produced: 0,
      })
    }
    return
  }

  if (entry.method === METHOD_STORED) {
    for await (const chunk of source) yield* consume(toBuffer(chunk))
  } else {
    const inflate = createInflateRaw()
    source.pipe(inflate)
    try {
      for await (const chunk of inflate) yield* consume(toBuffer(chunk))
    } catch (error) {
      if (error instanceof ImportRunFailure) throw error
      // A zlib error means the member is not the deflate stream its header said
      // it was. That is the archive's problem, not an outage, so it ends the run
      // with a category rather than throwing an unclassified error the executor
      // would retry forever.
      fail('malformed_archive', 'archive entry is not a valid deflate stream', {
        entry: entry.name,
      })
    } finally {
      source.destroy()
      inflate.destroy()
    }
  }

  // **What arrived must be what the directory said would arrive.**
  //
  // For a deflate member, zlib validates the stream's structure but says nothing
  // about its length; for a **stored** member nothing validates anything at all —
  // the bytes are passed through verbatim, so a directory that understates or
  // overstates the size is otherwise completely undetected, and the entry is
  // parsed as though it were whole. Checking the produced count against the
  // declared one costs a comparison and turns a silently truncated report — a
  // customer's import missing days nobody would notice — into a refusal.
  //
  // The sizes come from the *central directory*, which carries true values even
  // for members written with a data descriptor (where the local header's are
  // zero), so this holds for every well-formed archive. It is checked before the
  // trailing line is emitted, so a truncated entry yields no partial last row.
  if (entryBytes !== entry.declaredUncompressedSize) {
    fail('malformed_archive', 'archive entry does not match its declared size', {
      entry: entry.name,
      declared: entry.declaredUncompressedSize,
      produced: entryBytes,
    })
  }

  // A final line with no trailing newline is still a line. Dropping it would
  // silently lose the last day of an export whose writer omitted the terminator.
  if (pending.length > 0) yield decodeLine(pending, entry, budgets)
}

function decodeLine(line: Buffer, entry: ArchiveEntry, budgets: ArchiveBudgets): string {
  if (line.length > budgets.maxRowBytes) {
    fail('row_too_long', 'archive entry contains a row past the row budget', {
      entry: entry.name,
      limit: budgets.maxRowBytes,
    })
  }
  // CRLF exports are the common case from Windows tooling.
  const trimmed = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line
  return trimmed.toString('utf8')
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  const bytes = chunk as Uint8Array
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Stream a downloaded object onto local disk under a hard byte ceiling.
 *
 * The ceiling is here rather than left to the port because the signed upload
 * bound the *declared* size, and this is where the bytes are actually counted: a
 * provider that streamed more than it said would otherwise fill the worker's
 * disk. It is the same argument the inflate budgets make one level down.
 */
export async function writeStreamToFile(
  body: AsyncIterable<Uint8Array>,
  path: string,
  maxBytes: number,
): Promise<number> {
  const handle = await open(path, 'w')
  let written = 0
  try {
    for await (const chunk of body) {
      written += chunk.byteLength
      if (written > maxBytes) {
        fail('entry_too_large', 'archive exceeds the archive budget while downloading', {
          limit: maxBytes,
        })
      }
      await handle.write(chunk)
    }
  } finally {
    await handle.close()
  }
  return written
}
