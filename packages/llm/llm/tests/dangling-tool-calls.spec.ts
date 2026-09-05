import { describe, expect, it } from 'vitest'
import { CallId } from '../src/brand.ts'
import { createMessage, createToolResultMessage, createUserMessage } from '../src/message.ts'
import type { Message } from '../src/types.ts'
import { closeDanglingToolCalls, TOOL_RESULT_MISSING } from '../src/dangling-tool-calls.ts'

const source = { kind: 'plugin', plugin: 'test' } as const

function assistant(...callIds: string[]): Message {
  return createMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling' },
      ...callIds.map(id => ({ type: 'tool-call' as const, id: CallId(id), name: 'f', arguments: '{}' })),
    ],
    source,
  })
}

function result(id: string): Message {
  return createToolResultMessage({ callId: CallId(id), content: [{ type: 'text', text: 'ok' }], isError: false })
}

describe('closeDanglingToolCalls', () => {
  it('returns the same array when every tool call has a result', () => {
    const history = [assistant('a', 'b'), result('a'), result('b'), createUserMessage({ content: [{ type: 'text', text: 'next' }], source })]
    expect(closeDanglingToolCalls(history)).toBe(history)
  })

  it('inserts an error result right after the assistant for each call that never got one', () => {
    const history = [assistant('a', 'b'), result('b'), createUserMessage({ content: [{ type: 'text', text: 'continue' }], source })]
    const closed = closeDanglingToolCalls(history)
    expect(closed).toHaveLength(4)
    expect(closed[0]).toBe(history[0])
    expect(closed[1]).toMatchObject({
      role: 'user',
      source: { kind: 'tool', callId: 'a' },
      content: [{ type: 'tool-result', toolCallId: 'a', isError: true }],
    })
    expect(closed[1]?.content[0]).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining(TOOL_RESULT_MISSING) as string }],
    })
    expect(closed[2]).toBe(history[1])
    expect(closed[3]).toBe(history[2])
  })

  it('closes calls left open at the end of the history', () => {
    const closed = closeDanglingToolCalls([assistant('a')])
    expect(closed.map(message => message.role)).toEqual(['assistant', 'user'])
  })

  it('does not let a result after a later assistant satisfy an earlier call', () => {
    const closed = closeDanglingToolCalls([assistant('a'), assistant('b'), result('a'), result('b')])
    expect(closed.map(message => message.source.kind === 'tool' ? message.source.callId : message.role)).toEqual([
      'assistant', 'a', 'assistant', 'a', 'b',
    ])
  })
})
