import { ApiError } from '@openanalytics/contracts'
import { OwnershipError } from '@openanalytics/postgres'

/**
 * How an `OwnershipError` becomes a response, and the one seam an optional
 * surface has into it.
 *
 * Its own module because two things needed to be true at once. The mapping is
 * called from a dozen handlers in `routes.ts`, so threading a per-request
 * dependency through each one would have been a dozen edits for one hook; and
 * `OwnershipError`'s violation vocabulary is shared — the same class carries
 * "this site must keep an owner", which every deployment can raise, and "this
 * plan's site limit is reached", which only a deployment that sells plans can.
 * A module-level registry keeps the product mapping exhaustive over what the
 * product can raise, and lets the surface that raises the rest say what those
 * mean, beside the code that raises them.
 */

/**
 * A mapper an optional surface registers. It either throws its own `ApiError` or
 * returns, in which case the next mapper — and finally the product mapping —
 * gets the error. Returning rather than rethrowing is what keeps a surface from
 * having to know the product's fallbacks.
 */
export type OwnershipErrorMapper = (error: OwnershipError) => void

const mappers: OwnershipErrorMapper[] = []

/** Idempotent, so importing the surface twice registers once. */
export function registerOwnershipErrorMapper(mapper: OwnershipErrorMapper): void {
  if (mappers.includes(mapper)) return
  mappers.push(mapper)
}

export function ownershipToApiError(error: unknown): never {
  if (error instanceof OwnershipError) {
    for (const mapper of mappers) mapper(error)
    if (error.violation === 'billing_owner') {
      // The `OA002` deferred trigger: the site's owner of record must stay an
      // accepted owner member. `VALIDATION_FAILED` for the same reason
      // `last_owner` has it — both are "the shape you are asking for is not a
      // site", stated about the field the caller named.
      throw new ApiError(
        'VALIDATION_FAILED',
        'The site owner cannot be removed; hand the site over first',
      )
    }
    if (error.violation === 'last_owner') {
      throw new ApiError('VALIDATION_FAILED', 'A site must keep at least one owner')
    }
    if (error.violation === 'site_not_found') {
      throw new ApiError('SITE_NOT_FOUND', 'No such site')
    }
    if (error.violation === 'not_an_owner') {
      throw new ApiError('FORBIDDEN', 'Only an owner can take over billing')
    }
    if (error.violation === 'already_billing_owner') {
      throw new ApiError('VALIDATION_FAILED', 'The caller is already the billing owner')
    }
    throw new ApiError('NOT_FOUND', 'The user is not a member of this site')
  }
  throw error
}

/**
 * The create path's own refusals, which are not membership violations.
 *
 * A taken slug is reported as an ordinary field validation rather than a new
 * error code: the catalog already says `details.issues` names fields, and "this
 * name is taken" is a form error, not a class of failure of its own.
 *
 * The two *commercial* refusals a create can meet — an unfunded caller's second
 * site, and a plan whose site limit is reached — are not here. They can only be
 * raised by the gate a hosted deployment registers on `createSite`, and the
 * mapping for them is registered beside it (`src/cloud/http/ownership.ts`).
 */
export function createSiteToApiError(error: unknown): never {
  if (error instanceof OwnershipError && error.violation === 'slug_taken') {
    throw new ApiError('VALIDATION_FAILED', 'That site slug is already taken', {
      details: { issues: [{ field: 'slug', code: 'taken' }] },
    })
  }
  ownershipToApiError(error)
}
