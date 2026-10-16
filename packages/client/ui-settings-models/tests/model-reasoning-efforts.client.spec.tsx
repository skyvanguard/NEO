// @vitest-environment jsdom
/** Reasoning levels of hand-declared pi-ai models: echo, level rows, API values, and placement. */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelDraft } from '../src/client/ModelListEditor.tsx'
import { ModelReasoningEfforts } from '../src/client/ModelReasoningEfforts.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

/** Render the controlled group over local state, reporting every write. */
function renderGroup(initial: ModelDraft, options: { disabled?: boolean } = {}) {
  const writes: ModelDraft[] = []
  function Harness() {
    const [model, setModel] = useState(initial)
    return (
      <ModelReasoningEfforts
        model={model} position={1} disabled={options.disabled ?? false} t={t}
        onChange={(next) => { writes.push(next); setModel(next) }}
      />
    )
  }
  render(<Harness />)
  return { writes, efforts: () => writes.at(-1)?.['reasoningEfforts'] }
}

const toggle = () => screen.getByRole('switch', { name: `${en.modelReasoning} 1` })
const levels = () => screen.queryAllByRole<HTMLSelectElement>('combobox').map(select => select.value)
const select = (row: number) => screen.getByRole<HTMLSelectElement>('combobox', { name: `${en.modelReasoningLevel} ${String(row)}` })
const value = (level: string) => screen.getByRole<HTMLInputElement>('textbox', { name: `${level} ${en.modelReasoningValue}` })
const remove = (level: string) => screen.getByRole<HTMLButtonElement>('button', { name: `${en.modelReasoningRemove} ${level}` })
const add = () => screen.getByRole<HTMLButtonElement>('button', { name: en.modelReasoningAdd })

describe('ModelReasoningEfforts', () => {
  it.each([
    ['absent', { id: 'chat' }],
    ['false', { id: 'chat', reasoningEfforts: false }],
  ])('shows a model whose field is %s as switched off without writing', (_label, model) => {
    const { writes } = renderGroup(model)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(en.modelReasoningOffHint)).toBeTruthy()
    expect(levels()).toEqual([])
    expect(writes).toEqual([])
  })

  it('echoes stored levels as rows with their API values', () => {
    renderGroup({ id: 'gateway', reasoningEfforts: { off: null, high: 'high', max: 'ultra' } })
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('button', { name: en.modelReasoningHelp })).toBeTruthy()
    expect(levels()).toEqual(['off', 'high', 'max'])
    expect(value('off').value).toBe('')
    expect(value('off').placeholder).toBe(en.modelReasoningOffValuePlaceholder)
    expect(value('off').disabled).toBe(true)
    expect(value('high').value).toBe('high')
    expect(value('max').value).toBe('ultra')
    // Each select offers its own level and the levels no other row uses.
    expect([...select(2).options].map(option => option.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('turns on with off, low, medium, and high while keeping other fields', () => {
    const { writes } = renderGroup({ id: 'chat', contextWindow: 131072, compat: { supportsDeveloperRole: false } })
    fireEvent.click(toggle())
    expect(writes.at(-1)).toEqual({
      id: 'chat', contextWindow: 131072, compat: { supportsDeveloperRole: false },
      reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
    })
    expect(levels()).toEqual(['off', 'low', 'medium', 'high'])
  })

  it('removes the field when switched off and restores the levels when switched back on', () => {
    const stored = { off: 'none', high: 'deep' }
    const { writes } = renderGroup({ id: 'chat', reasoningEfforts: stored })
    fireEvent.click(toggle())
    expect(writes[0]).toEqual({ id: 'chat' })
    fireEvent.click(toggle())
    expect(writes[1]).toEqual({ id: 'chat', reasoningEfforts: stored })
  })

  it('adds the next unused level above the highest row, then the lowest unused one', () => {
    const { efforts } = renderGroup({ id: 'chat', reasoningEfforts: { low: 'low', max: 'max' } })
    fireEvent.click(add())
    expect(levels()).toEqual(['low', 'max', 'off'])
    expect(efforts()).toEqual({ off: null, low: 'low', max: 'max' })
    fireEvent.click(add())
    expect(levels()).toEqual(['low', 'max', 'off', 'minimal'])
    expect(efforts()).toEqual({ off: null, minimal: 'minimal', low: 'low', max: 'max' })
  })

  it('stops adding once every level has a row', () => {
    renderGroup({ id: 'chat', reasoningEfforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' } })
    fireEvent.click(add())
    expect(levels()).toHaveLength(7)
    expect(add().disabled).toBe(true)
  })

  it('keeps the edited row in place and writes levels in escalation order', () => {
    const { efforts } = renderGroup({ id: 'chat', reasoningEfforts: { low: 'low', high: 'deep', max: 'max' } })
    fireEvent.change(select(1), { target: { value: 'xhigh' } })
    expect(levels()).toEqual(['xhigh', 'high', 'max'])
    expect(Object.entries(efforts() as object)).toEqual([['high', 'deep'], ['xhigh', 'xhigh'], ['max', 'max']])
    // A custom spelling moves between thinking levels, but not across off.
    fireEvent.change(select(2), { target: { value: 'medium' } })
    expect(efforts()).toEqual({ medium: 'deep', xhigh: 'xhigh', max: 'max' })
    fireEvent.change(select(2), { target: { value: 'off' } })
    expect(efforts()).toEqual({ off: null, xhigh: 'xhigh', max: 'max' })
    fireEvent.change(select(2), { target: { value: 'low' } })
    expect(efforts()).toEqual({ low: 'low', xhigh: 'xhigh', max: 'max' })
  })

  it('edits API values, sending the level name for a blank field and keeping a stored off value', () => {
    const { efforts } = renderGroup({ id: 'gateway', reasoningEfforts: { off: 'none', high: 'high' } })
    expect(value('off').value).toBe('none')
    expect(value('off').disabled).toBe(true)
    fireEvent.change(value('high'), { target: { value: ' deep ' } })
    expect(efforts()).toEqual({ off: 'none', high: 'deep' })
    fireEvent.change(value('high'), { target: { value: '' } })
    expect(value('high').value).toBe('')
    expect(efforts()).toEqual({ off: 'none', high: 'high' })
  })

  it('deletes a row and requires a level besides off', () => {
    const { efforts } = renderGroup({ id: 'chat', reasoningEfforts: { off: null, high: 'high' } })
    expect(screen.queryByText(en.modelReasoningNeedsLevel)).toBeNull()
    fireEvent.click(remove('high'))
    expect(levels()).toEqual(['off'])
    expect(efforts()).toEqual({ off: null })
    expect(screen.getByText(en.modelReasoningNeedsLevel)).toBeTruthy()
    fireEvent.click(remove('off'))
    expect(levels()).toEqual([])
    expect(efforts()).toEqual({})
  })

  it('disables every control while read-only or saving', () => {
    const { writes } = renderGroup({ id: 'chat', reasoningEfforts: { high: 'deep' } }, { disabled: true })
    expect((toggle() as HTMLButtonElement).disabled).toBe(true)
    expect(select(1).disabled).toBe(true)
    expect(value('high').disabled).toBe(true)
    expect(remove('high').disabled).toBe(true)
    expect(add().disabled).toBe(true)
    toggle().click()
    remove('high').click()
    add().click()
    expect(writes).toEqual([])
  })
})
