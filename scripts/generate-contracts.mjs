#!/usr/bin/env node
/**
 * Generates the TypeScript types the frontend client is built from.
 *
 * Docs snapshot 05, D-215: the generated client is produced from the OpenAPI
 * document in CI and published as a semver artifact. A hand-edited type file is
 * not a contract, so `--check` fails the build when the committed output has
 * drifted from the spec.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * One entry per OpenAPI document.
 */
const DOCUMENTS = [
  {
    spec: join(ROOT, 'packages', 'contracts', 'openapi', 'openapi.yaml'),
    out: join(ROOT, 'packages', 'contracts', 'src', 'generated', 'api.ts'),
    source: 'packages/contracts/openapi/openapi.yaml',
  },
]

const checkOnly = process.argv.includes('--check')

function generate(document) {
  const banner = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: ${document.source}
 * Regenerate with: pnpm run contracts:generate
 */

`
  // openapi-typescript writes to stdout when no --output is given.
  const stdout = execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'openapi-typescript', 'bin', 'cli.js'), document.spec],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return banner + stdout
}

let drifted = false

for (const document of DOCUMENTS) {
  const generated = generate(document)

  if (checkOnly) {
    let current
    try {
      current = readFileSync(document.out, 'utf8')
    } catch {
      console.error(`[contracts] ${document.out} is missing. Run: pnpm run contracts:generate`)
      drifted = true
      continue
    }
    // Normalize line endings so a Windows checkout does not report false drift.
    if (current.replace(/\r\n/g, '\n') !== generated.replace(/\r\n/g, '\n')) {
      console.error(
        `[contracts] generated client is out of date with ${document.source}.\n` +
          '            Run: pnpm run contracts:generate',
      )
      drifted = true
      continue
    }
    console.log(`[contracts] generated client is in sync with ${document.source}`)
  } else {
    mkdirSync(dirname(document.out), { recursive: true })
    writeFileSync(document.out, generated)
    console.log(`[contracts] wrote ${document.out}`)
  }
}

if (drifted) process.exit(1)
