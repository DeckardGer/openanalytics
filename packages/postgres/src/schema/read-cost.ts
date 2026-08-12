import { bigint, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The measured half of the expensive-query gate (mirror of migration 0046,
 * ADR-0043 D7).
 *
 * Hourly buckets rather than daily ones, so "per rolling day" is a real rolling
 * window and not a midnight cliff: a caller that exhausts its budget at 23:00
 * and one that exhausts it at 00:30 should wait the same amount of time, and
 * with calendar buckets they wait an hour and twenty-three hours respectively.
 *
 * `credentialKey` is the string the rate limiter charges — `key:<id>` or
 * `oauth:<id>` — so the two gates cannot disagree about who a caller is.
 */
export const readCostLedger = pgTable(
  'read_cost_ledger',
  {
    credentialKey: text('credential_key').notNull(),
    hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
    // `bigint` with `mode: 'number'`: a day of milliseconds is at most 86.4
    // million, so it never approaches the safe-integer boundary, and reading it
    // as a string would make every comparison a parse.
    elapsedMs: bigint('elapsed_ms', { mode: 'number' }).notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.credentialKey, t.hourBucket] }),
    index('read_cost_ledger_hour_bucket_idx').on(t.hourBucket),
  ],
)
