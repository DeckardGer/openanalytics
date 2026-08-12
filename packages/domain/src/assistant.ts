import { z } from 'zod'

/**
 * The assistant's quota, its provider and its bounds (ADR-0046, D5–D7).
 *
 * Every number below is a named environment default rather than a literal in a
 * handler, and for this milestone that is a requirement rather than a style
 * rule. F-306 asks for "at most 20 questions per user per day" **and** for a
 * limit that can later vary by plan; a `20` written into the accept path would
 * satisfy the first clause while making the second a rewrite.
 *
 * **None of the six bounds in D7 is measured, and this file says so rather than
 * presenting them as though they were** — ADR-0043 D7's honesty clause, adopted
 * deliberately. There has never been a real model session against this system.
 * They are set wide enough not to constrain an ordinary question and narrow
 * enough to catch the accident, and the first checkpoint that drives a real
 * session amends the measured distribution into the ADR beside them.
 *
 * The numbers live here rather than in `packages/domain/src/env.ts` for the
 * reason `read-cost.ts` does: a bound with two homes has two answers the day
 * somebody changes one of them. `env.ts` declares only `OPENAI_API_KEY`,
 * `ASSISTANT_MODEL` and `OPENAI_BASE_URL` — and declares them without defaults
 * — because that table's job is the per-service secret boundary, not the value.
 */

/**
 * The width of the quota's rolling window, in hourly buckets (ADR-0046 D5).
 *
 * Not a limit and not configurable: it is a *fact* about the ledger, whose
 * predicate is `hour_bucket > date_trunc('hour', now()) - interval '23 hours'` —
 * 23 whole hours plus the current partial one. `GET /v1/assistant/usage` reports
 * it rather than letting a client hardcode "per day", and it lives here so the
 * report and the table cannot disagree about what the window is.
 */
export const ASSISTANT_USAGE_WINDOW_HOURS = 24

export const assistantConfigSchema = z.object({
  /**
   * F-306's number: at most this many questions per user per rolling day.
   *
   * The window is 24 hourly buckets rather than a calendar day (D5), so the
   * limit frees up gradually and the refusal's `Retry-After` is true.
   *
   * No zero. A deployment that does not want an assistant leaves
   * `OPENAI_API_KEY` unset and the routes report themselves unconfigured (D6);
   * a limit of zero would instead leave the endpoint mounted, advertising
   * itself, and refusing every question with a wait that never ends.
   */
  ASSISTANT_DAILY_QUESTION_LIMIT: z.coerce.number().int().min(1).max(10_000).default(20),
  /**
   * Messages the client may send in one request — ten exchanges of history.
   *
   * Past that a conversation has drifted off the question it started from, and
   * the client can start a new one for free: the server stores no conversation
   * (D12), so "start again" costs a request rather than a deletion.
   */
  ASSISTANT_MAX_MESSAGES: z.coerce.number().int().min(1).max(200).default(20),
  /**
   * Characters per message. A question, not a document.
   *
   * Characters rather than bytes because the contract's `maxLength` counts
   * characters — the same unit, so a schema-valid message is never refused for
   * its size alone. A pasted log file is refused legibly instead of being
   * forwarded at cost.
   */
  ASSISTANT_MAX_MESSAGE_CHARS: z.coerce.number().int().min(1).max(100_000).default(4_000),
  /**
   * The whole request body, checked independently of the per-message cap:
   * twenty messages each under 4,000 characters can still be a payload nobody
   * meant to send.
   */
  ASSISTANT_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(32_000),
  /**
   * Rounds of tool calls in one turn — the bound on a loop that is otherwise
   * unbounded.
   *
   * ADR-0043 D6 *measured* a thorough three-site MCP turn at 19 tool calls
   * (`1 + 6n`), and Chat Completions can request several per round, so eight
   * rounds is generous for that shape while still terminating.
   */
  ASSISTANT_MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(50).default(8),
  /**
   * The ceiling on one answer, and therefore on what one question can spend.
   * An answer about traffic numbers, not an essay. Halved from 2,000 on
   * 2026-08-09: live answers were arriving at essay length, and a bound this
   * generous never pushed back. Small answers never touch either value.
   */
  ASSISTANT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(32_000).default(1_000),
  /**
   * The deadline on the whole provider call.
   *
   * Above the query gateway's own deadline so our downstream's typed failure
   * normally surfaces first and this one is the backstop against a hung socket
   * — the shape `QUERY_GATEWAY_TIMEOUT_MS` already uses.
   */
  ASSISTANT_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  /**
   * F-306's model, movable without a deploy of new code.
   *
   * "The provider is configuration" is bounded rather than promised (the
   * ADR-0022 form): any endpoint that speaks the Chat Completions wire protocol
   * is a URL and a model name, and a provider with a *different* wire protocol
   * is a new adapter behind the same interface — a file, not a redesign.
   */
  ASSISTANT_MODEL: z.string().min(1).default('gpt-5.5'),
  /** Where that protocol is spoken. Switching to any Chat-Completions-compatible
   * endpoint — a different vendor, a gateway, a local model server — is this
   * value plus `ASSISTANT_MODEL`. */
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com'),
  /**
   * The provider credential, operator-set and **optional**.
   *
   * Unset means the assistant is unconfigured, and D2 is why that is not a boot
   * failure: the routes mount on every deployment and say what is wrong, rather
   * than being absent — an unmounted `/v1` path answers `401`, which a browser
   * would render as "you are signed out".
   *
   * `min(1)` rather than the 16-character `secret` shape `env.ts` uses for our
   * own keys: this one's length is the provider's to decide, exactly as
   * `STRIPE_SECRET_KEY`'s is.
   */
  OPENAI_API_KEY: z.string().min(1).optional(),
})

export type AssistantConfig = z.infer<typeof assistantConfigSchema>

export function loadAssistantConfig(
  source: Record<string, string | undefined> = process.env,
): AssistantConfig {
  return assistantConfigSchema.parse(source)
}
