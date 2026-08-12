import type { PersistedEvent } from '@openanalytics/contracts'
import { markSitesFirstEvent, type SiteFirstEventCandidate } from '@openanalytics/postgres'
import type { IngestDeps } from './deps.ts'
import { WORKER_METRICS } from './metrics.ts'

/**
 * The install-verified signal (ADR-0027): `sites.first_event_at`, filled once
 * per site ever from the batch that carried its first event.
 *
 * Onboarding asks "is data flowing yet". Nothing in the system answered it: an
 * analytics query returning no rows means "not installed", "installed but nobody
 * has visited" and "installed, wrong interval" alike, and it costs a ClickHouse
 * read per poll to stay ambiguous. One instant on the site row answers it
 * exactly — NULL until an event has landed, an instant afterwards.
 *
 * It is filled *here*, in the worker's batch flow, and not on the collector's
 * hot path. The collector sees every event of every site forever; a write there
 * would tax every event a customer ever sends to learn something that stops
 * being interesting after the first one. The worker already holds the batch's
 * events, already opens a Postgres transaction per batch for the usage ledger,
 * and already knows which sites the batch touched — so the fill costs at most
 * one extra statement per batch, and after the sites in it are known-filled it
 * costs nothing at all.
 */

/** The slice of `IngestDeps` this needs; `IngestDeps` satisfies it structurally. */
export type FirstEventFillDeps = Pick<IngestDeps, 'db' | 'logger' | 'metrics'>

export interface FirstEventFill {
  /**
   * Fill the signal for any site in `events` not already known to have one.
   * Resolves to the number of sites filled by this call. Never rejects.
   */
  record(deps: FirstEventFillDeps, events: readonly PersistedEvent[]): Promise<number>
  /** Sites this process has already seen filled. Exposed for assertions. */
  readonly knownFilled: ReadonlySet<string>
}

/**
 * Earliest `occurred_at` per site in a batch, skipping sites already known
 * filled.
 *
 * One pass over events the pipeline is already holding — no re-parse, no second
 * fetch. The same shape as `fenceRegistrationsFor` and `rapidBurnCandidatesFor`
 * beside it, for the same reason: a per-site fact a batch-level write needs is
 * folded out of the rows once.
 *
 * `occurred_at`, not `accepted_at` or the worker's clock: the question is when
 * the visit happened, and it is the one instant of the three that a customer
 * comparing this against their own logs would recognise. It is client-supplied
 * and therefore already clamped by the collector's skew rules (ADR-0008), so it
 * cannot be arbitrarily far from real time.
 */
export function firstEventCandidatesFor(
  events: readonly PersistedEvent[],
  knownFilled: ReadonlySet<string>,
): SiteFirstEventCandidate[] {
  const earliest = new Map<string, number>()

  for (const event of events) {
    if (knownFilled.has(event.site_id)) continue
    const occurredAt = new Date(event.occurred_at).getTime()
    if (Number.isNaN(occurredAt)) continue
    const current = earliest.get(event.site_id)
    if (current === undefined || occurredAt < current) earliest.set(event.site_id, occurredAt)
  }

  return [...earliest].map(([siteId, occurredAt]) => ({ siteId, occurredAt: new Date(occurredAt) }))
}

/**
 * Create the per-process fill, with its already-filled cache.
 *
 * **The cache is an optimization and nothing else.** Correctness lives entirely
 * in the statement's `WHERE first_event_at IS NULL` guard, which holds across
 * processes, restarts, concurrent workers and retried batches — none of which a
 * `Set` in one process's heap can see. What the cache buys is the steady state:
 * a site whose signal is known set contributes no candidate, so a busy site's
 * millionth batch issues zero extra queries rather than one no-op UPDATE. A cold
 * process simply pays one no-op UPDATE per batch until it has learned, which is
 * why losing the cache is a cost and never a bug.
 *
 * A site is added to it only after a statement that *committed*, and every site
 * in that statement is added — not just the ids it returned. After the UPDATE
 * commits, every candidate row that exists has a non-NULL `first_event_at`,
 * whether this call set it or found it already set; a candidate that no longer
 * exists is a deleted site whose events the fence will drop from here on.
 *
 * Growth is bounded by the number of distinct sites this process ever ingests
 * for, at ~36 bytes each. If that ever mattered, the cache could be dropped
 * outright and only the query count would change.
 */
export function createFirstEventFill(): FirstEventFill {
  const knownFilled = new Set<string>()

  return {
    knownFilled,

    async record(deps: FirstEventFillDeps, events: readonly PersistedEvent[]): Promise<number> {
      const candidates = firstEventCandidatesFor(events, knownFilled)
      if (candidates.length === 0) return 0

      try {
        const filled = await markSitesFirstEvent(deps.db, candidates)

        for (const candidate of candidates) knownFilled.add(candidate.siteId)

        if (filled.length > 0) {
          deps.metrics.increment(WORKER_METRICS.siteFirstEvent, {}, filled.length)
          for (const siteId of filled) {
            // Once per site in the lifetime of the deployment, so it is an
            // `info` rather than a metric-only event: "this customer's tracker
            // started working" is a thing an operator wants to be able to find.
            deps.logger.info('site_first_event_recorded', { site_id: siteId })
          }
        }

        return filled.length
      } catch (err) {
        // Warn and continue, exactly like the queue-age gauge and the pipeline
        // heartbeat (ADR-0025). The batch's rows are already durable in
        // ClickHouse at this point; failing it over an onboarding hint would
        // re-run an insert and delay real data to fix a checkmark. The cache is
        // deliberately not updated, so the next batch for these sites tries
        // again — the signal is late rather than lost.
        deps.logger.warn('site_first_event_unwritten', {
          err,
          site_count: candidates.length,
          retryable: true,
        })
        return 0
      }
    },
  }
}
