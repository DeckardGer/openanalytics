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
