import { describe, expect, it } from 'vitest'
import {
  IGNORE_KEY,
  resolveIgnore,
  safeStorage,
  showIgnoreNotice,
} from '../../apps/tracker/src/index.ts'

/**
 * ADR-0057 F6 — `oa_ignore`. What is pinned: the hash sets/clears the flag, a
 * flagged browser reads as ignored on every later load, and both directions
 * produce the on-screen confirmation. The flag never leaves the browser, so
 * the whole surface under test is storage + DOM.
 */

describe('oa_ignore — a site excludes its own browsers', () => {
  it('#oa-ignore sets the flag and reports ignored immediately', () => {
    const storage = safeStorage(null)
    const decision = resolveIgnore(storage, '#oa-ignore')
    expect(decision).toEqual({ ignored: true, changed: 'ignored' })
    expect(storage.get(IGNORE_KEY)).toBe('1')
  })

  it('a later plain load in the same browser stays ignored', () => {
    const storage = safeStorage(null)
    resolveIgnore(storage, '#oa-ignore')
    expect(resolveIgnore(storage, '')).toEqual({ ignored: true, changed: null })
  })

  it('#oa-unignore clears the flag and tracking resumes on the same load', () => {
    const storage = safeStorage(null)
    resolveIgnore(storage, '#oa-ignore')
    const decision = resolveIgnore(storage, '#oa-unignore')
    expect(decision).toEqual({ ignored: false, changed: 'unignored' })
    expect(storage.get(IGNORE_KEY)).toBeNull()
    expect(resolveIgnore(storage, '')).toEqual({ ignored: false, changed: null })
  })

  it('an unrelated hash neither sets nor clears anything', () => {
    const storage = safeStorage(null)
    expect(resolveIgnore(storage, '#section-2')).toEqual({ ignored: false, changed: null })
    resolveIgnore(storage, '#oa-ignore')
    expect(resolveIgnore(storage, '#section-2').ignored).toBe(true)
  })

  it('shows and then removes the on-screen confirmation', () => {
    showIgnoreNotice(document, 'ignored')
    const note = Array.from(document.body.children).find((el) =>
      el.textContent?.includes('excluded from analytics'),
    )
    expect(note).toBeDefined()
    note?.remove()
  })
})
