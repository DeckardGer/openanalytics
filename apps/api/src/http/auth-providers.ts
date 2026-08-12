import { type ServiceEnv } from '@openanalytics/domain'
import { Hono } from 'hono'
import type { ApiVariables } from './middleware.ts'

/**
 * The sign-in methods this deployment actually offers.
 *
 * The frontend hard-coded its Google and GitHub buttons, so a deployment with no
 * GitHub OAuth app configured still rendered a GitHub button that could only end
 * in a provider error page. Which providers exist is server configuration; the
 * login screen should read it rather than assume it.
 *
 * Deliberately public and session-free: it is asked *before* anyone is signed in,
 * and it discloses only what a sign-in attempt would reveal in one click anyway.
 * It carries no client ids, no URLs and no secrets — only which doors exist.
 *
 * Email+password is **not** listed even though the endpoints are still mounted.
 * They exist for the test harness (there is no way to drive an OAuth consent
 * screen from a test), and the product decision of 2026-07-26 is that the only
 * doors are Google, GitHub and the magic link — each of which creates or signs in
 * to an account with no separate sign-up screen. A frontend that rendered a
 * password form from this list would be contradicting that decision.
 */

export const AUTH_PROVIDER_KINDS = ['oauth', 'email'] as const
export type AuthProviderKind = (typeof AUTH_PROVIDER_KINDS)[number]

export interface AuthProvider {
  readonly id: string
  readonly kind: AuthProviderKind
}

/**
 * Mirrors `socialFromEnv` in `apps/api/src/auth.ts`: a provider is enabled
 * exactly when both halves of its credential are present, which is the same
 * condition that decides whether Better Auth mounts it at all. Both halves,
 * because a client id with no secret is a button that fails at the callback
 * rather than at the click.
 */
export function enabledAuthProviders(env: ServiceEnv<'api'>): AuthProvider[] {
  const providers: AuthProvider[] = []

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push({ id: 'google', kind: 'oauth' })
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.push({ id: 'github', kind: 'oauth' })
  }
  // Always available wherever the auth surface is mounted: `createApiAuth` always
  // installs the magic-link plugin, because the send path is an outbox write and
  // needs no provider credential. Whether the mail is *delivered* depends on the
  // worker's drain and its Resend key, which this service cannot observe — and a
  // link that is queued but slow is a different problem from a door that does not
  // exist.
  providers.push({ id: 'magic_link', kind: 'email' })

  return providers
}

type Env = { Variables: ApiVariables }

export function createAuthProviderRoutes(deps: { readonly env: ServiceEnv<'api'> }): Hono<Env> {
  const app = new Hono<Env>()

  app.get('/auth/providers', (c) => c.json({ items: enabledAuthProviders(deps.env) }))

  return app
}
