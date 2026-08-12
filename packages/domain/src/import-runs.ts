/**
 * The import run's state vocabulary and the derived status (ADR-0032, D3/D7).
 *
 * Three consumers have to agree on these strings — the migration's CHECK, the
 * repository's transition guards and the api's response — so they live in one
 * pure module rather than being restated at each end.
 *
 * The **phase** is the run's own state, which is what an import screen shows
 * ("validating", "awaiting your review"). The **status** is the generic job
 * vocabulary every long-running operation in this API reports (docs snapshot 03
 * §13), so a client that only knows "queued/running/succeeded/failed" can render
 * an import without learning the import state machine. One of them is a
 * statement about this feature; the other is a statement about work in general,
 * and collapsing them would make a generic progress component impossible.
 */

export const IMPORT_RUN_STATES = [
  'uploading',
  'uploaded',
  'validating',
  'processing',
  'ready_for_review',
  'publishing',
  'published',
  'failed',
  'discarded',
  'superseded',
  'rolled_back',
] as const
export type ImportRunState = (typeof IMPORT_RUN_STATES)[number]

/**
 * The states a run can still move out of by itself — the predicate of the
 * partial unique `import_runs_live_site_key` (migration 0030), restated here so
 * the index and every "is an import already under way?" read agree by
 * construction.
 *
 * `ready_for_review` is inside it, which is the whole point of D3: a human
 * review that can take days still holds the site's single import slot, so a
 * second import cannot be started beside a first one awaiting a decision. What
 * it does *not* hold is a job lease — the prepare job terminates succeeded when
 * it reaches this state.
 */
export const IMPORT_RUN_LIVE_STATES = [
  'uploading',
  'uploaded',
  'validating',
  'processing',
  'ready_for_review',
  'publishing',
] as const
export type ImportRunLiveState = (typeof IMPORT_RUN_LIVE_STATES)[number]

/** The states a `DELETE .../imports/{run_id}` may discard from. Past
 * `ready_for_review` the run owns a job lease or a published pointer, and
 * discarding it is a different operation (rollback) with a different name. */
export const IMPORT_RUN_DISCARDABLE_STATES = ['uploading', 'uploaded', 'ready_for_review'] as const

/**
 * States a run can never leave by itself — the complement of
 * `IMPORT_RUN_LIVE_STATES`.
 *
 * `published` is inside it and `superseded` is too. Both are terminal *as
 * transitions the run makes on its own*: only a publish of a later run or an
 * explicit rollback moves them, and neither is something a job or a sweep may
 * do.
 *
 * Its one consumer is `IMPORT_RUN_CLEANABLE_STATES` below, which subtracts
 * `published` from it — so this list is not merely a completeness check against
 * the live set, it is where the cleanable vocabulary comes from. A new terminal
 * state therefore becomes cleanable by default, which is the safe direction.
 *
 * It is deliberately *not* what decides whether a superseded run may be erased:
 * that question is "reachable", not "terminal", and a `superseded` run may still
 * be the single rollback generation. The backstop answers it from
 * `superseded_run_id` and the state of the run pointing at it.
 */
export const IMPORT_RUN_TERMINAL_STATES = [
  'published',
  'failed',
  'discarded',
  'superseded',
  'rolled_back',
] as const
export type ImportRunTerminalState = (typeof IMPORT_RUN_TERMINAL_STATES)[number]

export function isTerminalImportRunState(state: ImportRunState): boolean {
  return (IMPORT_RUN_TERMINAL_STATES as readonly string[]).includes(state)
}

/**
 * The states whose staged ClickHouse rows and archive a cleanup may erase.
 *
 * Terminal **minus `published`**, and derived from that list rather than written
 * out so the two cannot drift: a state added to the vocabulary as terminal is
 * cleanable by default, which is the safe direction — the alternative is a new
 * terminal state whose rows nothing ever purges.
 *
 * `published` is excluded because those rows *are* the site's live imported
 * history. `superseded` is included, and it is the one that needs care: a
 * superseded run may still be the single rollback generation (D3), so the
 * queries that select candidates exclude the run some published run names as its
 * predecessor. This list is the second line of defence — the guard on the claim
 * itself, which refuses a run whose state changed between being listed and being
 * cleaned.
 */
export const IMPORT_RUN_CLEANABLE_STATES: readonly ImportRunState[] =
  IMPORT_RUN_TERMINAL_STATES.filter((state) => state !== 'published')

/** The generic job vocabulary an operation's `status` is reported in. */
export type ImportRunStatus =
  'queued' | 'running' | 'succeeded' | 'failed_retryable' | 'failed_terminal' | 'cancelled'

export function isImportRunState(value: unknown): value is ImportRunState {
  return typeof value === 'string' && (IMPORT_RUN_STATES as readonly string[]).includes(value)
}

export function isLiveImportRunState(state: ImportRunState): boolean {
  return (IMPORT_RUN_LIVE_STATES as readonly string[]).includes(state)
}

/**
 * The D7 status derivation table.
 *
 * `jobStatus` is the status of the `import_prepare`/`import_publish` job that
 * currently owns the run, when one exists. It is what lets a run that is being
 * retried between attempts report `failed_retryable` rather than a flat
 * `running` — the difference between "this is working" and "this keeps failing
 * and will be tried again", which is exactly what a support conversation turns
 * on. Absent, the state alone decides.
 *
 * Two entries are worth naming because they look wrong at a glance:
 *
 * - `ready_for_review` is `running`, not `succeeded`. The prepare job has
 *   finished, but the *operation the customer started* has not: nothing is
 *   visible on their dashboard until they publish.
 * - `superseded` is `succeeded`. A superseded run was published and then
 *   replaced by a later one; it did what it was asked to do, and reporting it as
 *   cancelled would rewrite history the rollback generation still depends on.
 */
export function importRunStatusFor(
  state: ImportRunState,
  jobStatus?: ImportRunStatus | undefined,
): ImportRunStatus {
  switch (state) {
    case 'uploading':
    case 'uploaded':
      return 'queued'
    case 'validating':
    case 'processing':
    case 'publishing':
      return jobStatus ?? 'running'
    case 'ready_for_review':
      return 'running'
    case 'published':
    case 'superseded':
      return 'succeeded'
    case 'failed':
      return 'failed_terminal'
    case 'discarded':
    case 'rolled_back':
      return 'cancelled'
  }
}

/**
 * The staged archive's object key.
 *
 * Id-addressed (D1): nothing in the key is derived from customer input, so a
 * provider name or a filename can never steer where bytes land. Named here
 * rather than at the two ends that build and read it — the api creating the run
 * and the deletion snapshot enumerating what to purge — because a key format
 * that differs by one character between them is an object nobody can find.
 */
export function importArchiveObjectKey(siteId: string, runId: string): string {
  return `imports/${siteId}/${runId}/archive.zip`
}

/** The `imports/` prefix the bucket lifecycle rule expires (D1). */
export const IMPORT_OBJECT_PREFIX = 'imports/'

// --- The review summary and the cutover date (D4) -----------------------------

/**
 * What staging recorded for one report.
 *
 * `chunks` is beside `rows` because it is the unit the retry guarantee is
 * expressed in: a resumed run continues after the last durable chunk, and an
 * operator comparing a stalled run's progress against this number can tell
 * whether staging got anywhere at all.
 */
export interface ImportReportSummary {
  readonly rows: number
  readonly chunks: number
}

/**
 * The run summary, in the shape it is stored and returned in.
 *
 * `snake_case` on purpose: this object is written to `import_runs.summary`
 * (jsonb) and handed to the client verbatim by the api, so a camelCase field
 * here would be a camelCase field on the wire in a contract that is snake_case
 * everywhere else.
 */
export interface ImportRunSummary {
  /** Per report. A report the archive did not contain is simply absent, which is
   * a different statement from a report that contained zero rows. */
  readonly reports: Readonly<Record<string, ImportReportSummary>>
  /** The span the archive actually covers, `null` when it staged nothing. */
  readonly date_range: { readonly from: string; readonly to: string } | null
  readonly warnings: readonly ImportSummaryWarning[]
  /**
   * The cutover the review step offers by default (D4). Null only when nothing
   * was staged, in which case there is nothing to publish either.
   */
  readonly proposed_cutover_date: string | null
  readonly total_rows: number
}

export interface ImportSummaryWarning {
  readonly code: string
  readonly count: number
  readonly detail?: Readonly<Record<string, string | number>>
}

/**
 * The default cutover (D4).
 *
 * `min(first live event day, max imported date + 1)`. For the primary migration
 * case — a site with no live events yet — there is no clamp at all and the
 * default is `max imported date + 1`, so the whole import is visible and live
 * data starts winning the moment the tracker is installed.
 *
 * The arithmetic is UTC calendar arithmetic, never a local `Date`: the cutover
 * is compared against provider day keys, and computing "the next day" in the
 * worker's zone would land a day early for half the planet.
 */
export function defaultCutoverDate(input: {
  readonly maxImportedDate: string | null
  readonly firstEventAt: Date | null
}): string | null {
  if (input.maxImportedDate === null) return null
  const dayAfterImport = addUtcDay(input.maxImportedDate)
  if (input.firstEventAt === null) return dayAfterImport
  const firstLiveDay = input.firstEventAt.toISOString().slice(0, 10)
  return firstLiveDay < dayAfterImport ? firstLiveDay : dayAfterImport
}

/**
 * The latest cutover a site will accept (D4).
 *
 * `first live day + 1`, and null for a site that has never had an event — the
 * import cannot overlap data that does not exist. The `+ 1` is the ADR's, and it
 * is deliberately one day looser than the *default*: a customer whose provider
 * and tracker genuinely overlapped for the first live day may want that day to
 * come from the provider, which is a choice the review step is for. Anything
 * beyond it would hide live data the site already has behind imported numbers,
 * which is not a choice — it is a wrong dashboard.
 */
export function maxCutoverDate(firstEventAt: Date | null): string | null {
  if (firstEventAt === null) return null
  return addUtcDay(firstEventAt.toISOString().slice(0, 10))
}

/** `YYYY-MM-DD`, and a real calendar date. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return false
  return parsed.toISOString().slice(0, 10) === value
}

function addUtcDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

export type CutoverValidation =
  | { readonly ok: true; readonly cutoverDate: string }
  | { readonly ok: false; readonly code: 'invalid' | 'too_late' | 'unavailable' }

/**
 * Resolve the cutover a publish will write.
 *
 * Three refusals, and each is a different conversation with the customer:
 *
 * - `invalid` — the value is not a calendar date. A request problem.
 * - `too_late` — the value is past `first live day + 1`, which would hide live
 *   data behind imported numbers.
 * - `unavailable` — no value was given and the summary proposes none, which
 *   means nothing was staged. Publishing an empty run is refused rather than
 *   silently made a no-op, because the pointer would then name a run with no
 *   rows and the dashboard would read as empty for a customer who just imported.
 */
export function resolveCutoverDate(input: {
  readonly requested: unknown
  readonly proposed: string | null
  readonly firstEventAt: Date | null
}): CutoverValidation {
  const limit = maxCutoverDate(input.firstEventAt)

  // **An omitted value is clamped, never refused.**
  //
  // `too_late` is a statement about a field the client sent, and a client that
  // sent nothing cannot act on it — it would be told its request is invalid
  // because of a value it never chose. The proposal can legitimately sit past
  // the limit: it is computed at *staging* time, and a site whose first live
  // event arrives between staging and review moves the clamp underneath it.
  // Clamping is also what the customer means by "publish with the default": the
  // whole point of the default is the latest cutover that does not hide live
  // data, which is exactly `min(proposal, limit)`.
  if (input.requested === undefined || input.requested === null) {
    if (input.proposed === null) return { ok: false, code: 'unavailable' }
    const clamped = limit !== null && input.proposed > limit ? limit : input.proposed
    return { ok: true, cutoverDate: clamped }
  }

  // An explicit value is a choice, and a choice past the limit is refused rather
  // than quietly rewritten: silently publishing a different boundary from the one
  // the customer asked for is how a dashboard ends up disagreeing with the
  // request that produced it.
  if (!isCalendarDate(input.requested)) return { ok: false, code: 'invalid' }
  if (limit !== null && input.requested > limit) return { ok: false, code: 'too_late' }
  return { ok: true, cutoverDate: input.requested }
}
