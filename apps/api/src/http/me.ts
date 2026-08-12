import { ApiError, timezoneSchema } from '@openanalytics/contracts'
import { firstPartyClients } from '@openanalytics/auth'
import { grantScopeDescription, isGrantScope } from '@openanalytics/domain'
import {
  findOAuthApplicationName,
  getUserPreferences,
  listConnectedApps,
  revokeConnectedApp,
  setUserTimezone,
  type Database,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import type { ApiVariables } from './middleware.ts'

/**
 * The caller's own account preferences (ADR-0026).
 *
 * `/v1/me/...` is the first path on this API addressed by the session rather than
 * by a site id, and that is the whole point of the shape: there is no `user_id`
 * segment for a request to put someone else's id in. "Self only" is therefore
 * structural — the route reads `c.get('user').id` and has no other source for a
 * subject — rather than an ownership comparison that a later handler could forget
 * to repeat. It sits on the session-authenticated subtree, so an anonymous caller
 * gets `401 UNAUTHENTICATED` before any of this runs.
 *
 * A sub-resource (`/me/preferences`) rather than a `PATCH /v1/me` over the whole
 * identity: `/v1/me` would imply the API owns name, email and avatar, which it
 * does not — Better Auth owns those, and changing an email is its flow with its
 * verification, not a field on a merge patch here. This path owns exactly the
 * columns that are ours to write (ADR-0019: one surface, one owner).
 *
 * The value is *also* on the Better Auth session response as `user.timezone` —
 * it is *declared* under `user.additionalFields`, but the session response
 * flattens it onto the user object — which is what the dashboard reads on load.
 * This endpoint exists for the write and for the explicit read after it; the
 * first paint costs no extra round trip.
 */

export interface MeRoutesDeps {
  readonly db: Database
  /** For naming a first-party client on the connected-apps list. */
  readonly productName: string
}

type Env = { Variables: ApiVariables }

function preferencesJson(preferences: { timezone: string | null }) {
  return { timezone: preferences.timezone }
}

/** A `VALIDATION_FAILED` that names the offending field, the same
 * `details.issues` shape the rest of the surface emits and the frontend error
 * catalog already documents. */
function validationFailed(message: string, issues: readonly Record<string, unknown>[]): never {
  throw new ApiError('VALIDATION_FAILED', message, { details: { issues } })
}

export function createMeRoutes(deps: MeRoutesDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  /**
   * The apps the caller has connected, and one-click revoke (ADR-0048 D4).
   *
   * Self-service, and self-service only in this version: a grant is
   * account-scoped — it reads every site its user belongs to — so one admin
   * revoking another member's grant would reach across sites the admin has no
   * standing on. Cross-user revocation is deferred until it has a scoping story
   * (D4). Addressed by the session's own user id, the same "self only" shape the
   * preference routes have.
   */
  app.get('/me/connected-apps', async (c) => {
    const user = c.get('user')
    const connected = await listConnectedApps(db, user.id)
    const firstParty = firstPartyClients(deps.productName)

    const apps = await Promise.all(
      connected.map(async (app) => {
        const name =
          firstParty.find((client) => client.clientId === app.clientId)?.name ??
          (await findOAuthApplicationName(db, app.clientId)) ??
          app.clientId
        return {
          client_id: app.clientId,
          name,
          // The scopes as a person reads them, so the screen can say what each
          // app can do without the caller decoding scope strings. Unknown
          // strings (the OIDC basics) are dropped, not shown.
          scopes: app.scopes.filter(isGrantScope).map((scope) => ({
            scope,
            description: grantScopeDescription(scope),
          })),
          active_token_count: app.activeTokenCount,
          first_authorized_at: app.firstAuthorizedAt.toISOString(),
          last_authorized_at: app.lastAuthorizedAt.toISOString(),
        }
      }),
    )
    return c.json({ apps })
  })

  app.delete('/me/connected-apps/:client_id', async (c) => {
    const user = c.get('user')
    const clientId = c.req.param('client_id')
    const { tokensRevoked, consentsRevoked } = await revokeConnectedApp(db, user.id, clientId)
    if (tokensRevoked === 0 && consentsRevoked === 0) {
      // The user never connected this client (or already revoked it). A 404 is
      // the honest answer — reporting a no-op as success would tell a caller a
      // connection was severed that never existed.
      throw new ApiError('NOT_FOUND', 'No connected application with that id')
    }
    return c.body(null, 204)
  })

  app.get('/me/preferences', async (c) => {
    const user = c.get('user')
    const preferences = await getUserPreferences(db, user.id)
    if (!preferences) {
      // The session resolved but the row is gone — the account was deleted
      // between the two reads. Not a 500: the caller is not signed in to
      // anything any more.
      throw new ApiError('UNAUTHENTICATED', 'Authentication required')
    }
    return c.json(preferencesJson(preferences))
  })

  app.patch('/me/preferences', async (c) => {
    const user = c.get('user')

    let body: Record<string, unknown>
    try {
      const parsed = await c.req.json()
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
      body = parsed as Record<string, unknown>
    } catch {
      throw new ApiError('VALIDATION_FAILED', 'A JSON request body is required')
    }

    // A patch that names no field is a client bug, not a no-op: answering 200 to
    // it would report success for a change that was never requested.
    if (!('timezone' in body)) {
      validationFailed('timezone is required', [{ field: 'timezone', code: 'required' }])
    }

    const raw = body['timezone']
    let timezone: string | null
    if (raw === null) {
      // Explicit null clears the preference and returns the user to the
      // browser-detected default. It is a real choice, distinct from omitting
      // the field, which is why the presence check above is separate.
      timezone = null
    } else {
      // The same validator the analytics query surface uses, which asks the
      // runtime's own tz database rather than a regex — an unknown but
      // well-formed identifier must not become the stored preference and then
      // fail every chart request afterwards.
      const parsed = timezoneSchema.safeParse(raw)
      if (!parsed.success) {
        validationFailed('timezone must be a valid IANA identifier', [
          { field: 'timezone', code: 'invalid' },
        ])
      }
      timezone = parsed.data
    }

    const preferences = await setUserTimezone(db, { userId: user.id, timezone })
    if (!preferences) {
      throw new ApiError('UNAUTHENTICATED', 'Authentication required')
    }
    return c.json(preferencesJson(preferences))
  })

  return app
}
