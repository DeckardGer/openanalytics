import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Ambient request/job context.
 *
 * Carried implicitly so that deep call sites can log with correlation without
 * every function signature growing a context parameter. Only identifiers live
 * here — never payloads, credentials or PII.
 */

export interface RequestContext {
  readonly requestId: string
  readonly traceId: string
  /** HTTP route pattern or background job type. */
  readonly route?: string | undefined
  /** Set only once authorization resolved it; never taken from client input. */
  readonly siteId?: string | undefined
  readonly userId?: string | undefined
  /**
   * The OAuth client and grant a request authenticated with (ADR-0051 D10,
   * delivering ADR-0048 D5).
   *
   * Set by the api's grant arm once a bearer has resolved to a live grant, so
   * every line the rest of the request produces — and every audit row it writes
   * — names the application that acted. Absent on a session request, which is a
   * person acting directly and has no client to name.
   *
   * `grantId` identifies the *access-token row*, which is the right grain for a
   * request and the wrong one for durable state: Better Auth's refresh grant
   * inserts a new row each time, so a value stored under it would change hourly
   * (ADR-0051 D6).
   */
  readonly clientId?: string | undefined
  readonly grantId?: string | undefined
}

/**
 * A holder rather than the context itself, so that a fact resolved mid-request
 * can be recorded for the *whole* request (see `setRequestContextFields`).
 * `AsyncLocalStorage` propagates a store inwards only; one indirection is what
 * lets an answer found in a nested scope be visible to the frame that will log
 * the request when it finishes.
 */
interface ContextHolder {
  current: RequestContext
}

const storage = new AsyncLocalStorage<ContextHolder>()

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run({ current: context }, fn)
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()?.current
}

/**
 * Merges fields into the current context **for the duration of `fn` only**.
 *
 * The scoped form. Use it when the added field describes the call rather than
 * the request — the matched route pattern at the moment a request is logged,
 * for instance, which must not leak into whatever runs next.
 */
export function withRequestContextFields<T>(fields: Partial<RequestContext>, fn: () => T): T {
  const holder = storage.getStore()
  if (!holder) {
    throw new Error('withRequestContextFields called outside of a request context')
  }
  return storage.run({ current: { ...holder.current, ...fields } }, fn)
}

/**
 * Merges fields into the current context for the **rest of the request**,
 * outward as well as inward.
 *
 * Used when authorization resolves a fact that was true of the request all
 * along and was merely unknown until now — which site it is for, which person
 * or which application is asking. The scoped form cannot express that: a
 * middleware that learns the caller's identity and then calls `next()` returns
 * long before the request is logged, so a field merged only for its own scope
 * is absent from the one line that summarises the request (ADR-0051 D10, which
 * is where this distinction was found).
 *
 * Silently does nothing outside a request context. A background job that
 * happens to call a repository is not an error, and observability must never be
 * the thing that throws.
 */
export function setRequestContextFields(fields: Partial<RequestContext>): void {
  const holder = storage.getStore()
  if (!holder) return
  holder.current = { ...holder.current, ...fields }
}
