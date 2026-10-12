// Phase 5 measurement, not a test: per-token cost of the token meter's
// session/event follower as the log grows.
// Run: npx tsx packages/llm/token-meter/tests/bench-follow.mts [steps] [tokens]
import { performance } from 'node:perf_hooks'
import { Context } from '@neo/cordis'
import { createMessage, createUserMessage } from '@neo/llm'
import SessionStore, { SessionId } from '@neo/session'
import TokenMeter from '@neo/token-meter'

const STEPS = Number(process.argv[2] ?? 400)
const TOKENS = Number(process.argv[3] ?? 200)

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(TokenMeter)
const session = ctx.sessions.create(SessionId('bench-follow'))
// Prime the meter so its session/event follower is active for this session.
session.append('turn/start', { turn: 1 })
session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
ctx.tokenMeter.measure(session)

let turn = 1
for (let s = 1; s <= STEPS; s++) {
  const step = ((s - 1) % 20) + 1
  if (step === 1 && s > 1) {
    turn += 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  session.append('step/start', { turn, step })
  const started = performance.now()
  for (let i = 0; i < TOKENS; i++) {
    session.append('assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text: 'tok ' } })
  }
  const perToken = (performance.now() - started) / TOKENS
  session.append('assistant/message', {
    turn, step,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'tok '.repeat(TOKENS) }], source: { kind: 'model', provider: 'p', model: 'm' } }),
    usage: { inputTokens: 100, outputTokens: TOKENS },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
  if (step === 20) session.append('turn/end', { turn, reason: { kind: 'completed' } })
  if (s % 100 === 0 || s === STEPS) console.log(`log=${String(session.seq).padStart(7)} events  ${(perToken * 1000).toFixed(1)} µs/token`)
}
await ctx.fiber.dispose()
