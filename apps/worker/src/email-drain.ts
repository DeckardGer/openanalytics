import type { ServiceEnv } from '@openanalytics/domain'
import {
  EMAIL_OUTBOX_TOPIC,
  processEmailOutbox,
  selectEmailTransport,
  type EmailOutboxStore,
} from '@openanalytics/integrations'
import type { Logger } from '@openanalytics/observability'
import {
  claimDueOutbox,
  markOutboxDelivered,
  markOutboxFailed,
  type Database,
} from '@openanalytics/postgres'

/**
 * Email delivery is a worker job (docs snapshot 02 §5): the API only writes the
 * send to the outbox, and this loop drains it through whichever transport the
 * environment configures — Resend, SMTP, or the log transport when neither is
 * set. It is a thin interval over the already-tested `processEmailOutbox`; the
 * correctness of a single drain is proven in the unit and Postgres tests.
 *
 * Which transport is chosen is `selectEmailTransport`'s decision, not this
 * file's: the loop below is the same loop for all three, which is the point of
 * the seam.
 */

const DEFAULT_INTERVAL_MS = 5_000

export function createEmailOutboxStore(db: Database): EmailOutboxStore {
  return {
    claimDue: (limit) => claimDueOutbox(db, { topic: EMAIL_OUTBOX_TOPIC, limit }),
    markDelivered: (id) => markOutboxDelivered(db, id),
    markFailed: (id, reason) => markOutboxFailed(db, id, reason),
  }
}

export interface EmailDrainDeps {
  readonly db: Database
  readonly env: ServiceEnv<'worker'>
  readonly logger: Logger
  readonly intervalMs?: number
}

export interface EmailDrain {
  stop(): Promise<void>
}

export function startEmailDrain(deps: EmailDrainDeps): EmailDrain {
  const store = createEmailOutboxStore(deps.db)
  const log = (event: string, fields: Record<string, unknown>) => deps.logger.info(event, fields)
  const transport = selectEmailTransport({
    apiKey: deps.env.RESEND_API_KEY,
    smtp: {
      host: deps.env.SMTP_HOST,
      port: deps.env.SMTP_PORT,
      secure: deps.env.SMTP_SECURE,
      user: deps.env.SMTP_USER,
      pass: deps.env.SMTP_PASS,
      from: deps.env.SMTP_FROM,
    },
    defaultFrom: deps.env.EMAIL_FROM ?? 'noreply@localhost',
    log,
  })
  // Stated once at startup rather than only on the first drained row. "Mail is
  // silently going nowhere" and "no mail has been queued yet" are the two
  // states a fresh install is most likely to be in, and they look identical
  // until this line names the transport.
  //
  // At `warn` when nothing is configured, because that state is a fault on a
  // real deployment and not a mode: the magic link is a front door, and with
  // the log transport it is never delivered *and* never written down (the log
  // transport records a subject and a recipient domain, deliberately no body
  // and no URL — see `createLogEmailTransport`). A self-hoster who submits
  // their address and then goes looking in the log finds nothing, so the
  // reason has to be in the first place they look, which is boot. The
  // variables are computed rather than listed, so the line cannot outlive the
  // condition it describes.
  if (transport.id === 'log') {
    const missing = [
      ...(deps.env.RESEND_API_KEY ? [] : ['RESEND_API_KEY']),
      ...(deps.env.SMTP_HOST ? [] : ['SMTP_HOST']),
    ]
    deps.logger.warn('email_transport_selected', {
      transport: transport.id,
      missing,
      detail: `no mail transport is configured: set ${missing.join(' or ')} on the worker. Until then nothing is delivered, and the message body and sign-in link are written nowhere.`,
    })
  } else {
    deps.logger.info('email_transport_selected', { transport: transport.id })
  }

  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const result = await processEmailOutbox({ store, transport, log })
      if (result.claimed > 0) {
        deps.logger.info('email_outbox_drained', { ...result, transport: transport.id })
      }
    } catch (err) {
      deps.logger.error('email_outbox_drain_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  // The drain must not by itself keep the process alive.
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
