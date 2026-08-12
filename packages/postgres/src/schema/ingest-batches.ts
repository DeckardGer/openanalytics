import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, instant, primaryId, updatedAt } from './_shared.ts'

/**
 * The batch manifest (mirror of migration 0015).
 *
 * The durable record that turns at-least-once queue delivery into exactly one
 * raw ClickHouse row and exactly one usage unit (docs snapshot 02 §7.5; 05
 * D-209 step 3, D-210, D-216). The manifest is written before the ClickHouse
 * insert, so a crash at any point leaves a statement of what the batch was
 * rather than a set of messages a second worker would group differently.
 *
 * `ingestBatchItems`' (streamName, messageId) unique is the constraint that
 * makes "messages are never silently re-split into new batches" enforceable: a
 * reclaimer that finds a message already in a manifest continues that manifest.
 */

export const INGEST_BATCH_STATES = [
  'pending',
  'inserting',
  'inserted',
  'usage_recorded',
  'completed',
  'dead_lettered',
] as const

export type IngestBatchState = (typeof INGEST_BATCH_STATES)[number]

/**
 * `abandoned` (migration 0020) is the fourth terminal answer: the batch stopped
 * for good and no further write will be issued under this registration, but
 * whether rows landed before it stopped is unknown. It is what a dead-lettered
 * batch's registrations settle to, so the M10 drain stops waiting on them.
 */
export const INGEST_BATCH_SITE_STATES = ['registered', 'written', 'dropped', 'abandoned'] as const
export type IngestBatchSiteState = (typeof INGEST_BATCH_SITE_STATES)[number]

export const INGEST_BATCH_DROP_REASONS = [
  'site_deleting',
  'site_deleted',
  'site_missing',
  'generation_mismatch',
] as const
export type IngestBatchDropReason = (typeof INGEST_BATCH_DROP_REASONS)[number]

export const ingestBatches = pgTable(
  'ingest_batches',
  {
    id: primaryId(),
    /** Deterministic token, shared with ClickHouse and `usage_batches`. */
    batchId: text('batch_id').notNull(),
    streamName: text('stream_name').notNull(),
    consumerGroup: text('consumer_group').notNull(),
    state: text('state').$type<IngestBatchState>().notNull().default('pending'),
    messageCount: integer('message_count').notNull(),
    byteSize: integer('byte_size').notNull(),
    payloadHash: text('payload_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: instant('next_attempt_at'),
    lastErrorCode: text('last_error_code'),
    claimedBy: text('claimed_by'),
    leaseExpiresAt: instant('lease_expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    insertedAt: instant('inserted_at'),
    completedAt: instant('completed_at'),
    deadLetteredAt: instant('dead_lettered_at'),
  },
  (t) => [
    unique('ingest_batches_batch_id_key').on(t.batchId),
    check(
      'ingest_batches_completed_check',
      sql`(${t.state} = 'completed') = (${t.completedAt} IS NOT NULL)`,
    ),
    check(
      'ingest_batches_dead_lettered_check',
      sql`(${t.state} = 'dead_lettered') = (${t.deadLetteredAt} IS NOT NULL)`,
    ),
    index('ingest_batches_runnable_idx').on(t.state, t.nextAttemptAt),
    index('ingest_batches_completed_idx').on(t.completedAt),
  ],
)

export const ingestBatchItems = pgTable(
  'ingest_batch_items',
  {
    id: primaryId(),
    batchId: text('batch_id')
      .notNull()
      .references(() => ingestBatches.batchId, { onDelete: 'cascade' }),
    streamName: text('stream_name').notNull(),
    messageId: text('message_id').notNull(),
    /** Row order inside the batch, preserved byte-for-byte across retries. */
    position: integer('position').notNull(),
    // No foreign key: a manifest is an audit record and must outlive the site
    // deletion D-210 performs.
    siteId: uuid('site_id').notNull(),
    eventId: uuid('event_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    acceptedAt: instant('accepted_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ingest_batch_items_stream_message_key').on(t.streamName, t.messageId),
    unique('ingest_batch_items_batch_position_key').on(t.batchId, t.position),
    index('ingest_batch_items_batch_idx').on(t.batchId),
    index('ingest_batch_items_site_idx').on(t.siteId),
  ],
)

export const ingestBatchSites = pgTable(
  'ingest_batch_sites',
  {
    id: primaryId(),
    batchId: text('batch_id')
      .notNull()
      .references(() => ingestBatches.batchId, { onDelete: 'cascade' }),
    siteId: idColumn('site_id').notNull(),
    /** The generation the batch's events were accepted under. */
    ingestGeneration: integer('ingest_generation').notNull(),
    /** What the site actually carried when the fence was checked. */
    observedGeneration: integer('observed_generation'),
    observedStatus: text('observed_status'),
    state: text('state').$type<IngestBatchSiteState>().notNull().default('registered'),
    dropReason: text('drop_reason').$type<IngestBatchDropReason>(),
    rowCount: integer('row_count').notNull().default(0),
    registeredAt: instant('registered_at').notNull().defaultNow(),
    settledAt: instant('settled_at'),
  },
  (t) => [
    unique('ingest_batch_sites_batch_site_key').on(t.batchId, t.siteId),
    check(
      'ingest_batch_sites_drop_state_check',
      sql`(${t.state} = 'dropped') = (${t.dropReason} IS NOT NULL)`,
    ),
    index('ingest_batch_sites_inflight_idx').on(t.siteId, t.ingestGeneration),
  ],
)
