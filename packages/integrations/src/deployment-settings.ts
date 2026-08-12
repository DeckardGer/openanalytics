import type { CredentialVault } from './credential-vault.ts'
import type { EmailLogFn, SmtpEnvBlock } from './email.ts'
import { SMTP_DEFAULT_PORT, SMTP_IMPLICIT_TLS_PORT } from './email.ts'

/**
 * Deployment settings, between the database and the things they configure
 * (migration 0043).
 *
 * The api writes these rows and the worker reads them, so the shape has to be
 * agreed in one place: a mail transport typed into the dashboard is stored by
 * one service and used by another, and a field spelled differently on the two
 * sides is a relay that silently never authenticates. This module is that place.
 * It holds the AAD, the parse, and nothing else — no database, no HTTP.
 *
 * **Every failure here is a value, not a throw.** A stored row that cannot be
 * read is an operating condition (a keyring rotated without the old version, a
 * row written by a newer build), and the caller's answer is always the same:
 * fall back to the environment and say so in a log. A thrown error would take
 * the worker's email drain down with it.
 */

export type DeploymentSettingScopeName = 'email' | 'assistant'

/**
 * Binds a ciphertext to the row it belongs to. `scope` is the table's primary
 * key, so this is row identity exactly — a ciphertext moved between rows stops
 * decrypting rather than decrypting into the wrong setting.
 */
export function deploymentSettingAad(scope: DeploymentSettingScopeName): string {
  return `deployment_setting:${scope}`
}

/** The columns a reader needs, named structurally so this package does not
 * depend on `packages/postgres`. */
export interface StoredDeploymentSetting {
  readonly settings: Record<string, unknown>
  readonly encryptedSecret: string | null
  readonly keyVersion: string | null
  readonly secretLast4: string
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/**
 * The stored mail transport, without its password.
 *
 * A host is the one field with no defensible default, so a row without one is
 * not a transport — the same rule `selectEmailTransport` applies to the
 * environment, kept identical on purpose so "configured" means one thing.
 */
export function parseStoredEmailSettings(settings: Record<string, unknown>): SmtpEnvBlock | null {
  const host = asString(settings['host'])
  if (host === undefined) return null

  const rawPort = settings['port']
  const port =
    typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65_535
      ? rawPort
      : SMTP_DEFAULT_PORT
  const secure =
    typeof settings['secure'] === 'boolean' ? settings['secure'] : port === SMTP_IMPLICIT_TLS_PORT

  return {
    host,
    port,
    secure,
    ...(asString(settings['user']) === undefined ? {} : { user: asString(settings['user']) }),
    ...(asString(settings['from']) === undefined ? {} : { from: asString(settings['from']) }),
  }
}

export interface ResolveStoredSecretDeps {
  readonly row: StoredDeploymentSetting
  readonly scope: DeploymentSettingScopeName
  readonly vault: CredentialVault
  readonly log?: EmailLogFn
}

/**
 * The row's secret, or `undefined` with one log line saying why not.
 *
 * A row with no ciphertext is not a failure: an SMTP relay on the same host
 * frequently wants no credential at all, so "no secret" and "a secret that will
 * not decrypt" are answered the same way here and told apart by the log.
 */
export function resolveStoredSecret(deps: ResolveStoredSecretDeps): string | undefined {
  const stored = deps.row.encryptedSecret
  if (stored === null) return undefined

  const outcome = deps.vault.decrypt(stored, deploymentSettingAad(deps.scope))
  if (!outcome.ok) {
    deps.log?.('deployment_setting_secret_unreadable', {
      scope: deps.scope,
      reason: outcome.reason,
      keyVersion: deps.row.keyVersion,
    })
    return undefined
  }
  return outcome.plaintext
}

/**
 * The stored transport as `selectEmailTransport` wants it, password included.
 *
 * `null` when the row does not describe a transport. A row that names a host but
 * whose password will not decrypt still returns the block, without the
 * credential — nodemailer then offers no AUTH, the relay refuses, and the outbox
 * records `unauthorized`. That is a better failure than silently reverting to
 * the environment's relay, which would deliver the operator's mail through a
 * host they thought they had replaced.
 */
export function resolveStoredSmtpBlock(deps: ResolveStoredSecretDeps): SmtpEnvBlock | null {
  const block = parseStoredEmailSettings(deps.row.settings)
  if (block === null) return null
  const pass = resolveStoredSecret(deps)
  return { ...block, ...(pass === undefined ? {} : { pass }) }
}

export interface StoredAssistantProvider {
  readonly apiKey: string
  readonly model?: string
  readonly baseUrl?: string
}

/**
 * The stored model provider.
 *
 * `null` unless there is a usable key: a base URL and a model name configure
 * nothing on their own, and the assistant's whole availability question is
 * whether a key exists (`GET /v1/assistant/usage` reports `available`).
 */
export function resolveStoredAssistantProvider(
  deps: ResolveStoredSecretDeps,
): StoredAssistantProvider | null {
  const apiKey = resolveStoredSecret(deps)
  if (apiKey === undefined) return null
  const model = asString(deps.row.settings['model'])
  const baseUrl = asString(deps.row.settings['base_url'])
  return {
    apiKey,
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  }
}
