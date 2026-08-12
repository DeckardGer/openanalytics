import { createHash } from 'node:crypto'
import { ApiError } from '@openanalytics/contracts'
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  releaseIdempotencyKey,
  type Database,
} from '@openanalytics/postgres'
import type { MiddlewareHandler } from 'hono'
import type { ApiVariables } from './middleware.ts'

/**
 * The inbound `Idempotency-Key` boundary (docs snapshot 02 §18).
 *
 * The ledger itself is in `packages/postgres` and knows nothing about HTTP; this
 * is the HTTP half: read the header, hash the request, and map the ledger's four
 * outcomes onto responses. Generic on purpose — `scope` names the operation, so
 * every later create endpoint wraps itself the same way.
 *
 * Ordering matters. The middleware needs `c.get('user')`, so it is registered
 * *after* the session middleware: the key is scoped per user, and a key one
 * account presents must never collide with, or replay, another account's.
 *
 * The request hash is over the canonical request — method, path, and the JSON
 * body with object keys sorted recursively. Sorting is what makes the hash a
 * statement about the *request* rather than about how a client happened to
 * serialize it: `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same create, and a
 * retry that reordered its fields must replay rather than be told it conflicts.
 * Sorting only at the top level would leave that hole one nesting level down.
 *
 * A failed handler releases its claim, so a caller who sent a bad payload can
 * correct it and retry with the same key. That is why the release is keyed on
 * the response status and not only on a thrown error: a route that refuses with
 * `throw new ApiError(...)` has that error turned into a 4xx response by the
 * shared error handler before `next()` returns here.
 */

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

/** Bounds from the contract's `IdempotencyKey` parameter. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 1
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255

/**
 * Recursively orders object keys so two equal requests serialize identically.
 *
 * Arrays keep their order — `['a','b']` and `['b','a']` are different domain
 * lists, not the same one written twice.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    const ordered: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      ordered[key] = canonicalize(source[key])
    }
    return ordered
  }
  return value
}

/**
 * SHA-256 over the canonical request. Never the request itself: the ledger row
 * is a fingerprint, so a stored key cannot become a copy of a payload.
 */
export function canonicalRequestHash(input: {
  method: string
  path: string
  body: unknown
}): string {
  const canonical = JSON.stringify([
    input.method.toUpperCase(),
    input.path,
    canonicalize(input.body),
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export interface IdempotentOptions {
  readonly db: Database
  /** The operation the key is scoped to, e.g. `sites.create`. */
  readonly scope: string
}

type Env = { Variables: ApiVariables }

/**
 * Wraps a handler with the `Idempotency-Key` ledger.
 *
 * Absent header → the handler runs unchanged and no ledger row is written.
 * Sending a key is the client opting in, and an endpoint that wrote a row for
 * every request would accumulate state nobody asked for.
 */
export function idempotent(options: IdempotentOptions): MiddlewareHandler<Env> {
  const { db, scope } = options

  return async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_KEY_HEADER)
    if (key === undefined) {
      await next()
      return undefined
    }
    if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN_LENGTH}–${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
        { details: { issues: [{ field: 'Idempotency-Key', code: 'invalid' }] } },
      )
    }

    const user = c.get('user')

    // Read the body as text and parse it here rather than calling `c.req.json()`:
    // an unparseable body must not reject inside the ledger path, and Hono caches
    // the raw body, so the handler's own `readJson` still sees it.
    let body: unknown = null
    try {
      body = JSON.parse(await c.req.text())
    } catch {
      // Not JSON. The handler will refuse it; hashing `null` is enough to keep
      // the key's identity stable for the retry that follows.
      body = null
    }

    const ref = { userId: user.id, scope, key }
    const claim = await claimIdempotencyKey(db, {
      ...ref,
      requestHash: canonicalRequestHash({ method: c.req.method, path: c.req.path, body }),
    })

    if (claim.status === 'conflict') {
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used with a different request payload',
      )
    }

    if (claim.status === 'in_progress') {
      // Deterministic and safe: the first request is still running, so there is
      // no stored answer to replay and running the handler again would create a
      // second site. The client retries once the first finishes and gets the
      // replay then.
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'A request with this Idempotency-Key is still in flight',
        { details: { reason: 'in_progress' } },
      )
    }

    if (claim.status === 'replay') {
      // Verbatim: the stored status and body, not a freshly computed one. The
      // caller must be unable to tell a replay from the original. Built through
      // the context so the response still carries this request's own
      // `x-request-id` — a replay is a different request with the same answer.
      const replayed = claim.responseBody === null ? null : JSON.stringify(claim.responseBody)
      return c.newResponse(
        replayed,
        claim.responseStatus as 201,
        replayed === null ? undefined : { 'content-type': 'application/json; charset=UTF-8' },
      )
    }

    try {
      await next()
    } catch (error) {
      // A non-Error throw bypasses the shared error handler, so the claim is
      // released here too; otherwise the key would be held by a request that
      // produced no response at all.
      await releaseIdempotencyKey(db, ref)
      throw error
    }

    const status = c.res.status
    if (status < 200 || status >= 300) {
      await releaseIdempotencyKey(db, ref)
      return undefined
    }

    let stored: Record<string, unknown> | null = null
    try {
      stored = (await c.res.clone().json()) as Record<string, unknown>
    } catch {
      // A bodiless success (204) replays as a bodiless success.
      stored = null
    }
    await completeIdempotencyKey(db, { ...ref, responseStatus: status, responseBody: stored })
    return undefined
  }
}
