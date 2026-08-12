import { type ServiceEnv } from '@openanalytics/domain'
import type { Logger } from '@openanalytics/observability'
import { hasAnyUser, type Database } from '@openanalytics/postgres'
import { Hono } from 'hono'
import type { ApiVariables } from './middleware.ts'
import { clientAddress } from './oauth.ts'
import type { RateLimiter } from './rate-limit.ts'

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
 * Email+password **is** listed now, and only when `AUTH_PASSWORD_SIGNIN` is
 * enabled. The 2026-07-26 decision that the doors are Google, GitHub and the
 * magic link was written for the hosted product, where mail is configured and a
 * password is a liability nobody asked for. It stranded every self-hosted
 * install: with no OAuth app and no mail transport there was no door at all,
 * `create-admin` wrote an account the dashboard had no field to sign in with,
 * and the only way in was registering an app with a third party — for a product
 * whose argument is that you do not need one. The deployment decides, the
 * endpoint reports the decision, and the login screen draws what it is told.
 */

export const AUTH_PROVIDER_KINDS = ['oauth', 'email', 'password'] as const
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

  // The same condition Better Auth is handed in `auth.ts`, so the list cannot
  // advertise a form whose endpoints are not mounted.
  if (env.AUTH_PASSWORD_SIGNIN === 'enabled') {
    providers.push({ id: 'password', kind: 'password' })
  }

  return providers
}

type Env = { Variables: ApiVariables }

/** Long enough to be worth having, short enough that nobody writes it down. */
const MIN_PASSWORD_LENGTH = 12

/** Good enough to catch a typo; the address is proved by using it, not by a regex. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/**
 * The Better Auth surface this file needs. Declared structurally rather than
 * importing the concrete type, so this module does not depend on how the api
 * happens to build its auth instance.
 */
interface AuthApi {
  readonly api: {
    signUpEmail: (input: {
      body: { email: string; password: string; name: string }
    }) => Promise<unknown>
    signInEmail: (input: {
      body: { email: string; password: string }
      asResponse: true
    }) => Promise<Response>
  }
}

export interface AuthProviderDeps {
  readonly env: ServiceEnv<'api'>
  readonly logger: Logger
  readonly db?: Database
  readonly auth?: AuthApi
  /** Marks the first account's address verified; there is no mail to prove it with. */
  readonly markVerified?: (email: string) => Promise<void>
  readonly setupRateLimiter: RateLimiter
}

export function createAuthProviderRoutes(deps: AuthProviderDeps): Hono<Env> {
  const app = new Hono<Env>()

  /**
   * Whether this deployment has nobody in it yet.
   *
   * Fails **closed**, and that direction matters in both places it is used. On
   * the login screen a failed read must not take the door down, so the screen
   * offers the ordinary sign-in rather than a 500; on the setup route the same
   * answer refuses to create an account. An unreadable database is a reason to
   * do nothing, never a reason to assume the deployment is unclaimed.
   */
  const setupRequired = async (): Promise<boolean> => {
    const db = deps.db
    if (db === undefined) return false
    try {
      return !(await hasAnyUser(db))
    } catch (err) {
      deps.logger.warn('setup_state_unreadable', {
        reason: err instanceof Error ? err.message : 'unknown',
      })
      return false
    }
  }

  app.get('/auth/providers', async (c) =>
    c.json({
      items: enabledAuthProviders(deps.env),
      setup_required: await setupRequired(),
    }),
  )

  /**
   * Create the first account, and sign in with it.
   *
   * Mounted without a session because the whole point is that no session can
   * exist yet: a deployment with zero users has no way in, and this is it. The
   * guard is the emptiness of the table — the moment one row exists this
   * answers `409` and keeps answering it forever, so the route closes itself
   * and there is no flag anyone has to remember to turn off.
   *
   * **The window is real and worth naming.** Between the first successful boot
   * and the operator creating the account, anybody who can reach the api can
   * take it. It is minutes on a machine whose four DNS records were published
   * for this purpose, and the alternative — a setup token printed to the log —
   * reintroduces exactly the "go and read the log" step that made the previous
   * bootstrap so bad. So it is left open, rate-limited, and logged loudly with
   * the address that claimed it, and SELF-HOSTING says to do this first.
   *
   * The address is marked verified because there is nothing to verify it with:
   * the account exists precisely because mail is not configured yet. That is
   * also what makes it the *same* account later — sign in with the same address
   * once OAuth or SMTP works and you land here rather than on a second one.
   */
  app.post('/auth/setup', async (c) => {
    const auth = deps.auth
    const markVerified = deps.markVerified
    if (deps.db === undefined || auth === undefined || markVerified === undefined) {
      return c.json(
        { code: 'NOT_CONFIGURED', message: 'This deployment has no auth database.' },
        503,
      )
    }

    const window = deps.setupRateLimiter.check(`setup-ip:${clientAddress(c.req.raw)}`)
    if (!window.allowed) {
      return c.json({ code: 'RATE_LIMITED', message: 'Too many attempts.' }, 429, {
        'retry-after': String(window.retryAfterSeconds),
      })
    }

    // Checked before the body is even read: a deployment that is past setup owes
    // an anonymous caller nothing, not even a validation error.
    if (!(await setupRequired())) {
      return c.json(
        {
          code: 'SETUP_COMPLETE',
          message: 'This deployment already has an account. Sign in instead.',
        },
        409,
      )
    }

    const body = (await c.req.json().catch(() => null)) as {
      email?: unknown
      password?: unknown
      name?: unknown
    } | null
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const name =
      typeof body?.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : (email.split('@')[0] ?? 'Administrator')

    if (!LOOKS_LIKE_EMAIL.test(email)) {
      return c.json({ code: 'VALIDATION_FAILED', message: 'Enter a valid email address.' }, 400)
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return c.json(
        {
          code: 'VALIDATION_FAILED',
          message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
        },
        400,
      )
    }

    try {
      await auth.api.signUpEmail({ body: { email, password, name } })
    } catch (err) {
      // A duplicate is reachable despite the guard if two requests race. It is
      // not a crash, and it is not this caller's business which address exists.
      deps.logger.warn('setup_signup_refused', {
        reason: err instanceof Error ? err.message : 'unknown',
      })
      return c.json(
        { code: 'SETUP_COMPLETE', message: 'This deployment already has an account.' },
        409,
      )
    }

    // Before the sign-in, not after: `requireEmailVerification` refuses a
    // session for an unverified address, and this one can never be verified the
    // ordinary way.
    await markVerified(email)

    // Loud, and deliberately not identifying. Claiming a deployment is worth a
    // `warn`, but this repository's rule is that a raw address — postal or
    // network — never reaches a log line: `routes.ts` says an invitee's email
    // "never reaches the audit trail or a log", and `credential-source.ts` HMACs
    // client addresses rather than writing them down. Both applied here.
    //
    // The recipient *domain* is what the log transport already records for every
    // message it handles, and it is enough to recognise the claim. Who actually
    // holds the account is a `SELECT` away in `users`, which is where an
    // identity belongs.
    deps.logger.warn('setup_first_account_created', {
      email_domain: email.slice(email.lastIndexOf('@') + 1),
      detail: 'the first account was created through the unauthenticated setup route',
    })

    // Better Auth writes the session cookie onto its own response, so the
    // response is forwarded rather than rebuilt — a hand-copied Set-Cookie is
    // one attribute away from a session that silently does not stick.
    return auth.api.signInEmail({ body: { email, password }, asResponse: true })
  })

  return app
}
