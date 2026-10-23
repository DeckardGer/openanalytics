// fork: list every import the backend services can reach that does not resolve.
//
//   node --experimental-import-meta-resolve scripts/fork-backend-check.mjs
//
// Run from `/repo` inside an image. Walks the import graph from each backend
// entry point through `node_modules`, and prints one line per specifier that
// fails to resolve, sorted, so two images can be compared with `diff`.
//
// It is run on upstream's own image and on the slim one, and only the
// difference counts. Upstream already has unresolvable specifiers (optional
// `require`s inside try/catch, platform-specific drivers), so an empty list is
// not the bar; "nothing the stock image resolves is missing here" is. Static
// and literal dynamic imports only: a computed `import(name)` is invisible to
// this, which is why the image is also booted against a real stack before
// it is trusted.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENTRY_POINTS = [
  'apps/api/dist/main.js',
  'apps/collector/dist/main.js',
  'apps/query-gateway/dist/main.js',
  'apps/realtime/dist/main.js',
  'apps/worker/dist/main.js',
  // migrate's entrypoint, in `docker-compose.coolify.yml`.
  'packages/postgres/dist/cli.js',
  'packages/clickhouse/dist/cli.js',
  'apps/worker/dist/revenue/seed-15m-reroll.js',
]

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\s]+)\1/g
const PARSEABLE = /\.(?:m|c)?js$/
// Lines that are only comment, mostly JSDoc examples: kysely documents
// `import snakeCase from 'lodash/snakeCase'` without depending on lodash.
const COMMENT_LINE = /^\s*(?:\*|\/\/)/

const root = process.cwd()
const queue = ENTRY_POINTS.map((p) => `${root}/${p}`)
const seen = new Set()
const unresolved = new Set()

function resolve(specifier, file) {
  try {
    return import.meta.resolve(specifier, pathToFileURL(file).href)
  } catch {
    // Not resolvable as ESM; a CommonJS file may still `require` it.
  }
  try {
    return pathToFileURL(createRequire(file).resolve(specifier)).href
  } catch {
    // Neither resolver finds it: reported by the caller.
  }
  return null
}

while (queue.length > 0) {
  const file = queue.pop()
  if (seen.has(file)) continue
  seen.add(file)
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    unresolved.add(`${file.replace(root, '.')} :: <unreadable>`)
    continue
  }
  const code = source
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n')
  for (const [, , specifier] of code.matchAll(SPECIFIER)) {
    const url = resolve(specifier, file)
    // Package directories differ only in the store hash, which is identical for
    // the same lockfile, so the path is a stable key across the two images.
    if (url === null) unresolved.add(`${file.replace(root, '.')} :: ${specifier}`)
    else if (url.startsWith('file:') && PARSEABLE.test(url)) queue.push(fileURLToPath(url))
  }
}

for (const line of [...unresolved].sort()) console.log(line)
console.error(`fork-backend-check: ${seen.size} files walked, ${unresolved.size} unresolved`)
