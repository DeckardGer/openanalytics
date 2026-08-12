import {
  EMAIL_OUTBOX_TOPIC,
  buildMagicLinkEmailPayload,
  buildVerificationEmailPayload,
  createResendTransport,
  createSmtpTransport,
  parseEmailOutboxPayload,
  processEmailOutbox,
  selectEmailTransport,
  type DueOutboxRow,
  type EmailMessage,
  type EmailOutboxStore,
  type SmtpMailer,
  type SmtpTransportConfig,
} from '@openanalytics/integrations'
import { describe, expect, it, vi } from 'vitest'

/** Captures the config a selection produced and never opens a socket. */
function recordingMailerFactory(): {
  factory: (config: SmtpTransportConfig) => SmtpMailer
  configs: SmtpTransportConfig[]
  sent: { from: string; to: string }[]
} {
  const configs: SmtpTransportConfig[] = []
  const sent: { from: string; to: string }[] = []
  return {
    configs,
    sent,
    factory: (config) => {
      configs.push(config)
      return {
        async sendMail(message) {
          sent.push({ from: message.from, to: message.to })
          return { messageId: '<abc@relay>' }
        },
      }
    },
  }
}

describe('email transport selection', () => {
  it('falls back to the log transport when nothing is configured', () => {
    const transport = selectEmailTransport({ defaultFrom: 'noreply@test' })
    expect(transport.id).toBe('log')
  })

  it('uses Resend when a key is present', () => {
    const transport = selectEmailTransport({ apiKey: 're_test', defaultFrom: 'noreply@test' })
    expect(transport.id).toBe('resend')
  })

  it('uses SMTP when a host is present and no Resend key is', () => {
    const transport = selectEmailTransport({
      smtp: { host: 'mail.test' },
      defaultFrom: 'noreply@test',
      smtpMailerFactory: recordingMailerFactory().factory,
    })
    expect(transport.id).toBe('smtp')
  })

  it('an SMTP block with no host is not a configured transport', () => {
    const transport = selectEmailTransport({
      smtp: { port: 587, user: 'someone' },
      defaultFrom: 'noreply@test',
    })
    expect(transport.id).toBe('log')
  })

  it('prefers Resend over SMTP and says so, rather than silently rerouting', () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const transport = selectEmailTransport({
      apiKey: 're_test',
      smtp: { host: 'mail.test' },
      defaultFrom: 'noreply@test',
      log: (event, fields) => events.push({ event, fields }),
    })
    expect(transport.id).toBe('resend')
    expect(events).toEqual([
      { event: 'email_transport_conflict', fields: { chose: 'resend', ignored: 'smtp' } },
    ])
  })

  it('defaults the port to submission and derives implicit TLS from it', async () => {
    const recorder = recordingMailerFactory()
    await selectEmailTransport({
      smtp: { host: 'mail.test' },
      defaultFrom: 'noreply@test',
      smtpMailerFactory: recorder.factory,
    }).send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

    expect(recorder.configs[0]).toMatchObject({ port: 587, secure: false })
  })

  it('turns implicit TLS on for port 465 without being told to', async () => {
    const recorder = recordingMailerFactory()
    await selectEmailTransport({
      smtp: { host: 'mail.test', port: 465 },
      defaultFrom: 'noreply@test',
      smtpMailerFactory: recorder.factory,
    }).send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

    expect(recorder.configs[0]).toMatchObject({ port: 465, secure: true })
  })

  it('lets an explicit SMTP_SECURE override the port-derived default', async () => {
    const recorder = recordingMailerFactory()
    await selectEmailTransport({
      smtp: { host: 'mail.test', port: 465, secure: false },
      defaultFrom: 'noreply@test',
      smtpMailerFactory: recorder.factory,
    }).send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

    expect(recorder.configs[0]).toMatchObject({ secure: false })
  })

  it('prefers SMTP_FROM over EMAIL_FROM, for relays that refuse a foreign sender', async () => {
    const recorder = recordingMailerFactory()
    await selectEmailTransport({
      smtp: { host: 'mail.test', from: 'relay-account@mail.test' },
      defaultFrom: 'Brand <hello@brand.test>',
      smtpMailerFactory: recorder.factory,
    }).send({ to: 'a@b.com', subject: 's', html: '<p>h</p>' })

    expect(recorder.sent[0]?.from).toBe('relay-account@mail.test')
  })
})

describe('SMTP transport', () => {
  const config: SmtpTransportConfig = {
    host: 'mail.test',
    port: 587,
    secure: false,
    defaultFrom: 'noreply@test',
  }
  const message: EmailMessage = { to: 'a@b.com', subject: 's', html: '<p>h</p>' }

  it("returns the relay's message id on success", async () => {
    const transport = createSmtpTransport(config, () => ({
      sendMail: async () => ({ messageId: '<id@relay>' }),
    }))
    expect(await transport.send(message)).toEqual({ ok: true, id: '<id@relay>' })
  })

  it('builds the client once across sends rather than per message', async () => {
    const recorder = recordingMailerFactory()
    const transport = createSmtpTransport(config, recorder.factory)
    await transport.send(message)
    await transport.send(message)
    expect(recorder.configs).toHaveLength(1)
    expect(recorder.sent).toHaveLength(2)
  })

  it('authenticates only with a complete credential', async () => {
    const recorder = recordingMailerFactory()
    await createSmtpTransport({ ...config, user: 'someone' }, recorder.factory).send(message)
    expect(recorder.configs[0]?.pass).toBeUndefined()
  })

  it('maps auth, permanent and transient failures to the same reasons Resend uses', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ code: 'EAUTH', responseCode: 535 }, 'unauthorized'],
      [{ responseCode: 530 }, 'unauthorized'],
      [{ responseCode: 550 }, 'invalid'],
      [{ responseCode: 421 }, 'unavailable'],
      [{ code: 'ECONNECTION' }, 'unavailable'],
      [{ code: 'ETIMEDOUT' }, 'unavailable'],
      [{}, 'unavailable'],
    ]
    for (const [thrown, reason] of cases) {
      const transport = createSmtpTransport(config, () => ({
        sendMail: async () => {
          throw Object.assign(new Error('boom'), thrown)
        },
      }))
      const outcome = await transport.send(message)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason, JSON.stringify(thrown)).toBe(reason)
    }
  })

  it('never lets the relay reply text out — a reply to AUTH can echo the credential', async () => {
    const transport = createSmtpTransport(config, () => ({
      sendMail: async () => {
        throw Object.assign(new Error('535 5.7.8 Username and Password not accepted'), {
          code: 'EAUTH',
          responseCode: 535,
          response: '535 5.7.8 rejected credential hunter2',
        })
      },
    }))
    const outcome = await transport.send(message)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.detail).not.toContain('hunter2')
      expect(outcome.detail).not.toContain('Username')
      expect(outcome.detail).toContain('535')
    }
  })
})

describe('log transport', () => {
  it('captures messages and never logs the raw recipient', async () => {
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const transport = selectEmailTransport({
      defaultFrom: 'noreply@test',
      log: (event, fields) => events.push({ event, fields }),
    })

    const outcome = await transport.send({
      to: 'person@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
    })

    expect(outcome.ok).toBe(true)
    const logged = events[0]
    expect(logged?.fields).toMatchObject({ recipientDomain: 'example.com' })
    // The hard rule: no raw address anywhere in the log line.
    expect(JSON.stringify(events)).not.toContain('person@example.com')
  })
})

describe('Resend transport', () => {
  const config = { apiKey: 're_test', defaultFrom: 'noreply@test' }
  const message: EmailMessage = { to: 'a@b.com', subject: 's', html: '<p>h</p>' }

  it('returns the provider id on success', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: 're_123' }), { status: 200 }),
    )
    const outcome = await createResendTransport(config, fetchImpl as unknown as typeof fetch).send(
      message,
    )
    expect(outcome).toEqual({ ok: true, id: 're_123' })
  })

  it('maps auth, server and client errors to typed reasons', async () => {
    const cases: [number, string][] = [
      [401, 'unauthorized'],
      [503, 'unavailable'],
      [422, 'invalid'],
    ]
    for (const [status, reason] of cases) {
      const fetchImpl = vi.fn(async () => new Response('nope', { status }))
      const outcome = await createResendTransport(
        config,
        fetchImpl as unknown as typeof fetch,
      ).send(message)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe(reason)
    }
  })

  it('treats a transport error as retryable-unavailable, not a throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const outcome = await createResendTransport(config, fetchImpl as unknown as typeof fetch).send(
      message,
    )
    expect(outcome).toEqual({ ok: false, reason: 'unavailable', detail: 'resend request failed' })
  })
})

describe('email outbox payload', () => {
  it('builds a verification payload from typed config, not a hard-coded brand', () => {
    const payload = buildVerificationEmailPayload({
      to: 'u@x.com',
      url: 'https://api.test/verify?token=abc',
      productName: 'Acme Metrics',
    })
    expect(payload.kind).toBe('verification')
    expect(payload.subject).toContain('Acme Metrics')
    expect(payload.html).toContain('https://api.test/verify?token=abc')
  })

  it('builds a magic-link payload that promises sign-in, never sign-up', () => {
    const payload = buildMagicLinkEmailPayload({
      to: 'u@x.com',
      url: 'https://api.test/magic-link/verify?token=abc',
      productName: 'Acme Metrics',
    })
    expect(payload.kind).toBe('magic_link')
    expect(payload.subject).toContain('Acme Metrics')
    expect(payload.html).toContain('https://api.test/magic-link/verify?token=abc')
    // One email serves both faces of the door; the copy must not promise
    // account creation to someone who already has one.
    expect(payload.html.toLowerCase()).not.toContain('sign up')
    expect(parseEmailOutboxPayload(payload)).toEqual(payload)
  })

  it('rejects a malformed payload', () => {
    expect(() => parseEmailOutboxPayload({ kind: 'verification', to: 'x' })).toThrow()
    expect(() => parseEmailOutboxPayload(null)).toThrow()
  })
})

describe('processEmailOutbox', () => {
  function fakeStore(rows: DueOutboxRow[]): EmailOutboxStore & {
    delivered: string[]
    failed: { id: string; reason: string }[]
  } {
    const delivered: string[] = []
    const failed: { id: string; reason: string }[] = []
    return {
      delivered,
      failed,
      claimDue: async () => rows,
      markDelivered: async (id) => {
        delivered.push(id)
      },
      markFailed: async (id, reason) => {
        failed.push({ id, reason })
      },
    }
  }

  it('delivers valid rows through the transport and fails malformed ones', async () => {
    const store = fakeStore([
      {
        id: 'ok-1',
        payload: { kind: 'verification', to: 'a@b.com', subject: 's', html: '<p>h</p>' },
      },
      { id: 'bad-1', payload: { kind: 'nonsense' } },
    ])
    const transport = selectEmailTransport({ defaultFrom: 'noreply@test' })

    const result = await processEmailOutbox({ store, transport })

    expect(result).toEqual({ claimed: 2, delivered: 1, failed: 1 })
    expect(store.delivered).toEqual(['ok-1'])
    expect(store.failed).toEqual([{ id: 'bad-1', reason: 'invalid_payload' }])
  })

  it('marks a row failed on a provider failure without throwing', async () => {
    const store = fakeStore([
      {
        id: 'ok-1',
        payload: { kind: 'verification', to: 'a@b.com', subject: 's', html: '<p>h</p>' },
      },
    ])
    const transport = {
      id: 'stub',
      send: async () => ({ ok: false as const, reason: 'unavailable' as const, detail: 'down' }),
    }

    const result = await processEmailOutbox({ store, transport })

    expect(result.delivered).toBe(0)
    expect(store.failed).toEqual([{ id: 'ok-1', reason: 'unavailable' }])
  })
})

describe('outbox topic', () => {
  it('is a stable constant', () => {
    expect(EMAIL_OUTBOX_TOPIC).toBe('email.send')
  })
})
