import type { SafeStorage } from './storage.ts'

/**
 * ADR-0057 F6 — a site excludes its own browsers, without a console.
 *
 * Visiting any page of the site with `#oa-ignore` in the URL sets a
 * localStorage flag, and from then on the tracker in that browser installs
 * nothing and sends nothing; `#oa-unignore` clears the flag. Both directions
 * show a short on-screen confirmation, because a flag nobody can see is a flag
 * nobody trusts — the operator asking "did it take?" is the whole UX.
 *
 * The flag never reaches the server. There is no central list of excluded
 * devices, deliberately: exclusion is a property of the browser profile that
 * set it, exactly like the class-standard `plausible_ignore`. A browser whose
 * localStorage is unavailable (Safari private mode) cannot persist the flag
 * and keeps being counted — the honest failure for a mechanism whose whole
 * store is localStorage. A site in strict mode (`data-storage="none"`,
 * ADR-0064) has no exclusion flag at all for the same reason, and `browser.ts`
 * does not call this module there.
 */

export const IGNORE_KEY = 'oa_ignore'

export interface IgnoreDecision {
  /** True → the boot path must stop before installing anything. */
  readonly ignored: boolean
  /** Non-null when this page load changed the flag; drives the confirmation. */
  readonly changed: 'ignored' | 'unignored' | null
}

export function resolveIgnore(storage: SafeStorage, hash: string): IgnoreDecision {
  if (hash === '#oa-ignore') {
    storage.set(IGNORE_KEY, '1')
    return { ignored: true, changed: 'ignored' }
  }
  if (hash === '#oa-unignore') {
    storage.remove(IGNORE_KEY)
    return { ignored: false, changed: 'unignored' }
  }
  return { ignored: storage.get(IGNORE_KEY) === '1', changed: null }
}

/**
 * The on-screen confirmation. Inline styles and a max z-index because this
 * renders on an arbitrary customer page whose CSS is unknown; it removes
 * itself after four seconds and never captures a click.
 */
export function showIgnoreNotice(doc: Document, changed: 'ignored' | 'unignored'): void {
  const note = doc.createElement('div')
  note.textContent =
    changed === 'ignored'
      ? 'Open Analytics: this browser is now excluded from analytics'
      : 'Open Analytics: this browser is being counted again'
  note.setAttribute(
    'style',
    'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#111;color:#fff;' +
      'padding:10px 14px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;pointer-events:none',
  )
  const attach = (): void => {
    if (!doc.body) return
    doc.body.appendChild(note)
    doc.defaultView?.setTimeout(() => note.remove(), 4000)
  }
  if (doc.body) attach()
  else doc.addEventListener('DOMContentLoaded', attach, { once: true })
}
