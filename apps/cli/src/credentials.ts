import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where the CLI keeps its token, and how honestly it says so (ADR-0043 D10).
 *
 * D10 left the keychain question to be **measured at CP-cli**, and it was, on
 * 2026-08-06. Three measurements, one of them decisive:
 *
 * 1. **Windows' credential store cannot give a secret back.** `cmdkey /generic:`
 *    writes a credential and `cmdkey /list:` shows its target and user — and
 *    never its password. There is no command-line read. A CLI that stored its
 *    token there could write it once and never use it again.
 * 2. **`fs.chmod(0o600)` is a no-op on Windows.** The mode reads back as `666`
 *    and the real ACL grants Modify to several principals including a group. A
 *    CLI that wrote a "0600 file" there and said "readable only by you" would be
 *    saying something false.
 * 3. **`icacls /inheritance:r /grant:r <user>:(F)` does work.** It reduces the
 *    ACL to exactly one principal, the owner, and the file stays readable by
 *    them.
 *
 * macOS's `security` and Linux's `secret-tool` were **not** measured — this
 * machine is Windows and there was no VM to run them on. That is stated rather
 * than papered over, and it does not change the answer, because measurement 1
 * already rules the keychain out on the platform where the CLI is developed:
 * shelling out cannot be the strategy if it fails outright on one of three, and
 * the alternative — a native module (`keytar`, `@napi-rs/keyring`) — puts a
 * platform binary in the install path of every CI run and every contributor for a
 * convenience used by one app.
 *
 * **So: a restricted file, on every platform, and the CLI says which protection
 * it got.** POSIX gets `chmod 0600`; Windows gets `icacls`; and if either fails,
 * `describeProtection` says the file is *not* restricted rather than implying it
 * is. D10's own words: "a token in a plain file is acceptable only if the CLI
 * says so out loud."
 */

export interface StoredCredential {
  readonly accessToken: string
  readonly refreshToken: string
  /** ISO-8601. The CLI refreshes rather than failing when this has passed. */
  readonly expiresAt: string
  readonly apiBaseUrl: string
  readonly scope: string
}

/** How the file ended up protected — reported, never assumed. */
export type Protection =
  | { readonly kind: 'posix-0600' }
  | { readonly kind: 'windows-acl' }
  | { readonly kind: 'unrestricted'; readonly reason: string }

export interface CredentialStore {
  readonly path: string
  read(): StoredCredential | null
  write(credential: StoredCredential): Protection
  clear(): boolean
}

/**
 * `~/.config/oa/credentials.json`, or `$OA_CONFIG_HOME` when set.
 *
 * Not `$XDG_CONFIG_HOME` alone: it is unset on Windows and on plenty of macOS
 * setups, and a path that silently moves between machines is a token somebody
 * loses. One variable, one default.
 */
export function credentialPath(env: Record<string, string | undefined> = process.env): string {
  const configured = env['OA_CONFIG_HOME']
  if (configured && configured.length > 0) return join(configured, 'credentials.json')
  return join(homedir(), '.config', 'oa', 'credentials.json')
}

/** Restrict a file to its owner, and say what actually happened. */
function protect(path: string): Protection {
  if (process.platform === 'win32') {
    // `chmod` is a no-op here (measured), so the ACL is the only real control.
    try {
      const user = userInfo().username
      execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:(F)`], {
        stdio: 'ignore',
      })
      return { kind: 'windows-acl' }
    } catch (error) {
      return {
        kind: 'unrestricted',
        reason: `icacls failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  try {
    chmodSync(path, 0o600)
    // Verified, not assumed: `chmod` returns void on a filesystem that silently
    // ignores it, and this is the CLI's only claim about the file's safety.
    const mode = statSync(path).mode & 0o777
    if (mode !== 0o600) {
      return { kind: 'unrestricted', reason: `filesystem kept mode ${mode.toString(8)}` }
    }
    return { kind: 'posix-0600' }
  } catch (error) {
    return {
      kind: 'unrestricted',
      reason: `chmod failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function describeProtection(protection: Protection): string {
  switch (protection.kind) {
    case 'posix-0600':
      return 'readable only by you (mode 0600)'
    case 'windows-acl':
      return 'readable only by you (ACL restricted to your account)'
    case 'unrestricted':
      return `NOT restricted — ${protection.reason}`
  }
}

export function createCredentialStore(path: string = credentialPath()): CredentialStore {
  return {
    path,

    read(): StoredCredential | null {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        // Absent is the ordinary state before `oa login`, not an error.
        return null
      }
      try {
        const parsed = JSON.parse(raw) as Partial<StoredCredential>
        if (
          typeof parsed.accessToken !== 'string' ||
          typeof parsed.refreshToken !== 'string' ||
          typeof parsed.apiBaseUrl !== 'string'
        ) {
          return null
        }
        return {
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken,
          expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : '',
          apiBaseUrl: parsed.apiBaseUrl,
          scope: typeof parsed.scope === 'string' ? parsed.scope : '',
        }
      } catch {
        // A corrupt file reads as "not logged in" rather than crashing. The
        // recovery is `oa login`, which overwrites it, and that is what a person
        // would do anyway.
        return null
      }
    },

    write(credential: StoredCredential): Protection {
      mkdirSync(dirname(path), { recursive: true })
      // Restrict *before* the secret lands: creating the file empty, locking it
      // down and only then writing the token closes the window in which a
      // world-readable file holds a live credential.
      writeFileSync(path, '', { mode: 0o600 })
      const protection = protect(path)
      writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 })
      return protection
    },

    clear(): boolean {
      try {
        rmSync(path)
        return true
      } catch {
        return false
      }
    },
  }
}
