import { ApiError } from '@openanalytics/contracts'
import { isRecentReauth, type ServiceEnv } from '@openanalytics/domain'
import {
  AccountDeletionBlockedError,
  deploymentOperatorUserId,
  startAccountDeletion,
  type Database,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import { idempotent } from './idempotency.ts'
import type { ApiVariables } from './middleware.ts'

/**
 * `DELETE /v1/me` — account deletion (ADR-0030, decision 8).
 *
 * A separate module from `me.ts` for the same reason `/v1/me/preferences` is a
 * sub-resource rather than a `PATCH /v1/me`: preferences are two columns this
 * API owns, and this is the destruction of an identity Better Auth owns, gated
 * on a re-authentication and a typed confirmation. One file per weight class
 * keeps the preference handlers from acquiring, by proximity, the appearance of
 * being dangerous — and keeps this one's guards from being read as boilerplate.
 *
 * The guard chain, and what each link answers:
 *
 * - `sessionAuth` (inherited from the subtree this mounts on) — is anyone signed
 *   in. The subject is the session and nothing else: there is no `user_id`
 *   segment for a request to put somebody else's id in, so "self only" is
 *   structural rather than an ownership comparison a handler could forget.
 * - `isRecentReauth` — was the session recently *proven*, not merely valid. The
 *   same bar as the billing cutover and site deletion: a live cookie on a stolen
 *   laptop must not be able to erase its owner's account.
 * - the email confirmation — the human typed their own address. It is compared
 *   against the address on the session this request just resolved, never against
 *   anything else the client sent, which would make the confirmation
 *   self-referential.
 * - `idempotent` — a retried request replays the original answer instead of
 *   starting a second deletion. The repository is idempotent as well (it returns
 *   the live request for an account already being deleted), so the two agree
 *   rather than one covering for the other.
 * - **the deployment operator, and only where that role exists** — see below.
 *
 * The answer is `202`. Deletion is a state machine that waits for site deletions
 * and for Stripe to confirm a cancellation; there is no synchronous "done".
 *
 * **The caller's session survives this response**, by design, until the job
 * deletes the `sessions` rows moments later. Revoking here would mean the client
 * that asked could not read its own 202 — and it would put a second writer on a
 * table the teardown already owns, for a window whose only occupant is the
 * person who just asked to be erased.
 *
 * ## The operator refusal, and why it is scoped to one kind of deployment
 *
 * Since migration 0043 a self-hosted deployment keeps its SMTP password and its
 * model-provider key in `deployment_settings`, and the account allowed to read
 * and rewrite them is *derived*: `deploymentOperatorUserId` is the oldest
 * account, because there is no role above a site to ask. Nothing anywhere grants
 * or moves that role — so deleting the oldest account does not remove the
 * operator, it **silently promotes the next-oldest one**, who may be a viewer on
 * a single site and who never agreed to hold a relay credential. The transfer is
 * invisible from both ends: no confirmation, no audit entry, no screen that
 * changes until somebody opens the settings tab and finds it editable.
 *
 * So the operator cannot delete their own account, and the remedy is the one
 * this product already has for the same shape of problem — hand the thing over
 * first. Here that means clearing the stored settings, which returns the
 * deployment to its environment and makes the derived role worth nothing.
 *
 * **The guard fires only when `DEPLOYMENT_SETTINGS` is enabled, and that
 * restriction is the more important half.** A multi-tenant deployment sets it
 * `disabled`: there are no stored settings, no operator concept, and the oldest
 * account is nothing but the first customer who ever signed up. Refusing *their*
 * deletion would deny a real person the erasure ADR-0057 committed to giving
 * them, over a role that does not exist in that deployment. A safety measure
 * that fires in the hosted product is a defect, not a safety measure, so the
 * condition is checked before the identity is even looked up.
 *
 * It is checked first, ahead of the re-authentication and the confirmation.
 * Those two exist to prove intent, and no amount of proven intent changes this
 * answer — making somebody re-authenticate and type their own address in order
 * to be told "not while you hold this" is a worse answer than telling them
 * straight away.
 */

export interface MeDeletionRoutesDeps {
  readonly db: Database
  /**
   * Read for `DEPLOYMENT_SETTINGS` alone. Present rather than a bare boolean so
   * this module reads the same variable the settings surface and the worker's
   * mail drain read, from the same parsed environment — a second spelling of
   * "is this deployment self-hosted" is how the three drift apart.
   */
  readonly env: ServiceEnv<'api'>
}

type Env = { Variables: ApiVariables }

export function createMeDeletionRoutes(deps: MeDeletionRoutesDeps): Hono<Env> {
  const { db, env } = deps
  const app = new Hono<Env>()

  app.delete('/me', idempotent({ db, scope: 'me.delete' }), async (c) => {
    const user = c.get('user')
    const session = c.get('session')

    // The flag first, and the identity only if it is set: on a deployment that
    // configures itself from its environment there is no operator to be, and the
    // query that would ask is one this request has no business making.
    if (env.DEPLOYMENT_SETTINGS === 'enabled') {
      const operator = await deploymentOperatorUserId(db)
      if (operator !== null && operator === user.id) {
        throw new ApiError(
          'ACCOUNT_DELETION_BLOCKED',
          'This account administers the deployment. Clear its stored mail and assistant settings first, so the deployment falls back to its environment.',
          {
            // The same code the site holds use, because it is the same statement
            // — something depends on this account and must be dealt with first —
            // and the frontend already routes 409s here to a "deal with this
            // first" screen. `blocking_sites` is deliberately absent rather than
            // empty: no site is blocking, and `accountDeletionBlockers()` reads
            // its absence as "nothing to list" and falls through to the message.
            details: { reason: 'deployment_operator' },
          },
        )
      }
    }

    if (!isRecentReauth(session.createdAt, new Date())) {
      throw new ApiError('REAUTH_REQUIRED', 'Recent re-authentication required')
    }

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

    // Exact, not case-insensitive and not trimmed. The address is shown on the
    // screen the button lives on, so an exact match costs the user nothing and
    // makes the confirmation a deliberate act rather than an approximate one.
    const confirm = body['confirm']
    if (typeof confirm !== 'string' || confirm !== user.email) {
      throw new ApiError('VALIDATION_FAILED', 'The confirmation must be your exact email address', {
        details: { issues: [{ field: 'confirm', code: 'email_mismatch' }] },
      })
    }

    try {
      const started = await startAccountDeletion(db, { userId: user.id })
      return c.json({ deletion_request_id: started.deletionRequestId }, 202)
    } catch (error) {
      if (error instanceof AccountDeletionBlockedError) {
        // Every blocking site, with the reason each one blocks for. A refusal
        // that only said "you still have sites" would leave the caller to work
        // out which of two entirely different remedies each site needs.
        throw new ApiError(
          'ACCOUNT_DELETION_BLOCKED',
          'Sites still depend on this account and must be handed over or deleted first',
          {
            details: {
              blocking_sites: error.blockingSites.map((site) => ({
                site_id: site.siteId,
                slug: site.slug,
                reason: site.reason,
              })),
            },
          },
        )
      }
      throw error
    }
  })

  return app
}
