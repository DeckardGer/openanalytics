import {
  CITY_DROPPED_WARNING,
  DIMENSION_TRUNCATED_WARNING,
  IMPORT_DIMENSION_MAX_BYTES,
  IMPORT_TRUNCATION_SENTINEL,
  ImportRunFailure,
  PLAUSIBLE_PROVIDER_ID,
  ROWS_OUTSIDE_RANGE_WARNING,
  UNKNOWN_COLUMN_WARNING,
  parsePlausibleCsvLine,
  plausibleImportAdapter,
  type ImportRowBatch,
  type ImportedReport,
  type ImportedRow,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'
import { PLAUSIBLE_CSVS, plausibleEntryName } from '../support/import-fixtures.ts'

/**
 * The Plausible adapter (ADR-0032, D2/D11).
 *
 * The suite is organised around the three things an adapter can get wrong in a
 * way nobody notices until a customer compares totals with their old dashboard:
 *
 * 1. **Which file is which.** An entry claimed by the wrong report, or an
 *    entry/exit file refused as unknown, and the run either fails outright or
 *    stages the wrong numbers into the right table.
 * 2. **Which column is which.** Plausible does not promise column order, and a
 *    positional parser that is right today is wrong the day a column moves — with
 *    every value shifted one place and no error anywhere.
 * 3. **What is dropped, and whether anyone is told.** The city column and the
 *    entry/exit reports are deliberate losses; a silent one is the failure mode.
 */

const adapter = plausibleImportAdapter

async function* lines(text: string): AsyncIterable<string> {
  for (const line of text.split('\n')) yield line
}

async function parse<R extends ImportedReport>(
  report: R,
  table: string,
  text: string = PLAUSIBLE_CSVS[table] as string,
  options: { entryName?: string } = {},
): Promise<{ rows: ImportedRow<R>[]; warnings: Map<string, number> }> {
  const rows: ImportedRow<R>[] = []
  const warnings = new Map<string, number>()
  const batches = adapter.parseEntry<R>({
    report,
    entryName: options.entryName ?? plausibleEntryName(table),
    lines: lines(text),
  })
  for await (const batch of batches as AsyncIterable<ImportRowBatch<R>>) {
    rows.push(...batch.rows)
    for (const warning of batch.warnings ?? []) {
      warnings.set(warning.code, (warnings.get(warning.code) ?? 0) + warning.count)
    }
  }
  return { rows, warnings }
}

describe('entry recognition', () => {
  it('claims the eight staged reports and nothing else', () => {
    expect(adapter.providerId).toBe(PLAUSIBLE_PROVIDER_ID)
    const pairs: [string, ImportedReport][] = [
      ['visitors', 'metrics'],
      ['pages', 'pages'],
      ['sources', 'sources'],
      ['locations', 'geography'],
      ['devices', 'devices'],
      ['browsers', 'browsers'],
      ['operating_systems', 'os'],
      ['custom_events', 'custom_events'],
    ]
    for (const [table, report] of pairs) {
      expect(adapter.reportForEntry(plausibleEntryName(table)), table).toBe(report)
      expect(adapter.expectedEntryPattern(report).test(plausibleEntryName(table))).toBe(true)
    }
    expect(adapter.reports()).toHaveLength(8)
  })

  it('recognises entry/exit pages as declared drops, not unknown entries', () => {
    // The pipeline refuses any entry no report claims; without the dropped
    // pattern an ordinary Plausible export would fail `unexpected_entry` and the
    // customer would be told their archive is the wrong provider's.
    const dropped = adapter.droppedEntryPattern()
    expect(dropped).not.toBeNull()
    expect(adapter.reportForEntry(plausibleEntryName('entry_pages'))).toBeNull()
    expect(adapter.reportForEntry(plausibleEntryName('exit_pages'))).toBeNull()
    expect(dropped?.test(plausibleEntryName('entry_pages'))).toBe(true)
    expect(dropped?.test(plausibleEntryName('exit_pages'))).toBe(true)
    expect(dropped?.test(plausibleEntryName('visitors'))).toBe(false)
  })

  it('refuses an entry name that is not the provider’s shape', () => {
    // `imported_pages.csv` with no range, another provider's file, a path
    // traversal dressed as a report — none of them is claimed.
    expect(adapter.reportForEntry('imported_pages.csv')).toBeNull()
    expect(adapter.reportForEntry('../imported_pages_20240101_20240103.csv')).toBeNull()
    expect(adapter.reportForEntry('umami_pageviews.csv')).toBeNull()
  })
})

describe('CSV records', () => {
  it('keeps a quoted comma inside one field', () => {
    expect(parsePlausibleCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd'])
  })

  it('unescapes a doubled quote', () => {
    expect(parsePlausibleCsvLine('"say ""hi""",2')).toEqual(['say "hi"', '2'])
  })

  it('keeps empty trailing and interior fields', () => {
    expect(parsePlausibleCsvLine('a,,c,')).toEqual(['a', '', 'c', ''])
  })

  it('a quoted field containing a newline fails the run — theoretical for this provider', () => {
    // The line-based framework cannot carry a value containing a newline, so the
    // record's tail arrives as an unrelated line and the opening quote is never
    // closed. The reader refuses, and the caller fails the **run**, not the row:
    // a parser that skipped unreadable rows would publish a dashboard quietly
    // missing whatever it could not read. Plausible-generated exports
    // percent-encode URLs and carry no newline inside any dimension value, so
    // this is a real limitation nobody is expected to hit.
    expect(parsePlausibleCsvLine('a,"b,c')).toBeNull()
    // Garbage directly after a closing quote is the same class of ambiguity.
    expect(parsePlausibleCsvLine('"a"x,b')).toBeNull()
  })

  it('refuses a quote that opens after leading whitespace', () => {
    // ` "a,b",c` is three cells read strictly and four read leniently, and the
    // two disagree about where every later value goes — the shear that puts a
    // count into a dimension column.
    expect(parsePlausibleCsvLine(' "a,b",c')).toBeNull()
    expect(parsePlausibleCsvLine('x, "a,b"')).toBeNull()
    // A quote that is genuinely part of an unquoted value is still fine.
    expect(parsePlausibleCsvLine('5" screen,2')).toEqual(['5" screen', '2'])
  })
})

describe('column mapping', () => {
  it('reads the daily totals by name', async () => {
    const { rows } = await parse('metrics', 'visitors')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      date: '2024-01-01',
      visitors: 10,
      pageviews: 25,
      bounces: 4,
      visits: 12,
      visitDuration: 600,
    })
  })

  it('is indifferent to column order', async () => {
    // The whole reason the header is parsed. A positional reader would put
    // `visit_duration` into `visitors` here and never say a word.
    const reordered = [
      'visit_duration,bounces,visits,pageviews,visitors,date',
      '600,4,12,25,10,2024-01-01',
    ].join('\n')
    const { rows } = await parse('metrics', 'visitors', reordered)
    expect(rows[0]).toEqual({
      date: '2024-01-01',
      visitors: 10,
      pageviews: 25,
      bounces: 4,
      visits: 12,
      visitDuration: 600,
    })
  })

  it('ignores an unknown extra column and counts it as a warning', async () => {
    const extra = [
      'date,visitors,pageviews,bounces,visits,visit_duration,experimental_metric',
      '2024-01-01,10,25,4,12,600,999',
    ].join('\n')
    const { rows, warnings } = await parse('metrics', 'visitors', extra)
    expect(rows[0]).toMatchObject({ visitors: 10, visitDuration: 600 })
    expect(warnings.get(UNKNOWN_COLUMN_WARNING)).toBe(1)
  })

  it('fails the entry when a required column is missing', async () => {
    // A report parsed with a column missing would stage zeros that look like
    // measurements — worse than an error, because it is publishable.
    const missing = ['date,visitors,pageviews,bounces,visits', '2024-01-01,10,25,4,12'].join('\n')
    await expect(parse('metrics', 'visitors', missing)).rejects.toThrow(ImportRunFailure)
  })

  it('fails a header that repeats a column name', async () => {
    const duplicated = [
      'date,visitors,visitors,pageviews,bounces,visits,visit_duration',
      '2024-01-01,10,11,25,4,12,600',
    ].join('\n')
    await expect(parse('metrics', 'visitors', duplicated)).rejects.toThrow(ImportRunFailure)
  })

  it('carries hostname and the quoted page path', async () => {
    const { rows } = await parse('pages', 'pages')
    expect(rows.map((row) => row.page)).toEqual(['/', '/blog/hello,-world-"quoted"', '/pricing'])
    expect(rows[0]).toMatchObject({ hostname: 'shop.example.com', visitors: 6, pageviews: 10 })
  })

  it('carries the referrer, the UTM tuple and a quoted campaign', async () => {
    const { rows } = await parse('sources', 'sources')
    expect(rows[1]).toEqual({
      date: '2024-01-02',
      source: 'Newsletter',
      referrer: 'news.example.com',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'spring, 2024',
      utmContent: 'cta-a',
      utmTerm: '',
      pageviews: 9,
      visitors: 5,
      visits: 6,
      visitDuration: 280,
      bounces: 1,
    })
  })

  it('reads browsers, operating systems and devices with their versions', async () => {
    expect((await parse('browsers', 'browsers')).rows[0]).toMatchObject({
      browser: 'chrome',
      // The version is the provider's own string with no live counterpart to
      // agree with, so nothing translates it.
      browserVersion: '120.0',
    })
    expect((await parse('os', 'operating_systems')).rows[0]).toMatchObject({
      operatingSystem: 'windows',
      osVersion: '11',
    })
    expect((await parse('devices', 'devices')).rows[0]).toMatchObject({ device: 'desktop' })
  })

  it('reads custom events, including the goal-specific link_url', async () => {
    const { rows } = await parse('custom_events', 'custom_events')
    expect(rows[0]).toEqual({
      date: '2024-01-01',
      name: 'Signup',
      linkUrl: '',
      path: '',
      visitors: 3,
      events: 4,
    })
    expect(rows[1]?.linkUrl).toBe('https://partner.example.com/a')
  })

  it('tolerates an export with no link_url or path column', async () => {
    // Those two are Plausible's outbound-link and file-download properties; an
    // export with neither goal has no reason to carry them.
    const slim = ['date,name,visitors,events', '2024-01-01,Signup,3,4'].join('\n')
    const { rows } = await parse('custom_events', 'custom_events', slim)
    expect(rows[0]).toMatchObject({ name: 'Signup', linkUrl: '', path: '' })
  })
})

describe('the live vocabulary', () => {
  /** One row of a single-dimension report, so a token can be asserted directly. */
  const one = async (table: string, header: string, value: string): Promise<string> => {
    const report = ({ devices: 'devices', browsers: 'browsers', operating_systems: 'os' } as const)[
      table
    ] as 'devices' | 'browsers' | 'os'
    const columns =
      table === 'devices'
        ? 'date,device,visitors,visits,visit_duration,bounces,pageviews'
        : table === 'browsers'
          ? 'date,browser,browser_version,visitors,visits,visit_duration,bounces,pageviews'
          : 'date,operating_system,operating_system_version,visitors,visits,visit_duration,bounces,pageviews'
    const pad = table === 'devices' ? '1,1,1,1,1' : ',1,1,1,1,1'
    const { rows } = await parse(report, table, [columns, `2024-01-01,${value},${pad}`].join('\n'))
    const row = rows[0] as unknown as Record<string, string>
    return row[header] as string
  }

  it('translates device classes into the four the live classifier emits', async () => {
    // `normalizeUserAgentClass` returns desktop|mobile|tablet|unknown. Staging
    // Plausible's `Desktop` would put two rows on every merged devices breakdown
    // — one for each side of the cutover — that a customer reads as two devices.
    expect(await one('devices', 'device', 'Desktop')).toBe('desktop')
    expect(await one('devices', 'device', 'Mobile')).toBe('mobile')
    expect(await one('devices', 'device', 'Tablet')).toBe('tablet')
    // Anything the live side cannot produce, and an absent value, is `unknown` —
    // the live token for "could not tell", never the empty string.
    expect(await one('devices', 'device', 'Smart TV')).toBe('unknown')
    expect(await one('devices', 'device', '')).toBe('unknown')
  })

  it('translates browsers onto the live BROWSER_RULES tokens', async () => {
    expect(await one('browsers', 'browser', 'Chrome')).toBe('chrome')
    expect(await one('browsers', 'browser', 'Mobile Safari')).toBe('safari')
    expect(await one('browsers', 'browser', 'Microsoft Edge')).toBe('edge')
    expect(await one('browsers', 'browser', 'Firefox')).toBe('firefox')
    expect(await one('browsers', 'browser', 'Samsung Internet')).toBe('samsung')
    // An unmapped browser is still a real browser: lowercased, not `unknown`,
    // which would merge it with the genuinely unresolvable rows.
    expect(await one('browsers', 'browser', 'Vivaldi')).toBe('vivaldi')
    expect(await one('browsers', 'browser', '')).toBe('unknown')
  })

  it('translates operating systems onto the live OS_RULES tokens', async () => {
    // Not a case change: `macOS → macos` and `GNU/Linux → linux` are why these
    // are explicit maps rather than a blanket `toLowerCase`.
    expect(await one('operating_systems', 'operatingSystem', 'macOS')).toBe('macos')
    expect(await one('operating_systems', 'operatingSystem', 'Mac')).toBe('macos')
    expect(await one('operating_systems', 'operatingSystem', 'GNU/Linux')).toBe('linux')
    expect(await one('operating_systems', 'operatingSystem', 'Windows')).toBe('windows')
    expect(await one('operating_systems', 'operatingSystem', 'iOS')).toBe('ios')
    expect(await one('operating_systems', 'operatingSystem', 'Android')).toBe('android')
    expect(await one('operating_systems', 'operatingSystem', 'Chrome OS')).toBe('chromeos')
    expect(await one('operating_systems', 'operatingSystem', '')).toBe('unknown')
  })

  it('canonicalises the referrer host the way the live referrer path does', async () => {
    // `www.google.com` and `google.com` are one acquisition source, and merging
    // them is the whole reason the live path has a canonicaliser.
    const text = [
      'date,source,referrer,utm_source,utm_medium,utm_campaign,utm_content,utm_term,pageviews,visitors,visits,visit_duration,bounces',
      '2024-01-01,Google,WWW.Google.com:443,,,,,,1,1,1,1,1',
      '2024-01-02,Direct,,,,,,,1,1,1,1,1',
    ].join('\n')
    const { rows } = await parse('sources', 'sources', text)
    expect(rows[0]?.referrer).toBe('google.com')
    // Direct traffic stays empty on both sides.
    expect(rows[1]?.referrer).toBe('')
  })

  it('normalises the country to ISO-2 and blanks a placeholder', async () => {
    const geo = async (country: string): Promise<string> => {
      const text = [
        'date,country,region,city,visitors,visits,visit_duration,bounces,pageviews',
        `2024-01-01,${country},,,1,1,1,1,1`,
      ].join('\n')
      return (await parse('geography', 'locations', text)).rows[0]?.country as string
    }
    expect(await geo('gb')).toBe('GB')
    // `XX` and `T1` are the placeholders some platforms send for an unknown or
    // Tor-exit address; storing one would put a fake nation on a dashboard.
    expect(await geo('XX')).toBe('')
    expect(await geo('T1')).toBe('')
    expect(await geo('GBR')).toBe('')
    // The live rollup stores '' for a country it could not resolve, so an
    // unusable provider value becomes the same thing — not `unknown`.
    expect(await geo('')).toBe('')
  })
})

describe('row shape', () => {
  it('refuses a row that is not exactly as wide as the header', async () => {
    // A short row would read absent cells as empty — zeros that look like
    // measurements — and a long one means the reader and the writer disagree
    // about where a field ended.
    const short = [
      'date,visitors,pageviews,bounces,visits,visit_duration',
      '2024-01-01,10,25,4,12',
    ].join('\n')
    const long = [
      'date,visitors,pageviews,bounces,visits,visit_duration',
      '2024-01-01,10,25,4,12,600,extra',
    ].join('\n')
    await expect(parse('metrics', 'visitors', short)).rejects.toThrow(ImportRunFailure)
    await expect(parse('metrics', 'visitors', long)).rejects.toThrow(ImportRunFailure)
  })

  it('reports the report and the line, never the row’s content', async () => {
    // The detail is logged beside a customer-visible category. A hostile CSV must
    // not be able to write its own text into either.
    const text = [
      'date,visitors,pageviews,bounces,visits,visit_duration',
      '2024-01-01,1,1,1,1,1',
      '2024-01-02,<script>alert(1)</script>,1,1,1,1',
    ].join('\n')
    const error = (await parse('metrics', 'visitors', text).catch(
      (e: unknown) => e,
    )) as ImportRunFailure
    expect(error).toBeInstanceOf(ImportRunFailure)
    expect(error.category).toBe('malformed_csv')
    expect(error.detail).toEqual({ report: 'metrics', line: 3 })
    expect(JSON.stringify(error.detail)).not.toContain('script')
  })

  it('counts truncated dimensions with the same ceremony as the dropped city', async () => {
    // A truncated page path is a row the customer cannot find by searching for
    // its real URL — and a different merge key from the live row of that page.
    const text = [
      'date,hostname,page,visits,visitors,pageviews',
      `2024-01-01,shop.example.com,/${'x'.repeat(2_000)},1,1,1`,
      '2024-01-02,shop.example.com,/short,1,1,1',
    ].join('\n')
    const { rows, warnings } = await parse('pages', 'pages', text)
    expect(warnings.get(DIMENSION_TRUNCATED_WARNING)).toBe(1)
    expect(rows[0]?.page.endsWith(IMPORT_TRUNCATION_SENTINEL)).toBe(true)
    expect(Buffer.byteLength(rows[0]?.page ?? '', 'utf8')).toBeLessThanOrEqual(
      IMPORT_DIMENSION_MAX_BYTES,
    )
  })
})

describe('the declared filename range', () => {
  it('refuses eight digits that are not a calendar date', async () => {
    // Treating an unreadable range as *absent* would silently disable the
    // out-of-range warning it exists to raise.
    await expect(
      parse('metrics', 'visitors', PLAUSIBLE_CSVS['visitors'] as string, {
        entryName: 'imported_visitors_20241301_20241331.csv',
      }),
    ).rejects.toThrow(ImportRunFailure)
  })

  it('refuses a range that runs backwards', async () => {
    await expect(
      parse('metrics', 'visitors', PLAUSIBLE_CSVS['visitors'] as string, {
        entryName: 'imported_visitors_20241231_20240101.csv',
      }),
    ).rejects.toThrow(ImportRunFailure)
  })
})

describe('geography drops the city', () => {
  it('emits country and region only, and counts the dropped cities once', async () => {
    const { rows, warnings } = await parse('geography', 'locations')
    expect(rows).toEqual([
      {
        date: '2024-01-01',
        country: 'GB',
        region: 'GB-ENG',
        visitors: 5,
        visits: 6,
        pageviews: 8,
        bounces: 2,
        visitDuration: 240,
      },
      {
        date: '2024-01-02',
        country: 'DE',
        region: 'DE-BE',
        visitors: 4,
        visits: 4,
        pageviews: 6,
        bounces: 1,
        visitDuration: 190,
      },
    ])
    // One of the two rows carried a GeoNames id. The count is what tells the
    // reviewer whether the loss matters for their site.
    expect(warnings.get(CITY_DROPPED_WARNING)).toBe(1)
    // No row carries a city key at all, not even an empty one: a fabricated or
    // blank city sitting beside real live city names would be worse than absence.
    for (const row of rows) expect(Object.keys(row)).not.toContain('city')
  })

  it('says nothing when the export carried no city values', async () => {
    const noCity = [
      'date,country,region,city,visitors,visits,visit_duration,bounces,pageviews',
      '2024-01-01,GB,GB-ENG,,5,6,240,2,8',
    ].join('\n')
    const { warnings } = await parse('geography', 'locations', noCity)
    expect(warnings.has(CITY_DROPPED_WARNING)).toBe(false)
  })
})

describe('values', () => {
  it('refuses a date that is not a real calendar day', async () => {
    for (const bad of ['2024-02-31', '20240101', 'yesterday', '']) {
      const text = [
        'date,visitors,pageviews,bounces,visits,visit_duration',
        `${bad},1,1,1,1,1`,
      ].join('\n')
      await expect(parse('metrics', 'visitors', text), bad).rejects.toThrow(ImportRunFailure)
    }
  })

  it('accepts digits and nothing else', async () => {
    // `Number()` would take every one of these. Reading `1e3` as a thousand, or
    // `0x10` as sixteen, publishes a number the provider never wrote — with no
    // error anywhere — and `9007199254740993` reads back as ...992, so a count
    // nobody can round-trip is not a count.
    for (const bad of [
      '-1',
      '1.5',
      'NaN',
      'ten',
      '1e3',
      '0x10',
      '+5',
      ' 1 000',
      'Infinity',
      '1e21',
      '9007199254740993',
    ]) {
      const text = [
        'date,visitors,pageviews,bounces,visits,visit_duration',
        `2024-01-01,${bad},1,1,1,1`,
      ].join('\n')
      await expect(parse('metrics', 'visitors', text), bad).rejects.toThrow(ImportRunFailure)
    }
  })

  it('accepts the largest count that survives a round trip', async () => {
    const text = [
      'date,visitors,pageviews,bounces,visits,visit_duration',
      `2024-01-01,${String(Number.MAX_SAFE_INTEGER)},1,1,1,1`,
    ].join('\n')
    expect((await parse('metrics', 'visitors', text)).rows[0]?.visitors).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })

  it('reads an empty count as zero', async () => {
    const text = [
      'date,visitors,pageviews,bounces,visits,visit_duration',
      '2024-01-01,,1,1,1,1',
    ].join('\n')
    expect((await parse('metrics', 'visitors', text)).rows[0]?.visitors).toBe(0)
  })

  it('fails the row on an unterminated quote', async () => {
    const text = [
      'date,hostname,page,visits,visitors,pageviews',
      '2024-01-02,shop.example.com,"/a,1,1,1',
    ].join('\n')
    await expect(parse('pages', 'pages', text)).rejects.toThrow(ImportRunFailure)
  })

  it('scrubs a dimension value rather than storing it raw', async () => {
    // Control characters reach a dashboard cell, an export file and an operator's
    // terminal, and every one of those interprets at least one of them.
    const text = [
      'date,hostname,page,visits,visitors,pageviews',
      `2024-01-01,shop.example.com,/a${String.fromCharCode(7)}b   c,1,1,1`,
    ].join('\n')
    const { rows } = await parse('pages', 'pages', text)
    expect(rows[0]?.page).toBe('/a b c')
  })

  it('counts rows outside the filename’s declared range without failing them', async () => {
    // The rows are real measurements and the filename is the provider's own
    // bookkeeping; a mismatch is worth telling the reviewer, not worth refusing.
    const text = [
      'date,visitors,pageviews,bounces,visits,visit_duration',
      '2023-12-25,1,1,1,1,1',
      '2024-01-02,2,2,2,2,2',
      '2024-06-01,3,3,3,3,3',
    ].join('\n')
    const { rows, warnings } = await parse('metrics', 'visitors', text)
    expect(rows).toHaveLength(3)
    expect(warnings.get(ROWS_OUTSIDE_RANGE_WARNING)).toBe(2)
  })

  it('refuses an entry with no header at all, and says so accurately', async () => {
    // Blank lines are skipped *before* the header branch, so an entry that is
    // nothing but blank lines reports "entry is empty" rather than sending an
    // operator looking for a missing column in a file with no content.
    for (const empty of ['', '\n', '\n   \n\n']) {
      const error = (await parse('metrics', 'visitors', empty).catch(
        (e: unknown) => e,
      )) as ImportRunFailure
      expect(error, JSON.stringify(empty)).toBeInstanceOf(ImportRunFailure)
      expect(error.message).toContain('empty')
    }
  })

  it('skips blank lines before and after the header', async () => {
    const text = [
      '',
      'date,visitors,pageviews,bounces,visits,visit_duration',
      '',
      '2024-01-01,10,25,4,12,600',
      '   ',
    ].join('\n')
    expect((await parse('metrics', 'visitors', text)).rows).toHaveLength(1)
  })
})
