import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildAuthOptions, memoryAdapter } from '@openanalytics/auth'
import { isValidTimezone, timezoneSchema, userPreferencesFixture } from '@openanalytics/contracts'
import { schemaTableColumns } from '@openanalytics/postgres'
import { describe, expect, it } from 'vitest'

/**
 * The user timezone preference, at the contract layer (ADR-0026).
 *
 * The contract is edited before the implementation (AGENTS.md), so the document
 * itself is asserted here. The fixture is annotated with its generated schema
 * type, so importing it also proves the generated client and the spec agree
 * about the shape.
 *
 * The behavioural half — the session guard, the IANA refusal, null-versus-absent
 * — drives the real app in `tests/unit/api-user-preferences-routes.test.ts`; the
 * database half is in `tests/migration/user-preferences.test.ts`.
 */

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)
const MIGRATION_PATH = fileURLToPath(
  new URL('../../packages/postgres/migrations/0017_user_timezone.sql', import.meta.url),
)

async function spec(): Promise<string> {
  return readFile(SPEC_PATH, 'utf8')
}

/** The slice of the document belonging to one path item. */
function pathItem(text: string, path: string, nextPath: string): string {
  const start = text.indexOf(`  ${path}:`)
  expect(start, `openapi.yaml is missing the path ${path}`).toBeGreaterThan(-1)
  const end = text.indexOf(`  ${nextPath}:`, start)
  expect(end, `expected ${nextPath} to follow ${path}`).toBeGreaterThan(start)
  return text.slice(start, end)
}

describe('OpenAPI documents the preferences operations', () => {
  it('declares both operationIds exactly once', async () => {
    const text = await spec()
    for (const operationId of ['getUserPreferences', 'updateUserPreferences']) {
      const occurrences = text.split(`operationId: ${operationId}\n`).length - 1
      expect(occurrences, operationId).toBe(1)
    }
  })

  it('routes them at /v1/me/preferences and nowhere user-addressed', async () => {
    const text = await spec()
    expect(text).toContain('/v1/me/preferences:')
    // Self-only is structural. A path that takes a user id would make it a
    // comparison the handler has to remember to perform (ADR-0026 decision 5).
    expect(text).not.toContain('/v1/users/{user_id}')
  })

  it('carries GET and PATCH, and no other method', async () => {
    const text = await spec()
    // The next sibling is /v1/me/connected-apps since ADR-0048 CP4; slicing to
    // /v1/sites would swallow the neighbour's methods and responses.
    const block = pathItem(text, '/v1/me/preferences', '/v1/me/connected-apps')
    expect(block).toContain('    get:')
    expect(block).toContain('    patch:')
    expect(block).not.toContain('    put:')
    expect(block).not.toContain('    delete:')
    expect(block).not.toContain('    post:')
  })

  it('leaves both operations under the default session security', async () => {
    const text = await spec()
    // The next sibling is /v1/me/connected-apps since ADR-0048 CP4; slicing to
    // /v1/sites would swallow the neighbour's methods and responses.
    const block = pathItem(text, '/v1/me/preferences', '/v1/me/connected-apps')
    // `security: []` is how this document opts an operation out of the global
    // session requirement (health, the provider list, the public reads). This
    // one must not: it is the caller's own account.
    expect(block).not.toContain('security: []')
    expect(text).toContain('  - sessionCookie: []')
  })

  it('documents 401 on both and 400 on the write', async () => {
    const text = await spec()
    // The next sibling is /v1/me/connected-apps since ADR-0048 CP4; slicing to
    // /v1/sites would swallow the neighbour's methods and responses.
    const block = pathItem(text, '/v1/me/preferences', '/v1/me/connected-apps')
    expect(block.split("$ref: '#/components/responses/Unauthenticated'").length - 1).toBe(2)
    expect(block).toContain("$ref: '#/components/responses/ValidationFailed'")
  })

  it('requires timezone in the request body and allows an explicit null', async () => {
    const text = await spec()
    const start = text.indexOf('    UpdateUserPreferencesRequest:')
    expect(start).toBeGreaterThan(-1)
    const block = text.slice(start, text.indexOf('\n    AuthProvider:', start))
    expect(block).toContain('additionalProperties: false')
    // Required, so an empty patch is a contract violation and not a silent no-op;
    // nullable, so clearing the preference is expressible.
    expect(block).toContain('required: [timezone]')
    expect(block).toContain("type: 'null'")
    expect(block).toContain("$ref: '#/components/schemas/Timezone'")
  })

  it('states that null means "ask the browser", not UTC', async () => {
    const text = await spec()
    const start = text.indexOf('    UserPreferences:')
    const block = text.slice(start, text.indexOf('\n    UpdateUserPreferencesRequest:', start))
    expect(block).toContain('required: [timezone]')
    // The null semantics are the one thing a frontend can get backwards without
    // anything failing loudly, so they are stated on the field itself rather than
    // only in the ADR (ADR-0026 consequences).
    expect(block).toMatch(/never chosen/i)
    expect(block).toContain('Intl.DateTimeFormat')
  })

  it('reuses the shared Timezone schema rather than restating one', async () => {
    const text = await spec()
    expect(text.split('\n    Timezone:\n').length - 1).toBe(1)
    const start = text.indexOf('\n    Timezone:\n')
    const block = text.slice(start, text.indexOf('\n    DateRange:', start))
    // The bounds mirror `timezoneSchema`, which is the one validator every
    // surface that takes a zone runs.
    expect(block).toContain('minLength: 1')
    expect(block).toContain('maxLength: 64')
  })
})

describe('the fixture and the wire validator agree', () => {
  it('the fixture is a zone the server would accept', () => {
    expect(timezoneSchema.safeParse(userPreferencesFixture.timezone).success).toBe(true)
  })

  it('the validator refuses a well-formed but unknown identifier', () => {
    // The reason this endpoint validates at all: the string below is shaped
    // exactly like a real zone, and storing it would break every later chart.
    expect(isValidTimezone('Europe/Atlantis')).toBe(false)
    expect(timezoneSchema.safeParse('Europe/Atlantis').success).toBe(false)
    expect(isValidTimezone('Asia/Baku')).toBe(true)
    expect(isValidTimezone('UTC')).toBe(true)
  })

  it('bounds the wire value to the column the migration creates', () => {
    expect(timezoneSchema.safeParse('').success).toBe(false)
    expect(timezoneSchema.safeParse('A'.repeat(65)).success).toBe(false)
  })
})

describe('the value reaches the frontend on the session it already fetches', () => {
  it('declares timezone as a Better Auth user additional field', async () => {
    const options = buildAuthOptions({
      database: memoryAdapter({}),
      secret: 'x'.repeat(32),
      productName: 'Acme Metrics',
      trustedOrigins: ['https://app.test'],
      sendVerificationEmail: async () => {},
    })
    const field = options.user?.additionalFields?.['timezone']
    expect(field, 'the session response must carry the timezone').toBeDefined()
    expect(field?.type).toBe('string')
    // Nullable in the database, so never required on the model.
    expect(field?.required).toBe(false)
    // `returned` defaults to true — which is the entire point: the dashboard
    // learns the clock at the same moment it learns who is signed in, with no
    // extra round trip before the first chart (ADR-0026 decision 4).
    expect(field?.returned).not.toBe(false)
    // Read-only through the auth surface: sign-up and updateUser would both
    // accept an unvalidated string, and the only writer that checks the
    // identifier against the tz database is PATCH /v1/me/preferences.
    expect(field?.input).toBe(false)
  })

  it('mirrors the column on the Drizzle users table under the same name', async () => {
    // The adapter maps the model field to the column by name, so a rename on
    // either side would silently return undefined on every session.
    const users = schemaTableColumns().find((table) => table.name === 'users')
    expect(users?.columns).toContain('timezone')

    const sql = await readFile(MIGRATION_PATH, 'utf8')
    expect(sql).toContain('ADD COLUMN timezone text')
    expect(sql).toContain('users_timezone_format')
  })
})
