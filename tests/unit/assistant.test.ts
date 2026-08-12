import { assistantConfigSchema, loadAssistantConfig } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The assistant's bounds (ADR-0046 D5 and D7).
 *
 * Every number here is a named environment default rather than a literal in a
 * handler, and that is F-306's requirement rather than a style preference: the
 * question limit is expected to be re-asked per plan, and a `20` written into
 * the code would satisfy the sentence while defeating its purpose.
 *
 * None of the six bounds in D7 is measured. The ADR says so out loud and this
 * file does not pretend otherwise — what is asserted is that a default exists,
 * that it is wide enough not to constrain an ordinary question, and that the
 * values a deployment could set which would break the surface are refused.
 */

describe('the assistant configuration', () => {
  it('defaults to F-306’s twenty questions and to the model it names', () => {
    const config = assistantConfigSchema.parse({})
    expect(config.ASSISTANT_DAILY_QUESTION_LIMIT).toBe(20)
    expect(config.ASSISTANT_MODEL).toBe('gpt-5.5')
    expect(config.OPENAI_BASE_URL).toBe('https://api.openai.com')
  })

  it('defaults every D7 bound rather than leaving one unset', () => {
    const config = assistantConfigSchema.parse({})
    expect(config.ASSISTANT_MAX_MESSAGES).toBe(20)
    expect(config.ASSISTANT_MAX_MESSAGE_CHARS).toBe(4000)
    expect(config.ASSISTANT_MAX_PAYLOAD_BYTES).toBe(32_000)
    expect(config.ASSISTANT_MAX_TOOL_ITERATIONS).toBe(8)
    // Halved from 2,000 (2026-08-09): live answers ran essay-length.
    expect(config.ASSISTANT_MAX_OUTPUT_TOKENS).toBe(1000)
    expect(config.ASSISTANT_PROVIDER_TIMEOUT_MS).toBe(60_000)
  })

  it('reads every bound from the environment, so a deployment can move it', () => {
    const config = loadAssistantConfig({
      ASSISTANT_DAILY_QUESTION_LIMIT: '5',
      ASSISTANT_MAX_MESSAGES: '4',
      ASSISTANT_MAX_MESSAGE_CHARS: '100',
      ASSISTANT_MAX_PAYLOAD_BYTES: '2048',
      ASSISTANT_MAX_TOOL_ITERATIONS: '2',
      ASSISTANT_MAX_OUTPUT_TOKENS: '64',
      ASSISTANT_PROVIDER_TIMEOUT_MS: '5000',
      ASSISTANT_MODEL: 'gpt-5.5-mini',
      OPENAI_BASE_URL: 'https://gateway.internal.test',
    })
    expect(config).toMatchObject({
      ASSISTANT_DAILY_QUESTION_LIMIT: 5,
      ASSISTANT_MAX_MESSAGES: 4,
      ASSISTANT_MAX_MESSAGE_CHARS: 100,
      ASSISTANT_MAX_PAYLOAD_BYTES: 2048,
      ASSISTANT_MAX_TOOL_ITERATIONS: 2,
      ASSISTANT_MAX_OUTPUT_TOKENS: 64,
      ASSISTANT_PROVIDER_TIMEOUT_MS: 5000,
      ASSISTANT_MODEL: 'gpt-5.5-mini',
      OPENAI_BASE_URL: 'https://gateway.internal.test',
    })
  })

  it('tolerates an absent provider key — unset is "unconfigured", not invalid', () => {
    // D6: the routes mount on every deployment and say what is wrong when the
    // provider is not configured. A schema that required the key would make the
    // api refuse to boot over a feature an operator has not enabled, which is
    // the opposite of every other credential in this repository.
    expect(assistantConfigSchema.parse({}).OPENAI_API_KEY).toBeUndefined()
    expect(loadAssistantConfig({ OPENAI_API_KEY: 'sk-test-123' }).OPENAI_API_KEY).toBe(
      'sk-test-123',
    )
  })

  it('refuses a question limit of zero: "off" is an unconfigured provider, not a limit of none', () => {
    // Zero would leave the endpoint mounted, advertising itself, and refusing
    // every question with a `Retry-After` that never comes true.
    expect(() => assistantConfigSchema.parse({ ASSISTANT_DAILY_QUESTION_LIMIT: '0' })).toThrow()
  })

  it('refuses bounds that would make the surface unusable', () => {
    // A zero iteration ceiling means the model may never call a tool, which is
    // the whole surface; a zero output ceiling means it may never answer; a
    // zero message cap means no question fits.
    expect(() => assistantConfigSchema.parse({ ASSISTANT_MAX_TOOL_ITERATIONS: '0' })).toThrow()
    expect(() => assistantConfigSchema.parse({ ASSISTANT_MAX_OUTPUT_TOKENS: '0' })).toThrow()
    expect(() => assistantConfigSchema.parse({ ASSISTANT_MAX_MESSAGES: '0' })).toThrow()
    expect(() => assistantConfigSchema.parse({ ASSISTANT_MAX_MESSAGE_CHARS: '0' })).toThrow()
  })

  it('refuses a base URL that is not one', () => {
    // The adapter builds `${baseUrl}/v1/chat/completions` and sends a
    // spend-capable credential to it. A value that is not a URL would be a
    // request to somewhere nobody chose.
    expect(() => assistantConfigSchema.parse({ OPENAI_BASE_URL: 'api.openai.com' })).toThrow()
  })

  it('refuses a model name that is empty', () => {
    expect(() => assistantConfigSchema.parse({ ASSISTANT_MODEL: '' })).toThrow()
  })
})
