import { timestamp, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../ids.ts'

/**
 * Column builders shared by every table, so the ADR-0006 conventions are written
 * once rather than copied per table.
 *
 * These are NOT re-exported from the schema barrel: the barrel carries only
 * table objects, which is what the Drizzle client introspects.
 */

/**
 * UUIDv7 primary key. The `$defaultFn` supplies the id from the application on
 * insert; the migration creates the column with no database default (ADR-0006),
 * so these two agree that the app owns id generation.
 */
export function primaryId() {
  return uuid('id').primaryKey().$defaultFn(newId)
}

/** A `uuid` foreign-key column value, minted by the app like every other id. */
export function idColumn(name: string) {
  return uuid(name)
}

/** Creation timestamp, `timestamptz`, defaulting to `now()` (ADR-0006). */
export function createdAt() {
  return timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}

/** Last-modified timestamp; Better Auth and repositories set it on write. */
export function updatedAt() {
  return timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}

/** A nullable `timestamptz` for lifecycle instants (revoked_at, accepted_at, …). */
export function instant(name: string) {
  return timestamp(name, { withTimezone: true })
}
