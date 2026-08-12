import { getRequestContext } from '@openanalytics/observability'
import type { Database } from '../client.ts'
import { auditLogs } from '../schema/audit.ts'

/**
 * Audit ledger writes.
 *
 * `writeAudit` accepts either the database or an open transaction, so an audit
 * record is written in the same transaction as the change it describes — a
 * permission, ownership, key or credential change is never recorded out of step
 * with the state it audits (docs snapshot 02 §6, plan Milestone 2 item 10).
 *
 * `metadata` is safe, categorized detail only. It must never carry a raw token,
 * password, raw email or other secret; those are redacted from logs centrally
 * and must not be smuggled into the audit trail either.
 */

/** The subset of the database surface an audit write needs — satisfied by both
 * the pool-backed database and an open transaction. */
export type AuditExecutor = Pick<Database, 'insert'>

export type AuditActorType = 'user' | 'system' | 'service'

export interface AuditEntry {
  readonly action: string
  readonly actorUserId?: string | null
  readonly actorType?: AuditActorType
  readonly siteId?: string | null
  readonly targetType?: string | null
  readonly targetId?: string | null
  readonly metadata?: Record<string, unknown>
  readonly requestId?: string | null
}

/**
 * The client and grant an ambient request is authenticated as (ADR-0051 D10).
 *
 * Read from the request context rather than accepted as a parameter, so that
 * **every** audit row a token-authored change produces names the application —
 * the ones already written across a dozen repositories as much as the ones a
 * later milestone adds. ADR-0048 D5 promised this as a log line and shipped
 * neither; the ledger is where the question is actually asked, because "which
 * client made this change" outlives any log retention.
 *
 * Both are opaque identifiers. The access token itself is not in the context and
 * cannot reach here.
 *
 * Empty on a session request, on a background job, and in any test that calls a
 * repository directly — the merge below is additive, so an absent context is
 * simply the metadata the caller passed.
 */
function grantMetadata(): Record<string, string> {
  const context = getRequestContext()
  if (!context) return {}
  return {
    ...(context.clientId === undefined ? {} : { client_id: context.clientId }),
    ...(context.grantId === undefined ? {} : { grant_id: context.grantId }),
  }
}

export async function writeAudit(executor: AuditExecutor, entry: AuditEntry): Promise<void> {
  // Caller-supplied keys win: an entry that deliberately states a client id is
  // describing some *other* grant (a revocation names the one it killed), and
  // the ambient one would be the wrong answer to the question the row asks.
  const metadata = { ...grantMetadata(), ...(entry.metadata ?? {}) }

  await executor.insert(auditLogs).values({
    action: entry.action,
    actorType: entry.actorType ?? 'user',
    metadata,
    ...(entry.actorUserId === undefined ? {} : { actorUserId: entry.actorUserId }),
    ...(entry.siteId === undefined ? {} : { siteId: entry.siteId }),
    ...(entry.targetType === undefined ? {} : { targetType: entry.targetType }),
    ...(entry.targetId === undefined ? {} : { targetId: entry.targetId }),
    ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
  })
}
