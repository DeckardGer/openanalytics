import { asc, eq } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { users } from '../schema/auth.ts'
import { deploymentSettings, type DeploymentSettingScope } from '../schema/deployment-settings.ts'

/**
 * Deployment settings: what an operator supplies from a third party, typed into
 * the dashboard rather than into a file on the host (migration 0043).
 *
 * This module never encrypts and never decrypts. The vault lives in
 * `packages/integrations` because it needs `node:crypto`, and the split is the
 * same one `revenue_credentials` draws: the caller hands down a ciphertext it
 * produced, and reads one back to decrypt itself. A repository that took a
 * plaintext password could be called with one by mistake.
 */

export interface DeploymentSettingRow {
  readonly scope: DeploymentSettingScope
  readonly settings: Record<string, unknown>
  readonly encryptedSecret: string | null
  readonly keyVersion: string | null
  readonly secretLast4: string
  readonly updatedByUserId: string | null
  readonly updatedAt: Date
}

export async function readDeploymentSetting(
  db: Database,
  scope: DeploymentSettingScope,
): Promise<DeploymentSettingRow | null> {
  const [row] = await db
    .select({
      scope: deploymentSettings.scope,
      settings: deploymentSettings.settings,
      encryptedSecret: deploymentSettings.encryptedSecret,
      keyVersion: deploymentSettings.keyVersion,
      secretLast4: deploymentSettings.secretLast4,
      updatedByUserId: deploymentSettings.updatedByUserId,
      updatedAt: deploymentSettings.updatedAt,
    })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.scope, scope))
  return row ? { ...row, updatedAt: new Date(row.updatedAt) } : null
}

export interface WriteDeploymentSettingInput {
  readonly scope: DeploymentSettingScope
  /** The non-secret half, exactly as it will be read back. */
  readonly settings: Record<string, unknown>
  /** A ciphertext the caller produced, or `null` to store none. */
  readonly encryptedSecret: string | null
  readonly keyVersion: string | null
  readonly secretLast4: string
  readonly updatedByUserId: string
}

/**
 * Stores a scope, replacing whatever it held.
 *
 * A whole-row replace rather than a merge, because the surface above it is a
 * form: what the operator submits is the complete state of that setting, and a
 * merge would make "I cleared the username" indistinguishable from "I did not
 * send the username". The one field a form cannot resend is the secret itself,
 * which is why keeping it is the *caller's* decision — it reads the existing row
 * and passes the ciphertext back through unchanged.
 */
export async function writeDeploymentSetting(
  db: Database,
  input: WriteDeploymentSettingInput,
): Promise<DeploymentSettingRow> {
  const values = {
    settings: input.settings,
    encryptedSecret: input.encryptedSecret,
    keyVersion: input.keyVersion,
    secretLast4: input.secretLast4,
    updatedByUserId: input.updatedByUserId,
    updatedAt: new Date(),
  }
  const [row] = await db
    .insert(deploymentSettings)
    .values({ scope: input.scope, ...values })
    .onConflictDoUpdate({ target: deploymentSettings.scope, set: values })
    .returning({
      scope: deploymentSettings.scope,
      settings: deploymentSettings.settings,
      encryptedSecret: deploymentSettings.encryptedSecret,
      keyVersion: deploymentSettings.keyVersion,
      secretLast4: deploymentSettings.secretLast4,
      updatedByUserId: deploymentSettings.updatedByUserId,
      updatedAt: deploymentSettings.updatedAt,
    })
  const stored = row as NonNullable<typeof row>
  return { ...stored, updatedAt: new Date(stored.updatedAt) }
}

/**
 * Removes a scope, so the deployment falls back to its environment.
 *
 * A delete rather than a `configured = false` column: the row's whole content is
 * the configuration, and an emptied row that still existed would be a second way
 * to spell "not configured" for every reader to handle.
 */
export async function clearDeploymentSetting(
  db: Database,
  scope: DeploymentSettingScope,
): Promise<boolean> {
  const removed = await db
    .delete(deploymentSettings)
    .where(eq(deploymentSettings.scope, scope))
    .returning({ scope: deploymentSettings.scope })
  return removed.length > 0
}

/**
 * The account that claimed this deployment.
 *
 * Deployment settings are the operator's, and this repository has no role system
 * to ask — site memberships are per site, and none of them says anything about
 * who runs the install. The oldest account is the rule, and it is the same
 * sentence the first-run screen already makes to the person creating it:
 * whoever claims a fresh deployment first owns it.
 *
 * Deliberately not a stored flag. A column would need a backfill for every
 * install that predates it, a bootstrap for the one case where it is empty, and
 * a way to move it — three mechanisms in place of one `ORDER BY`. When this
 * install needs more than one operator it needs a role system, and that is an
 * ADR rather than a column added quietly here.
 *
 * `null` on an empty deployment, which is the state the claim screen exists for.
 */
export async function deploymentOperatorUserId(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1)
  return row?.id ?? null
}
