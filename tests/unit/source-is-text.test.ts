import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every TypeScript source in this repository is a text file git can diff.
 *
 * This exists because one of them was not. A `0x00` written straight into a
 * string literal — `parts.join('<NUL>')` instead of `parts.join('\0')` — is
 * valid TypeScript, compiles to exactly the same program, and passes Prettier
 * and ESLint without a word. What it costs is everything downstream of git's
 * text/binary heuristic: `git diff` reports `Bin 4412 -> 8612 bytes` instead of
 * a patch, `git blame` has nothing to attribute, and a pull request shows the
 * file as changed and refuses to show how.
 *
 * That is not a style problem. The file it happened to was the largest
 * behavioural change in its batch, and it was the one file nobody could read.
 *
 * Writing this check found two more, both older than the change that prompted
 * it and both invisible for the same reason: a key separator in
 * `packages/domain/src/event-classification.ts`, and a fixture string in
 * `tests/unit/import-cutover.test.ts` that quite reasonably wanted a NUL in its
 * *value*. All three are now escapes, which produce the identical string and
 * leave the file diffable — which is the point: nobody needs a literal NUL in
 * source, and wanting the byte at runtime is not a reason to store it in the
 * file.
 *
 * The check is deliberately narrow. NUL is the byte git's heuristic keys on,
 * and the escape for it says the same thing without costing the diff.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ROOTS = ['apps', 'packages', 'scripts', 'tests']
const SKIP = new Set(['node_modules', 'dist', 'bundle', '.next', 'coverage', '.turbo'])
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js']

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) sourceFiles(full, found)
    } else if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

describe('source files stay diffable', () => {
  it('contains no NUL byte in any TypeScript or JavaScript source', () => {
    const files = ROOTS.flatMap((name) => sourceFiles(join(ROOT, name)))
    // A guard that silently scanned nothing would pass forever. The exact count
    // is not pinned — it changes with every file added — but zero is a bug in
    // this test rather than a clean repository.
    expect(files.length).toBeGreaterThan(200)

    const offenders = files
      .filter((file) => readFileSync(file).includes(0))
      .map((file) => file.slice(ROOT.length).replaceAll('\\', '/'))

    expect(offenders).toEqual([])
  })
})
