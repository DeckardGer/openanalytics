import {
  DIMENSION_TRUNCATED_WARNING,
  ImportRunFailure,
  scrubImportDimensionDetailed,
  type ImportAdapter,
  type ImportRowBatch,
  type ImportWarning,
  type ImportedReport,
  type ImportedRow,
  type ParseEntryInput,
} from '../import-adapter.ts'
import { canonicalReferrerHost } from '../referrer.ts'

/**
 * The Plausible import adapter (ADR-0032, D2/D11; provider facts verified
 * 2026-07-29 against plausible.io/docs/csv-import).
 *
 * Plausible's export is a ZIP of **ten daily-aggregate CSVs** named
 * `imported_{table}_{YYYYMMDD}_{YYYYMMDD}.csv`, where the two dates are the range
 * the export was taken over. There are no event rows and no visitor identifiers
 * anywhere in it, which is the whole reason the read path unions rather than
 * merges (D2b) and the reason a cross-boundary number can never be `exact` (D5).
 *
 * Eight of the ten fill a staged report. `imported_entry_pages` and
 * `imported_exit_pages` are **declared dropped** — recognised, accepted, and
 * recorded as a summary note rather than failing the archive — because no live
 * entry/exit-pages operation exists to read them and a staging table nothing
 * serves would only widen the deletion registry for free.
 *
 * Three provider behaviours shape the parser and are worth naming, because each
 * one is a decision a future adapter has to make too:
 *
 * 1. **Column order is not part of the contract.** The header row is parsed and
 *    every column is addressed by name, so a provider that reorders or appends a
 *    column does not silently shift every value one place left. An unknown extra
 *    column is ignored with a counted warning; a missing *required* one fails the
 *    entry, because a report parsed with a column missing would stage zeros that
 *    look like measurements.
 * 2. **Fields are RFC 4180 quoted.** A page path or a UTM value legitimately
 *    contains a comma, so a `split(',')` would shear rows apart. The parser
 *    below handles quoting and doubled quotes in-line.
 * 3. **The city column cannot be honoured.** Plausible ships city as a GeoNames
 *    numeric id, and nothing in this system resolves that id to the name the live
 *    geography dimension uses (GeoLite2 resolves IP addresses, not GeoNames ids).
 *    The column is dropped and the reviewer is told exactly once, with a count.
 *
 * And one thing that is not about parsing at all: **the dimension values are
 * translated into this system's own vocabulary, not stored as the provider
 * spells them.** Plausible writes `Desktop`, `Chrome`, `macOS`, `www.google.com`;
 * the live classifier emits `desktop`, `chrome`, `macos`, `google.com`
 * (`anonymous-identity.ts`, `referrer.ts`). Staging the provider's spelling
 * would put two rows on every merged breakdown — one for each side of the
 * cutover — that a customer would read as two different browsers. The maps below
 * are the translation, and they are explicit rather than a blanket `toLowerCase`
 * because `macOS → macos` and `GNU/Linux → linux` are not case changes.
 */

export const PLAUSIBLE_PROVIDER_ID = 'plausible'

/** How many rows the adapter groups into one yielded batch. The pipeline
 * re-buckets into byte-bounded chunks, so this only bounds the parser's own
 * working set between yields. */
const BATCH_ROWS = 500

/** The provider file each report is filled from. */
const REPORT_TABLES: Readonly<Record<ImportedReport, string>> = {
  metrics: 'visitors',
  pages: 'pages',
  sources: 'sources',
  geography: 'locations',
  devices: 'devices',
  browsers: 'browsers',
  os: 'operating_systems',
  custom_events: 'custom_events',
}

/** `imported_{table}_{YYYYMMDD}_{YYYYMMDD}.csv`, anchored. The pipeline uses
 * these only to *recognise* an entry and refuses everything no report claims, so
 * an anchored pattern narrows what is accepted rather than what is executed. */
function entryPattern(table: string): RegExp {
  return new RegExp(`^imported_${table}_(\\d{8})_(\\d{8})\\.csv$`)
}

/** The two reports this adapter reads, recognises and deliberately does not
 * stage (D2). Accepted with a summary note, never `unexpected_entry`. */
const DROPPED_ENTRY_PATTERN = /^imported_(entry_pages|exit_pages)_\d{8}_\d{8}\.csv$/

/**
 * The columns each report needs, and the ones it merely tolerates.
 *
 * `optional` is not "nice to have": every entry in it is a column whose *absence*
 * is a legitimate export rather than a broken one. `city` is dropped anyway
 * (below), and `link_url`/`path` are Plausible's two goal-specific properties
 * that an export containing no outbound-link or file-download goal has no reason
 * to carry.
 */
interface ColumnSpec {
  readonly required: readonly string[]
  readonly optional: readonly string[]
}

const COLUMNS: Readonly<Record<ImportedReport, ColumnSpec>> = {
  metrics: {
    required: ['date', 'visitors', 'pageviews', 'bounces', 'visits', 'visit_duration'],
    optional: [],
  },
  pages: {
    required: ['date', 'hostname', 'page', 'visits', 'visitors', 'pageviews'],
    optional: [],
  },
  sources: {
    required: [
      'date',
      'source',
      'referrer',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
      'pageviews',
      'visitors',
      'visits',
      'visit_duration',
      'bounces',
    ],
    optional: [],
  },
  geography: {
    required: [
      'date',
      'country',
      'region',
      'visitors',
      'visits',
      'visit_duration',
      'bounces',
      'pageviews',
    ],
    optional: ['city'],
  },
  devices: {
    required: ['date', 'device', 'visitors', 'visits', 'visit_duration', 'bounces', 'pageviews'],
    optional: [],
  },
  browsers: {
    required: [
      'date',
      'browser',
      'browser_version',
      'visitors',
      'visits',
      'visit_duration',
      'bounces',
      'pageviews',
    ],
    optional: [],
  },
  os: {
    required: [
      'date',
      'operating_system',
      'operating_system_version',
      'visitors',
      'visits',
      'visit_duration',
      'bounces',
      'pageviews',
    ],
    optional: [],
  },
  custom_events: {
    required: ['date', 'name', 'visitors', 'events'],
    optional: ['link_url', 'path'],
  },
}

// --- Warning codes -----------------------------------------------------------

// --- The live vocabulary -----------------------------------------------------

/**
 * The token the live classifier uses when it could not tell.
 *
 * `normalizeUserAgentClass` returns `unknown` for an unresolvable device, browser
 * or OS, so an imported row with a blank one has to say `unknown` too — an empty
 * string would be a third value that merges with neither.
 *
 * Geography is deliberately different: the live path stores `''` for a country or
 * city it could not resolve (`normalizeCountry` returns null, which reaches
 * `events_raw` as the empty string), so an imported blank country stays blank.
 */
const UNKNOWN = 'unknown'

/** `UserAgentClass['deviceType']` — the only four values the live side emits. */
const DEVICE_TOKENS: Readonly<Record<string, string>> = {
  desktop: 'desktop',
  mobile: 'mobile',
  tablet: 'tablet',
}

/** `BROWSER_RULES` in `anonymous-identity.ts`, keyed on what Plausible writes. */
const BROWSER_TOKENS: Readonly<Record<string, string>> = {
  chrome: 'chrome',
  'chrome mobile': 'chrome',
  'mobile chrome': 'chrome',
  firefox: 'firefox',
  'mobile firefox': 'firefox',
  safari: 'safari',
  'mobile safari': 'safari',
  edge: 'edge',
  'microsoft edge': 'edge',
  opera: 'opera',
  'opera mobile': 'opera',
  'samsung internet': 'samsung',
  samsung: 'samsung',
}

/** `OS_RULES` in `anonymous-identity.ts`, keyed on what Plausible writes. */
const OS_TOKENS: Readonly<Record<string, string>> = {
  windows: 'windows',
  macos: 'macos',
  'mac os': 'macos',
  'mac os x': 'macos',
  mac: 'macos',
  ios: 'ios',
  android: 'android',
  linux: 'linux',
  'gnu/linux': 'linux',
  ubuntu: 'linux',
  'chrome os': 'chromeos',
  chromeos: 'chromeos',
  chromiumos: 'chromeos',
}

/**
 * Provider spelling → this system's token.
 *
 * The fallback differs by dimension because the live vocabularies do:
 *
 * - **`closed`** is `device_type`, whose live values are exactly
 *   `desktop|mobile|tablet|unknown` (`UserAgentClass`). A fifth value cannot come
 *   out of the live classifier, so a provider's `Smart TV` has no live row to
 *   merge with and belongs in `unknown` rather than as a category only imported
 *   ranges can ever show.
 * - **`open`** is browser and OS, whose live rules name a handful of families and
 *   answer `unknown` for the rest. A browser this table has not heard of is still
 *   a real browser: lowercasing keeps it distinct, while folding it into
 *   `unknown` would merge it with the genuinely unresolvable rows.
 *
 * An empty value is `unknown` either way, which is what the live classifier
 * returns for a user agent it could not read.
 */
function liveToken(
  value: string,
  table: Readonly<Record<string, string>>,
  vocabulary: 'closed' | 'open',
): string {
  const lowered = value.trim().toLowerCase()
  if (lowered === '') return UNKNOWN
  return table[lowered] ?? (vocabulary === 'closed' ? UNKNOWN : lowered)
}

/** ISO-3166-1 alpha-2, uppercased — `normalizeCountry`'s rule, minus the null:
 * the live rollup stores the empty string for a country it could not resolve, so
 * that is what an unusable provider value becomes here. `XX` and `T1` are the
 * placeholders some platforms send for unknown or Tor-exit addresses, and storing
 * one would put a fake nation in a customer's dashboard. */
function liveCountry(value: string): string {
  const upper = value.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper) || upper === 'XX' || upper === 'T1') return ''
  return upper
}

/** The reserved code D2 names: the geography city column was present and
 * carried values this system cannot resolve. */
export const CITY_DROPPED_WARNING = 'city_dropped'
/** Columns the header carried that no report reads. Counted, not named: a column
 * name is provider text and this warning is rendered to the customer. */
export const UNKNOWN_COLUMN_WARNING = 'unknown_columns'
/** Rows whose date falls outside the range the filename declares. A warning
 * rather than a failure — the rows are real measurements and the filename is the
 * provider's own bookkeeping. */
export const ROWS_OUTSIDE_RANGE_WARNING = 'rows_outside_declared_range'

// --- CSV ---------------------------------------------------------------------

/**
 * One CSV record, RFC 4180, from one already-framed line.
 *
 * Returns `null` for a line this reader will not guess at, and the caller then
 * **fails the whole run** with `malformed_csv` — not the row. That is the strict
 * choice on purpose: a parser that skipped unreadable rows would publish a
 * dashboard quietly missing whatever it could not read, and the customer's only
 * signal would be numbers that are slightly too small.
 *
 * Two shapes reach it:
 *
 * - **A quoted field with no closing quote**, which is what a value containing a
 *   literal newline looks like from here: the pipeline hands entries over one
 *   line at a time (it is inflating as the adapter consumes, and materialising an
 *   entry would defeat the whole budgeted-streaming design), so the record's
 *   second half arrives as a separate, unrelated line. **A quoted field
 *   containing a newline therefore fails the run** — a real limitation, and a
 *   theoretical one for this provider: Plausible-generated exports percent-encode
 *   URLs and carry no newline inside any dimension value. A provider that does
 *   would need the framework to frame *records* rather than lines, which is a
 *   change to the pipeline, not to an adapter.
 * - **A quote that opens somewhere other than the start of a field** — ` "a,b",c`
 *   with a leading space. Read leniently that is four cells and read strictly it
 *   is three, and the two disagree about where every later value goes. Refusing
 *   is the only reading that cannot silently shear a row.
 */
export function parsePlausibleCsvLine(line: string): readonly string[] | null {
  const cells: string[] = []
  let index = 0
  for (;;) {
    if (line[index] === '"') {
      index += 1
      let value = ''
      let closed = false
      while (index < line.length) {
        if (line[index] === '"') {
          // A doubled quote inside a quoted field is one literal quote.
          if (line[index + 1] === '"') {
            value += '"'
            index += 2
            continue
          }
          index += 1
          closed = true
          break
        }
        value += line[index]
        index += 1
      }
      if (!closed) return null
      cells.push(value)
      if (index === line.length) return cells
      // Anything but a separator after the closing quote is a record this
      // reader would have to guess at.
      if (line[index] !== ',') return null
      index += 1
      continue
    }
    const end = line.indexOf(',', index)
    const raw = end === -1 ? line.slice(index) : line.slice(index, end)
    // A quote that opens after leading whitespace is an ambiguous record, not a
    // literal quote character: the writer meant to quote and something put a
    // space in front of it.
    if (raw.trimStart().startsWith('"')) return null
    cells.push(raw)
    if (end === -1) return cells
    index = end + 1
  }
}

/** Strips the UTF-8 BOM and a CRLF carriage return. Both are ordinary in a
 * provider-generated CSV and neither is part of any value. */
function normalizeLine(line: string, first: boolean): string {
  const withoutCr = line.endsWith('\r') ? line.slice(0, -1) : line
  return first && withoutCr.charCodeAt(0) === 0xfeff ? withoutCr.slice(1) : withoutCr
}

// --- Values ------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar date, or null. `2024-02-31` round-trips to `2024-03-02`, so
 * the round trip *is* the check. */
function calendarDate(value: string): string | null {
  if (!ISO_DATE.test(value)) return null
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null
  return value
}

/** `YYYY-MM-DD`, and a real calendar date. A row nothing can ever query is a
 * parse failure rather than a row. */
function parseDate(value: string, where: RowContext): string {
  const date = calendarDate(value)
  if (date === null) {
    throw new ImportRunFailure('malformed_csv', 'row date is not a calendar date', where)
  }
  return date
}

/** `YYYYMMDD` → `YYYY-MM-DD`, the form the filename declares its range in, or
 * null when those eight digits are not a date. */
function fromCompactDate(value: string): string | null {
  return calendarDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`)
}

/**
 * A non-negative integer count.
 *
 * **Digits only.** `Number()` would accept `1e3`, `0x10`, `+5`, `Infinity` and a
 * leading-dot float, and every one of those is a value the provider did not
 * write — an export producing them is not an export this parser understands, and
 * silently reading `1e3` as a thousand is how a wrong number gets published with
 * no error anywhere. A float is refused for the same reason it always was: it
 * would be truncated into a `UInt64` column.
 *
 * The upper bound is `Number.MAX_SAFE_INTEGER`, because past it the *parse* is
 * already lossy — `9007199254740993` reads back as `9007199254740992` — and a
 * count nobody can round-trip is not a count.
 */
const DIGITS = /^\d+$/

function parseCount(value: string, where: RowContext): number {
  const trimmed = value.trim()
  if (trimmed.length === 0) return 0
  if (!DIGITS.test(trimmed)) {
    throw new ImportRunFailure('malformed_csv', 'count is not a non-negative integer', where)
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) {
    throw new ImportRunFailure('malformed_csv', 'count exceeds the safe integer range', where)
  }
  return parsed
}

// --- The adapter -------------------------------------------------------------

const REPORT_ORDER: readonly ImportedReport[] = [
  // Cheapest first: `visitors` is six small numbers per day, so an archive that
  // is the wrong provider's export fails before anything large is inflated.
  'metrics',
  'devices',
  'browsers',
  'os',
  'geography',
  'sources',
  'custom_events',
  'pages',
]

export const plausibleImportAdapter: ImportAdapter = {
  providerId: PLAUSIBLE_PROVIDER_ID,

  reports() {
    return REPORT_ORDER
  },

  expectedEntryPattern(report) {
    return entryPattern(REPORT_TABLES[report])
  },

  reportForEntry(entryName) {
    for (const report of REPORT_ORDER) {
      if (entryPattern(REPORT_TABLES[report]).test(entryName)) return report
    }
    return null
  },

  droppedEntryPattern() {
    return DROPPED_ENTRY_PATTERN
  },

  droppedEntryToken(entryName) {
    // The capture, never the filename: the token reaches the customer's review
    // screen, and a filename is provider text from inside an archive nothing has
    // yet proven benign.
    return DROPPED_ENTRY_PATTERN.exec(entryName)?.[1] ?? null
  },

  parseEntry<R extends ImportedReport>(
    input: ParseEntryInput<R>,
  ): AsyncIterable<ImportRowBatch<R>> {
    return parseEntry(input)
  },
}

/** Operator-facing context on a row failure: which report and which line. Never
 * the row's content — the detail is logged beside a customer-visible category,
 * and a hostile CSV must not be able to write text into either. */
type RowContext = { readonly report: ImportedReport; readonly line: number }

/**
 * The range the filename declares.
 *
 * Null when the entry name does not carry one, which `planEntries` has already
 * refused — defence in depth. A **throw** when the eight digits are not a
 * calendar date or the range runs backwards: `imported_pages_20241301_20240101`
 * is not an export this parser understands, and treating its range as absent
 * would silently disable the out-of-range warning it exists to raise.
 */
function declaredRange(
  report: ImportedReport,
  entryName: string,
): { from: string; to: string } | null {
  const match = entryPattern(REPORT_TABLES[report]).exec(entryName)
  if (!match) return null
  const from = fromCompactDate(match[1] as string)
  const to = fromCompactDate(match[2] as string)
  if (from === null || to === null || from > to) {
    throw new ImportRunFailure('unexpected_entry', 'entry name declares an impossible range', {
      report,
    })
  }
  return { from, to }
}

/**
 * Header row → column name to index.
 *
 * Duplicate names are refused rather than resolved by position: which of the two
 * a report reads would then depend on the order they happen to appear in, and
 * the reviewer would see a plausible number computed from the wrong column.
 */
function headerIndex(report: ImportedReport, cells: readonly string[]): Map<string, number> {
  const index = new Map<string, number>()
  for (const [position, raw] of cells.entries()) {
    const name = raw.trim().toLowerCase()
    if (name.length === 0) continue
    if (index.has(name)) {
      throw new ImportRunFailure('malformed_csv', 'header repeats a column name', { report })
    }
    index.set(name, position)
  }
  for (const required of COLUMNS[report].required) {
    if (!index.has(required)) {
      throw new ImportRunFailure('malformed_csv', 'header is missing a required column', { report })
    }
  }
  return index
}

/** Columns the header carried that this report neither requires nor tolerates. */
function unknownColumnCount(report: ImportedReport, index: ReadonlyMap<string, number>): number {
  const known = new Set([...COLUMNS[report].required, ...COLUMNS[report].optional])
  let unknown = 0
  for (const name of index.keys()) if (!known.has(name)) unknown += 1
  return unknown
}

async function* parseEntry<R extends ImportedReport>(
  input: ParseEntryInput<R>,
): AsyncIterable<ImportRowBatch<R>> {
  const report = input.report
  const range = declaredRange(report, input.entryName)

  let index: Map<string, number> | null = null
  let width = 0
  let batch: ImportedRow<R>[] = []
  let citiesSeen = 0
  let outsideRange = 0
  let unknownColumns = 0
  let truncated = 0
  let lineNumber = 0
  let first = true

  for await (const raw of input.lines) {
    lineNumber += 1
    const line = normalizeLine(raw, first)
    first = false

    // **Before the header branch.** An entry whose first line is blank — or an
    // entry that is nothing but blank lines — would otherwise consume that line
    // as its header and fail with "missing a required column", which sends an
    // operator looking for a column problem in a file that has no content.
    if (line.trim().length === 0) continue

    if (index === null) {
      const header = parsePlausibleCsvLine(line)
      if (header === null) {
        throw new ImportRunFailure('malformed_csv', 'header row is not a readable CSV record', {
          report,
          line: lineNumber,
        })
      }
      index = headerIndex(report, header)
      width = header.length
      unknownColumns = unknownColumnCount(report, index)
      continue
    }

    const where: RowContext = { report, line: lineNumber }
    const cells = parsePlausibleCsvLine(line)
    if (cells === null) {
      throw new ImportRunFailure('malformed_csv', 'row is not a readable CSV record', where)
    }
    // **A row must be exactly as wide as the header.** A short row would read
    // absent cells as empty — zeros that look like measurements — and a long one
    // means the reader and the writer disagree about where a field ended, which
    // is the shape a mis-parsed quote takes.
    if (cells.length !== width) {
      throw new ImportRunFailure('malformed_csv', 'row width does not match the header', where)
    }

    const at = (name: string): string => {
      const position = index?.get(name)
      return position === undefined ? '' : (cells[position] ?? '')
    }
    const text = (name: string): string => {
      const scrubbed = scrubImportDimensionDetailed(at(name))
      if (scrubbed.truncated) truncated += 1
      return scrubbed.value
    }
    const count = (name: string): number => parseCount(at(name), where)

    const date = parseDate(at('date').trim(), where)
    if (range !== null && (date < range.from || date > range.to)) outsideRange += 1
    if (report === 'geography' && at('city').trim().length > 0) citiesSeen += 1

    batch.push(rowFor(report, date, text, count) as ImportedRow<R>)
    if (batch.length >= BATCH_ROWS) {
      yield { report, rows: batch }
      batch = []
    }
  }

  if (index === null) {
    throw new ImportRunFailure('malformed_csv', 'entry is empty', { report })
  }

  const warnings: ImportWarning[] = []
  if (citiesSeen > 0) {
    // D2's reserved warning, emitted once with the count of rows whose city value
    // was thrown away — which is what tells the reviewer whether the loss matters
    // for their site or is a handful of rows.
    warnings.push({ code: CITY_DROPPED_WARNING, count: citiesSeen, detail: { report } })
  }
  if (outsideRange > 0) {
    warnings.push({ code: ROWS_OUTSIDE_RANGE_WARNING, count: outsideRange, detail: { report } })
  }
  if (unknownColumns > 0) {
    warnings.push({ code: UNKNOWN_COLUMN_WARNING, count: unknownColumns, detail: { report } })
  }
  if (truncated > 0) {
    // Same ceremony as the dropped city, and for the same reason: the loss is
    // acceptable and a *silent* loss is not. A truncated page path is a row the
    // customer will not find by searching for its real URL.
    warnings.push({ code: DIMENSION_TRUNCATED_WARNING, count: truncated, detail: { report } })
  }

  // The final yield always happens, even with an empty row list, because it is
  // what carries the warnings — a report whose only news is "the city column was
  // dropped" must still deliver it.
  yield { report, rows: batch, warnings }
}

/** Provider row → the normalized shape its report stages. Explicit per report,
 * because a generic rename would let a typo become an absent field the stored-row
 * mapper fills with a type default. */
function rowFor(
  report: ImportedReport,
  date: string,
  text: (name: string) => string,
  count: (name: string) => number,
): ImportedRow {
  switch (report) {
    case 'metrics':
      return {
        date,
        visitors: count('visitors'),
        visits: count('visits'),
        pageviews: count('pageviews'),
        bounces: count('bounces'),
        visitDuration: count('visit_duration'),
      }
    case 'pages':
      return {
        date,
        hostname: text('hostname'),
        page: text('page'),
        visitors: count('visitors'),
        visits: count('visits'),
        pageviews: count('pageviews'),
      }
    case 'sources':
      return {
        date,
        source: text('source'),
        // Through the same canonicaliser the live referrer path uses, so an
        // imported `www.google.com` merges with a live `google.com` instead of
        // sitting beside it as a second acquisition source.
        referrer: canonicalReferrerHost(text('referrer')),
        utmSource: text('utm_source'),
        utmMedium: text('utm_medium'),
        utmCampaign: text('utm_campaign'),
        utmContent: text('utm_content'),
        utmTerm: text('utm_term'),
        visitors: count('visitors'),
        visits: count('visits'),
        pageviews: count('pageviews'),
        bounces: count('bounces'),
        visitDuration: count('visit_duration'),
      }
    case 'geography':
      // `city` is read only to count it for the warning; it is never carried.
      return {
        date,
        country: liveCountry(text('country')),
        region: text('region'),
        visitors: count('visitors'),
        visits: count('visits'),
        pageviews: count('pageviews'),
        bounces: count('bounces'),
        visitDuration: count('visit_duration'),
      }
    case 'devices':
      return {
        date,
        device: liveToken(text('device'), DEVICE_TOKENS, 'closed'),
        visitors: count('visitors'),
        visits: count('visits'),
        pageviews: count('pageviews'),
        bounces: count('bounces'),
        visitDuration: count('visit_duration'),
      }
    case 'browsers':
      return {
        date,
        browser: liveToken(text('browser'), BROWSER_TOKENS, 'open'),
        // The version is the provider's own string and has no live counterpart
        // to agree with — nothing merges on it, so nothing translates it.
        browserVersion: text('browser_version'),
        visitors: count('visitors'),
        visits: count('visits'),
        pageviews: count('pageviews'),
        bounces: count('bounces'),
        visitDuration: count('visit_duration'),
      }
    case 'os':
      return {
        date,
        operatingSystem: liveToken(text('operating_system'), OS_TOKENS, 'open'),
        osVersion: text('operating_system_version'),
        visitors: count('visitors'),
        visits: count('visits'),
        pageviews: count('pageviews'),
        bounces: count('bounces'),
        visitDuration: count('visit_duration'),
      }
    case 'custom_events':
      return {
        date,
        name: text('name'),
        linkUrl: text('link_url'),
        path: text('path'),
        visitors: count('visitors'),
        events: count('events'),
      }
    default: {
      // Exhaustiveness, checked by the compiler: a ninth report added to
      // `IMPORTED_REPORTS` fails to build here rather than falling through to
      // whichever branch happened to be last. The throw is the runtime half, for
      // a value that reached this function past the type system.
      const unreachable: never = report
      throw new ImportRunFailure(
        'malformed_csv',
        `no Plausible mapping for report "${String(unreachable)}"`,
      )
    }
  }
}
