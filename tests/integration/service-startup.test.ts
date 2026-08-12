import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { healthResponseSchema } from '@openanalytics/contracts'
import { describe, expect, it } from 'vitest'

/**
 * Integration skeleton.
 *
 * Docs snapshot 04, Milestone 0 acceptance: "each app starts with a minimal
 * health endpoint" and "an env error fails safely and clearly at startup". These
 * are verified by actually spawning the built entrypoint — an in-process test of
 * `createApp` would not catch a broken build output, a bad `exports` map or a
 * bootstrap that never binds a port.
 *
 * Requires `pnpm build` first; CI runs the build step before this project.
 */

const exec = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const SERVICES = ['api', 'collector', 'worker', 'query-gateway', 'realtime'] as const

/**
 * One port per service so the suite can run without internal collisions, on a
 * base randomized per run. The fixed 39101-39105 block collided intermittently
 * with something already listening on the CI runner (EADDRINUSE on a port this
 * suite had not bound yet), and a per-run offset makes that a lottery loss
 * instead of a standing appointment. The env schema requires a concrete port,
 * so an ephemeral `PORT=0` is not an option here.
 */
const PORT_BASE = 30_000 + Math.floor(Math.random() * 20_000)
const PORTS: Record<(typeof SERVICES)[number], number> = {
  api: PORT_BASE,
  collector: PORT_BASE + 1,
  worker: PORT_BASE + 2,
  'query-gateway': PORT_BASE + 3,
  realtime: PORT_BASE + 4,
}

async function waitForHealth(
  port: number,
  output: () => string,
  timeoutMs = 20_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/health`)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  // The child's own output, not just the connection refusal. A service that
  // died during startup has already said why, and discarding that turns a
  // one-line diagnosis into a re-run and a guess — which is exactly what the
  // first flake of this suite cost.
  throw new Error(
    `health endpoint on :${port} never became reachable: ${String(lastError)}
` +
      `--- child output ---
${output() || '(no output)'}`,
  )
}

describe.each(SERVICES)('%s service', (service) => {
  it('starts and serves a contract-shaped health response', async () => {
    const port = PORTS[service]
    const child = (await import('node:child_process')).spawn(
      process.execPath,
      [`apps/${service}/dist/main.js`],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PORT: String(port),
          ENVIRONMENT: 'test',
          SERVICE_VERSION: '9.9.9',
          GIT_COMMIT: 'integration',
          LOG_LEVEL: 'warn',
        },
        // Captured rather than discarded, so a startup failure explains itself.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })

    let exited: { code: number | null; signal: string | null } | null = null
    child.on('exit', (code, signal) => {
      exited = { code, signal }
    })

    try {
      const response = await waitForHealth(port, () =>
        exited === null
          ? output
          : `${output}
(process exited: ${JSON.stringify(exited)})`,
      )
      expect(response.status).toBe(200)

      const body = healthResponseSchema.parse(await response.json())
      expect(body.service).toBe(service)
      expect(body.version).toBe('9.9.9')
      expect(response.headers.get('x-request-id')).toMatch(/^req_/)
    } finally {
      child.kill('SIGTERM')
    }
  })

  it('exits with a configuration error rather than starting misconfigured', async () => {
    // A service handed a secret it must never hold is a deployment mistake.
    // Starting anyway would hide it until something used the value.
    const forbidden: Record<string, Record<string, string>> = {
      api: { CLICKHOUSE_URL: 'https://clickhouse.internal:8443' },
      collector: { CLICKHOUSE_URL: 'https://clickhouse.internal:8443' },
      worker: { AUTH_SECRET: 'x'.repeat(32) },
      'query-gateway': { QUERY_SIGNING_PRIVATE_KEY: 'x'.repeat(32) },
      realtime: { DATABASE_URL: 'postgres://user:pw@localhost:5432/db' },
    }

    await expect(
      exec(process.execPath, [`apps/${service}/dist/main.js`], {
        cwd: repoRoot,
        env: { ...process.env, PORT: '0', ...forbidden[service] },
      }),
    ).rejects.toMatchObject({ code: 78 }) // EX_CONFIG
  })
})
