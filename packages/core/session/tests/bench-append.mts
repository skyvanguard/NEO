// Phase 5 measurement, not a test: cost of one streamed token's session
// append as the log grows. Run: npx tsx packages/core/session/tests/bench-append.mts
import { performance } from 'node:perf_hooks'
import { Session, SessionId } from '../src/index.ts'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const session = Session.create(SessionId('bench'))
const STEPS = Number(process.argv[2] ?? 400)
const TOKENS = Number(process.argv[3] ?? 200)

function step(turn: number, stepIndex: number, readEvents: boolean): number {
  session.append('step/start', { turn, step: stepIndex })
  const started = performance.now()
  for (let i = 0; i < TOKENS; i++) {
    session.append('assistant/chunk', { turn, step: stepIndex, chunk: { type: 'text-delta', index: 0, text: 'tok ' } })
    // A consumer that reads the full snapshot after each append pays the rebuild.
    if (readEvents) void session.events.length
  }
  const perToken = (performance.now() - started) / TOKENS
  session.append('assistant/message', {
    turn, step: stepIndex,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'tok '.repeat(TOKENS) }], source: { kind: 'model', provider: 'p', model: 'm' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: stepIndex })
  return perToken
}

for (const readEvents of [false, true]) {
  const fresh = Session.create(SessionId(`bench-${readEvents ? 'read' : 'append'}`))
  Object.assign(session, {})
  let turn = 0
  const samples: [number, number][] = []
  for (let s = 1; s <= STEPS; s++) {
    if ((s - 1) % 20 === 0) { turn += 1; fresh.append('turn/start', { turn }); fresh.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' }) }
    fresh.append('step/start', { turn, step: ((s - 1) % 20) + 1 })
    const started = performance.now()
    for (let i = 0; i < TOKENS; i++) {
      fresh.append('assistant/chunk', { turn, step: ((s - 1) % 20) + 1, chunk: { type: 'text-delta', index: 0, text: 'tok ' } })
      if (readEvents) void fresh.events.length
    }
    const perToken = (performance.now() - started) / TOKENS
    fresh.append('assistant/message', {
      turn, step: ((s - 1) % 20) + 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'tok '.repeat(TOKENS) }], source: { kind: 'model', provider: 'p', model: 'm' } }),
    }, { surfaceOp: 'append' })
    fresh.append('step/end', { turn, step: ((s - 1) % 20) + 1 })
    if (s % 20 === 0) fresh.append('turn/end', { turn, reason: { kind: 'completed' } })
    if (s % 100 === 0 || s === STEPS) samples.push([fresh.seq, perToken])
  }
  console.log(readEvents ? '\nappend + read session.events after each token:' : 'append only:')
  for (const [events, perToken] of samples) console.log(`  log=${String(events).padStart(7)} events  ${(perToken * 1000).toFixed(1)} µs/token`)
}
void step
