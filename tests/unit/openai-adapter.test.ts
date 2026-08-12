import { createOpenAiChatClient, type OpenAiToolCall } from '@openanalytics/integrations'
import { describe, expect, it } from 'vitest'

/**
 * The OpenAI Chat Completions adapter (ADR-0046 D6).
 *
 * SDK-free and built on the shape `createStripeClient` established, for the same
 * two reasons: an injectable `fetchImpl` means the tests that matter — a
 * streamed tool call, a mid-stream provider failure, a timeout — run with no
 * network and no recorded cassette, and a typed outcome union means a handler
 * never has to translate an exception into an error envelope.
 *
 * The one piece of real protocol knowledge this file pins is the fragmented
 * tool call. Chat Completions streams a call's `arguments` split across chunks,
 * keyed by `index`, with the name arriving on the first fragment and nothing
 * marking the last one but `finish_reason`. An adapter that emitted a call per
 * chunk would hand the loop three-quarters of a JSON object.
 */

const CONFIG = { apiKey: 'sk-test-key', baseUrl: 'https://api.openai.test', model: 'gpt-5.5' }

const USER_TURN = [{ role: 'user' as const, content: 'How did traffic do last week?' }]

interface Capture {
  readonly url: string
  readonly init: RequestInit
}

interface FetchPlan {
  readonly status?: number
  /** A non-streamed JSON body, for the error paths. */
  readonly body?: string
  /** SSE payload, in the network chunks it arrives in. */
  readonly chunks?: readonly string[]
  /** Fail the body stream once this many chunks have been delivered. */
  readonly errorAfterChunk?: number
  /** Never close the body, so only an abort can end the read. */
  readonly hangAfterChunks?: boolean
  /** Throw from `fetch` itself, as a DNS or connect failure does. */
  readonly networkError?: boolean
}

/** A `fetch` that speaks the provider's wire protocol and honours `signal`,
 * because an abort that the fake ignored would prove nothing about D10. */
function fakeFetch(plan: FetchPlan, captures: Capture[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captures.push({ url: String(input), init: init ?? {} })
    // Global `fetch` rejects rather than dialling when the signal is already
    // aborted; a fake that answered anyway would let a leak through.
    if (init?.signal?.aborted === true) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    if (plan.networkError === true) throw new TypeError('fetch failed')

    const status = plan.status ?? 200
    if (plan.body !== undefined || status !== 200) {
      return new Response(plan.body ?? '', {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }

    const chunks = plan.chunks ?? []
    const encoder = new TextEncoder()
    let index = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'))
          } catch {
            // The stream had already finished; an abort afterwards is a no-op.
          }
        })
      },
      pull(controller) {
        if (plan.errorAfterChunk !== undefined && index === plan.errorAfterChunk) {
          controller.error(new Error('socket hang up'))
          return undefined
        }
        if (index >= chunks.length) {
          if (plan.hangAfterChunks === true) return new Promise<void>(() => undefined)
          controller.close()
          return undefined
        }
        controller.enqueue(encoder.encode(chunks[index] as string))
        index += 1
        return undefined
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch
}

/** One SSE event, terminated the way the provider terminates it. */
const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
const DONE = 'data: [DONE]\n\n'

const textChunk = (content: string, finishReason: string | null = null): string =>
  event({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })

const usageChunk = (prompt: number, completion: number): string =>
  event({
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  })

describe('the OpenAI chat adapter', () => {
  describe('the request it makes', () => {
    it('posts the streamed completion the assistant loop needs', async () => {
      const captures: Capture[] = []
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('ok', 'stop'), DONE] }, captures),
      )

      await client.streamChat({
        messages: [
          { role: 'system', content: 'You answer questions about analytics.' },
          ...USER_TURN,
        ],
        tools: [
          {
            name: 'site_overview',
            description: 'Totals for a site over a range.',
            parameters: { type: 'object', properties: { site_id: { type: 'string' } } },
          },
        ],
        maxOutputTokens: 2000,
        timeoutMs: 60_000,
      })

      const capture = captures[0]
      expect(capture?.url).toBe('https://api.openai.test/v1/chat/completions')
      expect(capture?.init.method).toBe('POST')
      const headers = capture?.init.headers as Record<string, string>
      expect(headers['authorization']).toBe('Bearer sk-test-key')
      expect(headers['content-type']).toBe('application/json')

      const sent = JSON.parse(String(capture?.init.body)) as Record<string, unknown>
      expect(sent['model']).toBe('gpt-5.5')
      expect(sent['stream']).toBe(true)
      // Without this the final chunk carries no usage at all, and D5's token
      // columns would have nothing to record.
      expect(sent['stream_options']).toEqual({ include_usage: true })
      expect(sent['max_completion_tokens']).toBe(2000)
      expect(sent['messages']).toEqual([
        { role: 'system', content: 'You answer questions about analytics.' },
        { role: 'user', content: 'How did traffic do last week?' },
      ])
      expect(sent['tools']).toEqual([
        {
          type: 'function',
          function: {
            name: 'site_overview',
            description: 'Totals for a site over a range.',
            parameters: { type: 'object', properties: { site_id: { type: 'string' } } },
          },
        },
      ])
    })

    it('sends a tool result back as the provider spells it', async () => {
      // The loop's second round: the assistant's own tool call, then our result.
      // A `tool` message without its `tool_call_id` is rejected by the provider,
      // and the failure would arrive as our bug — which is what
      // `invalid_request` exists to say.
      const captures: Capture[] = []
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('done', 'stop'), DONE] }, captures),
      )

      await client.streamChat({
        messages: [
          ...USER_TURN,
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'call_1', name: 'site_overview', arguments: '{"site_id":"s1"}' }],
          },
          { role: 'tool', toolCallId: 'call_1', content: '{"data":{"pageviews":12}}' },
        ],
        maxOutputTokens: 100,
        timeoutMs: 1000,
      })

      const sent = JSON.parse(String(captures[0]?.init.body)) as {
        messages: Record<string, unknown>[]
      }
      expect(sent.messages[1]).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'site_overview', arguments: '{"site_id":"s1"}' },
          },
        ],
      })
      expect(sent.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"data":{"pageviews":12}}',
      })
    })

    it('omits the tools key entirely when there are none', async () => {
      // `tools: []` is not the same request: some endpoints reject an empty
      // array, and the final round of a loop deliberately offers no tools.
      const captures: Capture[] = []
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('ok', 'stop'), DONE] }, captures),
      )
      await client.streamChat({
        messages: USER_TURN,
        tools: [],
        maxOutputTokens: 10,
        timeoutMs: 1000,
      })
      const sent = JSON.parse(String(captures[0]?.init.body)) as Record<string, unknown>
      expect(sent['tools']).toBeUndefined()
    })
  })

  describe('the stream it reads', () => {
    it('assembles text deltas in order and reports each one as it arrives', async () => {
      const seen: string[] = []
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({
          chunks: [
            event({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
            textChunk('Traffic '),
            textChunk('is up '),
            textChunk('12%.', 'stop'),
            usageChunk(812, 37),
            DONE,
          ],
        }),
      )

      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
        onDelta: (text) => seen.push(text),
      })

      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.data.text).toBe('Traffic is up 12%.')
      expect(outcome.data.finishReason).toBe('stop')
      // The reason the response is a stream at all: the caller sees the text
      // before the request ends, one fragment at a time.
      expect(seen).toEqual(['Traffic ', 'is up ', '12%.'])
    })

    it('reads the final usage the token columns are written from', async () => {
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('hi', 'stop'), usageChunk(812, 37), DONE] }),
      )
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.data.usage).toEqual({ inputTokens: 812, outputTokens: 37 })
    })

    it('reports no usage rather than zero when the provider sent none', async () => {
      // Zero tokens and "the provider never told us" are different facts, and
      // recording the second as the first would understate a real spend.
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('hi', 'stop'), DONE] }),
      )
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.data.usage).toBeNull()
    })

    it('reassembles a tool call whose arguments arrive in fragments', async () => {
      // The protocol fact this adapter exists to hide: `arguments` is streamed
      // in pieces keyed by `index`, the name arrives once on the first
      // fragment, and nothing marks the last piece except `finish_reason`.
      const emitted: OpenAiToolCall[] = []
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({
          chunks: [
            event({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_abc',
                        type: 'function',
                        function: { name: 'site_timeseries', arguments: '' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
            event({
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '{"site_id":' } }] },
                  finish_reason: null,
                },
              ],
            }),
            event({
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '"s1"}' } }] },
                  finish_reason: null,
                },
              ],
            }),
            event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
            usageChunk(400, 21),
            DONE,
          ],
        }),
      )

      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
        onToolCall: (call) => emitted.push(call),
      })

      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.data.finishReason).toBe('tool_calls')
      expect(outcome.data.toolCalls).toEqual([
        { id: 'call_abc', name: 'site_timeseries', arguments: '{"site_id":"s1"}' },
      ])
      // Emitted once, complete — never one event per fragment, which would hand
      // the loop three-quarters of a JSON object to parse.
      expect(emitted).toEqual([
        { id: 'call_abc', name: 'site_timeseries', arguments: '{"site_id":"s1"}' },
      ])
      expect(JSON.parse(emitted[0]?.arguments ?? '')).toEqual({ site_id: 's1' })
    })

    it('keeps two calls in one round apart, by their index', async () => {
      // Chat Completions may request several tools per round, which is why D7's
      // iteration ceiling counts rounds rather than calls. Merging two indexes
      // would produce one call with both names' arguments concatenated.
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({
          chunks: [
            event({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'a', function: { name: 'top_pages', arguments: '{"s":' } },
                      { index: 1, id: 'b', function: { name: 'top_sources', arguments: '{"s":' } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
            event({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 1, function: { arguments: '2}' } },
                      { index: 0, function: { arguments: '1}' } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
            event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
            DONE,
          ],
        }),
      )

      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.data.toolCalls).toEqual([
        { id: 'a', name: 'top_pages', arguments: '{"s":1}' },
        { id: 'b', name: 'top_sources', arguments: '{"s":2}' },
      ])
    })

    it('reads an event split across two network chunks as one event', async () => {
      // SSE framing is a property of the byte stream, not of the socket reads.
      // Splitting on chunk boundaries would drop or corrupt whichever event
      // happened to straddle one, and it would do it intermittently.
      const whole = textChunk('half and half', 'stop')
      const cut = Math.floor(whole.length / 2)
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [whole.slice(0, cut), whole.slice(cut), DONE] }),
      )
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.data.text).toBe('half and half')
    })

    it('stops at [DONE] and ignores anything after it', async () => {
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('answer', 'stop'), DONE, textChunk(' and more')] }),
      )
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.data.text).toBe('answer')
    })
  })

  describe('the failures it types rather than throws', () => {
    it('maps 401 and 403 to unauthorized', async () => {
      for (const status of [401, 403]) {
        const client = createOpenAiChatClient(CONFIG, fakeFetch({ status }))
        const outcome = await client.streamChat({
          messages: USER_TURN,
          maxOutputTokens: 2000,
          timeoutMs: 1000,
        })
        expect(outcome.ok).toBe(false)
        if (outcome.ok) return
        expect(outcome.reason).toBe('unauthorized')
      }
    })

    it('maps a 5xx to unavailable', async () => {
      const client = createOpenAiChatClient(CONFIG, fakeFetch({ status: 503 }))
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('unavailable')
    })

    it('maps any other refusal to invalid_request — our bug, visible as ours', async () => {
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ status: 400, body: '{"error":{"message":"unknown parameter"}}' }),
      )
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('invalid_request')
      // The provider's own words never leave this module, exactly as the Stripe
      // adapter's do not.
      expect(outcome.detail).not.toContain('unknown parameter')
    })

    it('maps a network failure to unavailable instead of throwing', async () => {
      const client = createOpenAiChatClient(CONFIG, fakeFetch({ networkError: true }))
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('unavailable')
    })

    it('maps a socket that dies mid-stream to unavailable instead of throwing', async () => {
      // The head was already `200`, so this is the failure a naive adapter turns
      // into a rejected promise halfway through a handler that has already
      // written bytes to the client.
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('Traffic ')], errorAfterChunk: 1 }),
      )
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('unavailable')
    })

    it('maps an unparseable event to invalid_request', async () => {
      // Not skipped: an endpoint that answers `text/event-stream` with something
      // that is not our protocol is a configuration mistake, and silently
      // reading it as an empty answer would surface as "the assistant said
      // nothing".
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: ['data: not json at all\n\n', DONE] }),
      )
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 1000,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('invalid_request')
    })

    it('gives up on a hung stream at timeoutMs', async () => {
      // D7's backstop. `ASSISTANT_PROVIDER_TIMEOUT_MS` sits above the query
      // gateway's own deadline so a downstream's typed failure normally
      // surfaces first; this is what happens when nothing surfaces at all.
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('Traffic ')], hangAfterChunks: true }),
      )
      const started = Date.now()
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 40,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('unavailable')
      expect(outcome.detail).toContain('timed out')
      expect(Date.now() - started).toBeLessThan(5000)
    })

    it('lets the caller’s signal abort the provider call', async () => {
      // D10: closing the tab stops the generation rather than paying for tokens
      // nobody will read. The signal has to reach `fetch` itself — an adapter
      // that merely stopped reading would leave the provider generating.
      const captures: Capture[] = []
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('Traffic ')], hangAfterChunks: true }, captures),
      )
      const controller = new AbortController()
      const pending = client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 60_000,
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 10)

      const outcome = await pending
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('unavailable')
      expect(outcome.detail).toContain('aborted')
      expect(captures[0]?.init.signal).toBeInstanceOf(AbortSignal)
    })

    it('refuses immediately when the caller’s signal is already aborted', async () => {
      const client = createOpenAiChatClient(
        CONFIG,
        fakeFetch({ chunks: [textChunk('x', 'stop'), DONE] }),
      )
      const outcome = await client.streamChat({
        messages: USER_TURN,
        maxOutputTokens: 2000,
        timeoutMs: 60_000,
        signal: AbortSignal.abort(),
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('unavailable')
    })
  })
})
