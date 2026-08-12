import type { ServiceEnv } from '@openanalytics/domain'
import type { Database } from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'

import { startEmailDrain } from '../../apps/worker/src/email-drain.ts'

/**
 * What the worker says at boot about mail, and why the level is the assertion.
 *
 * A self-hosted install with no transport configured looks identical to one
 * whose mail simply has not been used yet: the magic link is enqueued, claimed
 * and "delivered" to the log transport, which records a subject and a recipient
 * domain and deliberately no link. The dry-run install traced exactly that path
 * and found nothing, because there is nothing to find.
 *
 * So the one line that can explain it is this one, and `info` is where it was
 * hiding. These tests pin the level and the named variables together — a `warn`
 * that does not say which variables are missing is a bell with no address on it,
 * and naming them at `info` puts the address somewhere nobody is looking.
 */

const db = {} as Database

function workerEnv(overrides: Record<string, unknown>): ServiceEnv<'worker'> {
  return overrides as unknown as ServiceEnv<'worker'>
}

/** Starts the drain, captures the boot line, and stops it again. */
async function boot(env: ServiceEnv<'worker'>) {
  const captured = createCapturedLogger()
  const drain = startEmailDrain({ db, env, logger: captured.logger })
  await drain.stop()
  const lines = captured.find('email_transport_selected')
  expect(lines).toHaveLength(1)
  return lines[0] as Record<string, unknown>
}

describe('worker mail transport boot line', () => {
  it('warns and names both variables when nothing is configured', async () => {
    const line = await boot(workerEnv({}))

    expect(line['level']).toBe('warn')
    expect(line['transport']).toBe('log')
    expect(line['missing']).toEqual(['RESEND_API_KEY', 'SMTP_HOST'])
    // The operator's next action has to be in the line, not inferred from it.
    expect(line['detail']).toContain('RESEND_API_KEY or SMTP_HOST')
    // And the thing the dry run went looking for: the link is not in the log.
    expect(line['detail']).toContain('written nowhere')
  })

  it('drops back to info once SMTP is configured', async () => {
    const line = await boot(workerEnv({ SMTP_HOST: 'smtp.example.com' }))

    expect(line['level']).toBe('info')
    expect(line['transport']).toBe('smtp')
    expect(line['missing']).toBeUndefined()
  })

  it('drops back to info once Resend is configured', async () => {
    // The control for the test above: two different configured transports, so
    // the level is following the transport rather than one variable's presence.
    const line = await boot(workerEnv({ RESEND_API_KEY: 're-not-a-real-key' }))

    expect(line['level']).toBe('info')
    expect(line['transport']).toBe('resend')
  })
})

/**
 * Where the transport comes from, once one can be stored (migration 0043).
 *
 * The rule is one sentence — **a stored transport wins over the environment** —
 * and it is worth pinning from both directions, because each failure is silent.
 * A stored relay that lost to `RESEND_API_KEY` would send the operator's mail
 * through a host they thought they had replaced; an environment relay that lost
 * to an empty table would stop a working deployment's mail the day it upgraded.
 */

/** A 32-byte key, base64, so `createCredentialVault` accepts the ring. */
const KEYRING = JSON.stringify({
  active: 'k1',
  keys: { k1: Buffer.alloc(32, 7).toString('base64') },
})

/** `readDeploymentSetting`'s chain, and nothing else: a drain that grew a
 * second query against this stub would fail here rather than pass by accident. */
const dbWithSetting = (settings: Record<string, unknown> | null) =>
  ({
    select: () => ({
      from: () => ({
        where: async () =>
          settings === null
            ? []
            : [
                {
                  scope: 'email',
                  settings,
                  encryptedSecret: null,
                  keyVersion: null,
                  secretLast4: '',
                  updatedByUserId: null,
                  updatedAt: new Date('2026-08-12T00:00:00.000Z'),
                },
              ],
      }),
    }),
  }) as unknown as Database

async function bootWith(env: ServiceEnv<'worker'>, database: Database) {
  const captured = createCapturedLogger()
  const drain = startEmailDrain({ db: database, env, logger: captured.logger })
  await drain.stop()
  const lines = captured.find('email_transport_selected')
  expect(lines).toHaveLength(1)
  return lines[0] as Record<string, unknown>
}

describe('stored mail settings', () => {
  it('prefers a stored relay over the environment, including over Resend', async () => {
    const line = await bootWith(
      workerEnv({
        DEPLOYMENT_SETTINGS: 'enabled',
        OA_CREDENTIAL_KEYRING: KEYRING,
        RESEND_API_KEY: 're-not-a-real-key',
        SMTP_HOST: 'env-relay.example',
      }),
      dbWithSetting({ host: 'stored-relay.example', port: 587, secure: false }),
    )

    expect(line['transport']).toBe('smtp')
    expect(line['source']).toBe('database')
  })

  it('falls back to the environment when the table holds nothing', async () => {
    const line = await bootWith(
      workerEnv({
        DEPLOYMENT_SETTINGS: 'enabled',
        OA_CREDENTIAL_KEYRING: KEYRING,
        RESEND_API_KEY: 're-not-a-real-key',
      }),
      dbWithSetting(null),
    )

    expect(line['transport']).toBe('resend')
    expect(line['source']).toBe('environment')
  })

  it('never reads the table when the deployment is configured from its environment', async () => {
    // `disabled` is what a multi-tenant deployment sets, and there the table
    // must not be consulted at all — a stub that throws on any query is the
    // only way to assert "did not read" rather than "read and ignored".
    const forbidden = {
      select: () => {
        throw new Error('the table must not be read when DEPLOYMENT_SETTINGS is disabled')
      },
    } as unknown as Database

    const line = await bootWith(
      workerEnv({
        DEPLOYMENT_SETTINGS: 'disabled',
        OA_CREDENTIAL_KEYRING: KEYRING,
        SMTP_HOST: 'env-relay.example',
      }),
      forbidden,
    )

    expect(line['transport']).toBe('smtp')
    expect(line['source']).toBe('environment')
  })

  it('says so and keeps delivering when the keyring is unusable', async () => {
    const captured = createCapturedLogger()
    const drain = startEmailDrain({
      db: dbWithSetting({ host: 'stored-relay.example' }),
      env: workerEnv({
        DEPLOYMENT_SETTINGS: 'enabled',
        OA_CREDENTIAL_KEYRING: '{not json',
        SMTP_HOST: 'env-relay.example',
      }),
      logger: captured.logger,
    })
    await drain.stop()

    // The ring is what reads the stored row, so a broken one costs the stored
    // transport and nothing else: mail the environment can still deliver has
    // nothing to do with it.
    expect(captured.find('deployment_settings_not_readable')).toHaveLength(1)
    const line = captured.find('email_transport_selected')[0] as Record<string, unknown>
    expect(line['source']).toBe('environment')
  })
})
