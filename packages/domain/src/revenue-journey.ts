/**
 * The journey display contract (docs snapshot 03 §11; ADR-0033, D7). Milestone
 * 12 Checkpoint 5.
 *
 * §11 fixes the wire shape of one timeline entry and one rule about it:
 *
 * ```json
 * {
 *   "event_id": "evt_123",
 *   "occurred_at": "2026-07-20T10:30:00Z",
 *   "name": "pricing_cta_clicked",
 *   "display": { "kind": "button_clicked", "text": "…", "icon": "mouse-pointer" },
 *   "properties": { "page_path": "/pricing" }
 * }
 * ```
 *
 * and: *"the frontend does not invent a sentence from the event name on its
 * own"*. The backend supplies a **stable
 * `display.kind`** plus template data, and the frontend may choose its own icon
 * and colour.
 *
 * ## Why `text` is rendered here and `properties` is still complete
 *
 * §11's own example carries a finished sentence in `display.text`, while D7 says
 * "template data per kind, no server-composed prose". Both are satisfied by
 * doing both: this module renders a **stable, deterministic** `text` from a
 * closed template per kind, and every field the template consumed is also in
 * `properties`. A frontend that wants the server's sentence renders `text`; one
 * that wants to localize renders its own from `display.kind` + `properties` and
 * ignores `text`. Neither has to invent anything, which is the rule both
 * documents are actually protecting.
 *
 * The templates are **pinned by tests**, because `text` is the one field a
 * client may put on screen verbatim: changing a template silently changes what a
 * customer reads, so it should be as hard to do by accident as changing a column
 * name.
 *
 * ## Rules the templates obey
 *
 * - **No money in `text`.** Amounts cross the wire as minor-unit integers plus a
 *   currency (03 §6.5) and are formatted by the client in the reader's locale.
 *   A sentence with a number in it would either duplicate that formatting badly
 *   or pre-divide, and 0018's whole rule is that nothing is pre-divided.
 * - **No pseudonym, ever.** No visitor id, no customer hash, no user id reaches
 *   a rendered string. The journey is about *what happened*, and D-102's boundary
 *   does not soften because the surface is owner-only.
 * - **Total over unknown vocabulary.** A provider status this build has never
 *   seen renders as itself rather than as an empty string, so a new dispute state
 *   degrades to a readable label instead of a blank row.
 */

/**
 * The stable display vocabulary.
 *
 * `conversion` is in the enum and rendered by this module, but **CP5's journey
 * endpoint does not emit one**: the attribution fact stores session entries and
 * the order's money objects, and the `conversion` event that matched it lives in
 * `events_raw` with no id carried onto the attribution row. It is listed and
 * implemented so the frontend's switch is complete on the day an event-grain
 * journey adds it, rather than being a breaking enum change later. ADR-0033 D7's
 * longer list (`page_view`, `custom_event`, `identify`) is the same idea one step
 * further out and is deliberately not committed to here — an enum value nothing
 * can produce is a promise, and three of them is a roadmap.
 */
export const REVENUE_JOURNEY_DISPLAY_KINDS = [
  'session_entry',
  'conversion',
  'revenue_charge',
  'revenue_refund',
  'revenue_dispute',
] as const
export type RevenueJourneyDisplayKind = (typeof REVENUE_JOURNEY_DISPLAY_KINDS)[number]

/**
 * The icon hint, per kind. Kebab-case Lucide names, matching §11's
 * `mouse-pointer`.
 *
 * A *hint*: §11 explicitly allows the frontend to choose its own icon and
 * colour. It is sent anyway so a client that has no opinion renders something
 * coherent, and so two clients render the same journey the same way.
 */
const ICONS: Readonly<Record<RevenueJourneyDisplayKind, string>> = {
  session_entry: 'log-in',
  conversion: 'target',
  revenue_charge: 'credit-card',
  revenue_refund: 'undo-2',
  revenue_dispute: 'alert-triangle',
}

export type JourneyPropertyValue = string | number | boolean | null

export interface RevenueJourneyEntry {
  /**
   * §11's field name, kept literally.
   *
   * It is not always an `events_raw` event id, and that is why the contract's
   * description says what it is per kind: a session entry carries the session id
   * and a money entry carries the provider object id. Both are stable, both are
   * already returned by other surfaces of this API, and neither is a pseudonym.
   */
  readonly event_id: string
  readonly occurred_at: string
  readonly name: string
  readonly display: {
    readonly kind: RevenueJourneyDisplayKind
    readonly text: string
    readonly icon: string
  }
  readonly properties: Readonly<Record<string, JourneyPropertyValue>>
}

export interface SessionEntryInput {
  readonly kind: 'session_entry'
  readonly sessionId: string
  readonly occurredAt: string
  readonly referrerDomain: string
  readonly utmSource: string
  readonly utmMedium: string
  readonly utmCampaign: string
  readonly utmContent: string
  readonly utmTerm: string
  readonly entryPage: string
}

export interface ConversionEntryInput {
  readonly kind: 'conversion'
  readonly eventId: string
  readonly occurredAt: string
  /** The customer's own conversion event name, e.g. `purchase`. */
  readonly name: string
  readonly orderId: string
}

export interface MoneyEntryInput {
  readonly kind: 'revenue_charge' | 'revenue_refund' | 'revenue_dispute'
  readonly objectId: string
  readonly occurredAt: string
  readonly status: string
  readonly currency: string
  readonly amountMinor: number
  readonly reportingCurrency: string
  readonly reportingAmountMinor: number
  /** `ecb | none | unavailable`. `unavailable` is what makes the reporting
   * amount meaningless rather than zero. */
  readonly conversionSource: string
}

export type RevenueJourneyEntryInput = SessionEntryInput | ConversionEntryInput | MoneyEntryInput

/**
 * The human label for a session's acquisition source.
 *
 * Precedence is `utm_source` → `referrer_domain` → `direct`, which is the same
 * order the sources report resolves and the same order a marketer reads: a
 * tagged campaign is what the site itself said about the visit, and it outranks
 * whatever header the browser happened to send.
 */
export function journeySourceLabel(input: {
  readonly utmSource: string
  readonly referrerDomain: string
}): string {
  if (input.utmSource !== '') return input.utmSource
  if (input.referrerDomain !== '') return input.referrerDomain
  return 'direct'
}

/** Charge statuses → the phrase the charge template uses. */
function chargePhrase(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'pending':
      return 'is pending'
    case 'failed':
      return 'failed'
    case 'refunded':
      return 'was fully refunded'
    case 'partially_refunded':
      return 'was partially refunded'
    default:
      // Readable rather than blank: a status this build has not learned about is
      // still information, and a row that renders as "Payment" says nothing.
      return `is ${status}`
  }
}

function refundPhrase(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'was issued'
    case 'pending':
      return 'is pending'
    case 'failed':
      return 'failed'
    case 'canceled':
    case 'cancelled':
      return 'was canceled'
    default:
      return `is ${status}`
  }
}

function disputePhrase(status: string): string {
  switch (status) {
    case 'won':
      return 'was won'
    case 'lost':
      return 'was lost'
    case 'needs_response':
      return 'needs a response'
    case 'under_review':
      return 'is under review'
    case 'charge_refunded':
      return 'was closed by a refund'
    default:
      if (status.startsWith('warning_')) return 'was raised as an early warning'
      return `is ${status}`
  }
}

/**
 * Renders one journey entry.
 *
 * Pure and total: every branch produces a non-empty `text`, so there is no input
 * for which a client receives a blank row.
 */
export function renderRevenueJourneyEntry(input: RevenueJourneyEntryInput): RevenueJourneyEntry {
  switch (input.kind) {
    case 'session_entry': {
      const source = journeySourceLabel(input)
      const text =
        input.entryPage !== ''
          ? `Session from ${source}, landing on ${input.entryPage}`
          : `Session from ${source}`
      return {
        event_id: input.sessionId,
        occurred_at: input.occurredAt,
        name: 'session_entry',
        display: { kind: 'session_entry', text, icon: ICONS.session_entry },
        properties: {
          session_id: input.sessionId,
          source,
          entry_page: input.entryPage,
          referrer_domain: input.referrerDomain,
          utm_source: input.utmSource,
          utm_medium: input.utmMedium,
          utm_campaign: input.utmCampaign,
          utm_content: input.utmContent,
          utm_term: input.utmTerm,
        },
      }
    }
    case 'conversion': {
      return {
        event_id: input.eventId,
        occurred_at: input.occurredAt,
        name: input.name,
        display: {
          kind: 'conversion',
          text: `Conversion “${input.name}” fired`,
          icon: ICONS.conversion,
        },
        properties: { order_id: input.orderId, event_name: input.name },
      }
    }
    default: {
      const phrase =
        input.kind === 'revenue_charge'
          ? `Payment ${chargePhrase(input.status)}`
          : input.kind === 'revenue_refund'
            ? `Refund ${refundPhrase(input.status)}`
            : `Dispute ${disputePhrase(input.status)}`
      return {
        event_id: input.objectId,
        occurred_at: input.occurredAt,
        name: input.kind,
        display: { kind: input.kind, text: phrase, icon: ICONS[input.kind] },
        properties: {
          object_id: input.objectId,
          status: input.status,
          // Minor units and a currency, never a formatted amount (03 §6.5).
          amount_minor: input.amountMinor,
          currency: input.currency,
          // Null rather than zero when there is no usable rate: zero is a number
          // a client would happily add up, and D2c's whole point is that this
          // one is unknown.
          reporting_amount_minor:
            input.conversionSource === 'unavailable' ? null : input.reportingAmountMinor,
          reporting_currency: input.reportingCurrency,
          conversion_source: input.conversionSource,
        },
      }
    }
  }
}
