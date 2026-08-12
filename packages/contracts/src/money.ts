import { z } from 'zod'

/**
 * Money.
 *
 * Docs snapshot 03 §6.5: amounts cross the wire as minor-unit integers plus a
 * currency, never as float dollars. Gross, refund, fee and net are separate
 * fields so a refund can never be inferred by subtracting rounded values.
 */

/** ISO-4217 alphabetic code, uppercase. */
export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be an uppercase ISO-4217 alphabetic code')

/** Signed: refunds and adjustments are negative amounts in the same field type. */
export const minorUnitAmountSchema = z.number().int().safe()

export const moneySchema = z.object({
  amount_minor: minorUnitAmountSchema,
  currency: currencySchema,
})

export type Money = z.infer<typeof moneySchema>

/**
 * Conversion provenance for any amount restated in a reporting currency.
 *
 * Docs snapshot 02 §14: the original currency/amount and the rate plus the time
 * it was taken are retained, so a historical report stays reproducible after
 * rates move.
 */
export const currencyConversionSchema = z.object({
  source: z.string().min(1),
  rate: z.number().positive(),
  rate_at: z.iso.datetime({ offset: false }),
})

export type CurrencyConversion = z.infer<typeof currencyConversionSchema>

export const revenueAmountsSchema = z.object({
  gross: moneySchema,
  refund: moneySchema,
  fee: moneySchema.nullable(),
  net: moneySchema,
  reporting: moneySchema.nullable(),
  conversion: currencyConversionSchema.nullable(),
})

export type RevenueAmounts = z.infer<typeof revenueAmountsSchema>

export function money(amountMinor: number, currency: string): Money {
  return moneySchema.parse({ amount_minor: amountMinor, currency })
}

/** Adds two amounts, refusing to silently mix currencies. */
export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`cannot add ${a.currency} and ${b.currency} without an explicit conversion`)
  }
  return { amount_minor: a.amount_minor + b.amount_minor, currency: a.currency }
}
