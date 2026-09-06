import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@neo/dsh-llm'
import type { UserMessage } from '@neo/dsh-llm'
import {
  deriveBrowserTimeZoneContext,
  renderBrowserTimeZoneContext,
} from '../src/request-zone.ts'

function browserMessage(timeZone: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: timeZone }],
    source: { kind: 'user', rpcId: `rpc-${timeZone}`, clientTimeZone: timeZone } as never,
  })
}

describe('browser request-zone context', () => {
  it('derives missing, unique, and sorted mixed zones from user-rpc messages only', () => {
    const plugin = createUserMessage({
      content: [{ type: 'text', text: 'plugin' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    expect(deriveBrowserTimeZoneContext([plugin])).toEqual({ kind: 'missing' })
    expect(deriveBrowserTimeZoneContext([
      browserMessage('Asia/Shanghai'),
      browserMessage('Asia/Shanghai'),
    ])).toEqual({ kind: 'resolved', timeZone: 'Asia/Shanghai' })
    expect(deriveBrowserTimeZoneContext([
      browserMessage('Asia/Shanghai'),
      browserMessage('America/New_York'),
    ])).toEqual({
      kind: 'mixed',
      timeZones: ['America/New_York', 'Asia/Shanghai'],
    })
  })

  it('degrades a malformed, unsupported, or non-canonical zone to no contribution instead of throwing', () => {
    // A lone nonconforming zone folds into 'missing' — never throws (the live
    // turn must not fail over one nonconforming client message).
    expect(deriveBrowserTimeZoneContext([browserMessage('+08:00')])).toEqual({ kind: 'missing' })
    expect(deriveBrowserTimeZoneContext([browserMessage('Not/A_Real_Zone')])).toEqual({ kind: 'missing' })
    expect(deriveBrowserTimeZoneContext([browserMessage('Etc/UTC')])).toEqual({ kind: 'missing' })
  })

  it('keeps the valid zones of a turn when another message carries a nonconforming zone', () => {
    // One bad message must not corrupt or drop the turn's real zone.
    expect(deriveBrowserTimeZoneContext([
      browserMessage('Asia/Shanghai'),
      browserMessage('Not/A_Real_Zone'),
    ])).toEqual({ kind: 'resolved', timeZone: 'Asia/Shanghai' })
    expect(deriveBrowserTimeZoneContext([
      browserMessage('Asia/Shanghai'),
      browserMessage('+08:00'),
      browserMessage('America/New_York'),
    ])).toEqual({ kind: 'mixed', timeZones: ['America/New_York', 'Asia/Shanghai'] })
  })

  it('renders one explicit model policy for every context', () => {
    expect(renderBrowserTimeZoneContext({ kind: 'resolved', timeZone: 'Asia/Shanghai' }))
      .toContain('Interpret otherwise-unqualified dates and times in this zone.')
    expect(renderBrowserTimeZoneContext({
      kind: 'mixed', timeZones: ['America/New_York', 'Asia/Shanghai'],
    })).toContain('mixed ["America/New_York","Asia/Shanghai"]')
    expect(renderBrowserTimeZoneContext({ kind: 'missing' })).toContain('unavailable')
  })
})
