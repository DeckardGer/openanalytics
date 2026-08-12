import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createAuth, drizzleAuthDatabase, type Auth } from '@openanalytics/auth'
import { createDatabase, createPool, migratePostgres, type Database } from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `scripts/create-admin.mjs` against a real Postgres and the real Better Auth
 * pipeline.
 *
 * The script exists because a fresh self-hosted install has no way for anyone to
 * sign in, so the thing worth proving is not that it inserts rows — it is that
 * the account it writes **can actually sign in**, through the same Better Auth
 * server API the api service mounts. A bootstrap that produces an account with a
 * subtly wrong password hash is worse than no bootstrap at all: it looks like it
 * worked.
 *
 * The script is run as a child process rather than imported, because what ships
 * to an operator is the CLI, including its argument handling and its exit codes.
 * It imports the built packages, so `pnpm run build` must have run — which
 * `pnpm run verify` does before the suite.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/postgres/migrations/', import.meta.url),
)
const SCRIPT = fileURLToPath(new URL('../../scripts/create-admin.mjs', import.meta.url))
const AUTH_SECRET = 'create-admin-secret-'.padEnd(48, 'x')
const PASSWORD = 'bootstrap-pw-9182'

/**
 * The two magic-link endpoints, named here because `Auth`'s inferred type
 * cannot see them: `createAuth` spreads the plugin in only when a sender is
 * configured, so the static type describes an instance without it while the
 * runtime instance has it. Narrowed at the one call site rather than widened at
 * the source — the conditional is deliberate, and the runtime shape is exactly
 * what this test exists to check.
 */
interface MagicLinkApi {
  signInMagicLink(input: { body: { email: string }; headers: Headers }): Promise<unknown>
  magicLinkVerify(input: {
    query: { token: string }
    headers: Headers
  }): Promise<{ user: { id: string } }>
}

describeIfPostgres('create-admin bootstrap', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `w3admin_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let scoped: string
  let pool: Pool
  let db: Database
  let auth: Auth
  /** A second instance with the magic-link plugin mounted, and its outbox. */
  let magicAuth: Auth
  const magicLinks: { to: string; url: string; token: string }[] = []

  const runScript = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: scoped,
        AUTH_SECRET,
        ADMIN_PASSWORD: PASSWORD,
        ...extraEnv,
      },
    })

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }

    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    scoped = url.toString()

    const { logger } = createCapturedLogger()
    await migratePostgres({ connectionString: scoped, directory: MIGRATIONS_DIR, logger })

    pool = createPool(scoped)
    db = createDatabase(pool)
    // The api's own posture: verification required, password endpoints mounted
    // (which is what AUTH_PASSWORD_SIGNIN=enabled does on a real deployment).
    auth = createAuth({
      database: drizzleAuthDatabase(db),
      secret: AUTH_SECRET,
      baseURL: 'http://localhost:4000',
      productName: 'Acme Metrics',
      trustedOrigins: ['http://localhost:4000'],
      enablePasswordSignIn: true,
      sendVerificationEmail: async () => {},
    })
    // The plugin mounts only when a sender is configured, which is exactly the
    // deployment this script is written for once its operator adds SMTP.
    magicAuth = createAuth({
      database: drizzleAuthDatabase(db),
      secret: AUTH_SECRET,
      baseURL: 'http://localhost:4000',
      productName: 'Acme Metrics',
      trustedOrigins: ['http://localhost:4000'],
      sendVerificationEmail: async () => {},
      sendMagicLinkEmail: async (message) => {
        magicLinks.push(message)
      },
    })
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('creates a verified account whose password Better Auth accepts', async () => {
    const email = `founder-${Date.now()}@example.com`
    const result = runScript(['--email', email])

    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    // The gate the account still needs, stated where the operator will see it.
    expect(result.stdout).toContain('AUTH_PASSWORD_SIGNIN=enabled')

    const row = await pool.query('SELECT id, email_verified FROM users WHERE email = $1', [email])
    expect(row.rowCount).toBe(1)
    expect(row.rows[0].email_verified).toBe(true)

    // The whole point: the hash the script produced is one Better Auth verifies.
    const signedIn = await auth.api.signInEmail({ body: { email, password: PASSWORD } })
    expect(signedIn.user.email).toBe(email)
  })

  it('is the account a later magic-link sign-in lands on, not a second one', async () => {
    // The sentence the script prints. Its whole remaining value is this: the
    // dashboard has no password field, so nobody signs in with what it wrote —
    // what the operator gets is a verified address that the first real door
    // they configure resolves to. If magic link made a *second* user, the
    // bootstrap would be worse than useless, because the account holding the
    // install's first membership would not be the one they are signed into.
    const email = `magic-${Date.now()}@example.com`
    expect(runScript(['--email', email]).status).toBe(0)
    const before = await pool.query('SELECT id FROM users WHERE email = $1', [email])
    expect(before.rowCount).toBe(1)

    magicLinks.length = 0
    const magicApi = magicAuth.api as unknown as MagicLinkApi
    await magicApi.signInMagicLink({ body: { email }, headers: new Headers() })
    const sent = magicLinks.at(-1)
    expect(sent?.to).toBe(email)

    const verified = await magicApi.magicLinkVerify({
      query: { token: sent?.token as string },
      headers: new Headers(),
    })
    expect(verified.user.id).toBe(before.rows[0].id)

    // And the constraint under it, so this is a property of the schema rather
    // than of one plugin's current behaviour.
    const rows = await pool.query('SELECT id FROM users WHERE email = $1', [email])
    expect(rows.rowCount).toBe(1)
  })

  it('is the verification write that makes that sign-in possible', async () => {
    // The control. An account created the ordinary way is unverified, and the
    // same call refuses it — so the assertion above is measuring the script's
    // one deliberate exception rather than a permissive default.
    const email = `unverified-${Date.now()}@example.com`
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'U' } })

    const row = await pool.query('SELECT email_verified FROM users WHERE email = $1', [email])
    expect(row.rows[0].email_verified).toBe(false)

    await expect(auth.api.signInEmail({ body: { email, password: PASSWORD } })).rejects.toThrow()
  })

  it('refuses a second run for the same address and changes nothing', async () => {
    const email = `repeat-${Date.now()}@example.com`
    expect(runScript(['--email', email]).status).toBe(0)

    const second = runScript(['--email', email], { ADMIN_PASSWORD: 'a-completely-different-pw' })
    expect(second.status).toBe(1)
    expect(second.stderr).toContain('already exists')

    // Not merely "it exited non-zero": the original credential still works, so
    // the refused run cannot have half-reset the account.
    const rows = await pool.query('SELECT id FROM users WHERE email = $1', [email])
    expect(rows.rowCount).toBe(1)
    const signedIn = await auth.api.signInEmail({ body: { email, password: PASSWORD } })
    expect(signedIn.user.email).toBe(email)
  })

  it('generates a password when none is supplied, and prints it once', async () => {
    const email = `generated-${Date.now()}@example.com`
    const result = runScript(['--email', email], { ADMIN_PASSWORD: '' })

    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    const match = /password\s+(\S+)\s+\(generated/u.exec(result.stdout)
    expect(match, `stdout: ${result.stdout}`).not.toBeNull()

    const signedIn = await auth.api.signInEmail({
      body: { email, password: match?.[1] as string },
    })
    expect(signedIn.user.email).toBe(email)
  })

  it('refuses to run without the arguments it cannot invent', async () => {
    expect(runScript([]).status).toBe(1)
    expect(runScript(['--email', 'a@b.com'], { AUTH_SECRET: '' }).stderr).toContain('AUTH_SECRET')
  })
})
