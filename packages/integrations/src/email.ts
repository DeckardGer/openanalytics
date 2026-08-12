/**
 * Transactional email transport.
 *
 * G-007 closed the provider to Resend, but the provider stays behind this
 * adapter so a change does not reach domain code. Two rules from the wider
 * design apply here:
 *
 * - Every send goes through the outbox (docs snapshot 02 §6). This module only
 *   *delivers* a message; the auth flow enqueues it. Nothing calls a transport
 *   directly on a request path.
 * - No raw recipient in logs (docs snapshot 02 §26). The log transport records a
 *   subject and the recipient's domain, never the full address.
 *
 * When no transport is configured the log transport is used, and that is the
 * default in tests (plan Milestone 2 item 2).
 *
 * ## Three transports, one seam
 *
 * Resend is what our own deployment runs, and it is not what a self-hosted
 * deployment can run: it needs an account, a verified domain and a key. Until
 * SMTP existed here, the only door into a fresh install — the magic link — had
 * nowhere to be delivered, so nobody could sign in at all. SMTP is the
 * lowest-common-denominator transport every mail host on earth speaks, so it is
 * the one that makes the product installable.
 *
 * `selectEmailTransport` prefers Resend when both are configured. That is the
 * conservative direction: our deployment sets `RESEND_API_KEY` and no SMTP
 * block, and a stray `SMTP_HOST` in a worker env must not silently reroute
 * production mail through a host nobody meant to send from.
 */

import { createTransport } from 'nodemailer'

/** A structured log sink, narrowed to what a transport needs, so this package
 * does not depend on the observability package. */
export type EmailLogFn = (event: string, fields: Record<string, unknown>) => void

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly html: string
  readonly text?: string
  /** Overrides the transport's default sender when set. */
  readonly from?: string
}

export type EmailSendOutcome =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false
      /** Categorized, safe reason — never a raw provider error body. */
      readonly reason: 'unavailable' | 'invalid' | 'unauthorized'
      readonly detail: string
    }

export interface EmailTransport {
  readonly id: string
  send(message: EmailMessage): Promise<EmailSendOutcome>
}

export interface ResendTransportConfig {
  readonly apiKey: string
  readonly defaultFrom: string
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

/**
 * Resend over `fetch`, with no SDK dependency. A provider failure is a typed
 * outcome, not a thrown error or a silent success: only a 5xx or a transport
 * error is retryable, and the raw response body never leaves this function.
 */
export function createResendTransport(
  config: ResendTransportConfig,
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    id: 'resend',
    async send(message) {
      let response: Response
      try {
        response = await fetchImpl(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: message.from ?? config.defaultFrom,
            to: message.to,
            subject: message.subject,
            html: message.html,
            ...(message.text === undefined ? {} : { text: message.text }),
          }),
        })
      } catch {
        return { ok: false, reason: 'unavailable', detail: 'resend request failed' }
      }

      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: 'unauthorized', detail: `resend responded ${response.status}` }
      }
      if (response.status >= 500) {
        return { ok: false, reason: 'unavailable', detail: `resend responded ${response.status}` }
      }
      if (!response.ok) {
        return { ok: false, reason: 'invalid', detail: `resend responded ${response.status}` }
      }

      const body = (await response.json().catch(() => null)) as { id?: string } | null
      return { ok: true, id: body?.id ?? 'unknown' }
    },
  }
}

export interface SmtpTransportConfig {
  readonly host: string
  /** 587 (submission, upgraded with STARTTLS) or 465 (implicit TLS). */
  readonly port: number
  /**
   * TLS from the first byte. `false` does **not** mean plaintext: nodemailer
   * still upgrades with STARTTLS when the server advertises it, which is the
   * whole of how port 587 works. Set it for 465, leave it for 587.
   */
  readonly secure: boolean
  /**
   * Both or neither. A relay on the same host frequently wants no credential at
   * all, and half a credential is a configuration mistake worth not sending
   * with — `createSmtpTransport` authenticates only when both are present.
   */
  readonly user?: string | undefined
  readonly pass?: string | undefined
  readonly defaultFrom: string
}

/**
 * The one method this module needs from a mail client, named here so the
 * provider library stays an implementation detail.
 *
 * It exists for the same reason `fetchImpl` exists on the Resend transport: the
 * send path is testable without a socket. It is not an abstraction over mail
 * clients — nothing else will ever implement it in production.
 */
export interface SmtpMailer {
  sendMail(message: {
    from: string
    to: string
    subject: string
    html: string
    text?: string | undefined
  }): Promise<{ messageId?: string | undefined }>
}

export type SmtpMailerFactory = (config: SmtpTransportConfig) => SmtpMailer

/**
 * The shape a failed nodemailer send carries. Read defensively — every field is
 * optional, and none of them is ever surfaced verbatim.
 */
interface SmtpErrorLike {
  readonly code?: unknown
  readonly responseCode?: unknown
}

/** SMTP replies that mean "the credential is wrong", not "the message is". */
const SMTP_AUTH_REPLY_CODES = new Set([530, 534, 535, 538])

/** nodemailer's own error codes for a connection that never carried a session. */
const SMTP_CONNECTION_ERROR_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ECONNREFUSED',
])

/**
 * Maps a thrown SMTP failure onto the same three reasons the Resend transport
 * reports, so `processEmailOutbox` retries and gives up on the same rules
 * whichever transport is configured.
 *
 * The classification is deliberately narrow about `detail`: nodemailer attaches
 * the server's raw reply text to `err.response`, and a reply to `AUTH` can echo
 * the credential that was offered. Only the numeric reply code and nodemailer's
 * own error code — both fixed vocabularies — cross this boundary.
 */
function classifySmtpFailure(err: unknown): {
  reason: 'unavailable' | 'invalid' | 'unauthorized'
  detail: string
} {
  const { code, responseCode } = (err ?? {}) as SmtpErrorLike
  const replyCode = typeof responseCode === 'number' ? responseCode : undefined
  const errorCode = typeof code === 'string' ? code : undefined

  if (errorCode === 'EAUTH' || (replyCode !== undefined && SMTP_AUTH_REPLY_CODES.has(replyCode))) {
    return {
      reason: 'unauthorized',
      detail: `smtp rejected the credential (${replyCode ?? 'EAUTH'})`,
    }
  }
  if (errorCode !== undefined && SMTP_CONNECTION_ERROR_CODES.has(errorCode)) {
    return { reason: 'unavailable', detail: `smtp connection failed (${errorCode})` }
  }
  // 4xx is SMTP's "try again later" and 5xx its "never"; the outbox treats the
  // first as retryable and the second as a dead row, which is the same split.
  if (replyCode !== undefined && replyCode >= 500) {
    return { reason: 'invalid', detail: `smtp responded ${replyCode}` }
  }
  if (replyCode !== undefined) {
    return { reason: 'unavailable', detail: `smtp responded ${replyCode}` }
  }
  return { reason: 'unavailable', detail: `smtp send failed (${errorCode ?? 'unknown'})` }
}

/**
 * SMTP through nodemailer, with the same typed-outcome contract as Resend: a
 * provider failure is a categorized value, never a thrown error, and the raw
 * server reply never leaves this function.
 *
 * **Why a dependency here and not for Resend.** Resend is one authenticated
 * `POST`, so `fetch` was the whole client. SMTP is a stateful line protocol with
 * a TLS upgrade negotiated mid-session, SASL, dot-stuffing, and a 998-octet line
 * limit that any real HTML body exceeds — a hand-rolled client would be the
 * least-tested code in the repository on the one path a self-hosted install
 * cannot log in without. nodemailer is the standard, MIT-0, and has zero runtime
 * dependencies of its own, so it adds exactly one package to the tree.
 *
 * The client is built once per transport rather than per send: nodemailer pools
 * nothing by default but does reuse the resolved configuration, and rebuilding
 * it per message would re-run TLS negotiation for every outbox row.
 */
export function createSmtpTransport(
  config: SmtpTransportConfig,
  mailerFactory: SmtpMailerFactory = createNodemailerMailer,
): EmailTransport {
  let mailer: SmtpMailer | undefined
  return {
    id: 'smtp',
    async send(message) {
      try {
        mailer ??= mailerFactory(config)
        const info = await mailer.sendMail({
          from: message.from ?? config.defaultFrom,
          to: message.to,
          subject: message.subject,
          html: message.html,
          ...(message.text === undefined ? {} : { text: message.text }),
        })
        return { ok: true, id: info.messageId ?? 'unknown' }
      } catch (err) {
        const { reason, detail } = classifySmtpFailure(err)
        return { ok: false, reason, detail }
      }
    },
  }
}

/**
 * Timeouts, because nodemailer's defaults are wrong for this caller.
 *
 * Its socket timeout is ten minutes. The worker's drain holds a `running` flag
 * across a tick and `stop()` waits for it, so one unresponsive relay would stall
 * every queued email for ten minutes and make a graceful shutdown take the same.
 * These are the same order as every other outbound deadline in the repository,
 * and the outbox's retry is what covers a send they cut short.
 */
const SMTP_CONNECTION_TIMEOUT_MS = 10_000
const SMTP_GREETING_TIMEOUT_MS = 10_000
const SMTP_SOCKET_TIMEOUT_MS = 30_000

function createNodemailerMailer(config: SmtpTransportConfig): SmtpMailer {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    ...(config.user !== undefined && config.pass !== undefined
      ? { auth: { user: config.user, pass: config.pass } }
      : {}),
  })
}

/** A log transport that also captures sent messages for test assertions. */
export interface LogEmailTransport extends EmailTransport {
  readonly sent: readonly EmailMessage[]
}

export function createLogEmailTransport(log?: EmailLogFn): LogEmailTransport {
  const sent: EmailMessage[] = []
  return {
    id: 'log',
    sent,
    async send(message) {
      sent.push(message)
      const at = message.to.lastIndexOf('@')
      const recipientDomain = at >= 0 ? message.to.slice(at + 1) : 'unknown'
      log?.('email_logged', { transport: 'log', subject: message.subject, recipientDomain })
      return { ok: true, id: `log_${sent.length}` }
    },
  }
}

/**
 * The SMTP half of the environment, before it is known to be complete.
 *
 * A block is "configured" exactly when it names a host — everything else has a
 * defensible default (port 587, STARTTLS, no credential, the deployment's
 * `EMAIL_FROM`), and a host does not.
 */
export interface SmtpEnvBlock {
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly secure?: boolean | undefined
  readonly user?: string | undefined
  readonly pass?: string | undefined
  /**
   * Overrides `defaultFrom` for SMTP only. Relays routinely refuse a `From`
   * that is not the authenticated mailbox, and that address is a property of
   * the relay, not of the product's branding — which is what `EMAIL_FROM` is.
   */
  readonly from?: string | undefined
}

/** The submission port, and the one whose TLS is negotiated rather than implicit. */
export const SMTP_DEFAULT_PORT = 587
/** Implicit TLS is the convention on this port, so it is the `secure` default there. */
export const SMTP_IMPLICIT_TLS_PORT = 465

export interface SelectEmailTransportDeps {
  readonly apiKey?: string | undefined
  readonly smtp?: SmtpEnvBlock | undefined
  readonly defaultFrom: string
  readonly log?: EmailLogFn
  readonly fetchImpl?: typeof fetch
  readonly smtpMailerFactory?: SmtpMailerFactory
}

/**
 * Resend when a key is configured, SMTP when a host is, the log transport
 * otherwise. The log transport being the nothing-configured default is what
 * makes it the default in tests.
 *
 * Resend wins a tie, and says so in the log rather than silently: see the module
 * header for why that direction and not the other.
 */
export function selectEmailTransport(deps: SelectEmailTransportDeps): EmailTransport {
  const smtpHost = deps.smtp?.host
  if (deps.apiKey) {
    if (smtpHost) {
      deps.log?.('email_transport_conflict', { chose: 'resend', ignored: 'smtp' })
    }
    return createResendTransport(
      { apiKey: deps.apiKey, defaultFrom: deps.defaultFrom },
      deps.fetchImpl,
    )
  }
  if (smtpHost) {
    const port = deps.smtp?.port ?? SMTP_DEFAULT_PORT
    return createSmtpTransport(
      {
        host: smtpHost,
        port,
        secure: deps.smtp?.secure ?? port === SMTP_IMPLICIT_TLS_PORT,
        user: deps.smtp?.user,
        pass: deps.smtp?.pass,
        defaultFrom: deps.smtp?.from ?? deps.defaultFrom,
      },
      deps.smtpMailerFactory,
    )
  }
  return createLogEmailTransport(deps.log)
}
