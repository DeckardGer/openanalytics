import { sanitizeUrl } from '@openanalytics/domain'
import type { ClientEvent, EventBatch } from '@openanalytics/contracts'

/**
 * Shared realtime-presence derivation for both ingest paths.
 *
 * The historical batch and the heartbeat both feed presence, and both must send
 * the *same* sanitized page they would persist — a path with no fragment, no
 * credentials and no sensitive query keys (docs snapshot 02 §11, §17). Deriving
 * it in one place keeps the two paths from drifting, and keeps a raw URL out of
 * the realtime store.
 */

/**
 * The sanitized `{ path, title? }` a presence touch carries, or `null` when the
 * page is absent or unparseable. Only the path is stored — the realtime snapshot
 * groups by path, never by the full URL.
 */
export function presencePageFrom(
  page: { url: string; title?: string | undefined } | undefined,
  redactQueryKeys: readonly string[],
): { path: string; title?: string } | null {
  if (page === undefined) return null
  const sanitized = sanitizeUrl(page.url, { redactQueryKeys })
  if (sanitized === null) return null
  return page.title === undefined
    ? { path: sanitized.path }
    : { path: sanitized.path, title: page.title }
}

/**
 * The page a batch's presence touch should reflect: the last page_view by
 * `occurred_at`, breaking a tie toward later array order.
 *
 * A batch may carry several pageviews (a burst flushed together); the visitor's
 * current page is the newest of them. Ties break toward the later array position
 * because that is the order the client produced them in — the last one it built
 * is the one it is on.
 *
 * The index comes back with the event because the caller needs the batch-parallel
 * arrays at the same position — the validated `occurred_at` and whether the
 * enqueue actually accepted this event rather than recognising a retry.
 */
export function lastPageViewOf(batch: EventBatch): { event: ClientEvent; index: number } | null {
  let chosen: { event: ClientEvent; index: number } | null = null
  let chosenAt = Number.NEGATIVE_INFINITY
  batch.events.forEach((event, index) => {
    if (event.type !== 'page_view') return
    const at = Date.parse(event.occurred_at)
    // `>=` so an equal timestamp later in the array wins the tie.
    if (at >= chosenAt) {
      chosen = { event, index }
      chosenAt = at
    }
  })
  return chosen
}
