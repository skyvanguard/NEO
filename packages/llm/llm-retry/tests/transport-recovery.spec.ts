import { createUserMessage } from '@neo/llm'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@neo/cordis'
import type { Agent } from '@neo/agent'
import AgentLoop from '@neo/agent-loop'
import { mountAgentLoopTestDependencies } from '@neo/agent-loop-testkit'
import * as LlmPiAi from '@neo/llm-pi-ai'
import type { MockLlmBehavior, MockLlmServer } from '@neo/llm-mock-server'
import { startMockLlmServer } from '@neo/llm-mock-server'
import { SessionId } from '@neo/session'
import * as Retry from '../src/index.ts'

let context: Context | undefined
const servers: MockLlmServer[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(servers.splice(0).map(server => server.close()))
  vi.unstubAllEnvs()
})

async function start(
  sequence: readonly MockLlmBehavior[],
  options: Omit<Parameters<typeof startMockLlmServer>[0], 'sequence'> = {},
): Promise<MockLlmServer> {
  const server = await startMockLlmServer({ sequence, ...options })
  servers.push(server)
  return server
}

/** The hand-declared OpenAI-compatible route every case drives. */
const PROVIDER = 'mock-gateway'
const MODEL = 'mock-model'

async function harness(
  baseURL: string,
  options: { streamIdleTimeoutMs?: number; initialDelayMs?: number } = {},
): Promise<Context> {
  vi.stubEnv('MOCK_LLM_API_KEY', 'mock-key')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LlmPiAi, {
    providers: {
      [PROVIDER]: {
        api: 'openai-completions',
        baseURL,
        apiKeyEnv: 'MOCK_LLM_API_KEY',
        models: [{ id: MODEL }],
        streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 1_000,
        retryPolicy: {
          mode: 'normal',
          maxRetries: 2,
          backoff: {
            initialDelayMs: options.initialDelayMs ?? 10,
            maxDelayMs: options.initialDelayMs ?? 10,
            jitterRatio: 0,
          },
        },
      },
    },
  })
  await ctx.plugin(Retry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function sendAndWait(ctx: Context, agent: Agent): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover through the provider boundary' }], source: { kind: 'user' } }))
  return idle
}

function finalAssistantText(agent: Agent): string | undefined {
  const message = agent.session.deriveMessages().at(-1)
  if (message?.role !== 'assistant') return undefined
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Text the failed attempt streamed before its retry: logged as chunks, never committed. */
function failedAttemptText(agent: Agent): string[] {
  const retry = agent.session.events.find(event => event.type === 'llm/retry')
  if (retry === undefined) return []
  return agent.session.events.flatMap(event =>
    event.type === 'assistant/chunk' && event.seq < retry.seq && event.data.chunk.type === 'text-delta'
      ? [event.data.chunk.text]
      : [])
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

describe('bounded retry through the real pi-ai OpenAI-compatible adapter', () => {
  it('recovers from a true refused connection after the endpoint starts during backoff', async () => {
    const port = await unusedPort()
    context = await harness(`http://127.0.0.1:${port}`, { initialDelayMs: 100 })
    const agent = context.agentLoop.create(SessionId('wire-refused'), { provider: PROVIDER, model: MODEL })
    let recoveryServer: Promise<MockLlmServer> | undefined
    context.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'llm/retry' || event.data.retry !== 1) return
      recoveryServer = start(['success'], { port, apiKey: 'mock-key', successText: 'connected after retry' })
    })

    await sendAndWait(context, agent)
    const server = await recoveryServer

    expect(server).toBeDefined()
    expect(server?.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'step/start')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[1, 1]])
    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TRANSPORT'])
    expect(finalAssistantText(agent)).toBe('connected after retry')
  })

  it.each([
    ['stream_disconnect', []] as const,
    ['partial_disconnect', ['discard me']] as const,
  ])('retries %s without committing failed chunks', async (behavior, failedText) => {
    const server = await start([behavior, 'success'], {
      apiKey: 'mock-key',
      partialText: 'discard me',
      chunkSize: 100,
      disconnectDelayMs: 20,
      successText: 'recovered response',
    })
    context = await harness(server.baseURL)
    const agent = context.agentLoop.create(SessionId(`wire-${behavior}`), { provider: PROVIDER, model: MODEL })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]?.body).toEqual(server.requests[1]?.body)
    expect(failedAttemptText(agent)).toEqual(failedText)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[1, 1]])
    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TRANSPORT'])
    expect(finalAssistantText(agent)).toBe('recovered response')
  })

  it('retries a wire-valid content-less completion without committing an empty message', async () => {
    const server = await start(['empty', 'success'], {
      apiKey: 'mock-key',
      successText: 'recovered from empty',
    })
    context = await harness(server.baseURL)
    const agent = context.agentLoop.create(SessionId('wire-empty'), { provider: PROVIDER, model: MODEL })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]?.body).toEqual(server.requests[1]?.body)
    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['EMPTY_RESPONSE'])
    expect(agent.session.events.filter(event => event.type === 'assistant/message')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[1, 1]])
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    expect(finalAssistantText(agent)).toBe('recovered from empty')
  })

  it('retries a clean partial EOF as a transport truncation without committing its text', async () => {
    const server = await start(['partial_eof', 'success'], {
      apiKey: 'mock-key',
      partialText: 'discarded clean eof',
      chunkSize: 100,
      successText: 'recovered after eof',
    })
    context = await harness(server.baseURL)
    const agent = context.agentLoop.create(SessionId('wire-partial-eof'), { provider: PROVIDER, model: MODEL })

    await sendAndWait(context, agent)

    // The wire closed cleanly but without a finish_reason, so the response is
    // truncated rather than complete: the adapter reports it as TRANSPORT.
    expect(server.requests).toHaveLength(2)
    expect(failedAttemptText(agent)).toEqual(['discarded clean eof'])
    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TRANSPORT'])
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(finalAssistantText(agent)).toBe('recovered after eof')
  })

  it('ends the turn on a non-default-retryable failure without retrying or committing', async () => {
    const server = await start(['malformed_json', 'success'], { apiKey: 'mock-key' })
    context = await harness(server.baseURL)
    const agent = context.agentLoop.create(SessionId('wire-malformed'), { provider: PROVIDER, model: MODEL })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(false)
    expect(agent.session.events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'PI_AI_ERROR' } } },
    })
  })

  it('turns a stalled body into TIMEOUT and succeeds on the next request', async () => {
    const server = await start(['stall', 'success'], {
      apiKey: 'mock-key',
      successText: 'recovered after timeout',
    })
    // This crosses the real HTTP idle timer, so leave scheduler slack between
    // the stalled attempt and the mock server's immediate successful response.
    context = await harness(server.baseURL, { streamIdleTimeoutMs: 1_000 })
    const agent = context.agentLoop.create(SessionId('wire-stall'), { provider: PROVIDER, model: MODEL })

    await sendAndWait(context, agent)

    expect(server.requests.map(record => record.behavior)).toEqual(['stall', 'success'])
    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TIMEOUT'])
    expect(finalAssistantText(agent)).toBe('recovered after timeout')
  }, 10_000)

  it('stops after the configured transport retry budget is exhausted', async () => {
    const server = await start(['connection_reset', 'connection_reset', 'connection_reset'], {
      apiKey: 'mock-key',
    })
    context = await harness(server.baseURL)
    const agent = context.agentLoop.create(SessionId('wire-exhausted'), { provider: PROVIDER, model: MODEL })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(3)
    expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'TRANSPORT' } } },
    })
  })
})
