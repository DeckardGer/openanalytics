import type { AssistantConfig } from '@openanalytics/domain'
import {
  createOpenAiChatClient,
  resolveStoredAssistantProvider,
  type CredentialVault,
  type OpenAiChatClient,
} from '@openanalytics/integrations'
import { readDeploymentSetting, type Database } from '@openanalytics/postgres'

/**
 * Which model provider the assistant is talking to, resolved per request
 * (migration 0043).
 *
 * The client used to be built once in `main.ts` from `OPENAI_API_KEY`, which is
 * correct for a deployment whose environment is its configuration and wrong for
 * one where the operator has just typed a key into a screen: the key would sit
 * in the database until somebody restarted the container, and nothing would say
 * so. So the question moved from startup to request time.
 *
 * **A stored key wins over the environment**, for the same reason the worker's
 * mail transport does: it is the one the operator can see and change. Our own
 * deployment stores nothing here, so its behaviour is byte for byte what it was.
 *
 * The client is still built once per *configuration*, not per request. A
 * provider client is a `fetch` wrapper — cheap, but not free to construct on
 * every question — and the row's `updated_at` is exactly the signal that says
 * when a rebuild is owed.
 */

export type AssistantClientResolver = () => Promise<OpenAiChatClient | undefined>

export interface AssistantProviderDeps {
  readonly db: Database
  readonly config: AssistantConfig
  /** The client built from `OPENAI_API_KEY`, when one was. */
  readonly envClient?: OpenAiChatClient
  /** Absent when there is no usable keyring; then only the environment applies. */
  readonly vault?: CredentialVault
  /** Injected so a test can resolve a provider without reaching a network. */
  readonly createClient?: typeof createOpenAiChatClient
  readonly onError?: (event: string, fields: Record<string, unknown>) => void
}

export function createAssistantClientResolver(
  deps: AssistantProviderDeps,
): AssistantClientResolver {
  const build = deps.createClient ?? createOpenAiChatClient
  let cachedKey: string | undefined
  let cachedClient: OpenAiChatClient | undefined

  return async () => {
    if (deps.vault === undefined) return deps.envClient

    let stored
    try {
      stored = await readDeploymentSetting(deps.db, 'assistant')
    } catch (err) {
      // An unreadable settings table must not take the assistant down on a
      // deployment whose key is in its environment. The env client is the
      // conservative answer: it is what this build did before the table existed.
      deps.onError?.('deployment_settings_read_failed', {
        scope: 'assistant',
        err,
        retryable: true,
      })
      return deps.envClient
    }
    if (stored === null) return deps.envClient

    // The cache key is the row's own version. Two writes in the same millisecond
    // would share it, and the loser would be the one the operator just made —
    // which is why `updated_at` is stamped in application code on every write
    // rather than being left to a trigger, and why the key version rides along:
    // a rotation changes the ciphertext without moving the timestamp.
    const key = `${stored.updatedAt.toISOString()}:${stored.keyVersion ?? ''}`
    if (key === cachedKey) return cachedClient ?? deps.envClient

    const provider = resolveStoredAssistantProvider({
      row: stored,
      scope: 'assistant',
      vault: deps.vault,
      ...(deps.onError ? { log: deps.onError } : {}),
    })
    cachedKey = key
    cachedClient =
      provider === null
        ? undefined
        : build({
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl ?? deps.config.OPENAI_BASE_URL,
            model: provider.model ?? deps.config.ASSISTANT_MODEL,
          })
    // A stored row whose secret will not decrypt falls back rather than
    // disabling the assistant: the operator's remedy is to re-enter the key, and
    // an install that also has one in its environment should keep working while
    // they do.
    return cachedClient ?? deps.envClient
  }
}
