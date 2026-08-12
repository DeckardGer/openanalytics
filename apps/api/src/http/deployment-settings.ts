import { ApiError } from '@openanalytics/contracts'
import type { ServiceEnv } from '@openanalytics/domain'
import {
  buildDeploymentTestEmailPayload,
  credentialLast4,
  deploymentSettingAad,
  EMAIL_OUTBOX_TOPIC,
  parseStoredEmailSettings,
  SMTP_DEFAULT_PORT,
  SMTP_IMPLICIT_TLS_PORT,
  type CredentialVault,
} from '@openanalytics/integrations'
import {
  clearDeploymentSetting,
  deploymentOperatorUserId,
  enqueueOutbox,
  newId,
  readDeploymentSetting,
  readOutboxDelivery,
  writeDeploymentSetting,
  type Database,
  type DeploymentSettingRow,
  type DeploymentSettingScope,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import type { ApiVariables } from './middleware.ts'
import type { RateLimiter } from './rate-limit.ts'

/**
 * What the operator configures from the dashboard instead of from a file on the
 * host (migration 0043).
 *
 * The self-host dry run found the same wall four times, and it is the shape of
 * the wall that matters rather than any one instance of it: **everything a fresh
 * install needs from a third party is reachable only through an env file that is
 * read once at boot.** Inviting a colleague needs a mail relay; asking the
 * assistant anything needs a model provider; both are `docker compose` edits and
 * a restart, and nothing in the product says so. This is the other door.
 *
 * Three decisions hold it up.
 *
 * **The operator is the oldest account.** There is no role system above a site —
 * memberships are per site, and none of them says who runs the install — so this
 * uses the one fact the deployment already has, and it is the same sentence the
 * first-run screen makes to the person creating that account: whoever claims a
 * fresh deployment first owns it. A column would need a backfill, a bootstrap
 * and a way to move it; when this needs more than one operator it needs an ADR,
 * not a quiet column.
 *
 * **A secret is written and never read back.** The password and the API key go
 * through the same vault a customer's Stripe key does (ADR-0033 D3), and every
 * read surface here returns `secret_last4` and a boolean. There is no endpoint
 * that returns a stored secret, which is what makes "the operator's browser was
 * left open" a smaller event than it would otherwise be.
 *
 * **The test send goes through the outbox.** `SMTP_PASS` is on the api's
 * forbidden list because the worker is the only process that delivers mail, and
 * that boundary is not worth spending on a convenience: this endpoint enqueues,
 * the worker delivers, and the operator watches the row. What it proves is that
 * the transport *the worker resolved* works — which is the thing that was in
 * doubt.
 */

type Env = { Variables: ApiVariables }

/** The three ways this surface can be closed, so the screen can say which. */
export type DeploymentSettingsClosedReason = 'disabled' | 'no_keyring' | 'not_operator'

export interface DeploymentSettingsDeps {
  readonly db: Database
  readonly env: ServiceEnv<'api'>
  /** Absent when `OA_CREDENTIAL_KEYRING` is unset or unusable. */
  readonly vault?: CredentialVault
  readonly testEmailRateLimiter: RateLimiter
}

/** `Name <addr@host>` is accepted by every relay and by Resend, so From allows it.
 * Enough to catch a typo; the relay decides whether it may actually send as it. */
const LOOKS_LIKE_FROM = /^[^<>]*<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$|^[^\s@]+@[^\s@]+\.[^\s@]+$/u

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

function validationFailed(message: string, field: string): never {
  throw new ApiError('VALIDATION_FAILED', message, {
    details: { issues: [{ field, code: 'invalid' }] },
  })
}

/**
 * The three-way secret semantics every write on this surface uses.
 *
 * A form cannot resend a password it was never given, so the field's *absence*
 * has to mean "keep what is stored" — and that leaves no ordinary value for
 * "remove it", which is what `null` is. A string replaces. Getting this wrong in
 * either direction is silent: a merge that treated absence as removal would wipe
 * the relay credential every time somebody corrected the port.
 */
type SecretIntent =
  | { readonly kind: 'keep' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'set'; readonly value: string }

function readSecretIntent(body: Record<string, unknown>, field: string): SecretIntent {
  if (!(field in body)) return { kind: 'keep' }
  const raw = body[field]
  if (raw === null) return { kind: 'clear' }
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') validationFailed('Enter a value, or send null to remove it.', field)
  return { kind: 'set', value }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const parsed = (await request.json().catch(() => null)) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError('VALIDATION_FAILED', 'A JSON request body is required')
  }
  return parsed as Record<string, unknown>
}

/** The stored half of a scope as the dashboard reads it: never the secret. */
function storedJson(row: DeploymentSettingRow | null) {
  if (row === null) return null
  return {
    ...row.settings,
    secret_set: row.encryptedSecret !== null,
    secret_last4: row.secretLast4,
    updated_at: row.updatedAt.toISOString(),
  }
}

export function createDeploymentSettingsRoutes(deps: DeploymentSettingsDeps): Hono<Env> {
  const { db, env } = deps
  const app = new Hono<Env>()

  const closedReason = async (userId: string): Promise<DeploymentSettingsClosedReason | null> => {
    if (env.DEPLOYMENT_SETTINGS !== 'enabled') return 'disabled'
    // Required for the whole surface rather than only for the writes that carry
    // a secret. Half a settings screen — a relay you can name but not
    // authenticate — is a worse answer than a closed one that names the missing
    // variable, and every scope here has a secret in its ordinary case.
    if (deps.vault === undefined) return 'no_keyring'
    const operator = await deploymentOperatorUserId(db)
    // Fails closed on an empty table: no operator means nobody is the operator,
    // not everybody.
    return operator !== null && operator === userId ? null : 'not_operator'
  }

  /** The guard every write and the test send share. */
  const requireOperator = async (userId: string): Promise<CredentialVault> => {
    const reason = await closedReason(userId)
    if (reason === null) return deps.vault as CredentialVault
    throw new ApiError(
      'FORBIDDEN',
      reason === 'disabled'
        ? 'This deployment is configured from its environment.'
        : reason === 'no_keyring'
          ? 'Set OA_CREDENTIAL_KEYRING on the api and the worker first.'
          : 'Only the account that claimed this deployment can change its settings.',
      { details: { reason } },
    )
  }

  /**
   * Everything the deployment screen draws, in one read.
   *
   * `editable: false` and a reason rather than a 403, because this read is what
   * decides whether the screen is offered at all — a member who is not the
   * operator should see no tab, and finding that out should not cost them an
   * error. When it is false the body carries no values at all: a deployment that
   * closed this surface has not agreed to disclose its relay to anyone.
   */
  app.get('/deployment/settings', async (c) => {
    const user = c.get('user')
    const reason = await closedReason(user.id)
    if (reason !== null) return c.json({ editable: false, reason })

    const [email, assistant] = await Promise.all([
      readDeploymentSetting(db, 'email'),
      readDeploymentSetting(db, 'assistant'),
    ])

    return c.json({
      editable: true,
      /**
       * Mail says only what this service can actually see.
       *
       * `SMTP_*` and `RESEND_API_KEY` are on the api's FORBIDDEN_KEYS — the
       * worker delivers mail, so the worker is the only process that holds the
       * relay credential — which means the api genuinely cannot tell whether
       * mail already works from the environment. Reporting `source: none` for
       * that case would be a guess, and the wrong one on our own deployment. So
       * the field is about *this table*, the screen says what it does not know,
       * and the test send is what settles it end to end.
       */
      email: { stored: storedJson(email) },
      assistant: {
        // The api holds `OPENAI_API_KEY` itself (it is the only service that
        // may), so here the environment half is knowable and worth saying.
        source: assistant !== null ? 'database' : env.OPENAI_API_KEY ? 'environment' : 'none',
        stored: storedJson(assistant),
        environment: env.OPENAI_API_KEY
          ? {
              ...(env.ASSISTANT_MODEL ? { model: env.ASSISTANT_MODEL } : {}),
              ...(env.OPENAI_BASE_URL ? { base_url: env.OPENAI_BASE_URL } : {}),
            }
          : null,
      },
    })
  })

  /**
   * Store the mail transport.
   *
   * A whole-row replace: what the form submits is the complete state of the
   * setting, so a field left out is a field cleared. The one exception is the
   * password, for the reason `readSecretIntent` gives.
   */
  app.put('/deployment/settings/email', async (c) => {
    const user = c.get('user')
    const vault = await requireOperator(user.id)
    const body = await readJsonObject(c.req.raw)

    const host = trimmed(body['host'])
    if (host === undefined) validationFailed('Enter the mail server’s hostname.', 'host')
    if (/\s/u.test(host)) validationFailed('A hostname cannot contain spaces.', 'host')

    const rawPort = body['port']
    const port = rawPort === undefined || rawPort === null ? SMTP_DEFAULT_PORT : Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      validationFailed('Enter a port between 1 and 65535.', 'port')
    }

    const rawSecure = body['secure']
    const secure = typeof rawSecure === 'boolean' ? rawSecure : port === SMTP_IMPLICIT_TLS_PORT

    const user_ = trimmed(body['user'])
    const from = trimmed(body['from'])
    if (from !== undefined && !LOOKS_LIKE_FROM.test(from)) {
      validationFailed('Use an address, or “Name <address>”.', 'from')
    }

    const existing = await readDeploymentSetting(db, 'email')
    const intent = readSecretIntent(body, 'password')
    // A username with no password is how an unauthenticated relay is spelled, so
    // it is allowed — but a *new* username beside a kept password is almost
    // always the operator forgetting to retype it, and it fails at the relay
    // rather than here. Named in the response contract instead of guessed at.
    const secret = resolveSecretWrite(intent, existing, vault, 'email')

    const stored = await writeDeploymentSetting(db, {
      scope: 'email',
      settings: {
        host,
        port,
        secure,
        ...(user_ === undefined ? {} : { user: user_ }),
        ...(from === undefined ? {} : { from }),
      },
      ...secret,
      updatedByUserId: user.id,
    })

    c.get('logger')?.info('deployment_setting_written', {
      scope: 'email',
      host,
      port,
      secure,
      authenticated: stored.encryptedSecret !== null,
    })
    return c.json(storedJson(stored))
  })

  /** Store the model provider. Same rules; one fewer field. */
  app.put('/deployment/settings/assistant', async (c) => {
    const user = c.get('user')
    const vault = await requireOperator(user.id)
    const body = await readJsonObject(c.req.raw)

    const model = trimmed(body['model'])
    const baseUrl = trimmed(body['base_url'])
    if (baseUrl !== undefined) {
      try {
        const parsed = new URL(baseUrl)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme')
      } catch {
        validationFailed('Enter an http or https URL.', 'base_url')
      }
    }

    const existing = await readDeploymentSetting(db, 'assistant')
    const intent = readSecretIntent(body, 'api_key')
    const secret = resolveSecretWrite(intent, existing, vault, 'assistant')
    // Unlike the relay, a provider with no key is not a configuration — it is
    // the absence of one, and storing it would make the assistant report itself
    // available and then fail on the first question.
    if (secret.encryptedSecret === null) {
      validationFailed('Enter the provider API key.', 'api_key')
    }

    const stored = await writeDeploymentSetting(db, {
      scope: 'assistant',
      settings: {
        ...(model === undefined ? {} : { model }),
        ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
      },
      ...secret,
      updatedByUserId: user.id,
    })

    c.get('logger')?.info('deployment_setting_written', {
      scope: 'assistant',
      model: model ?? null,
      base_url: baseUrl ?? null,
    })
    return c.json(storedJson(stored))
  })

  /**
   * Remove a scope, so the deployment falls back to its environment.
   *
   * `204` whether or not a row was there. Unusually for this API — the connected
   * apps route answers `404` for the same shape — because the state the caller
   * asked for is the state that now holds, and a screen that offers "use the
   * environment instead" should not have to distinguish "it already was".
   */
  for (const scope of ['email', 'assistant'] as const) {
    app.delete(`/deployment/settings/${scope}`, async (c) => {
      const user = c.get('user')
      await requireOperator(user.id)
      const removed = await clearDeploymentSetting(db, scope)
      if (removed) c.get('logger')?.info('deployment_setting_cleared', { scope })
      return c.body(null, 204)
    })
  }

  /**
   * Send the deployment a test email, addressed to the operator.
   *
   * The recipient is the session's own address and there is no field for it: a
   * deployment-wide send button that took an address would be an open relay for
   * one message, and the question being asked — "does my mail work?" — is
   * answered just as well by the operator's own inbox.
   *
   * Enqueued only. The worker resolves the transport, delivers, and writes the
   * outcome onto the row; `GET .../test/{id}` reads it back.
   */
  app.post('/deployment/settings/email/test', async (c) => {
    const user = c.get('user')
    await requireOperator(user.id)

    // Keyed on the account rather than the address, because the address is the
    // account's. Five a minute is generous for a person pressing a button and
    // narrow enough that the button is not a way to mail somebody repeatedly.
    const window = deps.testEmailRateLimiter.check(`deployment-test:${user.id}`)
    if (!window.allowed) {
      throw new ApiError('RATE_LIMITED', 'Wait a moment before sending another test.', {
        details: { retry_after_seconds: window.retryAfterSeconds },
      })
    }

    const stored = await readDeploymentSetting(db, 'email')
    const storedBlock = stored ? parseStoredEmailSettings(stored.settings) : null
    // Named from the stored row when there is one, and left unnamed otherwise:
    // the api cannot see the worker's relay (`SMTP_HOST` is on its forbidden
    // list), and a label guessed here would appear in the operator's inbox as a
    // fact. "the worker’s own settings" is true in every case it is used.
    const transportLabel = storedBlock?.host ?? 'the worker’s own settings'

    const { id } = await enqueueOutbox(db, {
      topic: EMAIL_OUTBOX_TOPIC,
      payload: {
        ...buildDeploymentTestEmailPayload({
          to: user.email,
          productName: env.PRODUCT_NAME,
          transportLabel,
        }),
      },
      // A fresh key every press, deliberately: the outbox deduplicates on it,
      // and an operator pressing the button again after fixing their relay means
      // "try again" rather than "I did not see the first one".
      idempotencyKey: `deployment-test:${newId()}`,
    })

    c.get('logger')?.info('deployment_test_email_queued', { transport: transportLabel })
    return c.json({ delivery_id: id, to: user.email }, 202)
  })

  /**
   * What became of a test send.
   *
   * The three outbox states map onto the three sentences an operator needs, and
   * the failure reason is the transport's own categorized one — never a raw
   * relay reply, which `classifySmtpFailure` already refuses to let out.
   */
  app.get('/deployment/settings/email/test/:id', async (c) => {
    const user = c.get('user')
    await requireOperator(user.id)

    const row = await readOutboxDelivery(db, c.req.param('id'))
    // The topic **and** the kind, because the topic alone is not the filter it
    // looks like: `EMAIL_OUTBOX_TOPIC` is `email.send`, which is what an
    // invitation, a magic link and a verification are queued under as well, so a
    // topic check would leave this a status endpoint over every message the
    // deployment has ever emailed. `kind` is what separates them, and
    // `deployment_test` is the only one this route serves.
    //
    // Kept as two checks rather than collapsing to the kind: the topic is what
    // says "this id belongs to mail at all", and a future non-mail topic that
    // happened to use the same kind string should not land here.
    if (row === null || row.topic !== EMAIL_OUTBOX_TOPIC || row.kind !== 'deployment_test') {
      throw new ApiError('NOT_FOUND', 'No test send with that id')
    }

    const status =
      row.status === 'delivered'
        ? 'delivered'
        : row.status === 'dead' || row.status === 'failed'
          ? 'failed'
          : 'pending'

    return c.json({
      status,
      attempts: row.attempts,
      // Kept on a pending row too: a send that failed once and is waiting to
      // retry is the most informative state this surface has, and hiding the
      // reason until it dies would waste four minutes of the operator's time.
      reason: row.lastError,
      delivered_at: row.deliveredAt?.toISOString() ?? null,
    })
  })

  return app
}

/**
 * Turns a secret intent into the three columns a write needs.
 *
 * Kept together because they are only ever correct together: a ciphertext
 * without its key version fails the table's CHECK, and a `last4` that does not
 * belong to the stored ciphertext is a display value that lies.
 */
function resolveSecretWrite(
  intent: SecretIntent,
  existing: DeploymentSettingRow | null,
  vault: CredentialVault,
  scope: DeploymentSettingScope,
): { encryptedSecret: string | null; keyVersion: string | null; secretLast4: string } {
  if (intent.kind === 'clear') {
    return { encryptedSecret: null, keyVersion: null, secretLast4: '' }
  }
  if (intent.kind === 'keep') {
    return {
      encryptedSecret: existing?.encryptedSecret ?? null,
      keyVersion: existing?.keyVersion ?? null,
      secretLast4: existing?.secretLast4 ?? '',
    }
  }
  const encrypted = vault.encrypt(intent.value, deploymentSettingAad(scope))
  return {
    encryptedSecret: encrypted.stored,
    keyVersion: encrypted.keyVersion,
    secretLast4: credentialLast4(intent.value),
  }
}
