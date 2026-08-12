#!/usr/bin/env node
/**
 * Bootstrap the first operator of a self-hosted install.
 *
 * ## Why this exists
 *
 * The product has one front door — OAuth and magic link — and a fresh install
 * has neither: no OAuth app is registered, and until a mail transport is
 * configured the magic link has nowhere to be delivered. That leaves a new
 * deployment with no way for anyone to sign in *at all*.
 *
 * So this writes one verified account directly. **It does not by itself finish
 * the job**, and the summary it prints says so: the dashboard's sign-in page
 * offers the three providers and has no password field, so nothing in a browser
 * can send the password this writes. What the account is worth is that the
 * address is already present and verified — configure a door and sign in with
 * it, and Better Auth resolves to this account rather than making a second one
 * (`users_email_key`, migration 0001, is what makes that a constraint rather
 * than a hope). The first-run screen that would close the gap properly is a
 * separate piece of work.
 *
 * ## What it does, and what it deliberately does not
 *
 * - It calls **Better Auth's own server API** (`auth.api.signUpEmail`) rather
 *   than writing an `accounts` row itself. The password hash format is Better
 *   Auth's business — scrypt with its own parameters — and a hand-rolled hash
 *   that is subtly wrong produces an account that exists and cannot sign in,
 *   which is the worst possible outcome for a bootstrap tool.
 * - It then sets `email_verified` directly, because that is the one thing the
 *   sign-up flow cannot do for us: verification arrives by email, and the whole
 *   premise here is that email does not work yet. This is a deliberate, single,
 *   stated exception — not a general "trust the operator" mode.
 * - It **never overwrites an existing account**. A repeat run against an email
 *   that already exists exits non-zero and changes nothing, so a re-run cannot
 *   silently reset somebody's password. Rotating a password is a different
 *   operation and it is the application's, not this script's.
 * - It creates a user and nothing else. No site, no membership, no plan: those
 *   are the product's own onboarding, and a bootstrap that pre-created them
 *   would be a second, divergent implementation of it.
 *
 * ## The gate this does not open
 *
 * Password sign-in is off unless `AUTH_PASSWORD_SIGNIN=enabled` is set on the
 * api service (ADR-0059 — production does not set it). This script writes a
 * password account regardless, because the account has to exist before the gate
 * is worth opening. Opening it mounts the api's password endpoints and nothing
 * more: no dashboard surface posts to them, so the flag reaches an API client
 * and not a browser. The summary states that rather than sending the operator
 * to a login page that cannot honour it.
 *
 * ## Usage
 *
 *   pnpm run build                      # this script imports built packages
 *   set -a; . ./.env; set +a
 *   ADMIN_PASSWORD='…' pnpm run create-admin -- --email you@example.com
 *
 * `DATABASE_URL` and `AUTH_SECRET` are required and read from the environment;
 * `--password` is accepted but `ADMIN_PASSWORD` is preferred, because arguments
 * are visible in the host's process list and environment variables are not.
 * With neither, a strong password is generated and printed once.
 */
import { randomBytes } from 'node:crypto'
import process from 'node:process'

/** Better Auth's own floor is 8; this is the floor for an account that is, by
 * construction, the most privileged one on the install. */
const MIN_PASSWORD_LENGTH = 12
/** 18 bytes of base64url — 144 bits, printed once and never stored by us. */
const GENERATED_PASSWORD_BYTES = 18

function fail(message) {
  process.stderr.write(`create-admin: ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { email: undefined, password: undefined, name: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const [flag, inlineValue] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined]
    const take = () => {
      if (inlineValue !== undefined) return inlineValue
      i += 1
      return argv[i]
    }
    switch (flag) {
      case '--email':
        args.email = take()
        break
      case '--password':
        args.password = take()
        break
      case '--name':
        args.name = take()
        break
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: pnpm run create-admin -- --email <address> [--name <name>]\n' +
            '  Password: ADMIN_PASSWORD env (preferred), --password, or generated.\n' +
            '  Requires DATABASE_URL and AUTH_SECRET in the environment.\n',
        )
        process.exit(0)
        break
      default:
        fail(`unknown argument "${arg}" (try --help)`)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const email = (args.email ?? process.env['ADMIN_EMAIL'] ?? '').trim().toLowerCase()
if (!email || !email.includes('@')) {
  fail('an email address is required: --email you@example.com (or ADMIN_EMAIL)')
}

const connectionString = process.env['DATABASE_URL']
if (!connectionString) {
  fail('DATABASE_URL is required (the same value the api and worker use)')
}

const secret = process.env['AUTH_SECRET']
if (!secret) {
  fail('AUTH_SECRET is required — it must be the SAME value the api service runs with')
}

// Precedence: the environment first, because an argument is visible to every
// other process on the host and an environment variable is not.
let password = process.env['ADMIN_PASSWORD'] ?? args.password
let generated = false
if (!password) {
  password = randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url')
  generated = true
} else if (password.length < MIN_PASSWORD_LENGTH) {
  fail(`the password must be at least ${MIN_PASSWORD_LENGTH} characters`)
}

const name = args.name ?? process.env['ADMIN_NAME'] ?? (email.split('@')[0] || 'Administrator')

/**
 * Built output, not source: this is a plain Node script, so it consumes the
 * packages the way a deployment does. A missing `dist` means the build has not
 * run, and saying that is more useful than Node's module-resolution error.
 */
async function loadWorkspace() {
  try {
    const [auth, postgres] = await Promise.all([
      import('../packages/auth/dist/index.js'),
      import('../packages/postgres/dist/index.js'),
    ])
    return { auth, postgres }
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ERR_MODULE_NOT_FOUND') {
      fail('the workspace is not built — run `pnpm run build` first')
    }
    throw err
  }
}

const { auth: authPkg, postgres } = await loadWorkspace()
const pool = postgres.createPool(connectionString)

try {
  const existing = await pool.query('SELECT id FROM users WHERE lower(email) = $1 LIMIT 1', [email])
  if (existing.rowCount > 0) {
    fail(
      `an account already exists for ${email} — this script never overwrites one. ` +
        'Use a different address, or reset the password from the application.',
    )
  }

  const db = postgres.createDatabase(pool)
  const auth = authPkg.createAuth({
    database: authPkg.drizzleAuthDatabase(db),
    secret,
    baseURL: process.env['AUTH_BASE_URL'] ?? 'http://localhost:4000',
    productName: process.env['PRODUCT_NAME'] ?? 'Open Analytics',
    trustedOrigins: [],
    // This instance is process-local and serves no HTTP: enabling the password
    // endpoints here does not mount anything anywhere. Whether the *api* accepts
    // a password sign-in is `AUTH_PASSWORD_SIGNIN`, and the summary below says so.
    enablePasswordSignIn: true,
    // Required by the options builder and never reached: sign-up sends the
    // verification mail, and the account this creates is verified below instead
    // — which is the entire reason the script exists.
    sendVerificationEmail: async () => {},
  })

  let userId
  try {
    const result = await auth.api.signUpEmail({ body: { email, password, name } })
    userId = result?.user?.id
  } catch (err) {
    // Better Auth reports a duplicate as a typed API error. It is reachable
    // despite the SELECT above if two runs race, and it must still not read as a
    // crash.
    const code = err && typeof err === 'object' ? err.body?.code : undefined
    if (code === 'USER_ALREADY_EXISTS') {
      fail(`an account already exists for ${email} — nothing was changed`)
    }
    const detail = err instanceof Error ? err.message : 'unknown error'
    fail(`Better Auth refused the sign-up: ${detail}`)
  }

  // The one thing the sign-up flow cannot do here: mark the address verified
  // without a mail round trip. Scoped to the row just created and gated on the
  // column still being false, so it can only ever move an account this run made.
  const verified = await pool.query(
    'UPDATE users SET email_verified = true, updated_at = now() WHERE lower(email) = $1 AND email_verified = false RETURNING id',
    [email],
  )
  userId ??= verified.rows[0]?.id
  if (!userId) {
    fail('the account was created but could not be read back — check the database and retry')
  }

  const loginBase = (process.env['APP_BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/u, '')
  process.stdout.write(
    `\ncreate-admin: account ready\n` +
      `  email     ${email}\n` +
      `  user id   ${userId}\n` +
      (generated ? `  password  ${password}   (generated — copy it now, it is not stored)\n` : '') +
      `\nWhat this account can and cannot do today\n` +
      `  The dashboard's sign-in page has no password field: it offers Google,\n` +
      `  GitHub and the magic link. So this account cannot be signed into from a\n` +
      `  browser yet, and the password above is for the api's own password\n` +
      `  endpoints, which mount only when AUTH_PASSWORD_SIGNIN=enabled is set on\n` +
      `  the api service.\n` +
      `\n` +
      `  What it does give you is a verified account on this address. Configure\n` +
      `  either door and sign in at ${loginBase}/login with the same address, and\n` +
      `  you land on this account rather than a second one:\n` +
      `    - OAuth:      GOOGLE_CLIENT_ID/SECRET or GITHUB_CLIENT_ID/SECRET on the api\n` +
      `    - Magic link: SMTP_HOST (or RESEND_API_KEY) on the worker\n`,
  )
} finally {
  await pool.end()
}
