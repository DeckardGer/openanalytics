import type { Auth } from '@openanalytics/auth'
import type { ServiceEnv } from '@openanalytics/domain'
import type { Logger, Metrics } from '@openanalytics/observability'
import type { Database } from '@openanalytics/postgres'
import type { RealtimeCache } from '@openanalytics/redis'
import type { Hono } from 'hono'
import type { CredentialUseRecorder } from './http/credential-events.ts'
import type { ApiVariables } from './http/middleware.ts'

/**
 * The seam an optional HTTP surface mounts through.
 *
 * The registration shape the rest of the split uses (`registerErrorCodes`,
 * `registerEnvExtension`, `registerSiteCreateExtension`), applied to routing.
 * The hosted billing, usage and notify surfaces live in `src/cloud/` and are
 * reached only from here: `main.cloud.ts` imports that tree, whose import
 * registers this extension, and `main.ts` — the product entry point — reads the
 * registry without naming a single cloud module. That is what lets
 * `scripts/check-boundaries.mjs` make "no product file imports `cloud/`" a build
 * failure rather than a habit.
 *
 * Two hooks, because the two groups of routes have different placement rules and
 * only one of them is negotiable:
 *
 * - `preSessionRoutes` are matched **before** the business subtree claims
 *   `/v1` behind its blanket session guard. The Stripe webhook is
 *   signature-authenticated over the raw body and would otherwise be answered
 *   `401`, which is the same reason the read-key surface, the public dashboard
 *   and the revenue webhook sit on that shelf (see `app.ts`).
 * - `businessRoutes` is mounted *inside* it, on the authenticated router, because
 *   the billing-transfer flow is a session (or grant) acting on a membership.
 */
export interface ApiCloudRoute {
  /** The prefix `app.route()` is called with, e.g. `/v1/billing`. */
  readonly path: string
  /**
   * `ApiVariables` whether or not the router resolves a principal, because that
   * is what `app.route` on this api's tree infers: a union here cannot be
   * inferred to one sub-environment, and the wider declaration costs an
   * unauthenticated subtree nothing — it simply never reads the variables a
   * session sets. The product's own mix of authenticated and anonymous subtrees
   * is declared the same way for the same reason.
   */
  readonly router: Hono<{ Variables: ApiVariables }>
}

/** What a pre-session cloud surface is handed. Everything here already exists in
 * `createApp`; nothing is constructed for the extension's benefit. */
export interface ApiCloudContext {
  readonly db: Database
  readonly auth: Auth
  readonly env: ServiceEnv<'api'>
  readonly logger: Logger
  readonly metrics?: Metrics
  /** G-010's recorder (ADR-0051 D5) — the same object the product's own
   * authenticators hold, never a second one. */
  readonly recordCredentialUse?: CredentialUseRecorder
}

/** What the business-subtree extension is handed: the pre-session context plus
 * the realtime cache, which the ownership cutover bumps. */
export interface ApiCloudBusinessContext {
  readonly db: Database
  readonly env: ServiceEnv<'api'>
  readonly realtime?: { readonly cache: RealtimeCache }
}

export interface ApiCloudExtension {
  readonly name: string
  readonly preSessionRoutes?: (ctx: ApiCloudContext) => readonly ApiCloudRoute[]
  readonly businessRoutes?: (ctx: ApiCloudBusinessContext) => Hono<{ Variables: ApiVariables }>
}

let registered: ApiCloudExtension | undefined

/**
 * Declares the api's optional surfaces. Idempotent by name, so importing the
 * cloud tree twice registers once; a *second, different* extension is a
 * programming error rather than a merge, because the mount order between two
 * unrelated pre-session subtrees would then be an accident of import order.
 */
export function registerApiCloudExtension(extension: ApiCloudExtension): void {
  if (registered?.name === extension.name) return
  if (registered) {
    throw new Error(
      `an api cloud extension is already registered ("${registered.name}"); ` +
        `"${extension.name}" would make the mount order depend on import order`,
    )
  }
  registered = extension
}

/** The registered extension, or `undefined` in a build that mounts none — which
 * is every self-hosted install and every test that does not ask for one. */
export function apiCloudExtension(): ApiCloudExtension | undefined {
  return registered
}
