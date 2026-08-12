import { sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { newId } from '../ids.ts'
import type { CredentialKind } from '../schema/credential-sources.ts'

/**
 * Where a credential has been used from, and what is new about this use
 * (ADR-0051 D5).
 *
 * One statement per authenticated read, and its steady state writes nothing: a
 * credential arriving from its usual source probes the unique index, finds the
 * row, and the `ON CONFLICT … WHERE` refuses the update because `last_seen_at`
 * is not yet stale — so no new row version: no heap tuple, no index entry,
 * nothing to vacuum. Not literally zero WAL, and the distinction is worth
 * keeping: `ON CONFLICT DO UPDATE` takes a tuple lock before it evaluates the
 * `WHERE`, and that lock is WAL-logged. One lock record, not a row rewrite.
 *
 * **`source_hash` is an HMAC and this module never sees an address.** The
 * derivation lives in `packages/domain` (`credentialSourceHash`); a repository
 * that took an address could be called with one by mistake, and the hard rule in
 * `AGENTS.md` is that a raw IP must not land anywhere.
 */

export type CredentialKindValue = CredentialKind

/**
 * What this use was, relative to everything the credential has done before.
 *
 * - `first_use` — no source has ever been recorded for this credential under
 *   this key version. The credential is being used for the first time.
 * - `new_source` — the credential is known, this source is not.
 * - `known` — nothing to report; the overwhelming majority of reads.
 * - `capped` — the credential has reached `maxSources` and is no longer
 *   tracked (D9). Distinct from `known`: nothing is being observed, rather than
 *   nothing having happened.
 */
export type CredentialSourceOutcome = 'first_use' | 'new_source' | 'known' | 'capped'

export interface NoteCredentialSourceInput {
  readonly kind: CredentialKindValue
  /** The api key's uuid, or `<user_id>:<client_id>` for an OAuth grant (D6). */
  readonly ref: string
  readonly keyVersion: number
  /** The D4 fingerprint. Never an address. */
  readonly sourceHash: string
  /** Set for `api_key`; the site-deletion purge finds the row by it. */
  readonly siteId?: string | null
  /** Set for `oauth_grant`; the account-deletion purge finds the row by it. */
  readonly userId?: string | null
  /** The distinct-source cap for one credential (D9). */
  readonly maxSources: number
  /** How stale `last_seen_at` must be before a known source is touched again. */
  readonly refreshAfterSeconds: number
}

export interface NoteCredentialSourceResult {
  readonly outcome: CredentialSourceOutcome
  /** Distinct sources recorded **before** this use. */
  readonly priorSources: number
  /**
   * True when this insert is the one that reached `maxSources`, which is the
   * single deterministic moment `credential.source_tracking_capped` is written.
   * Checking `priorSources >= maxSources` instead would fire on every subsequent
   * request, which is the log spam the cap exists to prevent.
   */
  readonly reachedCap: boolean
}

/**
 * Record a use, and say what was new about it.
 *
 * The insert is gated on the prior count in the same statement, so a credential
 * at the cap attempts nothing at all — including the `last_seen_at` refresh for
 * sources it already has. That is deliberate: past the cap this credential is
 * not being tracked, and a `last_seen_at` that kept moving would suggest it was.
 *
 * Whether a row was inserted is decided by **comparing the returned id with the
 * one generated here**, not by `xmax = 0`: on conflict, `RETURNING` yields the
 * pre-existing row and therefore its original id. The comparison is exact, needs
 * no system column, and cannot be confused by a subtransaction.
 */
export async function noteCredentialSource(
  db: Database,
  input: NoteCredentialSourceInput,
): Promise<NoteCredentialSourceResult> {
  const id = newId()
  const result = await db.execute(sql`
    WITH prior AS (
      SELECT count(*)::int AS n
      FROM credential_sources
      WHERE credential_kind = ${input.kind}
        AND credential_ref = ${input.ref}
        AND key_version = ${input.keyVersion}
    ),
    touched AS (
      INSERT INTO credential_sources
        (id, credential_kind, credential_ref, key_version, source_hash, site_id, user_id)
      SELECT ${id}, ${input.kind}, ${input.ref}, ${input.keyVersion}, ${input.sourceHash},
             ${input.siteId ?? null}::uuid, ${input.userId ?? null}::uuid
      FROM prior
      WHERE prior.n < ${input.maxSources}
      ON CONFLICT (credential_kind, credential_ref, key_version, source_hash)
      DO UPDATE SET last_seen_at = now()
        WHERE credential_sources.last_seen_at
              < now() - make_interval(secs => ${input.refreshAfterSeconds})
      RETURNING id
    )
    SELECT prior.n AS prior_count, (SELECT id FROM touched) AS touched_id
    FROM prior
  `)

  const row = (result as unknown as { rows: { prior_count: number; touched_id: string | null }[] })
    .rows[0]
  const priorSources = Number(row?.prior_count ?? 0)
  const inserted = row?.touched_id === id

  if (priorSources >= input.maxSources) {
    return { outcome: 'capped', priorSources, reachedCap: false }
  }
  if (!inserted) {
    return { outcome: 'known', priorSources, reachedCap: false }
  }
  return {
    outcome: priorSources === 0 ? 'first_use' : 'new_source',
    priorSources,
    reachedCap: priorSources + 1 === input.maxSources,
  }
}
