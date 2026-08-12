import type { ServiceEnv } from '@openanalytics/domain'
import {
  createAuth,
  drizzleAuthDatabase,
  type Auth,
  type OAuthCredentials,
} from '@openanalytics/auth'
import {
  EMAIL_OUTBOX_TOPIC,
  buildMagicLinkEmailPayload,
  buildVerificationEmailPayload,
} from '@openanalytics/integrations'
import type { Metrics } from '@openanalytics/observability'
import { enqueueOutbox, type Database } from '@openanalytics/postgres'
import { API_METRICS } from './metrics.ts'
import { parseTrustedOrigins } from './http/cors.ts'

/**
 * Wires Better Auth for the API service.
 *
 * The verification and magic-link emails are composed here and written to the
 * outbox — the API never sends mail itself (docs snapshot 02 §5; RESEND_API_KEY
 * is on the API's FORBIDDEN list). Social providers are added only when their
 * credentials are present, so a deployment with no OAuth app configured simply
 * omits them.
 */

export interface ApiAuthDeps {
  readonly env: ServiceEnv<'api'>
  readonly db: Database
  /**
   * The G-006 sink, for the enqueue counters below. Optional so a test that only
   * needs an auth instance need not build one.
   */
  readonly metrics?: Metrics | undefined
}

function socialFromEnv(env: ServiceEnv<'api'>): {
  google?: OAuthCredentials
  github?: OAuthCredentials
} {
  const social: { google?: OAuthCredentials; github?: OAuthCredentials } = {}
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    social.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    social.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
  }
  return social
}

/**
 * The three browser destinations the authorization server hands out
 * (ADR-0043 D14).
 *
 * Two of them are the api's own, and one is the frontend's, and which is which
 * is the whole of D14:
 *
 * - **Login is `apps/web`'s** — there is one login screen and OAuth does not get
 *   a second. `APP_BASE_URL` names the frontend, exactly as the invite and
 *   Stripe return links do; `AUTH_BASE_URL` is the api host and building a login
 *   link from it sends a person to a page the api does not serve, which is the
 *   defect ADR-0019 fixed for those links.
 * - **Consent and device verification are the api's**, served as minimal HTML,
 *   so M16 reaches production without a frontend deploy. They are deliberately
 *   plain: a designed frontend replaces them later, and until then an OAuth flow
 *   with no consent screen would be an OAuth flow with no consent.
 *
 * Both api pages are absolute URLs on `AUTH_BASE_URL`, not paths. Better Auth
 * resolves a bare path against its own base and would reach the same place
 * today, but the device `verification_uri` is *printed for a human to type into
 * whichever browser they have*, and a relative URI there is unusable.
 */
export const OAUTH_CONSENT_PATH = '/oauth/consent'
export const OAUTH_DEVICE_PATH = '/oauth/device'

export function oauthPageUrls(env: ServiceEnv<'api'>): {
  loginPage: string
  consentPage: string
  deviceVerificationUri: string
} {
  const apiBase = (env.AUTH_BASE_URL ?? 'http://localhost:4000').replace(/\/$/u, '')
  const appBase = (env.APP_BASE_URL ?? env.AUTH_BASE_URL ?? 'http://localhost:3000').replace(
    /\/$/u,
    '',
  )
  return {
    loginPage: `${appBase}/login`,
    consentPage: `${apiBase}${OAUTH_CONSENT_PATH}`,
    deviceVerificationUri: `${apiBase}${OAUTH_DEVICE_PATH}`,
  }
}

/**
 * The two outbox writes Better Auth calls to deliver a sign-in link, and their
 * counter.
 *
 * Exported as a factory rather than left inline so the counter can be proven
 * without standing up Better Auth to provoke a magic link. The whole point of
 * the metric is that "nobody can sign in" and "nobody is trying to sign in"
 * stopped looking identical, and a metric asserted only through a stack that
 * needs a live database is a metric that will be asserted in an integration
 * suite nobody runs on a laptop.
 */
export function createAuthEmailSenders(deps: {
  readonly db: Database
  readonly productName: string
  readonly metrics?: Metrics | undefined
}): {
  sendVerificationEmail: (input: { to: string; url: string; token: string }) => Promise<void>
  sendMagicLinkEmail: (input: { to: string; url: string; token: string }) => Promise<void>
} {
  const { db, productName, metrics } = deps
  return {
    // The counter follows the write rather than preceding it: what is measured
    // is a row that exists, and an `enqueueOutbox` that throws must not leave a
    // count claiming mail was queued. The address is never a label and never a
    // log field — the outbox row is the only place it lives.
    sendVerificationEmail: async ({ to, url, token }) => {
      await enqueueOutbox(db, {
        topic: EMAIL_OUTBOX_TOPIC,
        payload: buildVerificationEmailPayload({ to, url, productName }) as unknown as Record<
          string,
          unknown
        >,
        idempotencyKey: `email.verification:${token}`,
      })
      metrics?.increment(API_METRICS.authEmailEnqueued, { kind: 'verification' })
    },
    sendMagicLinkEmail: async ({ to, url, token }) => {
      await enqueueOutbox(db, {
        topic: EMAIL_OUTBOX_TOPIC,
        payload: buildMagicLinkEmailPayload({ to, url, productName }) as unknown as Record<
          string,
          unknown
        >,
        idempotencyKey: `email.magic_link:${token}`,
      })
      metrics?.increment(API_METRICS.authEmailEnqueued, { kind: 'magic_link' })
    },
  }
}

export function createApiAuth(deps: ApiAuthDeps): Auth {
  const { env, db, metrics } = deps

  const secret = env.AUTH_SECRET
  if (!secret) {
    throw new Error('AUTH_SECRET is required to mount authentication')
  }

  const productName = env.PRODUCT_NAME
  // The same allowlist the credentialed CORS middleware answers to, parsed by the
  // same function: Better Auth's origin/CSRF check and the browser's CORS check
  // are two halves of one boundary, and two parses of one variable could drift.
  const trustedOrigins = parseTrustedOrigins(env.AUTH_TRUSTED_ORIGINS)
  const social = socialFromEnv(env)

  return createAuth({
    database: drizzleAuthDatabase(db),
    secret,
    ...oauthPageUrls(env),
    ...(env.AUTH_BASE_URL === undefined ? {} : { baseURL: env.AUTH_BASE_URL }),
    productName,
    trustedOrigins,
    // Only ever set to `none` for the pre-launch localhost-testing window; the
    // rationale and the restore step live with the variable in
    // `packages/domain/src/env.ts` and in `docs/dev/localhost-live-testing.md`.
    ...(env.AUTH_COOKIE_SAMESITE === undefined ? {} : { cookieSameSite: env.AUTH_COOKIE_SAMESITE }),
    // Password routes are a test-harness affordance; production does not set
    // AUTH_PASSWORD_SIGNIN, so they are not mounted there (ADR-0059).
    enablePasswordSignIn: env.AUTH_PASSWORD_SIGNIN === 'enabled',
    // Required unless a self-hosted deployment with no working mail transport
    // has relaxed it; production does not set AUTH_EMAIL_VERIFICATION and so
    // gets the same `true` this line replaced.
    requireEmailVerification: env.AUTH_EMAIL_VERIFICATION === 'required',
    ...(Object.keys(social).length > 0 ? { social } : {}),
    ...createAuthEmailSenders({ db, productName, metrics }),
  })
}
