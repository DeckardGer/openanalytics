/**
 * The import provider catalog (ADR-0032, D11).
 *
 * One list, published over HTTP, so the frontend renders what this build can
 * actually do. The mock the dashboard shipped with named six providers that were
 * never the six the plan lists, and the two only converged by redeploying the
 * frontend; a catalog endpoint is how they converge without one.
 *
 * `available: false` is deliberately a *listed* provider rather than an absent
 * one. "Matomo is coming" and "Matomo is not a thing we do" are different
 * answers, and a screen that can only show what works cannot give the first.
 *
 * `capability` is the honest half of the descriptor. Plausible's export is
 * aggregate-only — ten daily-grain CSVs, no visitor identifiers — which is what
 * makes the whole D2/D4/D5 read design necessary, and a provider that could ship
 * event-level rows would be staged and read differently. Stating it per provider
 * keeps that a property of the adapter rather than an assumption in the pipeline.
 */

export const IMPORT_PROVIDER_CAPABILITIES = ['aggregate_only', 'event_level'] as const
export type ImportProviderCapability = (typeof IMPORT_PROVIDER_CAPABILITIES)[number]

export interface ImportProviderDescriptor {
  readonly id: string
  readonly displayName: string
  readonly capability: ImportProviderCapability
  /** Whether this build has a working adapter. Never inferred from the list. */
  readonly available: boolean
}

/**
 * The catalog, in the order the picker should show it: what works first.
 *
 * The five unavailable entries are the follow-up sub-parts behind the same
 * descriptor/parser framework (D11, F-302). Their capability is recorded now
 * because it is a property of the *provider's export*, not of our adapter — GA
 * and OpenPanel can ship event-level rows whether or not we read them yet, and
 * a descriptor that lied about that would mislead the staging design later.
 */
export const IMPORT_PROVIDERS: readonly ImportProviderDescriptor[] = [
  { id: 'plausible', displayName: 'Plausible', capability: 'aggregate_only', available: true },
  { id: 'umami', displayName: 'Umami', capability: 'event_level', available: false },
  { id: 'matomo', displayName: 'Matomo', capability: 'event_level', available: false },
  { id: 'fathom', displayName: 'Fathom', capability: 'aggregate_only', available: false },
  {
    id: 'google_analytics',
    displayName: 'Google Analytics',
    capability: 'aggregate_only',
    available: false,
  },
  { id: 'openpanel', displayName: 'OpenPanel', capability: 'event_level', available: false },
]

export function findImportProvider(id: unknown): ImportProviderDescriptor | null {
  if (typeof id !== 'string') return null
  return IMPORT_PROVIDERS.find((provider) => provider.id === id) ?? null
}
