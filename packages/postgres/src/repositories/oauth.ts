import { randomBytes } from 'node:crypto'
import { oauthGrantCredentialRef, type DeviceTokenError } from '@openanalytics/domain'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { newId } from '../ids.ts'
import { writeAudit } from './audit.ts'
import {
  deviceCodes,
  oauthAccessTokens,
  oauthApplications,
  oauthConsents,
} from '../schema/oauth.ts'

/**
 * The one edge of the device flow Better Auth does not provide (ADR-0043 D13).
 *
 * Its `POST /device/token` creates a *session* and hands back `session.token`,
 * which authenticates the whole dashboard. The endpoint is removed from the
 * plugin (`packages/auth/src/better-auth.ts`); this is what replaces it: an
 * approved device code becomes a row in `oauth_access_tokens` carrying the
 * scopes the device asked for and nothing else.
 *
 * Everything else stays the library's. The row this reads was created by
 * `/device/code`, its `user_code` was generated there, and it was approved
 * through the session-authenticated `/device/approve`. What is re-derived here is
 * only RFC 8628 §3.5's polling state machine — `authorization_pending`,
 * `slow_down`, `expired_token`, `access_denied` — because it is inseparable from
 * the token issuance it guards.
 */

/** What a device code lookup found, for the approval page to render. */
export interface DeviceAuthorizationView {
  readonly id: string
  readonly userCode: string
  readonly clientId: string | null
  readonly scope: string | null
  readonly status: string
  readonly expiresAt: Date
  readonly userId: string | null
}

/**
 * The device authorization a user code names, however they typed it.
 *
 * The code is displayed in groups (`WDJB-MJHT`) and people type the hyphen, so
 * it is stripped — the same normalization Better Auth's own `/device` does — and
 * upper-cased, because the generating alphabet is upper-case and a terminal that
 * echoes lower-case would otherwise produce a code that cannot be found.
 */
export async function findDeviceAuthorization(
  db: Database,
  userCode: string,
): Promise<DeviceAuthorizationView | null> {
  const normalized = userCode.replace(/-/gu, '').trim().toUpperCase()
  if (normalized.length === 0) return null
  const [row] = await db
    .select({
      id: deviceCodes.id,
      userCode: deviceCodes.userCode,
      clientId: deviceCodes.clientId,
      scope: deviceCodes.scope,
      status: deviceCodes.status,
      expiresAt: deviceCodes.expiresAt,
      userId: deviceCodes.userId,
    })
    .from(deviceCodes)
    .where(eq(deviceCodes.userCode, normalized))
  return row ?? null
}

export interface DeviceExchangeSuccess {
  readonly ok: true
  readonly userId: string
  readonly scope: string | null
}

export interface DeviceExchangeFailure {
  readonly ok: false
  readonly error: DeviceTokenError
  readonly description: string
}

export type DeviceExchangeResult = DeviceExchangeSuccess | DeviceExchangeFailure

/**
 * Claim an approved device code, exactly once (RFC 8628 §3.5).
 *
 * One transaction with the row locked, because every branch here either reads
 * state and writes it (`last_polled_at`) or consumes the row, and two polls
 * arriving together must not both succeed. The order of the checks is the RFC's
 * and is not interchangeable:
 *
 * 1. **Existence and client**, before anything is written, so an unknown code
 *    costs no update.
 * 2. **The polling interval**, and this is checked *before* expiry on purpose: a
 *    device hammering the endpoint should be told to slow down whatever else is
 *    true of its code, and answering `expired_token` to a flood would invite it
 *    to start a new authorization and flood again.
 * 3. **`last_polled_at` is stamped**, so the next poll is measured from this one
 *    even when this one fails.
 * 4. **Expiry**, and the row is deleted: a code past its deadline is never
 *    approvable, and leaving it would let somebody approve it afterwards and see
 *    a success page for a device that gave up.
 * 5. **Status.** `pending` is the ordinary answer and leaves the row alone;
 *    `denied` deletes it, because the human has decided and the device must not
 *    be able to keep asking.
 * 6. **Approved** deletes the row and returns its user, in the same statement.
 *    `DELETE ... RETURNING` is what makes the code single-use: a replayed device
 *    code finds nothing and answers `invalid_grant`, and there is no window in
 *    which two callers both read "approved".
 *
 * Time comes from the database (`now()`), not from the process. Two services
 * with a few milliseconds of clock skew would otherwise disagree about whether a
 * code has expired, which is the class of defect M10 recorded when a job's
 * `available_at` was written by Postgres and compared in JavaScript.
 */
export async function claimApprovedDeviceCode(
  db: Database,
  input: { readonly deviceCode: string; readonly clientId: string },
): Promise<DeviceExchangeResult> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id, client_id, status, user_id, scope,
             expires_at <= now() AS expired,
             (last_polled_at IS NOT NULL
              AND polling_interval IS NOT NULL
              AND now() < last_polled_at + make_interval(secs => polling_interval / 1000.0))
               AS too_soon
      FROM device_codes
      WHERE device_code = ${input.deviceCode}
      FOR UPDATE
    `)
    const row = (
      locked as unknown as {
        rows: {
          id: string
          client_id: string | null
          status: string
          user_id: string | null
          scope: string | null
          expired: boolean
          too_soon: boolean
        }[]
      }
    ).rows[0]

    if (!row) {
      return { ok: false, error: 'invalid_grant', description: 'Unknown device code' }
    }
    if (row.client_id !== null && row.client_id !== input.clientId) {
      // Not `invalid_client`: from the device's side this is a code that does
      // not belong to it, and RFC 8628 spends `invalid_grant` on exactly that.
      return {
        ok: false,
        error: 'invalid_grant',
        description: 'Device code was issued to another client',
      }
    }
    if (row.too_soon) {
      return {
        ok: false,
        error: 'slow_down',
        description: 'Polled faster than the interval; wait longer between requests',
      }
    }

    await tx
      .update(deviceCodes)
      .set({ lastPolledAt: sql`now()` })
      .where(eq(deviceCodes.id, row.id))

    if (row.expired) {
      await tx.delete(deviceCodes).where(eq(deviceCodes.id, row.id))
      return { ok: false, error: 'expired_token', description: 'The device code has expired' }
    }
    if (row.status === 'pending') {
      return {
        ok: false,
        error: 'authorization_pending',
        description: 'Waiting for the user to approve this device',
      }
    }
    if (row.status === 'denied') {
      await tx.delete(deviceCodes).where(eq(deviceCodes.id, row.id))
      return { ok: false, error: 'access_denied', description: 'The user denied this device' }
    }

    const claimed = await tx
      .delete(deviceCodes)
      .where(and(eq(deviceCodes.id, row.id), eq(deviceCodes.status, 'approved')))
      .returning({ userId: deviceCodes.userId, scope: deviceCodes.scope })
    const consumed = claimed[0]
    if (!consumed?.userId) {
      // Approved with no user is a row that cannot exist — `/device/approve`
      // writes both in one statement — so this is the "somebody else won the
      // race" branch, and `invalid_grant` is what a replay deserves.
      return { ok: false, error: 'invalid_grant', description: 'Device code already exchanged' }
    }
    return { ok: true, userId: consumed.userId, scope: consumed.scope }
  })
}

export interface IssuedOAuthToken {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresInSeconds: number
  readonly scope: string
}

/**
 * Write an access token in the shape Better Auth issues and reads.
 *
 * Deliberately the library's shape, not ours: 32 random alphanumerics stored as
 * issued, so `/oauth2/token`'s `refresh_token` grant and `/oauth2/userinfo` both
 * find this row by the same plain lookup they use for a token they minted
 * themselves. That is what makes this **one exchange** rather than a second token
 * system — after this row exists, every later renewal is the library's.
 *
 * The tokens are not hashed for the same reason; see the migration and the
 * schema, where the trade-off is recorded rather than assumed.
 */
export async function issueOAuthAccessToken(
  db: Database,
  input: {
    readonly userId: string
    readonly clientId: string
    readonly scope: string
    readonly accessTokenExpiresInSeconds: number
    readonly refreshTokenExpiresInSeconds: number
  },
): Promise<IssuedOAuthToken> {
  // base64url of 24 bytes is 32 characters, matching the library's own length
  // without importing its private random helper.
  const opaque = (): string => randomBytes(24).toString('base64url')
  const accessToken = opaque()
  const refreshToken = opaque()

  return db.transaction(async (tx) => {
    await tx.insert(oauthAccessTokens).values({
      accessToken,
      refreshToken,
      // Both deadlines from the database clock, for the reason the claim above
      // reads `now()` there: the token's expiry is compared against `now()` by
      // Better Auth's own endpoints.
      accessTokenExpiresAt: sql`now() + make_interval(secs => ${input.accessTokenExpiresInSeconds})`,
      refreshTokenExpiresAt: sql`now() + make_interval(secs => ${input.refreshTokenExpiresInSeconds})`,
      clientId: input.clientId,
      userId: input.userId,
      scopes: input.scope,
    })

    // The mint half of G-010 for OAuth (ADR-0051 D2), in the same transaction as
    // the row it describes — `writeAudit`'s standing contract, and the reason a
    // grant cannot exist without a record of being issued.
    //
    // `target_id` is the *grant* identity (`<user_id>:<client_id>`), not the
    // token row's, so this row still names the same credential after Better
    // Auth's refresh grant has replaced the row several times over (D6).
    //
    // No `site_id`: an OAuth grant is a person's and reaches whichever of their
    // sites the request names. Nothing is being said about one site here.
    await writeAudit(tx, {
      action: 'oauth_grant.issued',
      actorUserId: input.userId,
      actorType: 'user',
      targetType: 'oauth_grant',
      targetId: oauthGrantCredentialRef(input.userId, input.clientId),
      // The grant, never the token. The scope string is exactly the part a user
      // may later dispute — the same reason `api_key.created` records scopes.
      metadata: { clientId: input.clientId, scope: input.scope, via: 'device_code' },
    })

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: input.accessTokenExpiresInSeconds,
      scope: input.scope,
    }
  })
}

/** A live OAuth access token, resolved for the read surface (ADR-0043 D2). */
export interface ResolvedOAuthToken {
  readonly id: string
  readonly userId: string
  readonly clientId: string
  /** The stored grant, space-delimited. `readScopesFromGrant` reads it. */
  readonly scopes: string
}

/**
 * Resolve a bearer token to the person it belongs to, or nothing.
 *
 * Two reasons a row can fail to resolve, and both answer the same way — `null`,
 * which the caller turns into `401`. An expired token and a token that was never
 * issued are indistinguishable to a caller, deliberately: the alternative tells
 * somebody holding a stolen string whether it was ever real.
 *
 * `user_id` is `NOT NULL` in every row this system writes (the device exchange
 * and Better Auth's own grants both set it), but the column is nullable because
 * Better Auth's model declares it so. A row without one resolves to nothing
 * rather than to a principal with no user — the whole of D2 is that an OAuth
 * principal *has* a user, and a `null` slipping through would be a
 * `ReadPrincipal` whose type says otherwise.
 *
 * Expiry is compared in the database, against the same clock that wrote the
 * deadline.
 */
export async function resolveOAuthAccessToken(
  db: Database,
  rawToken: string,
): Promise<ResolvedOAuthToken | null> {
  const [row] = await db
    .select({
      id: oauthAccessTokens.id,
      userId: oauthAccessTokens.userId,
      clientId: oauthAccessTokens.clientId,
      scopes: oauthAccessTokens.scopes,
    })
    .from(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.accessToken, rawToken), sql`access_token_expires_at > now()`))
  if (!row?.userId) return null
  return { id: row.id, userId: row.userId, clientId: row.clientId, scopes: row.scopes }
}

/** One OAuth client a user has live grants to (ADR-0048 D4). */
export interface ConnectedApp {
  readonly clientId: string
  /** Live grants for this client — tokens whose refresh has not expired, so the
   * app can still act. */
  readonly activeTokenCount: number
  readonly firstAuthorizedAt: Date
  readonly lastAuthorizedAt: Date
  /** The union of scopes across the client's live grants, space-split. */
  readonly scopes: readonly string[]
}

/**
 * The OAuth clients a user has authorized and that can still act (ADR-0048 D4).
 *
 * Grouped from `oauth_access_tokens`, **not** `oauth_consents`: the device flow
 * (the CLI's login) writes a token and no consent row, so consents miss every
 * CLI grant. A client counts as connected while any of its grants has a refresh
 * token that has not expired — that is the window in which it can renew and
 * keep reading, so it is the honest "still connected" line. Aggregated in the
 * process rather than in SQL because a user has few connected apps and the
 * scope union is a set operation over short strings.
 */
export async function listConnectedApps(db: Database, userId: string): Promise<ConnectedApp[]> {
  const rows = await db
    .select({
      clientId: oauthAccessTokens.clientId,
      scopes: oauthAccessTokens.scopes,
      createdAt: oauthAccessTokens.createdAt,
    })
    .from(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.userId, userId), sql`refresh_token_expires_at > now()`))

  const byClient = new Map<
    string,
    { count: number; first: Date; last: Date; scopes: Set<string> }
  >()
  for (const row of rows) {
    const createdAt = new Date(row.createdAt)
    const existing = byClient.get(row.clientId)
    const scopeParts = row.scopes.split(/\s+/u).filter((part) => part.length > 0)
    if (!existing) {
      byClient.set(row.clientId, {
        count: 1,
        first: createdAt,
        last: createdAt,
        scopes: new Set(scopeParts),
      })
    } else {
      existing.count += 1
      if (createdAt < existing.first) existing.first = createdAt
      if (createdAt > existing.last) existing.last = createdAt
      for (const part of scopeParts) existing.scopes.add(part)
    }
  }

  return [...byClient.entries()]
    .map(([clientId, value]) => ({
      clientId,
      activeTokenCount: value.count,
      firstAuthorizedAt: value.first,
      lastAuthorizedAt: value.last,
      scopes: [...value.scopes],
    }))
    .sort((a, b) => b.lastAuthorizedAt.getTime() - a.lastAuthorizedAt.getTime())
}

/**
 * Revoke a user's access for one client (ADR-0048 D4).
 *
 * Deletes the user's tokens **and** consents for the client, in one
 * transaction. Both, necessarily: a surviving `oauth_consents` row is a
 * standing "yes" that Better Auth's authorize flow reads to skip the consent
 * screen, so leaving it would let the client silently re-issue a token on its
 * next authorize — which would make "revoke" a lie. In-flight device codes are
 * left alone: they carry no client-scoped grant yet and expire on their own
 * within ten minutes.
 *
 * Returns how many of each were removed, so the caller can answer `404` for a
 * client the user never connected rather than reporting a no-op as success.
 */
export async function revokeConnectedApp(
  db: Database,
  userId: string,
  clientId: string,
): Promise<{ tokensRevoked: number; consentsRevoked: number }> {
  return db.transaction(async (tx) => {
    const tokens = await tx
      .delete(oauthAccessTokens)
      .where(and(eq(oauthAccessTokens.userId, userId), eq(oauthAccessTokens.clientId, clientId)))
      .returning({ id: oauthAccessTokens.id })
    const consents = await tx
      .delete(oauthConsents)
      .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId)))
      .returning({ id: oauthConsents.id })

    // The revoke half of G-010 for OAuth (ADR-0051 D2), and the row that carries
    // the most: this function **deletes** the tokens and consents, so once it
    // commits the audit row is the only surviving evidence that the grant ever
    // existed. Written in the same transaction, so a revocation cannot happen
    // without one.
    //
    // Recorded even when both counts are zero — the caller turns that into a
    // `404` — because "somebody asked to revoke an app they had not connected"
    // is itself worth having in the trail of an account under investigation.
    await writeAudit(tx, {
      action: 'oauth_grant.revoked',
      actorUserId: userId,
      actorType: 'user',
      targetType: 'oauth_grant',
      targetId: oauthGrantCredentialRef(userId, clientId),
      metadata: {
        clientId,
        tokensRevoked: tokens.length,
        consentsRevoked: consents.length,
      },
    })

    return { tokensRevoked: tokens.length, consentsRevoked: consents.length }
  })
}

/** What registration persisted, for the RFC 7591 response (ADR-0047). */
export interface CreatedOAuthApplication {
  readonly clientId: string
  readonly createdAt: Date
}

/**
 * Write a dynamically registered client in the shape Better Auth reads
 * (ADR-0047 D1, D5).
 *
 * The library's shape for the reason `issueOAuthAccessToken` uses it: after
 * this row exists, `getClient` — and through it authorize, consent, token and
 * refresh — treats the client exactly like one the library registered itself.
 * `type` is always `'public'` and `client_secret` stays NULL (the schema's
 * spelling of "public", which the token endpoint's PKCE path never reads);
 * the policy that guarantees only such rows arrive here lives in
 * `validateClientRegistration`, not in this writer.
 *
 * `user_id` is deliberately never stamped: registration is a client
 * introducing itself, not a user acquiring property, and a populated
 * `user_id` on a no-`ON DELETE` foreign key would block that user's account
 * deletion (ADR-0047 D5).
 *
 * The id is `dcr_` + 22 base64url characters — recognizable in logs, and
 * incapable of colliding with the first-party `oa-cli`/`oa-mcp` ids.
 */
export async function createOAuthApplication(
  db: Database,
  input: {
    readonly clientName: string
    readonly redirectUris: readonly string[]
    readonly metadata: Readonly<Record<string, string>> | null
  },
): Promise<CreatedOAuthApplication> {
  const clientId = `dcr_${randomBytes(16).toString('base64url')}`
  const [row] = await db
    .insert(oauthApplications)
    .values({
      id: newId(),
      name: input.clientName,
      clientId,
      redirectUrls: input.redirectUris.join(','),
      type: 'public',
      metadata: input.metadata === null ? null : JSON.stringify(input.metadata),
    })
    .returning({ createdAt: oauthApplications.createdAt })
  return { clientId, createdAt: row!.createdAt }
}

/**
 * The display name a client id was registered under, or nothing.
 *
 * For the consent page's heading (ADR-0047 D8): a first-party id is answered
 * from configuration before this is asked, and a `dcr_…` id resolves to the
 * registration-supplied name. Disabled clients resolve too — a name is a
 * label for the refusal they are about to receive, not an authorization.
 */
export async function findOAuthApplicationName(
  db: Database,
  clientId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ name: oauthApplications.name })
    .from(oauthApplications)
    .where(eq(oauthApplications.clientId, clientId))
  return row?.name ?? null
}

/**
 * Drop device authorizations nobody came back for.
 *
 * **The exchange deletes a code when it is polled** — on approval, on denial and
 * on expiry — so in the ordinary flow this finds nothing. What it is for is the
 * flow that does not end: a CLI killed with Ctrl-C, a person who never opens the
 * link, a terminal closed mid-login. Those rows expire and are then never polled
 * again, so nothing deletes them and the table grows without bound. Observed on
 * the production deploy of this milestone — one abandoned `pending` row from a
 * code whose CLI had moved on.
 *
 * An hour past expiry rather than at expiry: the exchange's own `expired_token`
 * branch is the answer a device deserves for a code it polls late, and sweeping
 * at the deadline would turn that into `invalid_grant` — "your code expired" and
 * "there is no such code" are different sentences, and only the first tells a
 * person to run `oa login` again.
 */
export async function sweepExpiredDeviceCodes(db: Database): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM device_codes
    WHERE expires_at < now() - interval '1 hour'
  `)
  return (result as unknown as { rowCount?: number }).rowCount ?? 0
}
