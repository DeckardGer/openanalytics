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
 * `null` — meaning "fall back to the environment" — in two cases, and the second
 * one is the subtle half:
 *
 * - the row does not describe a transport at all (no host);
 * - **the row stores a credential this build cannot read.** An unreadable
 *   ciphertext is not a transport minus a password, it is a transport we do not
 *   have, so the caller is told there is nothing here rather than being handed a
 *   block that cannot authenticate.
 *
 * A row that stores *no* ciphertext still returns its block: an SMTP relay on
 * the same host frequently wants no credential at all, and that is a complete
 * configuration rather than a broken one.
 *
 * The second case used to return the block without the credential, on the
 * argument that reverting to the environment would deliver the operator's mail
 * through a host they thought they had replaced. That reasoning is real, but it
 * buys the wrong thing: nodemailer offers no AUTH, the relay answers 535, the
 * outbox classifies it `unauthorized` — which is *not retryable* — and the
 * message dies. The cost is not a visible error, it is dead mail including
 * sign-in links, on a deployment whose environment relay was working a moment
 * earlier. Falling back keeps mail moving; the operator's remedy is to re-enter
 * the password, and `deployment_setting_secret_unreadable` is logged every time
 * this path is taken so the state is never silent.
 *
 * It is also what `resolveStoredAssistantProvider` has always done for the
 * identical failure. One failure mode, one answer.
 */
export function resolveStoredSmtpBlock(deps: ResolveStoredSecretDeps): SmtpEnvBlock | null {
  const block = parseStoredEmailSettings(deps.row.settings)
  if (block === null) return null
  const pass = resolveStoredSecret(deps)
  // `encryptedSecret` rather than `pass === undefined` alone: those are two
  // different rows. One stores nothing and is finished; the other stores a
  // secret that would not come back, and is not.
  if (deps.row.encryptedSecret !== null && pass === undefined) return null
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
