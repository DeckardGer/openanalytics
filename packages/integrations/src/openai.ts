/**
 * OpenAI Chat Completions adapter (ADR-0046, D6).
 *
 * Built on the shape `createStripeClient` established (ADR-0033 D3) and for the
 * same reasons, restated here because they are what this file is:
 *
 * - **An injectable `fetchImpl`**, defaulting to global `fetch`, so the tests
 *   that matter — a streamed tool call, a mid-stream provider failure, a
 *   timeout — run with no network and no recorded cassette.
 * - **A typed outcome union, never a throw.** `unauthorized` (the key is wrong
 *   or withdrawn), `unavailable` (5xx, timeout, socket failure, abort),
 *   `invalid_request` (the provider rejected our payload, or answered something
 *   that is not this protocol — our bug, and it must be visible as ours). A
 *   handler that has to translate exceptions into an error envelope is a handler
 *   where a stack trace eventually reaches a user.
 * - **No `openai` package.** Chat Completions with streaming and tool calls is a
 *   POST with an SSE response and a documented JSON shape; it is framing, not
 *   cryptography. A dependency in the api's install path is a cost paid by every
 *   CI run and every contributor, and it is worth paying for PKCE and token
 *   hashing, not for request framing. It also keeps the *provider* swappable,
 *   which is F-306's actual requirement — an SDK is the one thing that makes a
 *   provider hard to change.
 *
 * What "the provider is configuration" promises is bounded rather than
 * overstated (the ADR-0022 form): any endpoint speaking this wire protocol is a
 * `baseUrl` and a `model`. An endpoint with a *different* tool-call encoding or
 * streaming envelope is a new adapter behind this same interface — a file, not
 * a redesign.
 *
 * The provider credential lives in this module's `Authorization` header and
 * nowhere else: never interpolated into prompt text, never a tool argument,
 * never logged. Neither does the provider's own error prose leave here — only
 * the status — for the reason the Stripe adapter gives.
 */

// --- The conversation, in this repository's spelling --------------------------

/**
 * A tool call the model asked for.
 *
 * `arguments` is the raw JSON **text** the model produced, not a parsed object,
 * and that is deliberate: a model can emit arguments that are not valid JSON,
 * and the caller has to be able to tell that apart from arguments that parsed
 * to something it did not expect.
 */
export interface OpenAiToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/**
 * One message in the request.
 *
 * `system` is server-owned and `tool` is produced by the dispatch and by
 * nothing else (ADR-0046 D7) — this type describes the wire, and the route is
 * what refuses a client that tries to send either.
 */
export interface OpenAiChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  /** Null on an assistant turn that was only a tool call. */
  readonly content: string | null
  /** Required on a `tool` message: which call this result answers. */
  readonly toolCallId?: string
  /** The calls an assistant turn asked for, replayed back into the next round. */
  readonly toolCalls?: readonly OpenAiToolCall[]
}

/** A tool as the model is shown it. `parameters` is a JSON Schema object. */
export interface OpenAiToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/** What the turn cost, as the provider reported it. */
export interface OpenAiUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface StreamChatInput {
  readonly messages: readonly OpenAiChatMessage[]
  /** Omitted or empty means no `tools` key at all — the final round of a loop
   * deliberately offers none, and `tools: []` is a different request some
   * endpoints reject. */
  readonly tools?: readonly OpenAiToolDefinition[]
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  /** The caller's abort — a closed browser tab (D10). It reaches `fetch`, so
   * the generation stops rather than being merely ignored. */
  readonly signal?: AbortSignal
  /** Assistant text as it arrives, one provider fragment per call. */
  readonly onDelta?: (text: string) => void
  /** A tool call, once it is **complete**. Never one event per fragment. */
  readonly onToolCall?: (call: OpenAiToolCall) => void
}

export interface OpenAiChatCompletion {
  /** Every text delta, concatenated. */
  readonly text: string
  readonly toolCalls: readonly OpenAiToolCall[]
  readonly finishReason: string | null
  /** Null when the provider sent none: "zero tokens" and "we were never told"
   * are different facts, and recording the second as the first would understate
   * a real spend. */
  readonly usage: OpenAiUsage | null
}

export type OpenAiFailureReason = 'unauthorized' | 'unavailable' | 'invalid_request'

export type OpenAiOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false
      readonly reason: OpenAiFailureReason
      /** Safe, categorized detail — never the provider's own error body. */
      readonly detail: string
    }

export interface OpenAiChatClient {
  streamChat(input: StreamChatInput): Promise<OpenAiOutcome<OpenAiChatCompletion>>
}

export interface OpenAiChatConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
}

// --- Wire shapes --------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

function toWireMessage(message: OpenAiChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.role === 'tool') {
    // The provider refuses a tool result that does not name the call it
    // answers, and that refusal is ours to have caused — hence `invalid_request`
    // rather than something that reads like a provider fault.
    wire['tool_call_id'] = message.toolCallId
  }
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    wire['tool_calls'] = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return wire
}

/** A tool call as it accumulates across chunks, keyed by the provider's index. */
interface PartialToolCall {
  id: string
  name: string
  arguments: string
}

// --- The client ---------------------------------------------------------------

/**
 * Chat Completions over `fetch`, streamed.
 *
 * One method, because one is what the assistant loop needs: send the whole
 * conversation, read text deltas as they arrive, read the complete tool calls
 * the model asked for, and read what the turn cost.
 */
export function createOpenAiChatClient(
  config: OpenAiChatConfig,
  fetchImpl: typeof fetch = fetch,
): OpenAiChatClient {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`

  return {
    async streamChat(input) {
      const body = JSON.stringify({
        model: config.model,
        messages: input.messages.map(toWireMessage),
        stream: true,
        // Without this the terminal chunk carries no usage at all, and D5's
        // token columns would have nothing to record.
        stream_options: { include_usage: true },
        max_completion_tokens: input.maxOutputTokens,
        ...(input.tools !== undefined && input.tools.length > 0
          ? {
              tools: input.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
      })

      // Two ways this call can end early, and they are reported differently
      // because they mean different things to an operator: our own deadline
      // fired, or the person closed the tab.
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, input.timeoutMs)
      const onCallerAbort = (): void => {
        controller.abort()
      }
      input.signal?.addEventListener('abort', onCallerAbort)
      if (input.signal?.aborted === true) controller.abort()

      const abortDetail = (): string =>
        timedOut
          ? `openai request timed out after ${String(input.timeoutMs)}ms`
          : 'openai request aborted by the caller'

      try {
        // A caller who has already gone gets no request at all. Global `fetch`
        // rejects on an aborted signal anyway; saying so here means the tab
        // that closed while the loop was between rounds costs no tokens.
        if (controller.signal.aborted) {
          return { ok: false, reason: 'unavailable', detail: abortDetail() }
        }

        let response: Response
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body,
            signal: controller.signal,
          })
        } catch {
          // A DNS failure, a refused connection, or either abort above. All of
          // them are "we could not get an answer", which is what the caller has
          // to act on.
          return {
            ok: false,
            reason: 'unavailable',
            detail: controller.signal.aborted ? abortDetail() : 'openai request failed',
          }
        }

        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            reason: 'unauthorized',
            detail: `openai responded ${String(response.status)}`,
          }
        }
        if (response.status >= 500) {
          return {
            ok: false,
            reason: 'unavailable',
            detail: `openai responded ${String(response.status)}`,
          }
        }
        if (!response.ok) {
          return {
            ok: false,
            reason: 'invalid_request',
            detail: `openai responded ${String(response.status)}`,
          }
        }
        if (response.body === null) {
          return { ok: false, reason: 'invalid_request', detail: 'openai response has no body' }
        }

        return await readStream(response.body, input, () =>
          controller.signal.aborted ? abortDetail() : null,
        )
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onCallerAbort)
      }
    },
  }
}

/**
 * Read the SSE body into one completion.
 *
 * Framing is a property of the byte stream and not of the socket reads, so the
 * decoder holds a buffer across chunks: an event split across two reads is one
 * event, and an adapter that split on chunk boundaries would corrupt whichever
 * event happened to straddle one — intermittently, and only under load.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  input: StreamChatInput,
  abortDetail: () => string | null,
): Promise<OpenAiOutcome<OpenAiChatCompletion>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  let text = ''
  let finishReason: string | null = null
  let usage: OpenAiUsage | null = null
  const partials = new Map<number, PartialToolCall>()
  const completed: OpenAiToolCall[] = []

  /**
   * Publish the accumulated calls.
   *
   * Only when a `finish_reason` arrives, because nothing else marks the last
   * fragment: `arguments` is streamed in pieces and emitting one per chunk
   * would hand the loop three-quarters of a JSON object. Insertion order is the
   * provider's `index` order, which is the order the calls were opened in.
   */
  const flushToolCalls = (): void => {
    for (const [, partial] of [...partials.entries()].sort((a, b) => a[0] - b[0])) {
      const call: OpenAiToolCall = {
        id: partial.id,
        name: partial.name,
        arguments: partial.arguments,
      }
      completed.push(call)
      input.onToolCall?.(call)
    }
    partials.clear()
  }

  try {
    let done = false
    while (!done) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')

        // Blank separators, and the `event:`/`id:`/`:` lines an intermediary may
        // add. Only `data:` carries the protocol.
        if (!line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).trim()
        if (payload === '[DONE]') {
          done = true
          break
        }
        if (payload.length === 0) continue

        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch {
          // Not skipped. An endpoint answering `text/event-stream` with
          // something that is not this protocol is a configuration mistake, and
          // reading it as an empty answer would surface to a user as "the
          // assistant said nothing".
          return {
            ok: false,
            reason: 'invalid_request',
            detail: 'openai stream sent an event that is not JSON',
          }
        }

        const event = asRecord(parsed)
        if (event === null) {
          return {
            ok: false,
            reason: 'invalid_request',
            detail: 'openai stream sent an event that is not an object',
          }
        }

        const reportedUsage = asRecord(event['usage'])
        if (reportedUsage !== null) {
          const inputTokens = asFiniteNumber(reportedUsage['prompt_tokens'])
          const outputTokens = asFiniteNumber(reportedUsage['completion_tokens'])
          if (inputTokens !== null || outputTokens !== null) {
            usage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
          }
        }

        const choices = event['choices']
        if (!Array.isArray(choices)) continue
        for (const rawChoice of choices) {
          const choice = asRecord(rawChoice)
          if (choice === null) continue

          const delta = asRecord(choice['delta'])
          if (delta !== null) {
            const content = asString(delta['content'])
            if (content !== null && content.length > 0) {
              text += content
              input.onDelta?.(content)
            }
            accumulateToolCalls(delta['tool_calls'], partials)
          }

          const reason = asString(choice['finish_reason'])
          if (reason !== null) {
            finishReason = reason
            flushToolCalls()
          }
        }
      }
    }
  } catch {
    // The head was already `200`, so this is a socket that died mid-answer, or
    // one of the two aborts. Never a rejected promise: the caller is a handler
    // that may already have written bytes to a browser.
    const aborted = abortDetail()
    return {
      ok: false,
      reason: 'unavailable',
      detail: aborted ?? 'openai stream failed mid-response',
    }
  } finally {
    // Best effort: the stream may already be errored or closed, and failing to
    // release a reader must not become the error the caller sees.
    try {
      await reader.cancel()
    } catch {
      /* already gone */
    }
  }

  // A stream that ended without a `finish_reason` but with calls in flight —
  // a truncated response. They are reported rather than dropped, because a
  // dropped call looks to the loop like a model that answered nothing.
  flushToolCalls()

  return { ok: true, data: { text, toolCalls: completed, finishReason, usage } }
}

/**
 * Fold one chunk's `tool_calls` fragments into the accumulator.
 *
 * The protocol fact this hides: the call's `index` is the identity, the `id`
 * and `name` arrive once (usually on the first fragment), and `arguments`
 * arrives in pieces that have to be concatenated in order. Two calls in one
 * round differ only by their index, so keying on anything else would merge
 * them.
 */
function accumulateToolCalls(raw: unknown, partials: Map<number, PartialToolCall>): void {
  if (!Array.isArray(raw)) return
  for (const entry of raw) {
    const call = asRecord(entry)
    if (call === null) continue
    const index = asFiniteNumber(call['index']) ?? 0
    const existing = partials.get(index) ?? { id: '', name: '', arguments: '' }

    const id = asString(call['id'])
    if (id !== null && id.length > 0) existing.id = id

    const fn = asRecord(call['function'])
    if (fn !== null) {
      const name = asString(fn['name'])
      if (name !== null && name.length > 0) existing.name = name
      const args = asString(fn['arguments'])
      if (args !== null) existing.arguments += args
    }

    partials.set(index, existing)
  }
}
