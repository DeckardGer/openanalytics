import { newId } from '@openanalytics/postgres'

/**
 * Billing-account fixtures for the cloud migration tests.
 *
 * Cloud migration 0009 put a row between a user and their subscription, and
 * every test that used to write `INSERT INTO subscriptions (user_id, …)` now
 * needs two rows in the right order. That is a fact about the schema, not about
 * any one test, so it is written once here — a test that spells the join out
 * itself is a test that will spell it out differently next time.
 *
 * Deliberately raw SQL against the caller's pool rather than the repositories:
 * these tests exist to check what the repositories do, and a fixture that used
 * them would be asserting a function against itself.
 */

/** The narrow slice of `pg`'s Pool/Client these helpers use. */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/** The account this user is billed through, created if it does not exist. */
export async function ensureBillingAccount(
  sql: SqlRunner,
  userId: string,
  options: { stripeCustomerId?: string | null } = {},
): Promise<string> {
  const result = await sql.query(
    `INSERT INTO billing_accounts (id, owner_user_id, stripe_customer_id)
          VALUES ($1, $2, $3)
     ON CONFLICT (owner_user_id) DO UPDATE
            SET stripe_customer_id = coalesce(EXCLUDED.stripe_customer_id,
                                              billing_accounts.stripe_customer_id)
       RETURNING id`,
    [newId(), userId, options.stripeCustomerId ?? null],
  )
  return result.rows[0]?.['id'] as string
}

export interface SubscriptionFixture {
  readonly userId: string
  readonly entitlementState?: string
  readonly providerStatus?: string | null
  readonly planTier?: string | null
  readonly billingInterval?: string | null
  readonly stripeCustomerId?: string | null
  readonly stripeSubscriptionId?: string | null
  readonly currentPeriodStart?: Date | null
  readonly currentPeriodEnd?: Date | null
  readonly cancelAtPeriodEnd?: boolean
  readonly trialEndsAt?: Date | null
  readonly quotaAnchorAt?: Date | null
  readonly providerSnapshotAt?: Date | null
}

/**
 * A subscription on the given user's account, creating the account if needed.
 *
 * Returns the account id, because that is what the repositories are keyed on
 * now and what an assertion about the row has to select by.
 */
export async function giveSubscription(
  sql: SqlRunner,
  input: SubscriptionFixture,
): Promise<string> {
  const billingAccountId = await ensureBillingAccount(sql, input.userId, {
    stripeCustomerId: input.stripeCustomerId ?? null,
  })

  await sql.query(
    `INSERT INTO subscriptions
       (id, billing_account_id, entitlement_state, provider_status, plan_tier,
        billing_interval, stripe_subscription_id, current_period_start,
        current_period_end, cancel_at_period_end, trial_ends_at, quota_anchor_at,
        provider_snapshot_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (billing_account_id) DO UPDATE SET
       entitlement_state = EXCLUDED.entitlement_state,
       provider_status = EXCLUDED.provider_status,
       plan_tier = EXCLUDED.plan_tier,
       billing_interval = EXCLUDED.billing_interval,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       trial_ends_at = EXCLUDED.trial_ends_at,
       quota_anchor_at = EXCLUDED.quota_anchor_at,
       provider_snapshot_at = EXCLUDED.provider_snapshot_at`,
    [
      newId(),
      billingAccountId,
      input.entitlementState ?? 'inactive',
      input.providerStatus ?? null,
      input.planTier ?? null,
      input.billingInterval ?? null,
      input.stripeSubscriptionId ?? null,
      input.currentPeriodStart ?? null,
      input.currentPeriodEnd ?? null,
      input.cancelAtPeriodEnd ?? false,
      input.trialEndsAt ?? null,
      input.quotaAnchorAt ?? null,
      input.providerSnapshotAt ?? null,
    ],
  )

  return billingAccountId
}

/** The account funding a site right now, from the open funding row. */
export async function openFundingAccount(sql: SqlRunner, siteId: string): Promise<string | null> {
  const result = await sql.query(
    `SELECT billing_account_id FROM billing_account_sites
      WHERE site_id = $1 AND effective_to IS NULL`,
    [siteId],
  )
  return (result.rows[0]?.['billing_account_id'] as string | undefined) ?? null
}

/**
 * Move a site's funding to an account the crude way — close the open interval,
 * open the next — for tests that are asserting something downstream of a
 * cutover rather than the cutover itself.
 */
export async function setSiteFunding(
  sql: SqlRunner,
  input: { siteId: string; billingAccountId: string; version?: number; reason?: string },
): Promise<void> {
  await sql.query(
    `UPDATE billing_account_sites SET effective_to = now()
      WHERE site_id = $1 AND effective_to IS NULL`,
    [input.siteId],
  )
  await sql.query(
    `INSERT INTO billing_account_sites
       (id, site_id, billing_account_id, version, effective_from, reason)
     VALUES ($1, $2, $3, coalesce($4, (
       SELECT coalesce(max(version), 0) + 1 FROM billing_account_sites WHERE site_id = $2
     )), now(), $5)`,
    [newId(), input.siteId, input.billingAccountId, input.version ?? null, input.reason ?? 'test'],
  )
}
