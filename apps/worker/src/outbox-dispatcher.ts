import {
  REALTIME_ACCESS_REVOKED_TOPIC,
  parseSiteOwnershipChangedPayload,
} from '@openanalytics/domain'
import { EMAIL_OUTBOX_TOPIC } from '@openanalytics/integrations'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  ACCOUNT_DELETION_COMPLETED_TOPIC,
  SITE_DELETION_COMPLETED_TOPIC,
  SITE_OWNERSHIP_CHANGED_TOPIC,
  claimDueOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  readOutboxBacklog,
  type Database,
} from '@openanalytics/postgres'
import { REALTIME_SITE_EPOCH_SUBJECT, type RealtimeCache } from '@openanalytics/redis'
import { WORKER_METRICS } from './ingest/metrics.ts'

/**
 * The generic outbox dispatcher.
 *
 * Every outbox topic needs a consumer, and three did not have one:
 * `billing.subscription`, `site.ownership_changed` and `notification.rapid_burn`
 * were written in-transaction by producers that were correct, and then
 * accumulated as `pending` rows forever. An outbox nobody drains is not a
 * deferred side effect — it is a side effect that never happens, plus a table
 * that grows without bound and a `SKIP LOCKED` scan that gets slower every day.
 *
 * `email-drain.ts` and `realtime-revocation-drain.ts` each hand-rolled the same
 * claim/deliver/fail loop around one topic. This is that loop with the topic
 * lifted into a registry, so a new topic costs a handler rather than a file —
 * which is what M10 needs, since deletion fans out across several of them.
 *
 * The handlers registered here are deliberately minimal: they record that the
 * effect was observed and settle the row. That is not a placeholder for its own
 * sake — the *state changes* behind all three topics are already durable and
 * already audited at the point they were written (an entitlement change, an
 * ownership cutover, a burn threshold crossing), so what the outbox row buys is
 * fan-out: cache invalidation, notification, digest. M10 owns that fan-out. What
 * this stops today is the pile-up, and it means the fan-out arrives as a handler
 * body rather than as a new drain.
 *
 * Two drains are deliberately NOT folded in. `email.send` and
 * `realtime.access_revoked` carry transport dependencies (Resend, the realtime
 * cache) whose absence must not stop the others, and both are proven by their own
 * suites; merging them would be churn on working paths.
 */

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_LIMIT = 50

/**
 * The typed policy and brand values the handlers need. Never literals at the
 * enforcement point (AGENTS.md, G-005): they come from the worker's env.
 */
export interface OutboxPolicy {
  /** `PRODUCT_NAME` (D-005) — the brand a notification email renders. */
  readonly productName: string
  // The two suspension windows (`BILLING_BLOCK_INGEST_GRACE_HOURS`,
  // `BLOCKED_DATA_RETENTION_DAYS`) were here until the open-core split. They left
  // with the handler that stamped them: a deployment that does not bill never
  // suspends a site, so neither number is in its environment to thread through.
}

/** The epoch-bumping half of the realtime cache, as the handlers use it. */
export type RealtimeEpochBumper = Pick<RealtimeCache, 'bumpEpochAndPublishDisconnect'>

export interface OutboxHandlerContext {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly policy: OutboxPolicy
  /**
   * Present when `REALTIME_CACHE_REDIS_URL` is configured. Absent, the handlers
   * log and continue rather than failing the row: the middleware still refuses a
   * blocked site on every request and every new token mint, so the *authorization*
   * closure holds regardless — what is missed is the immediate stream cut, which
   * the next connect-time check makes up for. This is the ADR-0022 shape of
   * guarantee, and in production the cache is always configured.
   */
  readonly realtimeCache?: RealtimeEpochBumper | undefined
}

/**
 * Handle one row. Returning normally marks it delivered; throwing marks it
 * failed, which retries with backoff and dead-letters once the attempts are
 * spent (`markOutboxFailed`'s policy).
 */
export type OutboxHandler = (payload: unknown, context: OutboxHandlerContext) => Promise<void>

export interface OutboxTopicRegistration {
  readonly topic: string
  readonly handle: OutboxHandler
  /** Rows claimed per tick. Defaults to 50. */
  readonly limit?: number
}

export interface OutboxDrainResult {
  readonly claimed: number
  readonly delivered: number
  readonly failed: number
}

/**
 * Bump the site-level realtime epoch, cutting every open stream on the site
 * (ADR-0030, decision 5).
 *
 * Unconditional on the blocked branch, and that is the whole point: a retried
 * handler that finds the sites already blocked must still bump, because the
 * attempt that blocked them may have died between the commit and this call.
 * `INCR` is safe to repeat — a double bump only over-revokes, which closes
 * streams whose tokens are about to be refused at mint anyway.
 *
 * Throws on a cache error, so the row is failed and retried with backoff rather
 * than settled having done half its job.
 */
export async function bumpSiteEpoch(context: OutboxHandlerContext, siteId: string): Promise<void> {
  if (!context.realtimeCache) {
    context.logger.warn('realtime_site_epoch_bump_skipped', {
      site_id: siteId,
      reason: 'REALTIME_CACHE_REDIS_URL missing',
      retryable: false,
    })
    return
  }
  await context.realtimeCache.bumpEpochAndPublishDisconnect({
    siteId,
    subject: REALTIME_SITE_EPOCH_SUBJECT,
  })
}

/**
 * `site.ownership_changed` — a cutover that blocked the site closes its streams.
 *
 * The site row was already written by the cutover transaction, so there is
 * nothing to re-derive: what the row buys is the fan-out the transaction could
 * not safely do itself. Any other status settles as a no-op.
 */
const handleSiteOwnershipChanged: OutboxHandler = async (payload, context) => {
  const parsed = parseSiteOwnershipChangedPayload(payload)
  if (parsed.status !== 'suspended') return
  await bumpSiteEpoch(context, parsed.siteId)
  context.logger.info('lifecycle_ownership_block_bumped', { site_id: parsed.siteId })
}

/**
 * `site.deletion_completed` — observe-only, on purpose (ADR-0030, D4).
 *
 * The row is written in the same transaction as the tombstone, so by the time
 * this runs the deletion is already durable and already audited. What the topic
 * exists for is the *notification* the email milestone will send ("your site and
 * its data have been erased"), and that is M11+ work. The registration exists
 * from CP3 for the reason the dispatcher's header gives: a topic nobody consumes
 * is not a deferred side effect, it is a table that grows forever and a
 * `SKIP LOCKED` scan that gets slower every day.
 *
 * It logs and settles. It deliberately does not re-check anything: re-reading
 * the site to confirm it is `deleted` would make a settled row depend on a state
 * the row itself is the record of.
 */
const handleSiteDeletionCompleted: OutboxHandler = async (payload, context) => {
  const record = (payload ?? {}) as Record<string, unknown>
  const siteId = typeof record['site_id'] === 'string' ? record['site_id'] : null
  context.logger.info('site_deletion_completed_observed', {
    site_id: siteId,
    deletion_request_id:
      typeof record['deletion_request_id'] === 'string' ? record['deletion_request_id'] : null,
  })
  await Promise.resolve()
}

/**
 * `account.deletion_completed` — observe-only, for the same reason its sibling
 * above is (ADR-0030, D8).
 *
 * The row is written in the same transaction that completes the request, so by
 * the time this runs the erasure is durable and audited. What the topic is *for*
 * is the mail telling the person their account and data are gone, and that is
 * the email milestone's. The registration exists from CP4 because a topic nobody
 * consumes is not a deferred side effect — it is a table that grows forever and
 * a `SKIP LOCKED` scan that gets slower every day.
 *
 * It deliberately logs the user id and nothing else. By the time the row is
 * delivered the account is a tombstone with no address to name, and re-reading
 * it to say more would make a settled row depend on state the row is the record
 * of.
 */
const handleAccountDeletionCompleted: OutboxHandler = async (payload, context) => {
  const record = (payload ?? {}) as Record<string, unknown>
  context.logger.info('account_deletion_completed_observed', {
    user_id: typeof record['user_id'] === 'string' ? record['user_id'] : null,
    deletion_request_id:
      typeof record['deletion_request_id'] === 'string' ? record['deletion_request_id'] : null,
  })
  await Promise.resolve()
}

/**
 * Topics this dispatcher does NOT drain, but does zero-fill.
 *
 * `email.send` and `realtime.access_revoked` have their own loops for the reason
 * the header gives — transport dependencies whose absence must not stop the
 * others — and neither loop publishes a gauge. The backlog read below is a
 * `GROUP BY` over the whole table, so a row on one of these topics *does*
 * produce a sample; what was missing is the sample in the healthy case. The
 * series therefore existed only while something was wrong, which is precisely
 * the state an absent series cannot be told apart from: a drain that stopped
 * running, or one that was never deployed, reads exactly like a drained queue.
 *
 * Found in M18 against the `email.send` dead-letter alert, whose `noDataState`
 * had to be `OK` to avoid firing on healthy silence — which is the same as
 * saying the alert could not distinguish health from blindness. With the topic
 * zero-filled the rule can key on a real zero instead.
 *
 * Zero-filling is not draining: the rows are still delivered by their own loops.
 * A topic named here that gains a registration above keeps working — the two
 * lists are unioned, not concatenated.
 *
 * `telegram.send` joined in M18 with the same justification as its siblings: its
 * drain carries a transport dependency (the Bot API) and publishes no gauge of
 * its own. It is registered by the surface that produces it rather than named
 * here, for the reason its drain moved: a build with no operator chat has no such
 * row to zero-fill.
 */
const observedOnly: string[] = [EMAIL_OUTBOX_TOPIC, REALTIME_ACCESS_REVOKED_TOPIC]

/**
 * Live lists rather than frozen ones, because a registered surface produces
 * topics of both kinds: `telegram.send` has its own drain and belongs in the
 * zero-filled list, while `billing.subscription` and `notification.rapid_burn`
 * are handled here. Both were declared inline until the open-core split.
 */
export const OBSERVED_ONLY_OUTBOX_TOPICS: readonly string[] = observedOnly

const topics: OutboxTopicRegistration[] = [
  { topic: SITE_OWNERSHIP_CHANGED_TOPIC, handle: handleSiteOwnershipChanged },
  { topic: SITE_DELETION_COMPLETED_TOPIC, handle: handleSiteDeletionCompleted },
  { topic: ACCOUNT_DELETION_COMPLETED_TOPIC, handle: handleAccountDeletionCompleted },
]

export const DEFAULT_OUTBOX_TOPICS: readonly OutboxTopicRegistration[] = topics

/**
 * Declares the topics a registered surface drains here. Idempotent by topic; a
 * second handler for one topic is refused rather than appended, because which of
 * the two settled a row would otherwise depend on import order.
 */
export function registerOutboxTopics(registrations: readonly OutboxTopicRegistration[]): void {
  for (const registration of registrations) {
    const existing = topics.find((candidate) => candidate.topic === registration.topic)
    if (existing === registration) continue
    if (existing) throw new Error(`an outbox handler for "${registration.topic}" exists`)
    topics.push(registration)
  }
}

/** Declares a topic that is drained elsewhere but must still be zero-filled, so
 * its gauge reads `0` rather than going absent (the reason the list exists). */
export function registerObservedOnlyOutboxTopics(names: readonly string[]): void {
  for (const name of names) {
    if (!observedOnly.includes(name)) observedOnly.push(name)
  }
}

export interface OutboxDispatcherDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly policy: OutboxPolicy
  readonly realtimeCache?: RealtimeEpochBumper | undefined
  readonly topics?: readonly OutboxTopicRegistration[]
  readonly intervalMs?: number
}

/**
 * Drain one topic once.
 *
 * A handler that throws fails *that row* and the loop continues: one malformed
 * payload must not stop the topic, which is the same rule the two hand-rolled
 * drains follow.
 */
export async function drainOutboxTopic(
  deps: Pick<OutboxDispatcherDeps, 'db' | 'logger' | 'metrics' | 'policy' | 'realtimeCache'>,
  registration: OutboxTopicRegistration,
): Promise<OutboxDrainResult> {
  const rows = await claimDueOutbox(deps.db, {
    topic: registration.topic,
    limit: registration.limit ?? DEFAULT_LIMIT,
  })

  let delivered = 0
  let failed = 0

  for (const row of rows) {
    try {
      await registration.handle(row.payload, {
        db: deps.db,
        logger: deps.logger,
        metrics: deps.metrics,
        policy: deps.policy,
        realtimeCache: deps.realtimeCache,
      })
      await markOutboxDelivered(deps.db, row.id)
      delivered += 1
      deps.metrics.increment(WORKER_METRICS.outboxDelivered, { topic: registration.topic })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'handler_failed'
      deps.logger.warn('outbox_delivery_failed', {
        outbox_id: row.id,
        topic: registration.topic,
        reason,
        retryable: true,
      })
      await markOutboxFailed(deps.db, row.id, reason)
      failed += 1
      deps.metrics.increment(WORKER_METRICS.outboxFailed, { topic: registration.topic })
    }
  }

  return { claimed: rows.length, delivered, failed }
}

/**
 * Publish the backlog as gauges, for every topic — including the two this
 * dispatcher does not own.
 *
 * The backlog is the only signal that distinguishes "no rows to deliver" from
 * "nothing is draining this topic at all", and the second is exactly the failure
 * that went unnoticed until the pre-M10 audit. Published even when zero, for the
 * reason the reconciliation gauge is: a series that appears only when something
 * is wrong cannot be told apart from a job that stopped running.
 */
export async function publishOutboxBacklog(
  deps: Pick<OutboxDispatcherDeps, 'db' | 'metrics'>,
  topics: readonly string[],
): Promise<void> {
  const backlog = await readOutboxBacklog(deps.db)
  const seen = new Set<string>()

  for (const row of backlog) {
    seen.add(`${row.topic}:${row.status}`)
    deps.metrics.gauge(WORKER_METRICS.outboxBacklog, row.count, {
      topic: row.topic,
      status: row.status,
    })
    deps.metrics.gauge(WORKER_METRICS.outboxOldestAgeMs, row.oldestAgeMs, {
      topic: row.topic,
      status: row.status,
    })
  }

  // A topic that has just been fully drained stops appearing in the GROUP BY.
  // Left alone, its last non-zero gauge would be the newest value the backend
  // ever saw, and the alert would stay lit on a queue that is empty.
  //
  // The union with `OBSERVED_ONLY_OUTBOX_TOPICS` is applied here rather than at
  // the call site so no caller can produce a backlog reading that is missing
  // them — the docstring above has claimed "every topic, including the two this
  // dispatcher does not own" since M10, and until M18 only the call site's list
  // was actually zero-filled.
  for (const topic of new Set([...topics, ...OBSERVED_ONLY_OUTBOX_TOPICS])) {
    for (const status of ['pending', 'processing', 'dead'] as const) {
      if (seen.has(`${topic}:${status}`)) continue
      deps.metrics.gauge(WORKER_METRICS.outboxBacklog, 0, { topic, status })
      deps.metrics.gauge(WORKER_METRICS.outboxOldestAgeMs, 0, { topic, status })
    }
  }
}

export interface OutboxDispatcher {
  stop(): Promise<void>
}

export function startOutboxDispatcher(deps: OutboxDispatcherDeps): OutboxDispatcher {
  const topics = deps.topics ?? DEFAULT_OUTBOX_TOPICS
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      for (const registration of topics) {
        const result = await drainOutboxTopic(deps, registration)
        if (result.claimed > 0) {
          deps.logger.info('outbox_drained', { topic: registration.topic, ...result })
        }
      }
      await publishOutboxBacklog(
        deps,
        topics.map((registration) => registration.topic),
      )
    } catch (err) {
      deps.logger.error('outbox_dispatch_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  // The dispatcher must not by itself keep the process alive.
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
