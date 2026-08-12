import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { newId } from '../ids.ts'
import {
  ingestBatchItems,
  ingestBatchSites,
  ingestBatches,
  type IngestBatchDropReason,
  type IngestBatchSiteState,
  type IngestBatchState,
} from '../schema/ingest-batches.ts'
import { sites } from '../schema/sites.ts'
import { usageBatchDeltas } from '../schema/usage.ts'

/**
 * The batch manifest repository (migration 0015; docs snapshot 02 §7.5, 05
 * D-209 step 3 and D-210).
 *
 * Everything here exists to make one sentence true: *the manifest is the truth*.
 * A worker never decides what a batch is from the messages it happens to be
 * holding — it writes the manifest first, and every later decision reads it
 * back. That is what makes a crash recoverable rather than merely survivable.
 */

export interface ManifestMessage {
  readonly messageId: string
  readonly siteId: string
  readonly eventId: string
  readonly payloadHash: string
  readonly acceptedAt: Date
}

export interface ManifestItem extends ManifestMessage {
  readonly position: number
}

export interface Manifest {
  readonly batchId: string
  readonly streamName: string
  readonly consumerGroup: string
  readonly state: IngestBatchState
  readonly attempts: number
  readonly messageCount: number
  readonly byteSize: number
  readonly payloadHash: string
  readonly lastErrorCode: string | null
  readonly claimedBy: string | null
  readonly leaseExpiresAt: Date | null
  readonly nextAttemptAt: Date | null
  /** Ordered by `position`. This ordering is the insert's row order. */
  readonly items: readonly ManifestItem[]
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  )
}

type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

async function loadManifest(db: Executor, batchId: string): Promise<Manifest | null> {
  const [batch] = await db.select().from(ingestBatches).where(eq(ingestBatches.batchId, batchId))
  if (!batch) return null

  const items = await db
    .select()
    .from(ingestBatchItems)
    .where(eq(ingestBatchItems.batchId, batchId))
    .orderBy(asc(ingestBatchItems.position))

  return {
    batchId: batch.batchId,
    streamName: batch.streamName,
    consumerGroup: batch.consumerGroup,
    state: batch.state,
    attempts: batch.attempts,
    messageCount: batch.messageCount,
    byteSize: batch.byteSize,
    payloadHash: batch.payloadHash,
    lastErrorCode: batch.lastErrorCode,
    claimedBy: batch.claimedBy,
    leaseExpiresAt: batch.leaseExpiresAt,
    nextAttemptAt: batch.nextAttemptAt,
    items: items.map((item) => ({
      position: item.position,
      messageId: item.messageId,
      siteId: item.siteId,
      eventId: item.eventId,
      payloadHash: item.payloadHash,
      acceptedAt: item.acceptedAt,
    })),
  }
}

export async function getManifest(db: Database, batchId: string): Promise<Manifest | null> {
  return await loadManifest(db, batchId)
}

export interface CreateManifestInput {
  /** Deterministic, from `deriveBatchId` over the same ordered message ids. */
  readonly batchId: string
  readonly streamName: string
  readonly consumerGroup: string
  readonly payloadHash: string
  readonly byteSize: number
  /** In insert order. Position is the array index. */
  readonly messages: readonly ManifestMessage[]
  readonly claimedBy: string
  readonly leaseTtlMs: number
}

export type ManifestPlan =
  | { readonly outcome: 'created'; readonly manifest: Manifest }
  | {
      readonly outcome: 'continued'
      readonly manifest: Manifest
      /**
       * Message ids from the caller's read that this manifest does not contain.
       * The caller re-plans them rather than folding them in: a manifest's
       * message list is fixed at creation, and widening it would change the
       * `batch_id` the ClickHouse token is derived from.
       */
      readonly remaining: readonly string[]
    }

/**
 * Create the manifest, or continue the one that already owns these messages.
 *
 * Docs snapshot 02 §7.5: "if the reclaimer sees a message already bound to a
 * manifest it creates no new batch, it continues the existing manifest's state
 * machine." A reclaimer taking over a crashed worker's pending messages must
 * reach the *same* batch, because the ClickHouse deduplication token is derived
 * from the message list — a re-split would produce a new token, and a new token
 * is new data.
 *
 * The existence check and the insert are not two decisions: the insert races
 * against another worker's reclaim, and the `(stream_name, message_id)` unique
 * constraint is what settles it. A unique violation is therefore not an error
 * here, it is the answer "someone else got there first, continue theirs".
 */
export async function createOrContinueManifest(
  db: Database,
  input: CreateManifestInput,
): Promise<ManifestPlan> {
  if (input.messages.length === 0) {
    throw new Error('A manifest must contain at least one message')
  }

  const messageIds = input.messages.map((message) => message.messageId)

  const existing = await findOwningBatch(db, input.streamName, messageIds)
  if (existing) return await continueFrom(db, existing, messageIds)

  const leaseExpiresAt = new Date(Date.now() + input.leaseTtlMs)

  try {
    await db.transaction(async (tx) => {
      await tx.insert(ingestBatches).values({
        id: newId(),
        batchId: input.batchId,
        streamName: input.streamName,
        consumerGroup: input.consumerGroup,
        state: 'pending',
        messageCount: input.messages.length,
        byteSize: input.byteSize,
        payloadHash: input.payloadHash,
        claimedBy: input.claimedBy,
        leaseExpiresAt,
      })

      await tx.insert(ingestBatchItems).values(
        input.messages.map((message, position) => ({
          id: newId(),
          batchId: input.batchId,
          streamName: input.streamName,
          messageId: message.messageId,
          position,
          siteId: message.siteId,
          eventId: message.eventId,
          payloadHash: message.payloadHash,
          acceptedAt: message.acceptedAt,
        })),
      )
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error

    // Either this exact batch_id already exists (a retry of the same read) or
    // another worker claimed one of the messages first. Both resolve the same
    // way: find the manifest that owns them and continue it.
    const owner = await findOwningBatch(db, input.streamName, messageIds)
    if (!owner) throw error
    return await continueFrom(db, owner, messageIds)
  }

  const manifest = await loadManifest(db, input.batchId)
  if (!manifest) throw new Error(`Manifest ${input.batchId} vanished immediately after creation`)
  return { outcome: 'created', manifest }
}

/**
 * The batch that owns the earliest of these messages, if any.
 *
 * "Earliest" is by stream position, not by read order, so two workers planning
 * overlapping reads converge on the same manifest instead of ping-ponging
 * between two of them.
 */
async function findOwningBatch(
  db: Database,
  streamName: string,
  messageIds: readonly string[],
): Promise<string | null> {
  const [row] = await db
    .select({ batchId: ingestBatchItems.batchId })
    .from(ingestBatchItems)
    .where(
      and(
        eq(ingestBatchItems.streamName, streamName),
        inArray(ingestBatchItems.messageId, [...messageIds]),
      ),
    )
    .orderBy(asc(ingestBatchItems.messageId))
    .limit(1)

  return row?.batchId ?? null
}

async function continueFrom(
  db: Database,
  batchId: string,
  readMessageIds: readonly string[],
): Promise<ManifestPlan> {
  const manifest = await loadManifest(db, batchId)
  if (!manifest) throw new Error(`Manifest ${batchId} is referenced by an item but does not exist`)

  const owned = new Set(manifest.items.map((item) => item.messageId))
  return {
    outcome: 'continued',
    manifest,
    remaining: readMessageIds.filter((id) => !owned.has(id)),
  }
}

/**
 * Take or renew the lease on a manifest.
 *
 * Returns false when another worker holds a live lease — the reclaim raced and
 * lost, which is ordinary. The conditional update is the whole mechanism: two
 * workers cannot both come out of it holding the batch, so the idempotency
 * downstream is a second line of defence rather than the only one.
 */
export async function claimManifest(
  db: Database,
  input: { batchId: string; claimedBy: string; leaseTtlMs: number; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date()
  const rows = await db
    .update(ingestBatches)
    .set({
      claimedBy: input.claimedBy,
      leaseExpiresAt: new Date(now.getTime() + input.leaseTtlMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(ingestBatches.batchId, input.batchId),
        or(
          isNull(ingestBatches.claimedBy),
          eq(ingestBatches.claimedBy, input.claimedBy),
          isNull(ingestBatches.leaseExpiresAt),
          lt(ingestBatches.leaseExpiresAt, now),
        ),
      ),
    )
    .returning({ batchId: ingestBatches.batchId })

  return rows.length > 0
}

export class ManifestTransitionError extends Error {
  readonly batchId: string
  readonly to: IngestBatchState

  constructor(batchId: string, to: IngestBatchState) {
    super(`Manifest ${batchId} could not transition to "${to}" from its current state`)
    this.name = 'ManifestTransitionError'
    this.batchId = batchId
    this.to = to
  }
}

/**
 * Move a manifest to a new state, refusing the move if it is not legal from the
 * state the row is actually in.
 *
 * The `from` set is part of the UPDATE predicate rather than a read-then-write,
 * because two workers on one batch is the case this exists for: the loser's
 * update matches no row and it learns that from the row count, not from a stale
 * read it took a moment earlier.
 */
async function transition(
  db: Executor,
  input: {
    batchId: string
    from: readonly IngestBatchState[]
    to: IngestBatchState
    set?: Record<string, unknown>
  },
): Promise<void> {
  const rows = await db
    .update(ingestBatches)
    .set({ state: input.to, updatedAt: new Date(), ...input.set })
    .where(
      and(eq(ingestBatches.batchId, input.batchId), inArray(ingestBatches.state, [...input.from])),
    )
    .returning({ batchId: ingestBatches.batchId })

  if (rows.length === 0) throw new ManifestTransitionError(input.batchId, input.to)
}

/** Before the insert is issued. */
export async function markInserting(db: Database, batchId: string): Promise<void> {
  await transition(db, {
    batchId,
    from: ['pending', 'inserting'],
    to: 'inserting',
    set: { nextAttemptAt: null },
  })
}

export async function markInserted(db: Database, batchId: string): Promise<void> {
  await transition(db, {
    batchId,
    from: ['inserting'],
    to: 'inserted',
    set: { insertedAt: new Date(), lastErrorCode: null },
  })
}

export async function markUsageRecorded(db: Database, batchId: string): Promise<void> {
  await transition(db, { batchId, from: ['inserted'], to: 'usage_recorded' })
}

export async function markCompleted(db: Database, batchId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, {
      batchId,
      from: ['usage_recorded'],
      to: 'completed',
      set: { completedAt: new Date(), claimedBy: null, leaseExpiresAt: null },
    })
    // The backstop for the fence. A completed batch's rows are durable, so any
    // registration still open here — a settle that failed after the insert, a
    // recovery path that reached the ACK from a state that skips it — is settled
    // with the manifest rather than left for the M10 drain to wait on forever.
    await settleBatchSites(tx, batchId, 'written')
  })
}

/**
 * Schedule the next attempt after a retryable failure.
 *
 * `ambiguous` decides the state, and it is the most consequential boolean in the
 * pipeline: an ambiguous insert stays in `inserting` so the next attempt reuses
 * the same token, while a definite failure returns to `pending`. Reading an
 * ambiguous timeout as a clean failure is how a batch ends up inserted twice.
 */
export async function markAttemptFailed(
  db: Database,
  input: { batchId: string; errorCode: string; retryDelayMs: number; ambiguous: boolean },
): Promise<void> {
  await transition(db, {
    batchId: input.batchId,
    from: ['pending', 'inserting', 'inserted'],
    to: input.ambiguous ? 'inserting' : 'pending',
    set: {
      // Counted here rather than at the attempt, so a failure *before* the
      // insert is issued — an unreachable payload, a fence transaction that
      // deadlocked — still moves the batch toward the dead-letter decision
      // instead of retrying forever without ever incrementing anything.
      attempts: sql`${ingestBatches.attempts} + 1`,
      lastErrorCode: input.errorCode,
      nextAttemptAt: new Date(Date.now() + input.retryDelayMs),
      claimedBy: null,
      leaseExpiresAt: null,
    },
  })
}

/**
 * Give up on a batch — and settle its fence registrations in the same
 * transaction.
 *
 * The settle is not bookkeeping. `registered` means "a writer is in flight for
 * this site at this generation", and the M10 deletion drain blocks on exactly
 * that. A dead-lettered batch has permanently stopped writing, so leaving its
 * registrations open would stall the deletion of those sites behind a writer
 * that gave up — forever, because nothing ever revisits a dead-lettered batch
 * unless an operator replays it.
 *
 * `abandoned` rather than `written`: a batch that died in `pending` or
 * `inserting` may or may not have landed rows, and only the settle *state* is
 * being decided here, not that question. The drain does not need the answer —
 * deletion removes a site's ClickHouse rows by site id — but a state that
 * claimed durability would be a lie the audit trail then carried.
 */
export async function markDeadLettered(
  db: Database,
  input: { batchId: string; errorCode: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, {
      batchId: input.batchId,
      from: ['pending', 'inserting', 'inserted'],
      to: 'dead_lettered',
      set: {
        deadLetteredAt: new Date(),
        lastErrorCode: input.errorCode,
        claimedBy: null,
        leaseExpiresAt: null,
      },
    })
    await settleBatchSites(tx, input.batchId, 'abandoned')
  })
}

/**
 * The manual replay hook (plan Milestone 6 item 10).
 *
 * Re-enters the machine at `pending` rather than jumping past the insert: the
 * stable token still protects whatever already landed, so replaying from the
 * start is both safe and the only way to finish a batch that failed partway.
 */
export async function replayDeadLettered(db: Database, batchId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transition(tx, {
      batchId,
      from: ['dead_lettered'],
      to: 'pending',
      set: { deadLetteredAt: null, attempts: 0, nextAttemptAt: null },
    })
    // The old fence decisions are discarded rather than reopened. They answered
    // a question about the state of those sites at dead-letter time, which may
    // be days or weeks stale by the time an operator replays; re-registration
    // re-asks it against the site rows as they are now. Keeping them would be
    // worse than useless — `registerBatchSites` writes with
    // `ON CONFLICT DO NOTHING`, so a stale `abandoned`/`registered` row would
    // survive the replay and the batch would write under a fence decision taken
    // before the site was, say, marked `deleting`.
    await tx.delete(ingestBatchSites).where(eq(ingestBatchSites.batchId, batchId))
  })
}

/**
 * Manifests that are neither complete nor dead and are due for another attempt.
 *
 * This is crash recovery's entry point: a worker that died mid-batch left a
 * manifest here, and it is found by state rather than by anything the queue
 * remembers.
 */
export async function listRunnableManifests(
  db: Database,
  input: { limit: number; now?: Date },
): Promise<Manifest[]> {
  const now = input.now ?? new Date()
  const rows = await db
    .select({ batchId: ingestBatches.batchId })
    .from(ingestBatches)
    .where(
      and(
        inArray(ingestBatches.state, ['pending', 'inserting', 'inserted', 'usage_recorded']),
        or(isNull(ingestBatches.nextAttemptAt), lt(ingestBatches.nextAttemptAt, now)),
        or(isNull(ingestBatches.leaseExpiresAt), lt(ingestBatches.leaseExpiresAt, now)),
      ),
    )
    .orderBy(asc(ingestBatches.createdAt))
    .limit(input.limit)

  const manifests: Manifest[] = []
  for (const row of rows) {
    const manifest = await loadManifest(db, row.batchId)
    if (manifest) manifests.push(manifest)
  }
  return manifests
}

// ---------------------------------------------------------------------------
// The D-210 write fence
// ---------------------------------------------------------------------------

export interface FenceRegistration {
  readonly siteId: string
  /** The generation the batch's events were accepted under. */
  readonly ingestGeneration: number
  readonly rowCount: number
}

export interface FenceDecision {
  readonly siteId: string
  readonly admitted: boolean
  readonly dropReason: IngestBatchDropReason | null
  readonly observedGeneration: number | null
  readonly observedStatus: string | null
  readonly rowCount: number
}

/**
 * Check every site's current status and generation and register the in-flight
 * write — in one transaction, before any ClickHouse row is written.
 *
 * Docs snapshot 05, D-210. Deletion bumps `ingest_generation`, marks the site
 * `deleting` and then waits for in-flight registrations at the old generation to
 * settle. A worker that skipped this could write rows *after* the delete
 * mutation ran, and the deletion would report a completeness it had not
 * achieved.
 *
 * `SELECT … FOR UPDATE` on the site rows is what makes the check and the
 * registration one decision. Without it, a deletion transaction could bump the
 * generation between this worker's read and its insert, and the registration
 * would record a generation that was already stale when it was written.
 *
 * Milestone 6 owns the registration and the drop path. The drain that waits on
 * these rows is Milestone 10.
 */
export async function registerBatchSites(
  db: Database,
  input: { batchId: string; registrations: readonly FenceRegistration[] },
): Promise<FenceDecision[]> {
  if (input.registrations.length === 0) return []

  return await db.transaction(async (tx) => {
    const siteIds = input.registrations.map((registration) => registration.siteId)

    // Locked, so a concurrent deletion cannot move the generation between this
    // read and the registration written below it.
    //
    // `ORDER BY id` is the lock-order mechanism, not a presentation choice
    // (ADR-0030, decision 4). Postgres acquires row locks in executor scan
    // order, so sorting `siteIds` in JavaScript would guarantee nothing — a seq
    // or bitmap scan over the `IN` list visits heap order regardless. Putting
    // the sort inside the locking statement places `LockRows` above `Sort`, so
    // this batch and the lifecycle transaction (which locks its own site set the
    // same way) take any shared rows in the same order and cannot deadlock.
    // Before this, registrations were locked in first-seen event order, which is
    // a deadlock waiting for traffic.
    await tx.execute(
      sql`SELECT id FROM ${sites} WHERE id IN (${sql.join(
        siteIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) ORDER BY id FOR UPDATE`,
    )

    const current = await tx
      .select({ id: sites.id, status: sites.status, generation: sites.ingestGeneration })
      .from(sites)
      .where(inArray(sites.id, siteIds))

    const bySite = new Map(current.map((row) => [row.id, row]))
    const decisions: FenceDecision[] = []

    for (const registration of input.registrations) {
      const site = bySite.get(registration.siteId)

      let dropReason: IngestBatchDropReason | null = null
      if (!site) {
        dropReason = 'site_missing'
      } else if (site.status === 'deleting') {
        dropReason = 'site_deleting'
      } else if (site.status === 'deleted') {
        dropReason = 'site_deleted'
      } else if (site.generation !== registration.ingestGeneration) {
        // Strict inequality, not "older than". A snapshot from a *newer*
        // generation than the site currently carries cannot be legitimate
        // either, and writing it would mean trusting an event about a fence
        // state the database has never been in.
        dropReason = 'generation_mismatch'
      }

      const admitted = dropReason === null

      await tx
        .insert(ingestBatchSites)
        .values({
          id: newId(),
          batchId: input.batchId,
          siteId: registration.siteId,
          ingestGeneration: registration.ingestGeneration,
          observedGeneration: site?.generation ?? null,
          observedStatus: site?.status ?? null,
          state: admitted ? 'registered' : 'dropped',
          dropReason,
          rowCount: registration.rowCount,
          ...(admitted ? {} : { settledAt: new Date() }),
        })
        // A retry of the same batch re-registers the same site. The row is the
        // audit record of a decision already made, so it is left as it stands
        // rather than being rewritten with a second timestamp.
        .onConflictDoNothing({
          target: [ingestBatchSites.batchId, ingestBatchSites.siteId],
        })

      decisions.push({
        siteId: registration.siteId,
        admitted,
        dropReason,
        observedGeneration: site?.generation ?? null,
        observedStatus: site?.status ?? null,
        rowCount: registration.rowCount,
      })
    }

    return decisions
  })
}

/**
 * Move every still-open registration of a batch to a terminal state.
 *
 * Only `registered` rows are touched: `dropped` rows recorded a decision the
 * fence already made, and a second settle must not overwrite the timestamp on a
 * row that settled earlier.
 */
async function settleBatchSites(
  db: Executor,
  batchId: string,
  to: Extract<IngestBatchSiteState, 'written' | 'abandoned'>,
): Promise<void> {
  await db
    .update(ingestBatchSites)
    .set({ state: to, settledAt: new Date() })
    .where(and(eq(ingestBatchSites.batchId, batchId), eq(ingestBatchSites.state, 'registered')))
}

/**
 * Settle the in-flight registrations once the rows are durable.
 *
 * `registered` is what the M10 drain waits on, so leaving a completed batch's
 * rows in that state would stall a deletion behind a writer that finished long
 * ago. Called on both the fresh insert path and the `record_usage` recovery
 * path — a crash between `markInserted` and this call leaves a manifest whose
 * recovery action skips the insert step, and settling only there was how a
 * batch reached `completed` with its fence rows still open.
 */
export async function markBatchSitesWritten(db: Database, batchId: string): Promise<void> {
  await settleBatchSites(db, batchId, 'written')
}

export async function listBatchSites(db: Database, batchId: string): Promise<FenceDecision[]> {
  const rows = await db.select().from(ingestBatchSites).where(eq(ingestBatchSites.batchId, batchId))

  return rows.map((row) => ({
    siteId: row.siteId,
    admitted: row.state !== 'dropped',
    dropReason: row.dropReason,
    observedGeneration: row.observedGeneration,
    observedStatus: row.observedStatus,
    rowCount: row.rowCount,
  }))
}

/**
 * Batches completed strictly after a restore point (docs snapshot 05, D-216).
 *
 * The bounded-replay selection: a batch that completed *before* the ClickHouse
 * restore point is already in the restored data and must not be written again,
 * and the insert-dedup token is explicitly not a correctness mechanism at
 * days-wide scale. Only the batches after the point are candidates.
 */
export async function listBatchesCompletedAfter(
  db: Database,
  input: { after: Date; limit: number },
): Promise<string[]> {
  const rows = await db
    .select({ batchId: ingestBatches.batchId })
    .from(ingestBatches)
    .where(
      and(eq(ingestBatches.state, 'completed'), sql`${ingestBatches.completedAt} > ${input.after}`),
    )
    .orderBy(asc(ingestBatches.completedAt))
    .limit(input.limit)

  return rows.map((row) => row.batchId)
}

/**
 * Remove manifests whose retention has elapsed.
 *
 * Retention matches the ACKed-payload retention: the manifest is what bounds a
 * disaster replay (D-216), so it has to outlive the queue entries it describes,
 * never the other way round. Items and fence rows cascade.
 */
export async function deleteManifestsCompletedBefore(
  db: Database,
  input: { before: Date; limit: number },
): Promise<number> {
  const rows = await db
    .delete(ingestBatches)
    .where(
      and(
        eq(ingestBatches.state, 'completed'),
        sql`${ingestBatches.completedAt} < ${input.before}`,
        sql`${ingestBatches.batchId} IN (
          SELECT batch_id FROM ingest_batches
          WHERE state = 'completed' AND completed_at < ${input.before}
          ORDER BY completed_at
          LIMIT ${input.limit}
        )`,
      ),
    )
    .returning({ batchId: ingestBatches.batchId })

  return rows.length
}

// ---------------------------------------------------------------------------
// Reads for the operational jobs (plan Milestone 6 item 11)
// ---------------------------------------------------------------------------

export interface BatchLedgerTotal {
  readonly batchId: string
  /** Billable units this batch contributed, summed across its deltas. */
  readonly ledger: number
}

/**
 * Completed batches in a window, each with its ledger total.
 *
 * Only `completed` batches. A batch mid-pipeline is *expected* to disagree with
 * ClickHouse — the rows land before the usage transaction commits — so including
 * one would make the reconciliation metric alarm on the system working.
 */
export async function listCompletedBatchLedgerTotals(
  db: Database,
  input: { since: Date; limit: number },
): Promise<BatchLedgerTotal[]> {
  // A join and a GROUP BY, not a correlated subquery in the projection. The
  // subquery version did not correlate — every batch came back with the sum of
  // the whole delta table — and it failed silently, which would have made the
  // reconciliation metric report enormous drift permanently. An alert that
  // always fires is an alert that gets ignored, so this is worse than not
  // having the metric. LEFT JOIN, so a completed batch that billed nothing
  // reports 0 rather than vanishing from the comparison.
  const rows = await db
    .select({
      batchId: ingestBatches.batchId,
      ledger: sql<number>`coalesce(sum(${usageBatchDeltas.delta}), 0)::int`,
      completedAt: ingestBatches.completedAt,
    })
    .from(ingestBatches)
    .leftJoin(usageBatchDeltas, eq(usageBatchDeltas.batchId, ingestBatches.batchId))
    .where(
      and(
        eq(ingestBatches.state, 'completed'),
        sql`${ingestBatches.completedAt} >= ${input.since}`,
      ),
    )
    .groupBy(ingestBatches.batchId, ingestBatches.completedAt)
    .orderBy(asc(ingestBatches.completedAt))
    .limit(input.limit)

  return rows.map((row) => ({ batchId: row.batchId, ledger: Number(row.ledger) }))
}

/**
 * Sites the worker has ingested for since `since`.
 *
 * The candidate set for the G-005 ceiling-days alert. A site at its daily
 * ceiling is by definition sending traffic, so the set that could possibly
 * qualify is exactly the set that has been busy — which bounds the job without a
 * limit that could silently truncate it.
 */
export async function listRecentlyIngestedSites(
  db: Database,
  input: { since: Date },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ siteId: ingestBatchItems.siteId })
    .from(ingestBatchItems)
    .where(sql`${ingestBatchItems.createdAt} >= ${input.since}`)

  return rows.map((row) => row.siteId)
}
