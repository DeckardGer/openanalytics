/**
 * API metric names.
 *
 * Mirrors `apps/collector/src/metrics.ts` and `apps/realtime/src/metrics.ts`:
 * one table, so an alert rule and the code that fires it cannot drift.
 *
 * This service had none until M18. It built the G-006 sink at startup, handed it
 * to the shared request middleware, and never wrote a counter of its own — so
 * the two §26 signals that live here, "the billing webhook has stopped being
 * processed" and "sign-in mail has stopped being enqueued", had no series to be
 * alerted on at all. `http_requests{route,status_class}` from the middleware is
 * not a substitute: Stripe's webhook answers `200` for *processed* and for
 * *ignored* alike (both acknowledge, so Stripe stops retrying), so the outcome
 * that matters is invisible in the status code.
 *
 * Names are Prometheus-legal — `api_x`, never `api.x`. A dotted name is dropped
 * or repaired by the remote-write exporter rather than published as written, and
 * that is the defect this table was added alongside.
 *
 * Labels are low-cardinality by contract. `outcome`, `provider`, `kind` and
 * `form` are all closed sets fixed in code; nothing here is labelled with a user,
 * a site, a customer or an address.
 */
export const API_METRICS = {
  /**
   * One provider webhook delivery, decided. Labelled `provider` and `outcome`:
   *
   * - `processed` — applied, deduped, or deliberately skipped by the
   *   reconciliation guard. All three acknowledge and all three are healthy.
   * - `ignored` — a delivery we understand and do not act on (an unhandled
   *   event type, a malformed body, a checkout without the references that make
   *   it bindable). Acknowledged, because a retry would be ignored again.
   * - `bad_signature` — the body did not verify. A sustained rate is a rotated
   *   endpoint secret, and it is the only outcome here that is answered 4xx.
   * - `provider_error` — the fetch back to the provider failed, so the row was
   *   left `received` and the delivery answered 5xx *on purpose*: the provider's
   *   own retry is the repair. Sustained, it means the retries are not
   *   succeeding either.
   * - `exception` — the handler threw. Not a designed outcome; it exists so a
   *   bug cannot make deliveries vanish from the counter entirely, which is the
   *   exact shape of "processing stalled" this is here to catch.
   *
   * Rate-of-total is the liveness signal (Stripe delivers continuously on a live
   * account); the outcome split is what says whether it is *working*.
   */
  webhookReceived: 'api_webhook_received',
  /**
   * The `provider_error` outcome again, on a series of its own.
   *
   * Deliberately not just a label filter on the counter above: this is the one
   * outcome where the delivery is neither settled nor refused — the ledger row
   * stays `received` and entitlement depends on a retry we do not control — so
   * it is the series an alert rule keys on, and a rule that keys on it should
   * not have to depend on a label spelling to stay armed.
   */
  webhookProviderError: 'api_webhook_provider_error',

  /**
   * One `POST /v1/notify` submission, decided (ADR-0041). Labelled `form` — the
   * server-side registry's id, so the label set is the deployment's own form
   * count — and `outcome`:
   *
   * `enqueued` | `rejected` (validation) | `rate_limited` | `not_found` |
   * `honeypot`.
   *
   * `honeypot` is counted although the caller is answered exactly like an
   * accept: the endpoint's response must not distinguish the two, but the
   * operator's dashboard must, or a form drowning in bots looks identical to a
   * popular one. `not_found` carries the *requested* id, which is the one label
   * value here that is not from the registry — bounded by the id length cap and
   * by the rate limit charged before the lookup.
   */
  notifySubmission: 'api_notify_submission',

  /**
   * A sign-in mail written to the outbox, labelled `kind`
   * (`magic_link` | `verification`).
   *
   * The api's half of the login path: everything after this row is the worker's
   * drain and Resend, both of which already have counters. What had no counter
   * was the *enqueue*, so "nobody can sign in" and "nobody is trying to sign in"
   * produced the same silence — and the outbox backlog gauge cannot separate
   * them either, since a topic with no rows and a topic nothing writes to look
   * the same from the table.
   */
  authEmailEnqueued: 'api_auth_email_enqueued',
} as const

export type ApiMetric = (typeof API_METRICS)[keyof typeof API_METRICS]
