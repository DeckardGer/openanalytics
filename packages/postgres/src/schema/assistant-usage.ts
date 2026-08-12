import { bigint, index, integer, pgTable, primaryKey, timestamp } from 'drizzle-orm/pg-core'
import { idColumn } from './_shared.ts'
import { users } from './auth.ts'

/**
 * The assistant's question quota and its token measurement (mirror of migration
 * 0049, ADR-0046 D5).
 *
 * Hourly buckets rather than a row per calendar day, so F-306's "20 questions
 * per day" is a real rolling window and not a midnight cliff — and so the `429`
 * can carry a `Retry-After` that names when a question actually frees up.
 *
 * Keyed by the *user*: a session-keyed quota would reset on sign-out, and a
 * question is not about one site. That is also why the table is an
 * account-deletion target while `read_cost_ledger`, which is keyed by a
 * credential, is in neither registry.
 *
 * The foreign key declares no `onDelete`, matching the migration: account
 * deletion scrubs the `users` row rather than deleting it, so a cascade could
 * never fire, and one that cannot fire reads as coverage.
 */
export const assistantUsageLedger = pgTable(
  'assistant_usage_ledger',
  {
    userId: idColumn('user_id')
      .notNull()
      .references(() => users.id),
    hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
    questionCount: integer('question_count').notNull().default(0),
    // `bigint` with `mode: 'number'`: token totals per user per hour stay far
    // below the safe-integer boundary, and reading them as strings would make
    // every comparison a parse. The column is wide because a counter that wraps
    // is worse than one that is wide, not because the values are.
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.hourBucket] }),
    index('assistant_usage_ledger_hour_bucket_idx').on(t.hourBucket),
  ],
)
