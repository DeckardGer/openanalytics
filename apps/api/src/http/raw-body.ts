/**
 * Reading a signature-authenticated raw body, with a cap that binds *before* the
 * bytes are materialized.
 *
 * Both webhook receivers on this service — Stripe billing (M3) and the per-site
 * revenue endpoint (ADR-0033, D4) — are authenticated by an HMAC over the raw
 * request body, which means both must read the whole body before they can know
 * whether the caller is entitled to send it. That is unavoidable and it is why
 * the cap matters: without one, `await c.req.text()` buffers whatever an
 * unauthenticated caller cares to send, and the first thing that fails is the
 * process rather than the request.
 *
 * `Content-Length` is checked first so an oversized body is refused **before**
 * it is materialized. It is a hint rather than a guarantee — a chunked request
 * carries none, and a lying one is a lie — so the buffered length is checked
 * again afterwards. The first check is what protects the process from an honest
 * large upload; the second is what makes the limit true.
 *
 * A fully streaming reader that aborts mid-body would be strictly better and is
 * not what Hono's `c.req.text()` offers. What is here bounds the damage to one
 * request's worth of memory at the declared size, which for a `Content-Length`
 * that lies is the platform's own body limit rather than ours — recorded rather
 * than hidden, because the alternative is reimplementing body parsing.
 */

export type CappedBody =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: 'too_large' }

export interface RawBodyRequest {
  header(name: string): string | undefined
  text(): Promise<string>
}

export async function readCappedRawBody(
  req: RawBodyRequest,
  maxBytes: number,
): Promise<CappedBody> {
  const declared = Number(req.header('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Refused without reading a byte of it.
    return { ok: false, reason: 'too_large' }
  }

  const body = await req.text()
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    // Either no `Content-Length` (chunked) or one that understated the body.
    return { ok: false, reason: 'too_large' }
  }
  return { ok: true, body }
}
