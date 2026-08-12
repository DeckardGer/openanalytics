import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

/**
 * Test projects are separated by what they need to run, not by subject matter
 * (docs snapshot 04, Milestone 0 item 9):
 *
 * - `unit`      — pure logic. No network, no containers. Runs on every commit.
 * - `contract`  — OpenAPI/schema agreement and HTTP envelope shape. No infra.
 * - `tracker`   — the browser tracker, in a DOM environment. Separate from
 *                 `unit` only because it needs `happy-dom`; it needs no network
 *                 and runs on every commit too.
 * - `integration` — needs real dependencies (Redis, ClickHouse, Postgres).
 * - `migration` — needs empty Postgres/ClickHouse instances to prove a database
 *                 can be built from the repository and that drift is detected.
 *
 * Keeping them apart means a contributor without Docker can still run the checks
 * that gate most changes, while CI runs all four.
 */

const alias = {
  '@openanalytics/contracts': resolvePath('./packages/contracts/src/index.ts'),
  '@openanalytics/domain': resolvePath('./packages/domain/src/index.ts'),
  '@openanalytics/observability/hono': resolvePath('./packages/observability/src/hono/index.ts'),
  '@openanalytics/observability': resolvePath('./packages/observability/src/index.ts'),
  '@openanalytics/migrations': resolvePath('./packages/migrations/src/index.ts'),
  '@openanalytics/postgres': resolvePath('./packages/postgres/src/index.ts'),
  '@openanalytics/clickhouse': resolvePath('./packages/clickhouse/src/index.ts'),
  '@openanalytics/redis': resolvePath('./packages/redis/src/index.ts'),
  '@openanalytics/auth': resolvePath('./packages/auth/src/index.ts'),
  '@openanalytics/integrations': resolvePath('./packages/integrations/src/index.ts'),
  '@openanalytics/testkit': resolvePath('./packages/testkit/src/index.ts'),
  // The CLI is an app, and its `exports` point at `dist`. Nothing builds it
  // before the unit project runs, so without this alias the suite resolves
  // against whatever a previous manual build happened to leave behind.
  '@openanalytics/cli': resolvePath('./apps/cli/src/index.ts'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'tracker',
          include: ['tests/tracker/**/*.test.ts'],
          environment: 'happy-dom',
          // A real customer origin, so URL sanitization and the same-origin
          // rules of `history.pushState` behave as they do on a live site.
          environmentOptions: { happyDOM: { url: 'https://shop.example.com/' } },
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          // One file at a time, for the same reason the migration project runs
          // serially. These suites share real infrastructure and, in the
          // startup suite's case, spawn real service processes on fixed ports.
          // Running the M6 crash matrix — which saturates three stores for
          // minutes — beside a suite that waits for a freshly spawned process
          // to bind a port is how a green suite becomes an occasionally red one.
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'migration',
          include: ['tests/migration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          // Migration tests share one database; running files in parallel would
          // make them race on the same ledger.
          fileParallelism: false,
        },
      },
    ],
  },
})
