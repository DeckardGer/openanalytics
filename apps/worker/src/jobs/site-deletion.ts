import {
  DELETION_REDIS_TARGETS,
  SITE_DELETION_PHASES,
  isSiteDeletionPhase,
  type SiteDeletionPhase,
} from '@openanalytics/domain'
import {
  SITE_DELETION_JOB_TYPE,
  claimFinalizerSite,
  countInFlightWriters,
  finalizeSiteDeletion,
  listDeletionTargets,
  listSiteMemberUserIds,
  markDeletionRequestRunning,
  markSiteDeletionFailed,
  purgeSitePostgres,
  readSiteDeletionContext,
  updateDeletionTarget,
  type DeletionTargetRow,
  type PurgeSitePostgresResult,
} from '@openanalytics/postgres'
import {
  EVENT_STREAM_KEY,
  REALTIME_SITE_EPOCH_SUBJECT,
  dailyBillableKey,
  dailyCeilingKey,
  decodeSiteQueueIndexEntry,
  dedupKey,
  realtimeEpochKey,
  realtimeFeedKey,
  siteQueueIndexKey,
  utcDayOffset,
  visitorMetaKey,
  visitorPagesKey,
  visitorPresenceKey,
} from '@openanalytics/redis'
import { WORKER_METRICS } from '../ingest/metrics.ts'
import type { DeletionPolicy, RedisPurgeClient } from './resources.ts'
import type { JobExecutor, JobExecutorContext, JobOutcome, JobRegistration } from './runner.ts'

/**
 * The fenced site-deletion executor (ADR-0030, decision 4).
 *
 * Seven phases, run in order, each of them idempotent and each of them resumable
 * from the durable state two tables hold: `jobs.phase` says which phase to enter
 * and `deletion_targets` says what is already done inside it. A worker that dies
 * mid-purge is recovered by another worker stealing the expired lease and
 * re-entering the same phase, which finds the completed targets and skips them.
 *
 * The phase order is the correctness argument, not a pipeline convenience:
 *
 * - `fence_drain` is first because nothing may be purged while a collector
 *   request can still admit an event for the site. Two things have to become
 *   true: the config cache TTL plus a margin must have elapsed since the start
 *   transaction (so no request can still be holding a snapshot that says
 *   "active"), and every `ingest_batch_sites` registration at a superseded
 *   generation must have settled (so no worker is mid-insert).
 * - `finalizer_fence` is second because the session finalizer is the one
 *   subsystem that writes ClickHouse *without* passing the ingest fence. A run
 *   that claimed the site before deletion started would happily insert fact and
 *   rollup rows after a verified purge. Taking and holding its lease is what
 *   closes that window; the driver-side status filter (decision 7) cannot,
 *   because a run already in flight outlives any filter.
 * - `redis_purge` precedes `postgres_purge` because the realtime epoch keys are
 *   enumerated from the `site_members` rows the Postgres purge deletes. Reversed,
 *   one epoch key per ex-member would be left behind with no way to find it
 *   short of a keyspace `SCAN`.
 * - `object_purge` works a key list the *start transaction* snapshotted, so it
 *   only has to precede `postgres_purge` — the rows those keys were read from
 *   are what that phase deletes. It sits early because it is quick and certain,
 *   and a deletion that stalls in the ClickHouse mutations should stall with the
 *   customer's uploaded archives already gone (ADR-0032, D9).
 * - `verify_finalize` is last and re-reads every target rather than trusting the
 *   phases that ran: the tombstone is a statement to the customer that their
 *   data is gone, and it is made only against observed verification.
 *
 * **Waiting is not failing.** Every "not yet" is a returned `retry`, which the
 * runner records without counting an attempt (`failJobRetryable(resetAttempts)`).
 * Only an unexpected error throws, and those attempts are what `JOB_MAX_ATTEMPTS`
 * bounds. A deletion may therefore wait days on a drain and still have its full
 * retry budget for the ClickHouse mutation that follows.
 */

/** How long to wait between polls of a condition that changes on its own. */
const DRAIN_RETRY_MS = 5_000
/** Longer, for a missing resource: a redeploy is the thing being waited on. */
const RESOURCE_RETRY_MS = 30_000
/** ClickHouse mutations rewrite parts; polling faster only adds load. */
const MUTATION_POLL_MS = 10_000
/** Keys removed per round trip. Bounded so one site cannot build a multi-megabyte
 * command, and large enough that a busy site is a handful of calls. */
const REDIS_CHUNK = 500
/** Keys per `DeleteObjects` call. The S3 API caps a batch delete at 1,000; half
 * of that keeps the request small and is far above any realistic site's key
 * count (one archive per import run). */
const OBJECT_CHUNK = 500

interface PhaseContext {
  readonly job: JobExecutorContext
  readonly deletionRequestId: string
  readonly siteId: string
  readonly ingestGeneration: number
  readonly requestedAt: Date
  readonly policy: DeletionPolicy
  readonly now: Date
}

type PhaseOutcome = 'advance' | { readonly retry: { readonly delayMs: number } }

const executeSiteDeletion: JobExecutor = async (context) => {
  const payload = context.job.payload
  const deletionRequestId = payload['deletion_request_id']
  if (typeof deletionRequestId !== 'string' || deletionRequestId.length === 0) {
    // A job with no request to work is not retryable by waiting: nothing will
    // ever add the field. Terminal with a reason, which is the only honest
    // settlement — and it is loud, because it means a producer wrote a bad row.
    return { terminal: { reason: 'site_deletion payload has no deletion_request_id' } }
  }

  const state = await readSiteDeletionContext(context.db, deletionRequestId)
  if (!state) {
    return { terminal: { reason: `deletion request ${deletionRequestId} has no site` } }
  }
  if (state.requestStatus === 'completed') {
    // The tombstone is already written — a lease that was stolen after the final
    // transaction committed, or a replayed job. Succeeding is correct and is what
    // makes the whole executor safe to re-run.
    return 'succeeded'
  }

  const policy = context.resources?.deletionPolicy
  if (!policy) {
    context.logger.error('site_deletion_policy_missing', {
      job_id: context.job.id,
      site_id: state.siteId,
      retryable: true,
    })
    return { retry: { delayMs: RESOURCE_RETRY_MS } }
  }

  const phaseContext: PhaseContext = {
    job: context,
    deletionRequestId,
    siteId: state.siteId,
    ingestGeneration: state.ingestGeneration,
    requestedAt: state.requestedAt,
    policy,
    now: new Date(),
  }

  // Resume at the recorded phase; an absent or unrecognised value starts at the
  // beginning, which is safe because every phase is idempotent.
  const startIndex = isSiteDeletionPhase(context.job.phase)
    ? SITE_DELETION_PHASES.indexOf(context.job.phase)
    : 0

  for (let index = startIndex; index < SITE_DELETION_PHASES.length; index += 1) {
    const phase = SITE_DELETION_PHASES[index] as SiteDeletionPhase

    // Two things at once: the phase marker is durable before the phase runs (so
    // a crash resumes here rather than one phase back), and the write is
    // lease-guarded, so a worker whose lease was stolen learns it before doing
    // any store work.
    if (!(await context.updatePhase(phase))) return lost(context, phase)
    context.metrics.increment(WORKER_METRICS.deletionPhase, { phase })

    const outcome = await runPhase(phase, phaseContext)
    if (outcome !== 'advance') return outcome

    // Long phases outrun the lease; re-extend between them so the next one
    // starts with a full TTL rather than the remainder of the claim's.
    if (!(await context.extendLease())) return lost(context, phase)
  }

  return 'succeeded'
}

/**
 * A stolen lease is not an error and not a retry the executor chose.
 *
 * Returning a retry makes the runner's guarded `failJobRetryable` refuse the
 * write — the row belongs to the new holder — and the runner records the job as
 * `lost`, which is the settlement that describes what happened. Throwing would
 * count a failed attempt against a job that did nothing wrong.
 */
function lost(context: JobExecutorContext, phase: string): JobOutcome {
  context.logger.warn('site_deletion_lease_lost', {
    job_id: context.job.id,
    site_id: context.job.subjectId,
    phase,
    retryable: true,
  })
  return { retry: { delayMs: DRAIN_RETRY_MS } }
}

async function runPhase(phase: SiteDeletionPhase, context: PhaseContext): Promise<PhaseOutcome> {
  switch (phase) {
    case 'fence_drain':
      return await fenceDrain(context)
    case 'finalizer_fence':
      return await finalizerFence(context)
    case 'redis_purge':
      return await redisPurge(context)
    case 'object_purge':
      return await objectPurge(context)
    case 'clickhouse_purge':
      return await clickhousePurge(context)
    case 'postgres_purge':
      return await postgresPurge(context)
    case 'verify_finalize':
      return await verifyFinalize(context)
  }
}

/**
 * Wait until acceptance has provably stopped (ADR-0030, D4 `fence_drain`).
 *
 * Two independent conditions, both necessary:
 *
 * 1. **The clock.** `INGEST_CONFIG_CACHE_TTL_SECONDS` after the start
 *    transaction, no collector can still be holding a cached config that says
 *    the site is active — plus `DELETION_ACCEPTANCE_MARGIN_MS`, which covers the
 *    request that read its config one microsecond before expiry and runs its
 *    enqueue script a whole request later, and the skew between the Postgres
 *    instant `requested_at` carries and this worker's clock.
 * 2. **The fence ledger.** Every `ingest_batch_sites` row for the site at a
 *    *lower* generation must have left `registered`. Those are workers that
 *    passed the fence before the bump; until they settle, one of them may still
 *    be inserting into ClickHouse.
 *
 * The ADR-0022 acceptance criterion is asserted around this phase in its
 * measurable form: after the bump, `worker_fence_dropped{reason='site_deleting'}`
 * for the site may appear and must cease within roughly the TTL. That metric is
 * emitted by the fence itself (`registerBatchSites`' drop path), so there is
 * nothing to increment here — the assertion is an observation of an existing
 * series, which is exactly why it is a criterion and not a new counter.
 */
async function fenceDrain(context: PhaseContext): Promise<PhaseOutcome> {
  const acceptanceClosedAt =
    context.requestedAt.getTime() +
    context.policy.ingestConfigCacheTtlSeconds * 1_000 +
    context.policy.deletionAcceptanceMarginMs

  if (context.now.getTime() < acceptanceClosedAt) {
    return { retry: { delayMs: DRAIN_RETRY_MS } }
  }

  const inFlight = await countInFlightWriters(context.job.db, {
    siteId: context.siteId,
    currentGeneration: context.ingestGeneration,
  })
  if (inFlight > 0) {
    context.job.logger.info('site_deletion_draining', {
      job_id: context.job.job.id,
      site_id: context.siteId,
      in_flight_writers: inFlight,
    })
    return { retry: { delayMs: DRAIN_RETRY_MS } }
  }

  // The first phase that proves work has begun; the request leaves `pending`.
  await markDeletionRequestRunning(context.job.db, context.deletionRequestId)
  return 'advance'
}

/** The identity the deletion job holds the finalizer lease under. Job-scoped, so
 * an operator reading `session_finalizer_state.claimed_by` sees which job holds
 * it and a second worker's steal is visible as a different name. */
function finalizerHolder(context: PhaseContext): string {
  return `deletion:${context.job.job.id}`
}

/**
 * Take the site's finalizer lease and keep it (ADR-0030, D4 `finalizer_fence`).
 *
 * `claimFinalizerSite` is a conditional upsert: it succeeds when the row is
 * unclaimed, already ours, or holds an expired lease, and returns null when a
 * live finalizer run holds it. Null is a wait, not a failure — the run finishes
 * or its lease expires, and the next poll takes it.
 *
 * The lease is re-taken at the top of every later purge phase rather than
 * refreshed on a timer. Re-claiming is idempotent for the current holder (the
 * `claimed_by = ours` branch of the predicate), it costs one statement per
 * phase, and it needs no background timer that could outlive the job. What it
 * buys is that a phase which outran `WORKER_LEASE_TTL_MS` and lost the lease to
 * a real finalizer run cannot silently continue purging.
 */
async function finalizerFence(context: PhaseContext): Promise<PhaseOutcome> {
  const claim = await claimFinalizerSite(context.job.db, {
    siteId: context.siteId,
    claimedBy: finalizerHolder(context),
    leaseTtlMs: context.policy.leaseTtlMs,
  })
  if (!claim) {
    context.job.logger.info('site_deletion_finalizer_busy', {
      job_id: context.job.job.id,
      site_id: context.siteId,
    })
    return { retry: { delayMs: DRAIN_RETRY_MS } }
  }
  return 'advance'
}

/** Re-take the finalizer lease at the top of a purge phase; see `finalizerFence`. */
async function holdFinalizerLease(context: PhaseContext): Promise<boolean> {
  const claim = await claimFinalizerSite(context.job.db, {
    siteId: context.siteId,
    claimedBy: finalizerHolder(context),
    leaseTtlMs: context.policy.leaseTtlMs,
  })
  return claim !== null
}

function targetsByName(rows: readonly DeletionTargetRow[]): Map<string, DeletionTargetRow> {
  return new Map(rows.map((row) => [row.target, row]))
}

/**
 * Run one store call, recording a throw on the target before rethrowing it.
 *
 * Without this a Redis instance that refuses a command, or a ClickHouse client
 * that cannot reach the server, leaves the target `running` with a NULL
 * `last_error` — the one state `deletion_targets` is supposed to make
 * self-explanatory, since the table exists precisely so an operator can see why a
 * purge is stuck without correlating logs. The rethrow is deliberate: an
 * unexpected store error *is* a failed attempt (unlike a "not yet", which is a
 * returned retry), and the runner counting it against `JOB_MAX_ATTEMPTS` is the
 * bound that keeps a genuinely impossible job from spinning forever.
 */
async function withTargetFailure<T>(
  context: PhaseContext,
  target: DeletionTargetRow,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    await updateDeletionTarget(context.job.db, {
      targetId: target.id,
      lastError: errorMessage(err),
    })
    context.job.metrics.increment(WORKER_METRICS.deletionTargetFailed, { store: target.store })
    throw err
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function completeTarget(
  context: PhaseContext,
  target: DeletionTargetRow,
  verification: Record<string, unknown>,
): Promise<void> {
  await updateDeletionTarget(context.job.db, {
    targetId: target.id,
    phase: 'completed',
    verified: true,
    verification,
    lastError: null,
    countAttempt: true,
  })
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

async function deleteKeys(client: RedisPurgeClient, keys: readonly string[]): Promise<number> {
  let removed = 0
  for (const batch of chunk(keys, REDIS_CHUNK)) {
    removed += await client.del(...batch)
  }
  return removed
}

/**
 * Remove every Redis key the site owns (ADR-0030, D4 `redis_purge`).
 *
 * The rule the whole phase obeys: **no `SCAN`, anywhere.** Both instances are
 * shared by every site, and a keyspace scan to delete one customer's data would
 * be an O(all customers) operation whose cost grows with the business and whose
 * blast radius is a pattern match. Every family below is enumerated from an
 * index that already exists for another reason — the day buckets (D-209), the
 * presence ZSET, the membership table — which is precisely why those indexes
 * were built.
 *
 * Deliberately left behind: `rl_*` (rate-limit windows, ≤2 min) and `sec_bot`
 * (bot counters, ≤2 days). They carry no visitor data, they are counters rather
 * than records, and they expire on their own well inside the window an operator
 * could observe them in. Chasing them would need the scan this phase refuses.
 */
async function redisPurge(context: PhaseContext): Promise<PhaseOutcome> {
  const queue = context.job.resources?.queue
  const realtime = context.job.resources?.realtime
  if (!queue || !realtime) {
    context.job.logger.error('site_deletion_redis_unavailable', {
      job_id: context.job.job.id,
      site_id: context.siteId,
      queue_configured: queue !== undefined,
      realtime_configured: realtime !== undefined,
      retryable: true,
    })
    context.job.metrics.increment(WORKER_METRICS.deletionTargetFailed, { store: 'redis' })
    return { retry: { delayMs: RESOURCE_RETRY_MS } }
  }

  const rows = await listDeletionTargets(context.job.db, {
    deletionRequestId: context.deletionRequestId,
    store: 'redis',
  })
  const byName = targetsByName(rows)

  for (const name of DELETION_REDIS_TARGETS) {
    const target = byName.get(name)
    // A snapshot that predates a new target name simply has no row for it. That
    // is the snapshot doing its job (the deletion purges what it promised), and
    // it is not an error.
    if (!target || target.phase === 'completed') continue

    await updateDeletionTarget(context.job.db, { targetId: target.id, phase: 'running' })

    const verification = await withTargetFailure(
      context,
      target,
      async () => await purgeRedisTarget(name, context, queue, realtime),
    )
    await completeTarget(context, target, verification)
    if (!(await context.job.extendLease())) return { retry: { delayMs: DRAIN_RETRY_MS } }
  }

  return 'advance'
}

async function purgeRedisTarget(
  name: (typeof DELETION_REDIS_TARGETS)[number],
  context: PhaseContext,
  queue: RedisPurgeClient,
  realtime: RedisPurgeClient,
): Promise<Record<string, unknown>> {
  const siteId = context.siteId

  switch (name) {
    case 'queue_index': {
      // `SITE_QUEUE_INDEX_TTL_DAYS + 1` days, today inclusive. The extra day is
      // not padding: the bucket's TTL is refreshed on every append, so a bucket
      // whose last write was yesterday can still be alive a full day past what
      // its nominal TTL suggests (ADR-0030, D4).
      const days = context.policy.siteQueueIndexTtlDays + 1
      let buckets = 0
      let streamEntries = 0
      let dedupRecords = 0

      for (let offset = 0; offset < days; offset += 1) {
        const bucket = siteQueueIndexKey(siteId, utcDayOffset(context.now, offset))
        let hadEntries = false

        // Paged, not `lrange(bucket, 0, -1)`. A busy site's day bucket holds one
        // entry per accepted event — millions of them at the ceiling — and
        // reading it whole would materialise the entire list in the worker's heap
        // and in one Redis reply buffer, on the *deletion* path, where the site
        // being purged is by definition one whose traffic nobody is managing any
        // more. `REDIS_CHUNK` bounds the reply the same way it already bounds the
        // `XDEL` and `DEL` commands below.
        for (let start = 0; ; start += REDIS_CHUNK) {
          const entries = await queue.lrange(bucket, start, start + REDIS_CHUNK - 1)
          if (entries.length === 0) break
          hadEntries = true

          const streamIds: string[] = []
          const dedupKeys: string[] = []
          for (const entry of entries) {
            // Every entry now names both ids. The ADR-0021 legacy id-only form
            // was removed on 2026-08-06 under ADR-0030 follow-up 2, after the
            // production buckets were confirmed drained of it; an entry that
            // still lacks the separator throws, which `withTargetFailure`
            // records on the target rather than letting the purge claim a
            // bucket it could not read.
            const decoded = decodeSiteQueueIndexEntry(entry)
            streamIds.push(decoded.streamId)
            dedupKeys.push(dedupKey(siteId, decoded.eventId))
          }

          for (const batch of chunk(streamIds, REDIS_CHUNK)) {
            streamEntries += await queue.xdel(EVENT_STREAM_KEY, ...batch)
          }
          dedupRecords += await deleteKeys(queue, dedupKeys)

          // A short page is the end of the list; a full one may not be, so the
          // walk continues. The bucket is only ever appended to (by a collector
          // the fence has already stopped for this site), so paging forward
          // cannot skip an entry.
          if (entries.length < REDIS_CHUNK) break
        }

        if (hadEntries) buckets += 1
        // Unconditionally: a `DEL` on a missing key is free, and a bucket that
        // exists but reads empty is a state nothing else would clean up. It is
        // also what makes the paged walk safe to end on a short page — whatever
        // the walk did not name, the `DEL` removes.
        await queue.del(bucket)
      }

      return {
        days_walked: days,
        buckets_with_entries: buckets,
        stream_entries_deleted: streamEntries,
        dedup_records_deleted: dedupRecords,
      }
    }

    case 'realtime_presence': {
      // The ZSET's members *are* the per-visitor key list; there is no other way
      // to know which visitor ids a site has had, and no scan is needed.
      const presence = visitorPresenceKey(siteId)
      const visitors = await realtime.zrange(presence, 0, -1)
      const keys = visitors.flatMap((visitorId) => [
        visitorMetaKey(siteId, visitorId),
        visitorPagesKey(siteId, visitorId),
      ])
      const removed = await deleteKeys(realtime, keys)
      await realtime.del(presence)
      return { visitors: visitors.length, visitor_keys_deleted: removed }
    }

    case 'realtime_feed': {
      const removed = await realtime.del(realtimeFeedKey(siteId))
      return { feeds_deleted: removed }
    }

    case 'realtime_epochs': {
      // Read from Postgres *now*, before `postgres_purge` deletes the rows. This
      // ordering is the only reason the epoch keys are addressable at all.
      const members = await listSiteMemberUserIds(context.job.db, siteId)
      // `public` is the share-link subject and `site` is the reserved
      // site-level subject decision 5 added; neither is a member, and both have
      // keys whenever a token was ever minted.
      const subjects = [...new Set([...members, 'public', REALTIME_SITE_EPOCH_SUBJECT])]
      const removed = await deleteKeys(
        realtime,
        subjects.map((subject) => realtimeEpochKey(siteId, subject)),
      )
      return { subjects: subjects.length, epoch_keys_deleted: removed }
    }

    case 'day_counters': {
      // Bounded by the longest-lived of the two families: the accepted-event
      // counter is the ceiling alert's streak memory and outlives its own day by
      // `SITE_CEILING_ALERT_CONSECUTIVE_DAYS` (+1 for the day in progress). Two
      // more days of slack cover the write that lands just before midnight.
      const days = context.policy.ceilingAlertConsecutiveDays + 3
      const keys: string[] = []
      for (let offset = 0; offset < days; offset += 1) {
        const day = utcDayOffset(context.now, offset)
        keys.push(dailyCeilingKey(siteId, day), dailyBillableKey(siteId, day))
      }
      const removed = await deleteKeys(realtime, keys)
      return { days_walked: days, counters_deleted: removed }
    }
  }
}

/**
 * Read the key list the start transaction snapshotted onto the object target.
 *
 * Anything that is not an array of strings reads as "no keys", which is the
 * conservative answer: a snapshot written by a build that predates this phase
 * carries no `keys` at all, and treating that as an error would strand every
 * in-flight deletion started before the deploy.
 */
function snapshottedKeys(target: DeletionTargetRow): string[] {
  const raw = target.verification?.['keys']
  if (!Array.isArray(raw)) return []
  return raw.filter((key): key is string => typeof key === 'string' && key.length > 0)
}

/**
 * Delete the site's objects and prove they are gone (ADR-0032, D9).
 *
 * The keys come from the **snapshot**, not from a live read, and that is the
 * whole design: the port has no `list`, so the only enumeration that ever exists
 * is the one `startSiteDeletion` took from `import_uploads` before anything was
 * purged — under the site row lock `createImportRun` also takes, so no run can
 * slip a key in behind it. `postgres_purge` later deletes those rows, and
 * `verify_finalize` re-reads only `deletion_targets`: by then the row below is
 * the sole record of which keys this deletion covered, and the truth about
 * storage was established here, by the `head() = null` checks.
 *
 * Verification is `head() = null` per key, the same shape as the ClickHouse
 * phase's `count() = 0`: the delete call reporting success is progress, and an
 * observation of absence is truth. It matters more here than it looks, because
 * `delete` is idempotent by contract and therefore cannot itself distinguish
 * "removed it" from "storage never saw it".
 *
 * Two "not yet" cases, both returned retries rather than failures:
 *
 * - **no credential and keys to delete.** The phase waits for the restart that
 *   provides it. Skipping would be a deletion claiming to have erased bytes it
 *   never reached — the one thing this whole subsystem exists to prevent.
 * - **a key that still heads.** Rare (S3 delete is strongly consistent), but the
 *   Hetzner `NoSuchBucket` flap is exactly the condition under which a `head`
 *   could answer wrongly, which is why the adapter now classifies that as an
 *   outage instead of as absence.
 *
 * An empty key list completes immediately. Most sites have never imported
 * anything, and a target that cannot be worked would otherwise have to be either
 * skipped or waited on forever.
 */
async function objectPurge(context: PhaseContext): Promise<PhaseOutcome> {
  const rows = await listDeletionTargets(context.job.db, {
    deletionRequestId: context.deletionRequestId,
    store: 'object',
  })

  for (const target of rows) {
    if (target.phase === 'completed') continue

    const keys = snapshottedKeys(target)
    if (keys.length === 0) {
      await completeTarget(context, target, {
        keys: [],
        deleted: 0,
        verified_at: new Date().toISOString(),
      })
      continue
    }

    const storage = context.job.resources?.objectStorage
    if (!storage) {
      context.job.logger.error('site_deletion_object_storage_unavailable', {
        job_id: context.job.job.id,
        site_id: context.siteId,
        reason: 'OBJECT_STORAGE_* not configured',
        keys: keys.length,
        retryable: true,
      })
      context.job.metrics.increment(WORKER_METRICS.deletionTargetFailed, { store: 'object' })
      return { retry: { delayMs: RESOURCE_RETRY_MS } }
    }

    await updateDeletionTarget(context.job.db, { targetId: target.id, phase: 'running' })

    const remaining = await withTargetFailure(context, target, async () => {
      for (const batch of chunk(keys, OBJECT_CHUNK)) {
        await storage.delete(batch.map((key) => ({ key })))
      }
      const stillThere: string[] = []
      for (const key of keys) {
        if ((await storage.head({ key })) !== null) stillThere.push(key)
      }
      return stillThere
    })

    if (remaining.length > 0) {
      await updateDeletionTarget(context.job.db, {
        targetId: target.id,
        lastError: `${String(remaining.length)} of ${String(keys.length)} objects still exist after delete`,
      })
      context.job.metrics.increment(WORKER_METRICS.deletionTargetFailed, { store: 'object' })
      return { retry: { delayMs: RESOURCE_RETRY_MS } }
    }

    // The key list is rewritten with the outcome rather than replaced by it: it
    // is the evidence of what this deletion promised to remove, and an operator
    // reading the row a month later needs both halves.
    await completeTarget(context, target, {
      keys,
      deleted: keys.length,
      verified_at: new Date().toISOString(),
    })
    if (!(await context.job.extendLease())) return { retry: { delayMs: DRAIN_RETRY_MS } }
  }

  return 'advance'
}

/**
 * Delete the site's rows from every analytics table and prove it
 * (ADR-0030, D4 `clickhouse_purge`).
 *
 * Three states per target, all durable, which is what makes the phase resumable
 * across a worker restart:
 *
 * - **no `mutation_id`** — nothing submitted. Submit and record the id.
 * - **`mutation_id`, not `verified`** — a mutation is in flight. Poll it; a
 *   `latest_fail_reason` records the error, meters the failure and retries,
 *   because a failed mutation in ClickHouse is almost always a resource
 *   condition rather than a bad statement.
 * - **`verified`** — a `SELECT count()` has observed zero rows. Skipped forever.
 *
 * The verification is the only statement that observes the end state rather than
 * progress, and it is why `is_done` alone is not accepted as completion. A
 * mutation reported done with rows still present is a real anomaly: the mutation
 * id is cleared so the next attempt re-submits, and the error is recorded on the
 * target rather than swallowed.
 *
 * One pass walks every ClickHouse target — submitting the ones with no mutation,
 * polling the ones that have one — and returns a retry if any is still
 * outstanding. That is bounded work by construction: one statement per target over
 * one site's part sets, each a `WHERE site_id = …` over tables partitioned
 * by month. The alternative, one table per job attempt, would multiply the
 * wall-clock time by the poll interval for no reduction in total server work,
 * since ClickHouse queues mutations per table regardless of when they arrive.
 * The job runner's own `limit: 1` is what keeps *deletions* from overlapping.
 */
async function clickhousePurge(context: PhaseContext): Promise<PhaseOutcome> {
  const maintenance = context.job.resources?.clickhouse
  if (!maintenance) {
    context.job.logger.error('site_deletion_clickhouse_unavailable', {
      job_id: context.job.job.id,
      site_id: context.siteId,
      reason: 'CLICKHOUSE_MAINTENANCE_USER/PASSWORD not configured',
      retryable: true,
    })
    context.job.metrics.increment(WORKER_METRICS.deletionTargetFailed, { store: 'clickhouse' })
    return { retry: { delayMs: RESOURCE_RETRY_MS } }
  }

  if (!(await holdFinalizerLease(context))) {
    return { retry: { delayMs: DRAIN_RETRY_MS } }
  }

  const targets = await listDeletionTargets(context.job.db, {
    deletionRequestId: context.deletionRequestId,
    store: 'clickhouse',
  })

  let pending = 0

  for (const target of targets) {
    if (target.phase === 'completed') continue

    let mutationId = target.mutationId
    // Whether ClickHouse has *reported* this mutation finished. It is not the
    // same question as "are the rows gone", and the difference is what the
    // remaining-rows branch below turns into an anomaly rather than a wait.
    let reportedDone = false

    if (mutationId === null) {
      await updateDeletionTarget(context.job.db, { targetId: target.id, phase: 'running' })
      const submitted = await withTargetFailure(
        context,
        target,
        async () => await maintenance.submitSiteDelete(target.target, context.siteId),
      )
      mutationId = submitted.mutationId
      await updateDeletionTarget(context.job.db, {
        targetId: target.id,
        mutationId,
        countAttempt: true,
      })
      // Fall through to the count rather than returning: a mutation over an
      // empty or tiny part set can already be finished by the time the submit
      // returns, and asking is one cheap aggregate against a full extra polling
      // round. What must NOT happen here is clearing the id we just recorded —
      // that is the resubmit loop the `reportedDone` guard below prevents.
    } else {
      const claimed = mutationId
      const progress = await withTargetFailure(
        context,
        target,
        async () => await maintenance.pollMutation(target.target, claimed),
      )
      if (progress.failReason !== null) {
        await updateDeletionTarget(context.job.db, {
          targetId: target.id,
          lastError: progress.failReason,
        })
        context.job.metrics.increment(WORKER_METRICS.deletionTargetFailed, { store: 'clickhouse' })
        context.job.logger.warn('site_deletion_mutation_failed', {
          job_id: context.job.job.id,
          site_id: context.siteId,
          table: target.target,
          mutation_id: mutationId,
          reason: progress.failReason,
          retryable: true,
        })
        pending += 1
        continue
      }
      if (!progress.done && !progress.missing) {
        pending += 1
        continue
      }
      reportedDone = true
    }

    // The only statement in the whole deletion that observes the end state.
    const remaining = await withTargetFailure(
      context,
      target,
      async () => await maintenance.countSiteRows(target.target, context.siteId),
    )
    if (remaining !== 0) {
      if (reportedDone) {
        // ClickHouse says the mutation is finished and the rows are still there.
        // That is an anomaly, not a wait: the id is cleared so the next attempt
        // re-submits rather than polling a mutation that will never change
        // again, and the reason is recorded on the target so an operator reading
        // the table alone can see it.
        await updateDeletionTarget(context.job.db, {
          targetId: target.id,
          lastError: `mutation reported complete with ${String(remaining)} rows remaining`,
          mutationId: null,
        })
        context.job.metrics.increment(WORKER_METRICS.deletionTargetFailed, { store: 'clickhouse' })
      }
      // Otherwise the mutation is simply still in flight and nothing is cleared:
      // an id that was recorded stays recorded and the next pass polls it, while
      // a submit that legitimately returned no id (the mutation finished and was
      // cleaned out of `system.mutations` before the lookup) leaves the column
      // NULL and the next pass re-submits — which over an already-empty part set
      // is wasted work, never a wrong result.
      pending += 1
      continue
    }

    await completeTarget(context, target, {
      count: 0,
      mutation_id: mutationId,
      verified_at: new Date().toISOString(),
    })

    if (!(await context.job.extendLease())) return { retry: { delayMs: DRAIN_RETRY_MS } }
  }

  if (pending > 0) return { retry: { delayMs: MUTATION_POLL_MS } }
  return 'advance'
}

/**
 * Delete the site-scoped Postgres rows (ADR-0030, D4 `postgres_purge`).
 *
 * The finalizer lease is re-taken (once there is work to do) and then *destroyed
 * with its row*: the `session_finalizer_state` delete inside `purgeSitePostgres`
 * removes what the lease was on. That is safe exactly because the site can never be finalized
 * again — the raw events it would recompute from are gone, and the status fence
 * refuses a `deleting` site anyway.
 *
 * Every row count is recorded, including zeros. A site with no invites is a
 * legitimate zero, so verification here is "the count was observed", not "the
 * count was positive" — the same distinction the ClickHouse phase draws between
 * `is_done` and `count() = 0`.
 *
 * **The outstanding-target check comes first, before the lease.** `claimFinalizerSite`
 * is an UPSERT, so re-entering this phase after a successful purge — a stolen
 * lease, a crash between the last target write and the phase advance, a replayed
 * job — would *re-create* the `session_finalizer_state` row this phase's own
 * purge deleted, and then advance leaving it behind. A phase that has nothing
 * left to do must touch nothing, which is what the early return now guarantees.
 */
async function postgresPurge(context: PhaseContext): Promise<PhaseOutcome> {
  const targets = await listDeletionTargets(context.job.db, {
    deletionRequestId: context.deletionRequestId,
    store: 'postgres',
  })
  const outstanding = targets.filter((target) => target.phase !== 'completed')
  if (outstanding.length === 0) return 'advance'

  if (!(await holdFinalizerLease(context))) {
    return { retry: { delayMs: DRAIN_RETRY_MS } }
  }

  let result: PurgeSitePostgresResult
  try {
    result = await purgeSitePostgres(context.job.db, { siteId: context.siteId })
  } catch (err) {
    // One transaction over twelve tables, so one failure belongs to all of the
    // targets it would have completed — recorded on each, metered once.
    const message = errorMessage(err)
    for (const target of outstanding) {
      await updateDeletionTarget(context.job.db, { targetId: target.id, lastError: message })
    }
    context.job.metrics.increment(WORKER_METRICS.deletionTargetFailed, { store: 'postgres' })
    throw err
  }

  for (const target of outstanding) {
    await completeTarget(context, target, {
      deleted: result.deleted[target.target] ?? 0,
      verified_at: new Date().toISOString(),
    })
  }

  return 'advance'
}

/**
 * Verify every target and write the tombstone (ADR-0030, D4 `verify`/`finalize`).
 *
 * The check is deliberately a re-read of `deletion_targets` rather than a
 * variable carried through the phases. The phases may have run in different
 * processes, across restarts, over days; the table is the only thing that knows
 * what all of them observed.
 *
 * A target that is not both `completed` and `verified` sends the job back to the
 * phase that owns it, and *that rewind is the whole point*. `jobs.phase` is where
 * the next claim resumes, so a retry returned from here without moving it would
 * re-enter `verify_finalize` — which re-reads the same table, finds the same
 * unfinished target, and returns the same retry. Nothing between the two passes
 * runs a purge, so the job would poll until an operator noticed. Rewinding to the
 * *earliest* outstanding store's phase costs one pass over the targets already
 * completed (every phase skips them) and puts the job back on the path that can
 * actually finish the work.
 *
 * The finalizer lease is *not* re-taken here: `postgres_purge` deleted the row it
 * lived on, and `claimFinalizerSite` is an upsert — re-claiming would resurrect a
 * row the purge just verified as gone.
 */
async function verifyFinalize(context: PhaseContext): Promise<PhaseOutcome> {
  const targets = await listDeletionTargets(context.job.db, {
    deletionRequestId: context.deletionRequestId,
  })
  const unfinished = targets.filter((target) => target.phase !== 'completed' || !target.verified)

  if (unfinished.length > 0) {
    const resumeAt = earliestPurgePhase(unfinished)
    context.job.logger.warn('site_deletion_targets_unfinished', {
      job_id: context.job.job.id,
      site_id: context.siteId,
      unfinished: unfinished.length,
      stores: [...new Set(unfinished.map((target) => target.store))],
      resume_phase: resumeAt,
      retryable: true,
    })
    // A refused write means the lease is someone else's; the retry below is then
    // refused by the runner too and settles as `lost`, which is the truthful
    // outcome — the new holder owns the phase marker.
    await context.job.updatePhase(resumeAt)
    return { retry: { delayMs: MUTATION_POLL_MS } }
  }

  await finalizeSiteDeletion(context.job.db, {
    deletionRequestId: context.deletionRequestId,
    siteId: context.siteId,
  })

  context.job.logger.info('site_deletion_completed', {
    job_id: context.job.job.id,
    site_id: context.siteId,
    deletion_request_id: context.deletionRequestId,
    targets: targets.length,
  })

  return 'advance'
}

/** Which phase owns a store's targets. An unknown store — a snapshot written by
 * a newer build, or a target vocabulary this one predates — maps to the first
 * purge phase, so the rewind is never *later* than the work it has to redo. */
function phaseForStore(store: string): SiteDeletionPhase {
  switch (store) {
    case 'clickhouse':
      return 'clickhouse_purge'
    case 'postgres':
      return 'postgres_purge'
    case 'object':
      return 'object_purge'
    case 'redis':
    default:
      return 'redis_purge'
  }
}

/** The earliest phase in `SITE_DELETION_PHASES` order that owns an outstanding
 * target — where a rewind has to land for every one of them to be re-attempted. */
function earliestPurgePhase(unfinished: readonly DeletionTargetRow[]): SiteDeletionPhase {
  let earliest = SITE_DELETION_PHASES.length - 1
  for (const target of unfinished) {
    const index = SITE_DELETION_PHASES.indexOf(phaseForStore(target.store))
    if (index < earliest) earliest = index
  }
  return SITE_DELETION_PHASES[earliest] as SiteDeletionPhase
}

export const SITE_DELETION_REGISTRATION: JobRegistration = {
  type: SITE_DELETION_JOB_TYPE,
  execute: executeSiteDeletion,
  /**
   * The job is dead; the request must stop claiming otherwise.
   *
   * Without this the site keeps a `pending` request nobody is working, and
   * `startSiteDeletion` — which decides by finding exactly that row — would
   * answer every later `DELETE /v1/sites/{id}` with the id of a deletion that
   * will never run. Marking it `failed` moves it out of the live set, which is
   * what makes the revive path in that same function reachable.
   */
  onTerminal: async (job, reason, context) => {
    if (job.subjectId === null) return
    const requestId = job.payload['deletion_request_id']
    await markSiteDeletionFailed(context.db, {
      ...(typeof requestId === 'string' && requestId.length > 0
        ? { deletionRequestId: requestId }
        : {}),
      siteId: job.subjectId,
      reason,
    })
  },
  // One at a time. A deletion holds a ClickHouse mutation and a finalizer lease;
  // claiming ten per tick would put ten concurrent mutations on one server and
  // serialize them behind each other anyway, since the page is executed serially.
  limit: 1,
}

export { executeSiteDeletion }
