#!/usr/bin/env node
/**
 * Architectural boundary check.
 *
 * Docs snapshot 04, Milestone 0 item 12 and its acceptance criterion: the
 * repository must contain no runtime import of the legacy `sl` tree. This runs
 * in CI so the rule survives contributor turnover, not just review attention.
 *
 * Three rules are enforced:
 *
 * 1. No import may reach outside this repository. The legacy system is a
 *    reference for auditing, never a runtime dependency (docs snapshot 05,
 *    D-002). A relative path that climbs past the repo root is the concrete way
 *    that would happen.
 *
 * 2. Domain and datastore packages may not import Hono. Docs snapshot 02 §4:
 *    the framework choice is settled, and the package split exists so business
 *    rules stay testable without an HTTP layer — not so Hono can be swapped out
 *    quietly.
 *
 * 3. Apps may not import each other. They deploy separately; shared code belongs
 *    in a package. An app-to-app import would couple two deploy units through a
 *    path that no package boundary reviews.
 *
 * 4. The web app may only import the contract package. Docs snapshot 05, D-218:
 *    the monorepo merge keeps frontend/backend separation as a boundary rule,
 *    not a physical repo split — `apps/web` consumes `packages/contracts`
 *    (OpenAPI types/generated client) and nothing else from the workspace.
 *
 * 5. The tracker imports nothing at all. Docs snapshot 02 §11: it is
 *    dependency-free because it executes on customers' sites, where every
 *    kilobyte and every transitive package is theirs to pay for and trust. A
 *    workspace import would drag a schema validator into every visitor's
 *    browser, so the rule is enforced here rather than left to review.
 *
 * 6. Nothing outside a `cloud/` directory may import one. This is the open-core
 *    boundary, and it is a build failure rather than a convention because it is
 *    the one rule whose violation is invisible in review: a product module that
 *    imports a hosted one still compiles, still passes its tests, and only fails
 *    on a self-hosted install — at runtime, as a query against a table the
 *    product migration stream never created. The dependency runs one way. A
 *    `cloud/` file may import the product freely.
 *
 *    Both forms are checked, because there are two ways to name one of these
 *    modules: a relative or aliased path with a `cloud/` segment
 *    (`./cloud/index.ts`, `../../cloud/errors.ts`) and a package subpath
 *    (`@openanalytics/domain/cloud`). Neither is allowed from outside.
 *
 *    `apps/web` draws the same line with two more directory names, because
 *    Next.js decides routes by path: `app/(cloud)/` holds the hosted routes
 *    and `app/(marketing)/` the marketing site. The three trees are cut from
 *    the public export together and may import each other freely; product code
 *    may import none of them, and reaches what it needs through the `@slots`
 *    seam (`apps/web/lib/slots.tsx`) instead.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'generated', '.next'])
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']

/** Packages that must stay free of the HTTP framework. */
const HONO_FREE_PACKAGES = [
  'packages/domain',
  'packages/contracts',
  'packages/postgres',
  'packages/clickhouse',
  'packages/redis',
  'packages/auth',
  'packages/integrations',
  'packages/migrations',
]

const IMPORT_PATTERN =
  /(?:^|[\s;{(])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;{(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, files)
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      files.push(full)
    }
  }
  return files
}

function importsOf(source) {
  const specifiers = []
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2]
    if (specifier) specifiers.push(specifier)
  }
  return specifiers
}

function inPackage(relPath, pkg) {
  return relPath === pkg || relPath.startsWith(`${pkg}/`)
}

/** The directory names the public export cuts. A file merely *named* `cloud.ts`
 * is not one of them and is held to the rule like any other product module. */
const EXCLUDED_DIRS = new Set(['cloud', '(cloud)', '(marketing)'])

/** True for a file inside one of those directories at any depth — the only
 * files allowed to import another. */
function inCloudTree(relPath) {
  const segments = relPath.split('/')
  return segments.slice(0, -1).some((segment) => EXCLUDED_DIRS.has(segment))
}

const violations = []

for (const file of walk(ROOT)) {
  const relPath = relative(ROOT, file).split(sep).join('/')
  const source = readFileSync(file, 'utf8')

  for (const specifier of importsOf(source)) {
    // Rule 1: nothing may resolve outside the repository.
    if (specifier.startsWith('.')) {
      const resolved = resolve(dirname(file), specifier)
      if (!resolved.startsWith(ROOT + sep) && resolved !== ROOT) {
        violations.push(
          `${relPath}: imports "${specifier}", which resolves outside this repository. ` +
            `Legacy code is a reference, never a runtime dependency.`,
        )
      }
    }

    // Rule 2: keep the HTTP framework out of domain and datastore packages.
    if (specifier === 'hono' || specifier.startsWith('hono/')) {
      const offending = HONO_FREE_PACKAGES.find((pkg) => inPackage(relPath, pkg))
      if (offending) {
        violations.push(
          `${relPath}: imports "${specifier}". ${offending} must stay framework-free ` +
            `so its rules are testable without an HTTP layer.`,
        )
      }
    }

    // Rule 3: apps deploy separately and must not depend on each other.
    if (relPath.startsWith('apps/') && specifier.startsWith('@openanalytics/')) {
      const target = specifier.slice('@openanalytics/'.length).split('/')[0]
      const currentApp = relPath.split('/')[1]
      const isApp = ['api', 'collector', 'worker', 'query-gateway', 'realtime', 'tracker'].includes(
        target,
      )
      if (isApp && target !== currentApp) {
        violations.push(
          `${relPath}: imports app "@openanalytics/${target}". ` +
            `Apps deploy separately; shared code belongs in packages/.`,
        )
      }
    }

    // Rule 5: the tracker bundle carries no dependency, not even a workspace
    // one. Relative imports inside its own source are the only form allowed.
    if (inPackage(relPath, 'apps/tracker/src') && !specifier.startsWith('.')) {
      violations.push(
        `${relPath}: imports "${specifier}". apps/tracker ships to third-party sites and ` +
          `must stay dependency-free; copy the constant and pin it with a test instead.`,
      )
    }

    // Rule 6: the open-core boundary. `inCloudTree` is true for a file *inside*
    // a `cloud/` directory anywhere in the repo, which is what makes the rule
    // one-directional: those files may import each other and the product, and
    // nothing else may import them.
    if (!inCloudTree(relPath)) {
      const segmented = specifier.split('/').some((segment) => EXCLUDED_DIRS.has(segment))
      const packageSubpath = /^@openanalytics\/[^/]+\/cloud(?:\/|$)/u.test(specifier)
      // `@/cloud/...`-style aliases and any other bare prefix, checked raw so a
      // future alias cannot open a door the two tests above close.
      const aliasPrefix = /^[^.@\w]*[@~]?\/?cloud\//u.test(specifier)
      if (segmented || packageSubpath || aliasPrefix) {
        violations.push(
          `${relPath}: imports "${specifier}", which the public export cuts. ` +
            `Only code inside a cloud/, app/(cloud)/ or app/(marketing)/ directory ` +
            `may do that: a self-hosted build has no such tables, credentials, routes ` +
            `or pages, and the dependency runs one way. In apps/web, reach it through ` +
            `the "@slots" seam instead.`,
        )
      }
    }

    // Rule 4: apps/web may only import packages/contracts (D-218). Both the
    // workspace-package form and a relative path that climbs out of apps/web
    // are violations; the contract is the only join point.
    if (inPackage(relPath, 'apps/web')) {
      if (specifier.startsWith('@openanalytics/')) {
        const target = specifier.slice('@openanalytics/'.length).split('/')[0]
        if (target !== 'contracts') {
          violations.push(
            `${relPath}: imports "@openanalytics/${target}". apps/web may only import ` +
              `@openanalytics/contracts; frontend/backend separation is a boundary rule (D-218).`,
          )
        }
      }
      if (specifier.startsWith('.')) {
        const resolved = resolve(dirname(file), specifier)
        const webRoot = join(ROOT, 'apps', 'web')
        if (resolved.startsWith(ROOT + sep) && !resolved.startsWith(webRoot + sep)) {
          violations.push(
            `${relPath}: imports "${specifier}", which reaches outside apps/web. ` +
              `The only backend surface apps/web may consume is @openanalytics/contracts (D-218).`,
          )
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Boundary violations:\n')
  for (const violation of violations) console.error(`  - ${violation}`)
  console.error(`\n${violations.length} violation(s).`)
  process.exit(1)
}

console.log(
  '[boundaries] ok — no legacy imports, no framework leakage, no app-to-app coupling, ' +
    'no product import of a cloud/ module',
)
