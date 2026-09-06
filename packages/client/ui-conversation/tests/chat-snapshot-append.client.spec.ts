import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode, ConversationLocation, ConversationTimelineSnapshot } from '@neo/dsh-client-runtime/client'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

const timeline: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }

function location(turn?: number, step?: number): ConversationLocation {
  if (turn === undefined) return { kind: 'session' }
  const turnLocation = { turn, start: undefined, end: undefined, status: 'unknown', steps: [], data: () => undefined }
  if (step === undefined) return { kind: 'turn', turn: turnLocation as never }
  return { kind: 'step', turn: turnLocation as never, step: { turn, step, start: undefined, end: undefined, status: 'unknown', data: () => undefined } as never }
}

function node(key: string, anchorSeq: number, opts: { visibility?: 'visible' | 'hidden'; turn?: number; step?: number } = {}): ChatConversationViewNode {
  return {
    key, kind: 'test', id: key, target: 'chat', data: undefined,
    anchorSeq,
    visibility: opts.visibility ?? 'visible',
    location: location(opts.turn, opts.step),
  }
}

/** The same nodes through a full `replace`: the reference every incremental path must match. */
interface Reference {
  order: readonly string[]
  turn: (turn: number) => readonly string[]
  step: (turn: number, step: number) => readonly string[]
}

function reference(nodes: readonly ChatConversationViewNode[]): Reference {
  const builder = new ChatSnapshotBuilder()
  const snapshot = builder.replace({ nodes, timeline })
  return { order: snapshot.order, turn: t => snapshot.locations.getTurn(t), step: (t, s) => snapshot.locations.getStep(t, s) }
}

function expectSame(builder: ChatSnapshotBuilder, all: Map<string, ChatConversationViewNode>): void {
  const expected = reference([...all.values()])
  const actual = builder.apply({ upserts: [], timeline })
  expect(actual.order).toEqual(expected.order)
  for (const turn of [1, 2, 3]) {
    expect(actual.locations.getTurn(turn)).toEqual(expected.turn(turn))
    for (const step of [1, 2]) expect(actual.locations.getStep(turn, step)).toEqual(expected.step(turn, step))
  }
}

/** A builder plus a `push` that applies a batch and checks it against a full rebuild. */
function growing(): { builder: ChatSnapshotBuilder; push: (...nodes: ChatConversationViewNode[]) => void } {
  const builder = new ChatSnapshotBuilder()
  const all = new Map<string, ChatConversationViewNode>()
  return {
    builder,
    push: (...nodes) => {
      for (const item of nodes) all.set(item.key, item)
      builder.apply({ upserts: nodes, timeline })
      expectSame(builder, all)
    },
  }
}

describe('ChatSnapshotBuilder append fast path', () => {
  it('extends the order for new tail nodes and matches a full rebuild', () => {
    const { builder, push } = growing()
    push(node('a', 1, { turn: 1, step: 1 }), node('b', 2, { turn: 1, step: 1 }))
    const before = builder.apply({ upserts: [], timeline })
    // The index is live, so capture the group references before growing it.
    const step11 = before.locations.getStep(1, 1)
    const step12 = before.locations.getStep(1, 2)
    // Tail growth: new keys, later anchors, out of order inside the batch.
    push(node('d', 5, { turn: 1, step: 2 }), node('c', 4, { turn: 1, step: 2 }), node('hidden', 6, { visibility: 'hidden', turn: 2 }))
    const after = builder.apply({ upserts: [], timeline })
    // Untouched groups keep their identity; the grown ones are new references.
    expect(after.locations.getStep(1, 1)).toBe(step11)
    expect(after.locations.getStep(1, 2)).not.toBe(step12)
    expect(after.order).toEqual(['a', 'b', 'c', 'd'])
  })

  it('falls back to the full sort when a node moves, becomes visible, or lands before the tail', () => {
    const { builder, push } = growing()
    push(node('a', 1, { turn: 1, step: 1 }), node('c', 3, { turn: 1, step: 1 }))
    // A new node that sorts before the tail.
    push(node('b', 2, { turn: 1, step: 1 }))
    // An equal anchor whose key sorts before the tail's.
    push(node('bb', 3, { turn: 1, step: 1 }))
    // An existing node moving to a later anchor and another one hidden.
    push(node('a', 9, { turn: 2, step: 1 }), node('c', 3, { visibility: 'hidden', turn: 1, step: 1 }))
    // A hidden node becoming visible again.
    push(node('c', 3, { turn: 1, step: 1 }))
    // Content-only updates leave the order alone.
    push({ ...node('b', 2, { turn: 1, step: 1 }), data: 'changed' })
    expect(builder.apply({ upserts: [], timeline }).order).toEqual(['b', 'bb', 'c', 'a'])
  })

  it('appends to an empty builder and to nodes without a location', () => {
    const { builder, push } = growing()
    push(node('session-scoped', 1))
    push(node('turn-scoped', 2, { turn: 3 }))
    push(node('step-scoped', 3, { turn: 3, step: 1 }))
    expect(builder.apply({ upserts: [], timeline }).locations.getTurn(3)).toEqual(['turn-scoped', 'step-scoped'])
  })
})
