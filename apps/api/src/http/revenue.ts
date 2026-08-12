import { ApiError } from '@openanalytics/contracts'
import {
  REVENUE_PROVIDERS,
  findRevenueProvider,
  revenueCredentialAad,
  revenueWebhookPath,
  type RevenueAdapter,
  type RevenueAdapterRegistry,
  type RevenueProviderDescriptor,
} from '@openanalytics/domain'
import { credentialLast4, type CredentialVault } from '@openanalytics/integrations'
import {
  createRevenueCredential,
  disconnectRevenueCredential,
  getSiteBasics,
  mintWebhookToken,
  newId,
  readLiveRevenueCredential,
  readRevenueCredential,
  rotateRevenueCredential,
  setRevenueWebhookSecret,
  writeAudit,
  type Database,
  type RevenueCredentialRow,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import { requireCapability, siteMembership, type ApiVariables } from './middleware.ts'

/**
 * The revenue connection surface (ADR-0033, D1/D3/D7).
 *
 * A customer creates a **restricted, read-only key** in their own provider
 * dashboard plus a webhook endpoint pointing at the URL this surface hands back,
 * and pastes both here. What that buys, and why it is the connection model
 * rather than an OAuth one-click, is D1: least privilege the customer can
 * inspect and revoke themselves, and one signing secret per site so a leak has a
 * blast radius of one.
 *
 * Four rules hold across every route here:
 *
 * - **Verify before storing.** A key that does not work is never written. The
 *   probe result decides the answer, and a rejected key (422) and an unreachable
 *   provider (503) are different answers because they have different remedies.
 * - **The secret goes in and never comes out.** The read surface returns
 *   `api_key_last4` and status; there is no route, no field and no error detail
 *   through which a stored credential leaves this service.
 * - **Disconnect is always available.** Two senses, and both are deliberate.
 *   These routes are not behind `requireAnalyticsAccess`, so a `suspended`
 *   site can still sever its provider connection — reading revenue *data* is
 *   what closes with `BILLING_BLOCKED` (D7); managing the credential is not a
 *   read of it. And `GET`/`DELETE` mount **without the keyring** (see
 *   `createRevenueRoutes`): neither touches the vault, disconnect erases
 *   ciphertext *columns* rather than decrypting anything, and a deployment whose
 *   ring went missing must not lose the ability to cut a live provider link.
 * - **A site on its way out accepts no new credential.** `POST` and `PATCH`
 *   refuse a `deleting`/`deleted` site — the same refusal
 *   `requireAnalyticsAccess` gives, without its `suspended` branch. A
 *   credential stored after `startSiteDeletion` erased the ciphertexts would sit
 *   decryptable through the whole purge and be deleted by a target that had
 *   already been verified.
 *
 * Authorization is `credentials:manage` — owner and admin, never viewer — the
 * same capability that already governs the site's API keys and its public share
 * credential. It covers the status read too, because the read carries the
 * webhook URL, and that URL is the address a signed provider payload is
 * delivered to.
 */

type Env = { Variables: ApiVariables }

function providerJson(provider: RevenueProviderDescriptor) {
  return {
    id: provider.id,
    display_name: provider.displayName,
    available: provider.available,
  }
}

/**
 * The provider catalog (D1), on its own mount and with no dependencies.
 *
 * Session-authenticated but not site-scoped, and **mounted unconditionally** —
 * the same reasoning the imports catalog records (ADR-0032, D11). It is a static
 * list that touches neither the keyring nor a provider, and its whole purpose is
 * convergence: the frontend's hardcoded provider list is replaced by this
 * endpoint without a redeploy. Behind the keyring check it would answer 404 on a
 * deployment mid-configuration, and the frontend cannot tell that from "this
 * build is too old", so it would keep rendering the mock list.
 */
export function createRevenueCatalogRoutes(): Hono<Env> {
  const app = new Hono<Env>()
  app.get('/revenue/providers', (c) => c.json({ items: REVENUE_PROVIDERS.map(providerJson) }))
  return app
}

export interface RevenueRoutesDeps {
  readonly db: Database
  /**
   * The api's own public origin, used to build the webhook URL the customer
   * pastes into their provider dashboard.
   *
   * `AUTH_BASE_URL` is what carries it: ADR-0019 established that it is Better
   * Auth's own base and *in production is the api host*, while `APP_BASE_URL`
   * names the frontend. The webhook is delivered to this service, not to the
   * dashboard, so it is the api origin that belongs here.
   */
  readonly apiBaseUrl: string
  /**
   * True when `apiBaseUrl` is the localhost fallback rather than a configured
   * origin. A production deployment in that state would hand every customer a
   * webhook URL pointing at their own machine, and nothing about the response
   * would say so — so each request that builds one warns.
   */
  readonly apiBaseUrlIsFallback?: boolean
  /**
   * The write half: connect and rotate. Present only when
   * `OA_CREDENTIAL_KEYRING` parsed, because both encrypt.
   *
   * `GET` and `DELETE` are registered either way. Neither touches the vault —
   * the status read renders columns, and disconnect *nulls* the ciphertext
   * columns rather than decrypting them — and a deployment whose ring went
   * missing must not thereby lose the ability to sever a live provider link.
   */
  readonly write?: {
    readonly vault: CredentialVault
    /** Composed at startup — `createRevenueAdapterRegistry([...])`. A provider
     * the catalog marks available with no adapter here is a build
     * inconsistency, and it answers 503 rather than storing a credential
     * nothing can use. */
    readonly adapters: RevenueAdapterRegistry
  }
}

function validationFailed(message: string, issues: readonly Record<string, unknown>[]): never {
  throw new ApiError('VALIDATION_FAILED', message, { details: { issues } })
}

async function readJson(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    if (typeof body !== 'object' || body === null) throw new Error('not an object')
    return body as Record<string, unknown>
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'A JSON request body is required')
  }
}

/** A required non-empty secret field, refused before it can reach a provider. */
function requiredSecret(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    validationFailed(`${field} is required`, [{ field, code: 'required' }])
  }
  return value.trim()
}

/**
 * A secret field that may be absent, but may not be present-and-empty.
 *
 * Absent is a statement ("I am not setting this now"); an empty string is a form
 * that submitted a blank box, and storing the ciphertext of `''` would produce a
 * credential that fails every signature check while looking configured.
 */
function optionalSecret(body: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(body, field)) return undefined
  return requiredSecret(body, field)
}

/** A logger handle, as the request context carries it. */
type RequestLogger =
  { warn: (message: string, fields: Record<string, unknown>) => void } | undefined

export function createRevenueRoutes(deps: RevenueRoutesDeps): Hono<Env> {
  const { db, write } = deps
  const app = new Hono<Env>()

  const base = '/sites/:site_id/revenue/connection'

  // Membership first, then the capability on every verb: unlike the analytics
  // surface there is no member-readable half here, because the status view
  // carries the webhook address.
  app.use(base, siteMembership(db), requireCapability('credentials:manage'))

  /**
   * The customer-facing webhook address.
   *
   * `new URL(path, base)` rather than string concatenation: the path is absolute
   * and the base comes from an operator-set environment variable, so a trailing
   * slash on `AUTH_BASE_URL` would otherwise produce a doubled separator in a
   * URL a human is about to paste into Stripe.
   */
  const webhookUrl = (credential: RevenueCredentialRow, logger: RequestLogger): string => {
    if (deps.apiBaseUrlIsFallback === true) {
      // Silence here would mean handing a customer a URL pointing at our own
      // loopback interface, with a perfectly successful-looking 200 around it.
      logger?.warn('revenue_webhook_url_uses_fallback_base', {
        site_id: credential.siteId,
        reason: 'AUTH_BASE_URL missing',
      })
    }
    return new URL(
      revenueWebhookPath(credential.provider, credential.webhookToken),
      deps.apiBaseUrl,
    ).toString()
  }

  /**
   * The wire shape of a connection. **Never carries a secret** — this is the
   * function the "no secret ever appears in a response" test pins.
   *
   * `webhook_url` is null for a disabled credential: the token still exists on
   * the row (so a provider still posting to the old address is acked and
   * ignored rather than 404'd into a retry storm), but publishing it beside a
   * dead connection would invite somebody to paste it into a dashboard.
   *
   * `webhook_secret_set` is a **boolean about a secret, never a piece of one**.
   * It exists because the connect flow is two steps and the UI has to know which
   * one the customer is on: a connection with `webhook_url` and no signing
   * secret is a normal, working, half-finished connection, and the screen that
   * shows it needs to say "now create the endpoint and paste the secret" rather
   * than either "connected" or "broken".
   */
  const connectionJson = (credential: RevenueCredentialRow, logger: RequestLogger) => ({
    provider: credential.provider,
    status: credential.status,
    api_key_last4: credential.apiKeyLast4,
    webhook_secret_set: credential.encryptedWebhookSecret !== null,
    webhook_url: credential.status === 'disabled' ? null : webhookUrl(credential, logger),
    connected_at: credential.connectedAt.toISOString(),
    last_verified_at: credential.lastVerifiedAt?.toISOString() ?? null,
    last_synced_at: credential.lastSyncedAt?.toISOString() ?? null,
    last_webhook_at: credential.lastWebhookAt?.toISOString() ?? null,
    last_error: credential.lastError,
  })

  /**
   * Refuse a site on its way out.
   *
   * The `requireAnalyticsAccess` refusal **without** its `suspended`
   * branch: a blocked site must still be able to connect, rotate and disconnect
   * a provider, because credential management is not a read of revenue. What it
   * must not do is accept a *new* secret after `startSiteDeletion` erased the
   * ones it had — that credential would sit decryptable for the whole length of
   * the purge and then be removed by a target that had already been verified.
   */
  const refuseIfSiteIsGoing = async (siteId: string): Promise<void> => {
    const site = await getSiteBasics(db, siteId)
    if (!site || site.status === 'deleting' || site.status === 'deleted') {
      throw new ApiError('SITE_NOT_FOUND', 'No such site')
    }
  }

  /** The adapter for a provider, or the typed refusal. */
  const adapterFor = (providerId: string): RevenueAdapter => {
    const adapter = write?.adapters.get(providerId)
    if (!adapter) {
      // The catalog said available and this build has no adapter — a packaging
      // mistake rather than anything the customer did. 503 because it is ours
      // and it may be fixed by a deploy, and the detail names it for the
      // operator reading the response beside the log line.
      throw new ApiError('PROVIDER_UNAVAILABLE', 'This build has no adapter for that provider', {
        details: { reason: 'adapter_unavailable', provider: providerId },
      })
    }
    return adapter
  }

  /**
   * The live probe, and the two failures it can produce.
   *
   * Nothing is stored on either path, which is the point of probing first: a
   * credential row that exists only because a customer typed something is a row
   * the sync loop would fail on forever.
   */
  const verifyOrRefuse = async (
    c: {
      get: (key: 'logger') => { warn: (m: string, f: Record<string, unknown>) => void } | undefined
    },
    input: { adapter: RevenueAdapter; siteId: string; actorUserId: string; secret: string },
  ): Promise<Date> => {
    const verification = await input.adapter.verifyCredential(input.secret)
    if (verification.outcome === 'ok') return new Date()

    // Audited whichever way it failed: a repeated verify-failure on a site is
    // the signal that somebody is pasting keys that are not theirs, and it is
    // the one part of this flow that leaves no row behind to notice it by.
    await writeAudit(db, {
      action: 'site.revenue.verify_failed',
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      targetType: 'revenue_credential',
      metadata: {
        provider: input.adapter.providerId,
        // A categorized outcome, never the provider's response body.
        outcome: verification.outcome,
        detail: verification.detail,
      },
    })
    c.get('logger')?.warn('revenue_credential_verify_failed', {
      site_id: input.siteId,
      provider: input.adapter.providerId,
      outcome: verification.outcome,
      retryable: verification.outcome === 'unavailable',
    })

    if (verification.outcome === 'unavailable') {
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        'The provider did not answer; the credential was not stored',
        { details: { provider: input.adapter.providerId, retryable: true } },
      )
    }
    throw new ApiError(
      'REVENUE_CREDENTIAL_REJECTED',
      'The provider rejected this key; check it has read access to charges and has not been revoked',
      { details: { provider: input.adapter.providerId } },
    )
  }

  /**
   * The site's connection, or an explicit "not connected".
   *
   * A disconnected credential reads back as `disabled` rather than as
   * `not_connected`: the row survives a disconnect on purpose (D3), and "you
   * connected Stripe and then disconnected it" is a different statement from
   * "you have never connected anything". The empty-state screen renders them
   * differently, and it can only do that if the API distinguishes them.
   */
  app.get(base, async (c) => {
    const { siteId } = c.get('membership')
    const credential = await readRevenueCredential(db, { siteId })
    if (!credential) return c.json({ status: 'not_connected' })
    return c.json(connectionJson(credential, c.get('logger')))
  })

  /**
   * Disconnect.
   *
   * The row stays and both ciphertexts are erased in the same UPDATE (D3). The
   * facts and the history are untouched — a disconnect is not a deletion of the
   * revenue a site earned — and the read surface reports `disabled` afterwards
   * so the dashboard can say so rather than showing an unexplained zero.
   *
   * Registered **outside** the keyring block, beside the status read. Neither
   * touches the vault: this one nulls ciphertext *columns* rather than
   * decrypting anything, so a deployment whose ring went missing keeps the one
   * operation a customer might urgently need — cutting a live provider link.
   *
   * No `deleting`/`deleted` guard either, and that is the same argument: a site
   * being erased is a site whose credentials should stop working sooner rather
   * than later, and `startSiteDeletion` has already erased them anyway, so this
   * is at worst a no-op answering 404.
   */
  app.delete(base, async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')

    const credential = await readLiveRevenueCredential(db, { siteId })
    if (!credential) {
      throw new ApiError('NOT_FOUND', 'This site has no connected revenue provider')
    }

    const disconnected = await disconnectRevenueCredential(db, {
      credentialId: credential.id,
      siteId,
      actorUserId: actor.id,
      reason: 'requested',
    })
    if (!disconnected) {
      throw new ApiError('NOT_FOUND', 'This site has no connected revenue provider')
    }

    return c.body(null, 204)
  })

  // Everything below encrypts, so it exists only with a usable keyring
  // (`routes.ts` decides; this is where the split lands). Without it the two
  // write verbs are simply not registered and answer 404 — no secret, no
  // surface — while the read and the disconnect above keep working.
  if (!write) return app
  const { vault } = write

  /**
   * Connect a provider.
   *
   * The order is the guarantee. Provider known and available → adapter present →
   * **live probe** → encrypt → insert. Every refusal happens before a ciphertext
   * exists, and the insert's conflict is decided by the partial unique rather
   * than by a read, so two concurrent connects cannot both succeed.
   *
   * The credential id is minted *before* the encryption because the AAD binds
   * it: `revenue_credential:{id}:{site_id}` is what stops a ciphertext being
   * replayed onto another row, and it can only bind an id that already exists.
   *
   * ## `webhook_secret` is optional, and the reason is an ordering knot
   *
   * CP1 required it here, which asked for a value the customer provably could
   * not have. A Stripe signing secret exists only once an endpoint has been
   * created pointing at **this site's `webhook_url`** — and that URL is minted
   * by this very request, from the token this row carries. The documented flow
   * was therefore circular: connect to learn the URL, but you cannot connect
   * without the secret the URL will produce.
   *
   * So connect is now step one of two. The API key is probed and stored, the
   * token is minted, the URL is returned, and `webhook_secret_set` is false. The
   * customer creates the endpoint at that URL and `PATCH`es the signing secret
   * back. No migration was needed: the column has always been nullable and the
   * disabled-erased CHECK is one-directional, so CP1's schema already permitted
   * exactly this row.
   *
   * The connection is `active` throughout, which is not a shortcut. Backfill and
   * reconcile run entirely on the API key, so a site in step one is genuinely
   * ingesting revenue; what it lacks is the low-latency path. `last_webhook_at`
   * staying null is how the read surface says so, and it is the truth rather
   * than a status that would paint a working connection as broken.
   */
  app.post(base, async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const body = await readJson(c)

    const provider = findRevenueProvider(body['provider'])
    if (!provider) {
      validationFailed('No such revenue provider', [{ field: 'provider', code: 'unknown' }])
    }
    if (!provider.available) {
      validationFailed(`Connecting ${provider.displayName} is not available yet`, [
        { field: 'provider', code: 'unavailable' },
      ])
    }

    const apiKey = requiredSecret(body, 'api_key')
    // Optional (see above), but never present-and-blank.
    const webhookSecret = optionalSecret(body, 'webhook_secret')
    const adapter = adapterFor(provider.id)

    // Before the probe, so a site on its way out never reaches a provider with
    // a key it is not going to keep.
    await refuseIfSiteIsGoing(siteId)

    const verifiedAt = await verifyOrRefuse(c, {
      adapter,
      siteId,
      actorUserId: actor.id,
      secret: apiKey,
    })

    const credentialId = newId()
    const aad = revenueCredentialAad({ credentialId, siteId })
    const encryptedApiKey = vault.encrypt(apiKey, aad)
    const encryptedWebhookSecret =
      webhookSecret === undefined ? null : vault.encrypt(webhookSecret, aad)

    const created = await createRevenueCredential(db, {
      id: credentialId,
      siteId,
      provider: provider.id,
      encryptedApiKey: encryptedApiKey.stored,
      encryptedWebhookSecret: encryptedWebhookSecret?.stored ?? null,
      // The active key version. On this path it labels whatever ciphertexts
      // were produced — both when a webhook secret came in with the connect,
      // just the API key when it did not. The column is per row rather than per
      // value, so a later write that replaces one ciphertext records the new
      // version and leaves the other decryptable under whatever version wrote it
      // (the ring keeps both). Step two of the connect flow is exactly such a
      // write.
      keyVersion: vault.activeKeyVersion,
      apiKeyLast4: credentialLast4(apiKey),
      webhookToken: mintWebhookToken(),
      createdByUserId: actor.id,
      verifiedAt,
    })

    if (!created.ok) {
      throw new ApiError(
        'REVENUE_ALREADY_CONNECTED',
        'This site is already connected to that revenue provider',
        { details: { provider: provider.id } },
      )
    }

    return c.json(connectionJson(created.credential, c.get('logger')), 201)
  })

  /**
   * Rotate the API key and/or set the webhook signing secret.
   *
   * Two independent halves, either or both, at least one. They are separate
   * because they mean different things and cost different things:
   *
   * - **`api_key`** is a rotation. It re-probes the provider, swaps the
   *   ciphertext with its key version and display tail in one UPDATE (they
   *   describe one secret and must not be able to disagree), and — the part that
   *   matters — bumps the backfill generation and enqueues a fresh walk, because
   *   the ordinary reason to rotate is that the old key had stopped working and
   *   left history un-walked.
   * - **`webhook_secret`** is step two of the connect flow. It touches neither
   *   the probe nor the backfill: pasting a signing secret says nothing about
   *   whether the API key works, and re-walking ninety days of provider history
   *   every time somebody finishes the connect guide would be a large, pointless
   *   bill.
   *
   * With both, the key rotates first and then the secret is set, in that order,
   * because the rotation is the one that can be refused by the provider — a
   * probe failure should leave the row completely untouched rather than having
   * already written a new signing secret onto it.
   *
   * An empty body is a `VALIDATION_FAILED` rather than a silent no-op, matching
   * the site settings `PATCH`: a save that changed nothing is far more likely a
   * client bug than an intention.
   */
  app.patch(base, async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const body = await readJson(c)
    const apiKey = optionalSecret(body, 'api_key')
    const webhookSecret = optionalSecret(body, 'webhook_secret')

    if (apiKey === undefined && webhookSecret === undefined) {
      validationFailed('At least one of api_key or webhook_secret is required', [
        { field: 'api_key', code: 'required_one_of' },
        { field: 'webhook_secret', code: 'required_one_of' },
      ])
    }

    // Same refusal as connect: this writes a fresh ciphertext, and a site whose
    // deletion has already erased its credentials must not get one back.
    await refuseIfSiteIsGoing(siteId)

    const credential = await readLiveRevenueCredential(db, { siteId })
    if (!credential) {
      throw new ApiError('NOT_FOUND', 'This site has no connected revenue provider')
    }

    const aad = revenueCredentialAad({ credentialId: credential.id, siteId })
    // The row after whichever halves ran. Seeded with what was read so a body
    // carrying only one half still answers with the whole connection.
    let current: RevenueCredentialRow = credential

    if (apiKey !== undefined) {
      const adapter = adapterFor(credential.provider)
      const verifiedAt = await verifyOrRefuse(c, {
        adapter,
        siteId,
        actorUserId: actor.id,
        secret: apiKey,
      })

      const encrypted = vault.encrypt(apiKey, aad)
      const rotated = await rotateRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        encryptedApiKey: encrypted.stored,
        keyVersion: encrypted.keyVersion,
        apiKeyLast4: credentialLast4(apiKey),
        actorUserId: actor.id,
        verifiedAt,
      })
      if (!rotated) {
        // Somebody disconnected it between the read and the write. The guard is
        // in the WHERE precisely so that is a conflict rather than a
        // resurrection.
        throw new ApiError('NOT_FOUND', 'This site has no connected revenue provider')
      }
      current = rotated
    }

    if (webhookSecret !== undefined) {
      const encrypted = vault.encrypt(webhookSecret, aad)
      const updated = await setRevenueWebhookSecret(db, {
        credentialId: credential.id,
        siteId,
        encryptedWebhookSecret: encrypted.stored,
        keyVersion: encrypted.keyVersion,
        actorUserId: actor.id,
      })
      if (!updated) {
        throw new ApiError('NOT_FOUND', 'This site has no connected revenue provider')
      }
      current = updated
    }

    return c.json(connectionJson(current, c.get('logger')))
  })

  return app
}
