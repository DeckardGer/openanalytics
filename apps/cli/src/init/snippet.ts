import fs from 'node:fs'
import path from 'node:path'

/**
 * The snippet `oa init` writes, and the file helpers every injector shares.
 *
 * The tag is docs/frontend/tracker_snippet.md verbatim — same attributes, same
 * host — because the whole promise of `init` is that it types exactly what the
 * dashboard's install screen would have shown. The key it embeds is the site's
 * `tracking_write` public token (`oa_pk_…`), which is public by design:
 * write-only, an ingest identifier, never read authorization. Writing it into
 * a customer's HTML is the intended use, not a leak.
 */

/**
 * Which collector the snippet points at (ADR-0020: the bundle is served from the
 * collector host).
 *
 * `undefined` when `OA_COLLECTOR_URL` is unset, and `init` refuses rather than
 * guessing. It defaulted to our own hosted collector until the open-core split,
 * which meant `oa init` in a self-hosted project wrote a snippet that shipped a
 * customer's traffic to us — silently, and into a deployment where their site key
 * does not exist. There is no honest default here: the collector's address is a
 * fact about a deployment, and only the person running it knows it.
 */
export function collectorUrl(env: Record<string, string | undefined>): string | undefined {
  const configured = env['OA_COLLECTOR_URL']?.trim()
  return configured === undefined || configured === '' ? undefined : configured.replace(/\/$/, '')
}

/** What `init` says when it has no collector to write. Shared by both faces so
 * the interactive spinner and the non-interactive stderr agree word for word. */
export const NO_COLLECTOR_MESSAGE =
  'Set OA_COLLECTOR_URL to your collector’s address (for example https://c.example.com) — ' +
  'the snippet needs it to know where to send events.'

/** The plain HTML form, for anything that has a `<head>` to put it in. */
export function scriptTag(key: string, collector: string): string {
  return `<script async src="${collector}/oa.js" data-key="${key}" data-collector="${collector}"></script>`
}

/**
 * Whether the tracker is already on the page.
 *
 * The marker is the bundle path rather than the collector host, so a snippet
 * pointed at a staging collector still counts as installed and `init` never
 * doubles a tag it merely does not recognise.
 */
export function isAlreadyInstalled(content: string): boolean {
  return content.includes('/oa.js')
}

export interface FoundFile {
  readonly rel: string
  readonly abs: string
}

export function findFile(cwd: string, candidates: readonly string[]): FoundFile | null {
  for (const candidate of candidates) {
    const abs = path.join(cwd, candidate)
    if (fs.existsSync(abs)) return { rel: candidate, abs }
  }
  return null
}

export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}
