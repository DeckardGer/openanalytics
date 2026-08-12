import { z } from 'zod'

/**
 * The request budget for key-authenticated reads (ADR-0042 D6).
 *
 * ADR-0031's own reversal recipe listed "rate limits for unattended callers" as
 * one of the four things that would have to exist. This is that item, closed
 * with a named value rather than a literal dropped into a route — the AGENTS
 * rule that a limit must not appear as an invented default.
 *
 * The numbers are deliberately the public surface's numbers
 * (`PUBLIC_READ_RATE_LIMIT_*`): one plugin polling one admin screen is the same
 * order of traffic as one human watching a share page, and a second pair of
 * values would assert a difference nobody has measured. Like that one, this is
 * an engineering value flagged for the launch rate-limit review, not a G-005
 * ingest abuse ceiling.
 *
 * **The budget is per key id, not per IP.** An unattended caller has a stable
 * credential and an unstable address: a WordPress site behind a shared host, a
 * CDN or a NAT presents an address that belongs to hundreds of unrelated sites,
 * so an IP key would let one noisy neighbour exhaust every other site's budget.
 * The credential is the thing that is actually one caller.
 */

export const readKeyConfigSchema = z.object({
  READ_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(60),
  READ_KEY_RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100_000).default(120),
  /**
   * The OAuth budget (ADR-0043 D6), on the same limiter and a different key
   * prefix.
   *
   * **It deliberately does not inherit the key's 60/120.** ADR-0042 D6's own
   * argument for reusing the public surface's numbers was that the traffic
   * shapes matched — one plugin polling one admin screen is one human watching a
   * share page. Here they visibly do not: one assistant turn can fan out to a
   * dozen tool calls in a few seconds, while an `oa stats` invocation is one
   * request. Inheriting would assert an equivalence that is plainly false.
   *
   * **Measured at CP-tools, 2026-08-06** (the numbers and the method are in
   * ADR-0043 D6). A thorough assistant turn over three sites costs **19** tool
   * calls, and the shape is `1 + 6n` in sites — so a ten-site customer's turn is
   * 61. The burst absorbs about five such turns arriving together; the
   * per-minute rate sustains roughly four of them a minute, which is past what a
   * person and a model produce in conversation.
   *
   * What was *not* measured is the distribution of turns per minute in a real
   * LLM session — there was no model in the loop, only the ceiling one turn can
   * reach. That assumption is recorded as an assumption in D6, and the launch
   * rate-limit review is where it meets production traffic.
   */
  OAUTH_READ_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(240),
  OAUTH_READ_RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100_000).default(360),
})

export type ReadKeyConfig = z.infer<typeof readKeyConfigSchema>

export class ReadKeyConfigError extends Error {
  readonly issues: readonly { path: string; message: string }[]

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }))
    super(
      `Invalid read-key configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
    this.name = 'ReadKeyConfigError'
    this.issues = issues
  }
}

export function loadReadKeyConfig(
  source: Record<string, string | undefined> = process.env,
): ReadKeyConfig {
  const result = readKeyConfigSchema.safeParse(source)
  if (!result.success) throw new ReadKeyConfigError(result.error)
  return result.data
}

/**
 * How stale `api_keys.last_used_at` may be before a read refreshes it
 * (ADR-0042 D7).
 *
 * Minute granularity, so a polling integration costs at most one small indexed
 * `UPDATE` per minute per key. This is the UI signal an owner uses to decide
 * which of three old keys is the live one — not an audit trail, which would need
 * a write per request and which §20 already puts in the audit log.
 *
 * A constant rather than configuration: it is a write-amplification trade-off,
 * not a policy an operator has any reason to tune.
 */
export const READ_KEY_LAST_USED_STALE_SECONDS = 60
