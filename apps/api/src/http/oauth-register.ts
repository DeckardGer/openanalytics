import { validateClientRegistration } from '@openanalytics/domain'
import type { Logger } from '@openanalytics/observability'
import type { RequestContextVariables } from '@openanalytics/observability/hono'
import { createOAuthApplication, type Database } from '@openanalytics/postgres'
import { Hono } from 'hono'
import { clientAddress } from './oauth.ts'
import type { RateLimiter } from './rate-limit.ts'

/**
 * `POST /v1/oauth/register` — RFC 7591 dynamic client registration (ADR-0047).
 *
 * The endpoint every MCP host reaches for when it meets an unknown server: it
 * introduces the client, and nothing more. The human authorization it precedes
 * is unchanged — authorize, our consent page, PKCE at the token endpoint — and
 * the scope ceiling is the provider's, which a registration cannot widen.
 *
 * Like the device token exchange it sits beside, this answers the RFC's own
 * `{ error, error_description }` shape rather than `ApiError`, because the
 * caller is an OAuth client library, and it mounts before the business
 * subtree's session guard because it is anonymous by design — RFC 7591's open
 * registration, deliberately: the clients that need this are exactly the ones
 * we have no prior relationship with (ADR-0047, alternatives).
 *
 * Anonymous and row-writing is a combination that needs a ceiling, and it has
 * two guards in the device exchange's ordering: the body is judged — parsed,
 * shape-checked, policy-checked — before the `register-ip:` window is charged,
 * so an arbitrary-garbage flood costs neither a bucket nor a query, and the
 * window is charged before the insert, so a valid-looking spray is bounded by
 * the limiter rather than by disk.
 */

type Env = { Variables: RequestContextVariables }

export interface OAuthRegistrationDeps {
  readonly db: Database
  /** Charged as `register-ip:<address>`; see `defaultRegistrationLimiter`. */
  readonly registrationRateLimiter: RateLimiter
  /** The authorization server's full scope list, for the response's echo. */
  readonly supportedScopes: readonly string[]
  readonly logger?: Logger
}

export function createOAuthRegistrationRoutes(deps: OAuthRegistrationDeps): Hono<Env> {
  const app = new Hono<Env>()

  const fail = (
    error: string,
    description: string,
    status: number,
    retryAfterSeconds?: number,
  ): Response =>
    new Response(JSON.stringify({ error, error_description: description }), {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        pragma: 'no-cache',
        ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
      },
    })

  app.post('/oauth/register', async (c) => {
    const body = await c.req.json().catch(() => null)
    const judged = validateClientRegistration(body, deps.supportedScopes)
    if (!judged.ok) return fail(judged.error, judged.description, 400)

    const window = deps.registrationRateLimiter.check(`register-ip:${clientAddress(c.req.raw)}`)
    if (!window.allowed) {
      return fail(
        'too_many_requests',
        'Too many registrations from this address',
        429,
        window.retryAfterSeconds,
      )
    }

    const created = await createOAuthApplication(deps.db, {
      clientName: judged.registration.clientName,
      redirectUris: judged.registration.redirectUris,
      metadata: judged.registration.metadata,
    })

    deps.logger?.info('oauth_client_registered', {
      client_id: created.clientId,
      client_name: judged.registration.clientName,
      redirect_uris: judged.registration.redirectUris.length,
    })

    // RFC 7591 §3.2.1: echo the metadata as registered. No `client_secret`
    // and no `registration_access_token` — the first does not exist for a
    // public client, and the management protocol (RFC 7592) is not offered.
    return new Response(
      JSON.stringify({
        client_id: created.clientId,
        client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
        client_name: judged.registration.clientName,
        redirect_uris: judged.registration.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: judged.registration.grantTypes,
        response_types: judged.registration.responseTypes,
        scope: judged.registration.scope,
      }),
      {
        status: 201,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          pragma: 'no-cache',
        },
      },
    )
  })

  return app
}
