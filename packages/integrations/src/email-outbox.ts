import type { EmailLogFn, EmailMessage, EmailTransport } from './email.ts'

/**
 * The outbox representation of an email and its delivery.
 *
 * Verification and invite mail is written to the `outbox` table as a row with
 * this payload, in the same flow as the state change that triggers it, and the
 * worker delivers it by draining the outbox through a transport. This module is
 * the seam between the two and holds no database or provider dependency, so the
 * mapping is unit-testable on its own.
 */

export const EMAIL_OUTBOX_TOPIC = 'email.send'

export interface EmailOutboxPayload {
  readonly kind:
    | 'verification'
    | 'invite'
    | 'magic_link'
    | 'billing_transfer_offer'
    | 'rapid_burn'
    /** A marketing-form submission forwarded to us (ADR-0041). The only kind
     * whose *content* is stranger-supplied; its recipient is not, and that is
     * the distinction the whole endpoint rests on. */
    | 'form_notification'
    /** The operator proving their own mail settings work (migration 0043). The
     * only kind nobody asked to receive — which is why its recipient is always
     * the address of the account that pressed the button, never a field. */
    | 'deployment_test'
  readonly to: string
  readonly subject: string
  readonly html: string
  readonly text?: string
}

export function toEmailMessage(payload: EmailOutboxPayload): EmailMessage {
  return {
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    ...(payload.text === undefined ? {} : { text: payload.text }),
  }
}

/** Validates a stored payload before it is delivered; a malformed row is a
 * delivery failure, not a thrown exception that stalls the whole batch. */
export function parseEmailOutboxPayload(value: unknown): EmailOutboxPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('email outbox payload must be an object')
  }
  const record = value as Record<string, unknown>
  const kind = record['kind']
  const to = record['to']
  const subject = record['subject']
  const html = record['html']
  const text = record['text']

  if (
    kind !== 'verification' &&
    kind !== 'invite' &&
    kind !== 'magic_link' &&
    kind !== 'billing_transfer_offer' &&
    kind !== 'rapid_burn' &&
    kind !== 'form_notification' &&
    kind !== 'deployment_test'
  ) {
    throw new Error('email outbox payload has an unknown kind')
  }
  if (typeof to !== 'string' || typeof subject !== 'string' || typeof html !== 'string') {
    throw new Error('email outbox payload is missing a required string field')
  }
  return { kind, to, subject, html, ...(typeof text === 'string' ? { text } : {}) }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Verification email content. The product name comes from typed config, never a
 * hard-coded brand string (docs snapshot 05, D-005), so a rebrand does not touch
 * this code.
 */
export function buildVerificationEmailPayload(input: {
  to: string
  url: string
  productName: string
}): EmailOutboxPayload {
  const product = escapeHtml(input.productName)
  const url = escapeHtml(input.url)
  return {
    kind: 'verification',
    to: input.to,
    subject: `Verify your ${input.productName} email`,
    html:
      `<p>Confirm your email to finish setting up your ${product} account.</p>` +
      `<p><a href="${url}">Verify email</a></p>`,
    text: `Confirm your email to finish setting up your ${input.productName} account: ${input.url}`,
  }
}

/**
 * Magic-link email content. One email serves both faces of the door — an
 * unknown address gets an account on first click, a known one gets a session —
 * so the copy promises "sign in" and nothing about creating anything. The
 * 15-minute expiry sentence must agree with `MAGIC_LINK_EXPIRES_IN_SECONDS`
 * in `@openanalytics/auth`.
 */
export function buildMagicLinkEmailPayload(input: {
  to: string
  url: string
  productName: string
}): EmailOutboxPayload {
  const product = escapeHtml(input.productName)
  const url = escapeHtml(input.url)
  return {
    kind: 'magic_link',
    to: input.to,
    subject: `Sign in to ${input.productName}`,
    html:
      `<p>Click the link below to sign in to ${product}.</p>` +
      `<p><a href="${url}">Sign in</a></p>` +
      `<p>This link expires in 15 minutes. If you did not request it, ignore this email.</p>`,
    text:
      `Sign in to ${input.productName}: ${input.url}\n` +
      `This link expires in 15 minutes. If you did not request it, ignore this email.`,
  }
}

/** Invitation email content. Like verification, the product and site names come
 * from typed config, not a hard-coded brand (docs snapshot 05, D-005). */
export function buildInviteEmailPayload(input: {
  to: string
  acceptUrl: string
  productName: string
  siteName: string
}): EmailOutboxPayload {
  const product = escapeHtml(input.productName)
  const site = escapeHtml(input.siteName)
  const url = escapeHtml(input.acceptUrl)
  return {
    kind: 'invite',
    to: input.to,
    subject: `You have been invited to ${input.siteName} on ${input.productName}`,
    html:
      `<p>You have been invited to the ${site} site on ${product}.</p>` +
      `<p><a href="${url}">Accept the invitation</a></p>`,
    text: `You have been invited to the ${input.siteName} site on ${input.productName}: ${input.acceptUrl}`,
  }
}

/**
 * The billing-transfer offer notification (ADR-0023).
 *
 * Sent to the nominated owner, because nothing happens until they answer. It
 * names who asked and when the offer lapses: an offer with no visible deadline
 * is one people leave in the inbox, and a seven-day window is only a protection
 * if the person can see it.
 *
 * It deliberately carries no accept link. Accepting means agreeing to pay, the
 * endpoint requires a recent re-authentication, and a one-click link in an email
 * is exactly the shape that gets clicked without reading.
 */
export function buildBillingTransferOfferEmailPayload(input: {
  to: string
  reviewUrl: string
  productName: string
  siteName: string
  /** The offerer's display name, or their address when they have no name. */
  fromName: string
  expiresAt: Date
}): EmailOutboxPayload {
  const product = escapeHtml(input.productName)
  const site = escapeHtml(input.siteName)
  const url = escapeHtml(input.reviewUrl)
  const from = escapeHtml(input.fromName)
  const expires = input.expiresAt.toISOString().slice(0, 10)
  return {
    kind: 'billing_transfer_offer',
    to: input.to,
    subject: `${input.fromName} asks you to take over billing for ${input.siteName}`,
    html:
      `<p>${from} has asked you to become the billing owner of the ${site} site on ${product}.</p>` +
      `<p>If you accept, ${site} moves onto your plan and is counted against its site limit. ` +
      `Nothing changes until you accept.</p>` +
      `<p><a href="${url}">Review the request</a> — it expires on ${expires}.</p>`,
    text:
      `${input.fromName} has asked you to become the billing owner of the ${input.siteName} site ` +
      `on ${input.productName}. If you accept, the site moves onto your plan. Nothing changes ` +
      `until you accept. Review it at ${input.reviewUrl} — it expires on ${expires}.`,
  }
}

/**
 * The rapid-burn notice (G-005; ADR-0021's follow-up, completed by ADR-0030 D1).
 *
 * Sent to the site's billing owner, because they are the only person a usage
 * warning is actionable for. It carries counts and nothing else — no event
 * contents, no page paths — for the same reason the outbox row it is built from
 * does: this is a delivery job rendering a threshold crossing, not a report.
 *
 * It deliberately does not say "you will be cut off". Crossing the daily
 * fraction is not a breach of anything: the plan limit is monthly, the collector
 * keeps accepting past it (D-103's buffer), and the notice exists so a customer
 * finds out on day two rather than on the invoice.
 */
export function buildRapidBurnEmailPayload(input: {
  to: string
  productName: string
  siteName: string
  /** The UTC day the crossing was observed on, `YYYY-MM-DD`. */
  utcDay: string
  /** Billable events counted for the site on that day. */
  dailyBillable: number
  /** The plan's monthly billable-event allowance. */
  windowLimit: number
}): EmailOutboxPayload {
  const product = escapeHtml(input.productName)
  const site = escapeHtml(input.siteName)
  const day = escapeHtml(input.utcDay)
  // Both names are customer-supplied (the site's) or config (the brand), and both
  // are escaped before they reach the HTML body.
  const counted = input.dailyBillable.toLocaleString('en-US')
  const limit = input.windowLimit.toLocaleString('en-US')
  return {
    kind: 'rapid_burn',
    to: input.to,
    subject: `${input.siteName} is using its ${input.productName} plan quickly`,
    html:
      `<p>On ${day} (UTC), ${site} recorded ${counted} billable events — a large share of ` +
      `its monthly allowance of ${limit}.</p>` +
      `<p>Nothing has been blocked and no events were dropped. This is a heads-up so the ` +
      `month does not end in a surprise: if this rate continues, ${site} will reach its ` +
      `${product} plan limit early.</p>`,
    text:
      `On ${input.utcDay} (UTC), ${input.siteName} recorded ${counted} billable events — a ` +
      `large share of its monthly allowance of ${limit}. Nothing has been blocked and no ` +
      `events were dropped; this is a heads-up so the month does not end in a surprise.`,
  }
}

/**
 * A marketing-form submission, forwarded to us (ADR-0041).
 *
 * The one builder in this module whose body is written by a stranger, so it is
 * the one where the escaping is load-bearing rather than defensive: every value
 * goes through `escapeHtml` and lands in the **body only**. The subject is the
 * registry's, unmodified, and `to` is the configured recipient the caller never
 * saw — a submitted value reaches neither.
 *
 * Field order follows the form's declaration rather than the submitted object's
 * key order, so two submissions of the same form read identically however the
 * client happened to serialize them.
 */
export function buildFormNotificationEmailPayload(input: {
  to: string
  subject: string
  formId: string
  /** In the form's declared order; already validated and trimmed. */
  fields: readonly { name: string; value: string }[]
}): EmailOutboxPayload {
  const rows = input.fields
    .map(
      (field) =>
        `<p><strong>${escapeHtml(field.name)}</strong><br>${escapeHtml(field.value).replace(
          /\n/g,
          '<br>',
        )}</p>`,
    )
    .join('')
  const text = input.fields.map((field) => `${field.name}:\n${field.value}`).join('\n\n')
  return {
    kind: 'form_notification',
    to: input.to,
    subject: input.subject,
    html: `<p>New submission from the ${escapeHtml(input.formId)} form.</p>${rows}`,
    text: `New submission from the ${input.formId} form.\n\n${text}`,
  }
}

/**
 * The message the deployment's mail settings prove themselves with.
 *
 * It goes through the outbox like every other send rather than being delivered
 * from the request that asked for it, which is the whole architecture in one
 * decision: the api holds no mail credential (`SMTP_PASS` is on its forbidden
 * list) and the worker is the only process that delivers. So this endpoint
 * cannot report "sent" — it reports "queued", and the operator watches the row.
 * That is slower to answer and it is the honest answer: what it proves is that
 * the transport the *worker* resolved works, which is the thing that was in
 * doubt.
 *
 * The copy says which relay it came from, because an operator testing a change
 * needs to tell this message apart from the one the previous settings sent.
 */
export function buildDeploymentTestEmailPayload(input: {
  to: string
  productName: string
  /** The mail host the worker is expected to deliver through. */
  transportLabel: string
}): EmailOutboxPayload {
  const product = escapeHtml(input.productName)
  const label = escapeHtml(input.transportLabel)
  return {
    kind: 'deployment_test',
    to: input.to,
    subject: `${input.productName} mail is working`,
    html:
      `<p>Your ${product} deployment sent this to prove its mail settings work.</p>` +
      `<p>It was delivered through <strong>${label}</strong>. Invitations, sign-in links and ` +
      `verification email take the same route.</p>`,
    text:
      `Your ${input.productName} deployment sent this to prove its mail settings work. ` +
      `It was delivered through ${input.transportLabel}. Invitations, sign-in links and ` +
      `verification email take the same route.`,
  }
}

export interface DueOutboxRow {
  readonly id: string
  readonly payload: unknown
}

/** The database side of delivery, injected so this orchestration stays testable
 * without Postgres. */
export interface EmailOutboxStore {
  claimDue(limit: number): Promise<readonly DueOutboxRow[]>
  markDelivered(id: string, providerId: string): Promise<void>
  markFailed(id: string, reason: string): Promise<void>
}

export interface ProcessEmailOutboxDeps {
  readonly store: EmailOutboxStore
  readonly transport: EmailTransport
  readonly limit?: number
  readonly log?: EmailLogFn
}

export interface ProcessEmailOutboxResult {
  readonly claimed: number
  readonly delivered: number
  readonly failed: number
}

/**
 * Drains one batch of due email rows through a transport. A malformed payload or
 * a provider failure marks that single row failed and moves on; it never throws
 * the batch away.
 */
export async function processEmailOutbox(
  deps: ProcessEmailOutboxDeps,
): Promise<ProcessEmailOutboxResult> {
  const due = await deps.store.claimDue(deps.limit ?? 20)
  let delivered = 0
  let failed = 0

  for (const row of due) {
    let message: EmailMessage
    try {
      message = toEmailMessage(parseEmailOutboxPayload(row.payload))
    } catch {
      await deps.store.markFailed(row.id, 'invalid_payload')
      failed += 1
      continue
    }

    const outcome = await deps.transport.send(message)
    if (outcome.ok) {
      await deps.store.markDelivered(row.id, outcome.id)
      delivered += 1
    } else {
      deps.log?.('email_delivery_failed', { reason: outcome.reason, outboxId: row.id })
      await deps.store.markFailed(row.id, outcome.reason)
      failed += 1
    }
  }

  return { claimed: due.length, delivered, failed }
}
