import {
  CREDENTIAL_SOURCE_MAX_PER_CREDENTIAL,
  CREDENTIAL_SOURCE_REFRESH_SECONDS,
  credentialSourceHash,
  type CredentialSourceKey,
} from '@openanalytics/domain'
import { noteCredentialSource, writeAudit, type Database } from '@openanalytics/postgres'
import type { Logger } from '@openanalytics/observability'

/**
 * G-010's credential events, for a credential that has just resolved
 * (ADR-0051 D2, D5, D9).
 *
 * **One recorder, two authenticators.** `readAuth` resolves a credential for the
 * read surface and `/mcp`; `principalAuth` resolves one for the narrow set of
 * writes a grant may make. A recorder that lived in only the first would leave a
 * write-only MCP client — a perfectly ordinary thing for an agent to be — with
 * no first-use event at all, and the journal would say a credential that had
 * been creating funnels for a month had never been used.
 *
 * **Not one row per read.** The statement below writes nothing in the steady
 * state, and an audit row only when something is genuinely new: the first time
 * this credential is used at all, the first time it is used from a given source,
 * and the single moment it stops being tracked (the cap). "What did this
 * credential read" stays unanswerable, deliberately.
 *
 * **Best-effort, and awaited.** Awaited because the statement is one indexed
 * probe in front of work an order of magnitude slower; best-effort because an
 * audit trail that can take down every authenticated request is a larger risk
 * than a gap in the trail, and the gap is logged. The same shape as
 * `read_key_last_used_write_failed`, which sits beside its first caller.
 */

export interface CredentialUse {
  readonly kind: 'api_key' | 'oauth_grant'
  /** The api key's uuid, or `<user_id>:<client_id>` for a grant (D6). */
  readonly ref: string
  /** Set for a key, which is bound to one site. A grant is not. */
  readonly siteId?: string
  /** Set for a grant. A key has no user at all (ADR-0043 D2). */
  readonly userId?: string
}

export interface CredentialEventDeps {
  readonly db: Database
  /**
   * The HMAC key, when one is configured. Absent, this records nothing — see
   * ADR-0051 D4: first use and new-source are decided by the same statement, so
   * without a fingerprint neither is knowable, and the api says so once at
   * startup rather than pretending to journal.
   */
  readonly key?: CredentialSourceKey | undefined
  readonly logger?: Logger | undefined
}

/**
 * The one address the fingerprint is allowed to see: `X-Real-IP`, and nothing
 * else.
 *
 * **Deliberately narrower than every other address reader in this codebase**,
 * and the narrowness is the security property rather than an oversight. The rate
 * limiter's `clientIp` prefers `X-Forwarded-For`, and `clientAddress` falls back
 * to it — both correct for a budget bucket, where a caller inventing a fresh
 * address only splits their own quota. Here the same fallback would be fatal:
 * somebody holding a stolen key could name the victim's usual address in the one
 * header they control and never trip the new-source event, turning the alert off
 * from the outside.
 *
 * The reverse proxy in front of this service asserts `X-Real-IP` from the
 * connection and strips the spoofable headers beside it. Reading
 * *only* that header makes the anti-spoofing property a property of **this
 * code** rather than of the deployment: a build put behind some other proxy, or
 * none, does not silently start trusting caller input — it sees `unknown` and
 * every credential reports one source. That is a signal that has stopped working
 * and says so, which is the honest failure; a forgeable one is the dishonest
 * one.
 */
function fingerprintAddress(request: Request): string {
  const header = request.headers.get('x-real-ip')
  if (!header) return 'unknown'
  return header.split(',')[0]?.trim() || 'unknown'
}

export type CredentialUseRecorder = (request: Request, use: CredentialUse) => Promise<void>

export function createCredentialUseRecorder(deps: CredentialEventDeps): CredentialUseRecorder {
  return async (request, use) => {
    const key = deps.key
    if (!key) return

    try {
      const sourceHash = credentialSourceHash({ address: fingerprintAddress(request), key })
      const seen = await noteCredentialSource(deps.db, {
        kind: use.kind,
        ref: use.ref,
        keyVersion: key.keyVersion,
        sourceHash,
        ...(use.siteId === undefined ? {} : { siteId: use.siteId }),
        ...(use.userId === undefined ? {} : { userId: use.userId }),
        maxSources: CREDENTIAL_SOURCE_MAX_PER_CREDENTIAL,
        refreshAfterSeconds: CREDENTIAL_SOURCE_REFRESH_SECONDS,
      })
      if (seen.outcome === 'known' || seen.outcome === 'capped') return

      // The fingerprint, never the address (D4), and never the token. The actor
      // is the *credential*: a key has no user, and a grant has one worth naming.
      const base = {
        actorType: 'service' as const,
        targetType: use.kind,
        targetId: use.ref,
        ...(use.siteId === undefined ? {} : { siteId: use.siteId }),
        ...(use.userId === undefined ? {} : { actorUserId: use.userId }),
      }
      await writeAudit(deps.db, {
        ...base,
        action:
          seen.outcome === 'first_use' ? 'credential.first_used' : 'credential.source_first_seen',
        metadata: { sourceHash, keyVersion: key.keyVersion, priorSources: seen.priorSources },
      })
      // A second row, once per credential, at the moment tracking stops. It is
      // what keeps the cap from being a silent truncation (D9).
      if (seen.reachedCap) {
        await writeAudit(deps.db, {
          ...base,
          action: 'credential.source_tracking_capped',
          metadata: {
            keyVersion: key.keyVersion,
            maxSources: CREDENTIAL_SOURCE_MAX_PER_CREDENTIAL,
          },
        })
      }
    } catch (error) {
      deps.logger?.warn('credential_source_note_failed', { err: error, retryable: true })
    }
  }
}
