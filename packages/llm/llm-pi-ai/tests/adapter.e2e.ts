import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@neo/cordis'
import LlmRuntime, { createUserMessage, CallId, ReasoningEffortId  } from '@neo/llm'
import type { Message, ToolSchema } from '@neo/llm'
import * as LlmPiAi from '@neo/llm-pi-ai'
import type { PiAiProviderProfile } from '@neo/llm-pi-ai'
import { assemble, type AssembledResult } from './assemble.ts'

/**
 * Real-API e2e for the pi-ai-backed adapter over pi-ai's `zai` catalog
 * route: GLM-4.7 + GLM-5.2 with provider defaults and representative
 * off/high/max reasoning, plus a replayed tool follow-up. Key-gated on
 * ZAI_API_KEY; ZAI_BASE_URL optionally overrides the catalog endpoint.
 */

const STANDARD = 'glm-4.7'
/** The catalog entry whose thinking-level map offers `max`. */
const FLAGSHIP = 'glm-5.2'
const contexts: Context[] = []

async function harness(_model: string, config: Partial<PiAiProviderProfile> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      zai: {
        ...process.env.ZAI_API_KEY === undefined ? {} : { apiKey: process.env.ZAI_API_KEY },
        ...process.env.ZAI_BASE_URL === undefined ? {} : { baseURL: process.env.ZAI_BASE_URL },
        ...config,
      },
    },
  })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function ask(text: string): Message[] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })]
}

function textOf(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

const weatherTool: ToolSchema = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}

describe.skipIf(!process.env.ZAI_API_KEY)('llm-pi-ai e2e (real API)', () => {
  it.each([STANDARD, FLAGSHIP])('%s + provider-default reasoning: plain text generation', async (model) => {
    const ctx = await harness(model)
    const result = await assemble(ctx,{
      model,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
  })

  it('standard + reasoning off: plain text without reasoning blocks', async () => {
    const ctx = await harness(STANDARD)
    const result = await assemble(ctx,{
      model: STANDARD,
      reasoningEffort: ReasoningEffortId('off'),
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(false)
    expect(textOf(result).toLowerCase()).toContain('pong')
  })

  it.each([STANDARD, FLAGSHIP])('%s + reasoning high: reasoning blocks present', async (model) => {
    const ctx = await harness(model)
    const result = await assemble(ctx,{
      model,
      reasoningEffort: ReasoningEffortId('high'),
      messages: ask('Which is larger, 9.11 or 9.8? Answer with just the number.'),
      maxTokens: 2000,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(true)
    expect(textOf(result)).toContain('9.8')
  })

  it('flagship + reasoning max: tool-call round trip', async () => {
    const ctx = await harness(FLAGSHIP)

    const first = await assemble(ctx,{
      model: FLAGSHIP,
      reasoningEffort: ReasoningEffortId('max'),
      messages: ask('What is the weather in Paris right now? Use the get_weather tool.'),
      tools: [weatherTool],
      maxTokens: 2000,
    })
    expect(first.finish.kind).toBe('tool-calls')
    const call = first.message.content.find(block => block.type === 'tool-call')
    expect(call).toBeDefined()
    expect(call!.name).toBe('get_weather')
    expect(JSON.parse(call!.arguments)).toMatchObject({ city: expect.stringMatching(/paris/i) as string })

    const second = await assemble(ctx,{
      model: FLAGSHIP,
      reasoningEffort: ReasoningEffortId('max'),
      messages: [
        ...ask('What is the weather in Paris right now? Use the get_weather tool.'),
        first.message,
        createUserMessage({
          content: [{
            type: 'tool-result',
            toolCallId: CallId(call!.id),
            content: [{ type: 'text', text: 'Sunny, 22°C' }],
          }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
      tools: [weatherTool],
      maxTokens: 2000,
    })
    expect(second.finish.kind).toBe('stop')
    expect(textOf(second).toLowerCase()).toMatch(/sunny|22/)
  })
})
