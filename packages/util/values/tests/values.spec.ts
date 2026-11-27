import { describe, expect, it } from 'vitest'
import { assertNever, deepEqualJson } from '../src/index.ts'

describe('assertNever', () => {
  it('throws with the JSON rendering of the escaped value', () => {
    expect(() => assertNever({ kind: 'surprise', n: 1 } as never))
      .toThrow(new Error('unreachable variant: {"kind":"surprise","n":1}'))
  })

  it('names the switch site when a context label is given', () => {
    expect(() => assertNever('extra' as never, 'compaction trigger'))
      .toThrow(new Error('unreachable variant in compaction trigger: "extra"'))
  })

  it('omits the switch site for an empty context label', () => {
    expect(() => assertNever(7 as never, '')).toThrow(new Error('unreachable variant: 7'))
  })

  it('falls back to String() for values JSON cannot render', () => {
    expect(() => assertNever(undefined as never)).toThrow(new Error('unreachable variant: undefined'))
    expect(() => assertNever(Symbol('tag') as never, 'symbol site'))
      .toThrow(new Error('unreachable variant in symbol site: Symbol(tag)'))
  })
})

describe('deepEqualJson', () => {
  it('treats identical primitives and the same reference as equal', () => {
    const shared = { a: [1] }
    expect(deepEqualJson(shared, shared)).toBe(true)
    expect(deepEqualJson('x', 'x')).toBe(true)
    expect(deepEqualJson(null, null)).toBe(true)
  })

  it('treats different primitives, and a primitive against an object, as unequal', () => {
    expect(deepEqualJson(1, 2)).toBe(false)
    expect(deepEqualJson(1, '1')).toBe(false)
    expect(deepEqualJson('a', { a: 1 })).toBe(false)
    expect(deepEqualJson({ a: 1 }, 'a')).toBe(false)
  })

  it('treats null as unequal to an empty object or array on either side', () => {
    expect(deepEqualJson(null, {})).toBe(false)
    expect(deepEqualJson({}, null)).toBe(false)
    expect(deepEqualJson(null, [])).toBe(false)
    expect(deepEqualJson([], null)).toBe(false)
  })

  it('compares arrays element by element and in order', () => {
    expect(deepEqualJson([1, 'two', [3, { four: 4 }]], [1, 'two', [3, { four: 4 }]])).toBe(true)
    expect(deepEqualJson([], [])).toBe(true)
    expect(deepEqualJson([1, 2], [2, 1])).toBe(false)
    expect(deepEqualJson([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqualJson([[1]], [[2]])).toBe(false)
  })

  it('never equates an array with an object, even an index-keyed one', () => {
    expect(deepEqualJson([], {})).toBe(false)
    expect(deepEqualJson({}, [])).toBe(false)
    expect(deepEqualJson(['a'], { 0: 'a' })).toBe(false)
    expect(deepEqualJson({ 0: 'a' }, ['a'])).toBe(false)
  })

  it('compares objects by key set and values, ignoring key order', () => {
    expect(deepEqualJson({ a: 1, b: { c: [true, null] } }, { b: { c: [true, null] }, a: 1 })).toBe(true)
    expect(deepEqualJson({}, {})).toBe(true)
    expect(deepEqualJson({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqualJson({ a: 1, b: 2 }, { a: 1 })).toBe(false)
    expect(deepEqualJson({ a: 1 }, { b: 1 })).toBe(false)
    expect(deepEqualJson({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false)
  })
})
