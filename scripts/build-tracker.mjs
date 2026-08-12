#!/usr/bin/env node
/**
 * Builds the browser tracker bundle and enforces its size budget.
 *
 * Docs snapshot 04, Milestone 4 item 10. The tracker executes on customers'
 * sites, so its size is not our cost — it is theirs, paid on every page load by
 * every visitor. A budget that is only measured in review is not a budget, so it
 * is measured here and enforced in CI.
 *
 * The number and its justification are in
 * `docs/adr/0008-milestone-4-tracker-and-event-contract.md`. It is an
 * engineering budget, not a `GATE` value: raising it is an ADR edit with a
 * measurement, not a product decision.
 *
 * esbuild is a dev dependency. The bundle itself stays dependency-free — that is
 * enforced separately by `pnpm run boundaries`.
 */
import { gzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'apps', 'tracker', 'src', 'browser.ts')
const OUT_DIR = join(ROOT, 'apps', 'tracker', 'bundle')
const OUT_FILE = join(OUT_DIR, 'oa.js')

/** Gzipped bytes. The number a visitor's connection actually transfers. */
export const GZIP_BUDGET_BYTES = 9_216

/** Uncompressed bytes. Bounds parse and compile cost, which gzip hides. */
export const RAW_BUDGET_BYTES = 24_576

const result = await build({
  entryPoints: [ENTRY],
  outfile: OUT_FILE,
  bundle: true,
  minify: true,
  format: 'iife',
  // Wide enough for the browsers a customer's visitors actually use, without
  // dragging in transpiler helpers for syntax we do not write.
  target: ['es2020', 'chrome80', 'firefox78', 'safari14', 'edge88'],
  legalComments: 'none',
  write: false,
})

const output = result.outputFiles[0]
if (!output) {
  console.error('[tracker] esbuild produced no output')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT_FILE, output.contents)

const raw = output.contents.byteLength
const gzip = gzipSync(output.contents, { level: 9 }).byteLength

const format = (bytes) => `${(bytes / 1024).toFixed(2)} KiB (${bytes} B)`
const percent = (used, budget) => `${((used / budget) * 100).toFixed(0)}%`

console.log(
  `[tracker] bundle   ${format(raw)}  of ${format(RAW_BUDGET_BYTES)}  ${percent(raw, RAW_BUDGET_BYTES)}`,
)
console.log(
  `[tracker] gzipped  ${format(gzip)}  of ${format(GZIP_BUDGET_BYTES)}  ${percent(gzip, GZIP_BUDGET_BYTES)}`,
)

const failures = []
if (gzip > GZIP_BUDGET_BYTES) {
  failures.push(`gzipped bundle is ${format(gzip)}, over the ${format(GZIP_BUDGET_BYTES)} budget`)
}
if (raw > RAW_BUDGET_BYTES) {
  failures.push(`raw bundle is ${format(raw)}, over the ${format(RAW_BUDGET_BYTES)} budget`)
}

if (failures.length > 0) {
  console.error('\n[tracker] size budget exceeded:')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(
    '\nEither make it smaller or raise the budget in scripts/build-tracker.mjs and\n' +
      'justify the new number in docs/adr/0008-milestone-4-tracker-and-event-contract.md.',
  )
  process.exit(1)
}

console.log('[tracker] within budget')
