import { z } from 'zod'

/**
 * Cursor pagination.
 *
 * Docs snapshot 01 §13.4 and 03 §6.4: large visitor/event/transaction/audit
 * listings are cursor-based. Offset pagination over grouped ClickHouse queries
 * gets more expensive the deeper a client pages, and `has_more` computed from an
 * offset count is wrong on the final page.
 */

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

/** Opaque to clients: the encoding is a server implementation detail. */
export const cursorSchema = z.string().min(1).max(512)

export const paginationQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export function cursorPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  })
}

export interface CursorPage<T> {
  items: T[]
  next_cursor: string | null
  has_more: boolean
}

/**
 * Builds a page from a result set fetched with `limit + 1` rows.
 *
 * Over-fetching by one is what makes `has_more` exact on the last page instead
 * of requiring a second count query.
 */
export function buildCursorPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => string,
): CursorPage<T> {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows.slice()
  const last = items.at(-1)
  return {
    items,
    next_cursor: hasMore && last !== undefined ? toCursor(last) : null,
    has_more: hasMore,
  }
}
