import { createUserMessage } from '@neo/llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@neo/cordis'
import LlmRuntime from '@neo/llm'
import * as LlmPiAi from '@neo/llm-pi-ai'
import { startMockLlmServer } from '@neo/llm-mock-server'
import type { MockLlmServer } from '@neo/llm-mock-server'
import SessionStore, { SessionId } from '@neo/session'
import SessionTitleService from '@neo/session-title'
import * as FirstMessageTitleProvider from '@neo/session-title-first-prompt-llm'

const contexts: Context[] = []
const servers: MockLlmServer[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => server.close()))
  vi.unstubAllEnvs()
})

describe('first-prompt title provider over a real OpenAI-compatible HTTP adapter', () => {
  it('replaces the fallback with a short model title', async () => {
    const server = await startMockLlmServer({
      sequence: ['success'],
      apiKey: 'mock-key',
      successText: 'Durable append-only session titles',
    })
    servers.push(server)
    vi.stubEnv('MOCK_LLM_API_KEY', 'mock-key')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        'neo-default-route': {
          api: 'openai-completions',
          baseURL: server.baseURL,
          apiKeyEnv: 'MOCK_LLM_API_KEY',
          models: [{ id: 'neo-default-model' }],
        },
      },
    })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, {
      fallbackMaxWords: 5,
      fallbackMaxBytes: 40,
      maxTitleBytes: 80,
    })
    await ctx.plugin(FirstMessageTitleProvider, {
      targetWords: 5,
      targetCjkCharacters: 10,
      maxInputBytes: 4_096,
      maxOutputTokens: 64,
      timeoutMs: 60_000,
      provider: 'neo-default-route',
      model: 'neo-default-model',
    })
    const session = ctx.sessions.create(SessionId('real-title-provider'))
    session.append('turn/start', {
      turn: 1,
    })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Explain why append-only logs make session titles durable.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const title = await ctx.sessionTitle.refresh(session)

    expect(title).toMatchObject({
      messageSeqs: [message.seq],
      source: {
        kind: 'provider',
        provider: 'session-title-first-prompt-llm',
        model: { provider: 'neo-default-route', model: 'neo-default-model' },
      },
    })
    expect(title?.title).toBe('Durable append-only session titles')
    expect(server.requests).toHaveLength(1)
  })
})
