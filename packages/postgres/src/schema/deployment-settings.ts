import { sql } from 'drizzle-orm'
import { check, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, updatedAt } from './_shared.ts'
import { users } from './auth.ts'

/**
 * Deployment settings (mirror of migration 0043).
 *
 * What an operator supplies from a third party — a mail relay, a model provider
 * — typed into the dashboard instead of into a file on the host. The migration
 * carries the full argument; what matters here is the shape:
 *
 * - `scope` is the primary key. One row per setting, no id, and the natural key
 *   is what the credential vault's AAD binds to (`deployment_setting:{scope}`).
 * - `settings` holds the non-secret half only. A password or an API key never
 *   lands in it — those go through the vault into `encryptedSecret`.
 * - `secretLast4` is the only part of a secret any read surface returns, on the
 *   `revenue_credentials` precedent.
 */

export type DeploymentSettingScope = 'email' | 'assistant'

/** The stored non-secret half of the mail transport. */
export interface EmailDeploymentSettings {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user?: string
  readonly from?: string
}

/** The stored non-secret half of the model provider. */
export interface AssistantDeploymentSettings {
  readonly model?: string
  readonly baseUrl?: string
}

export const deploymentSettings = pgTable(
  'deployment_settings',
  {
    scope: text('scope').$type<DeploymentSettingScope>().primaryKey(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** AES-256-GCM, AAD-bound to `deployment_setting:{scope}`. Nullable: a relay
     * on the same host often wants no credential at all. */
    encryptedSecret: text('encrypted_secret'),
    keyVersion: text('key_version'),
    secretLast4: text('secret_last4').notNull().default(''),
    /** NO ACTION on the user: a `users` row is scrubbed rather than deleted, so
     * a declared cascade could never fire (migration 0041's rule). */
    updatedByUserId: idColumn('updated_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('deployment_settings_scope_check', sql`${t.scope} IN ('email', 'assistant')`),
    // Written together or not at all — a ciphertext with no version decrypts as
    // 'malformed', which names the wrong fault.
    check(
      'deployment_settings_key_version_check',
      sql`(${t.encryptedSecret} IS NULL) = (${t.keyVersion} IS NULL)`,
    ),
    check(
      'deployment_settings_last4_check',
      sql`${t.encryptedSecret} IS NOT NULL OR ${t.secretLast4} = ''`,
    ),
  ],
)
