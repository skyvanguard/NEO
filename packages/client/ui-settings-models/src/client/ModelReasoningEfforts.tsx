/** Reasoning-level declarations for a model on a hand-declared pi-ai route. */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconPlusOutline16, IconTrashOutline16, Switch, Tooltip } from '@neo/client-ui-primitives'
import type { ModelDraft } from './ModelListEditor.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** pi-ai's thinking levels in escalation order: the only keys `reasoningEfforts` accepts. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One pi-ai thinking level. */
type Level = typeof LEVELS[number]

/** Wire value per offered level; `null` is the `off` entry that sends nothing. */
type Efforts = ReadonlyMap<Level, string | null>

/** Levels a model offers when the switch is first turned on: Off plus the common OpenAI-compatible trio. */
const INITIAL_LEVELS: readonly Level[] = ['off', 'low', 'medium', 'high']

/** The wire value a level sends unless its row says otherwise. */
function defaultValue(level: Level): string | null {
  return level === 'off' ? null : level
}

/**
 * Read the offered levels from a row.
 * @param model - model row as drafted.
 * @returns the offered levels, or `undefined` when the field is absent or `false`.
 */
function readEfforts(model: ModelDraft): Efforts | undefined {
  const value = model['reasoningEfforts']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = value as Readonly<Record<string, unknown>>
  return new Map(LEVELS.filter(level => Object.hasOwn(entries, level)).map((level) => {
    const wire = entries[level]
    return [level, typeof wire === 'string' ? wire : null] as const
  }))
}

/**
 * Replace a row's offered levels, preserving every other field.
 * @param model - model row as drafted.
 * @param efforts - the levels to write, or `undefined` to remove the field.
 * @returns the replacement row; the dict is written in escalation order.
 */
function withEfforts(model: ModelDraft, efforts: Efforts | undefined): ModelDraft {
  const next = { ...model }
  if (efforts === undefined) {
    // Absent is how a hand-declared model says it does not reason.
    Reflect.deleteProperty(next, 'reasoningEfforts')
    return next
  }
  next['reasoningEfforts'] = Object.fromEntries(
    LEVELS.flatMap(level => efforts.has(level) ? [[level, efforts.get(level) ?? null]] : []),
  )
  return next
}

/** Props of {@link ModelReasoningEfforts}. */
interface ModelReasoningEffortsProps {
  /** Effective model row, including fields outside the curated editor. */
  model: ModelDraft
  /** One-based row position for accessible names. */
  position: number
  /** Prevent changes while read-only or saving. */
  disabled: boolean
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Replace this row, preserving unrelated configuration. */
  onChange: (model: ModelDraft) => void
}

/**
 * Edit the `reasoningEfforts` a hand-declared pi-ai model offers: a switch,
 * then one row per level pairing the level with the value sent for it.
 * @param props - model declaration and row replacement action.
 * @returns the reasoning-level group.
 */
export function ModelReasoningEfforts({ model, position, disabled, t, onChange }: ModelReasoningEffortsProps): ReactNode {
  const efforts = readEfforts(model)
  // Turning the switch back on restores what it turned off in this session.
  const [lastEfforts, setLastEfforts] = useState<Efforts | undefined>(undefined)
  // Rows keep the order they were edited in; the stored dict is always in escalation order.
  const [order, setOrder] = useState<readonly Level[]>([])
  // Typed text is buffered so a cleared field stays empty while its level's name is stored.
  const [typed, setTyped] = useState<ReadonlyMap<Level, string>>(new Map())
  const label = `${t('modelReasoning')} ${String(position)}`
  const rows = efforts === undefined
    ? []
    : [...order.filter(level => efforts.has(level)), ...LEVELS.filter(level => efforts.has(level) && !order.includes(level))]
  const missingLevel = efforts !== undefined && !rows.some(level => level !== 'off')

  const write = (next: Efforts, nextOrder: readonly Level[]): void => {
    setOrder(nextOrder)
    onChange(withEfforts(model, next))
  }

  const toggleEnabled = (on: boolean): void => {
    if (on) {
      const restored = lastEfforts ?? new Map(INITIAL_LEVELS.map(level => [level, defaultValue(level)]))
      write(restored, LEVELS.filter(level => restored.has(level)))
      return
    }
    setLastEfforts(efforts)
    setTyped(new Map())
    onChange(withEfforts(model, undefined))
  }

  const changeLevel = (from: Level, to: Level): void => {
    const next = new Map(efforts)
    const wire = next.get(from) ?? null
    next.delete(from)
    // Only a custom spelling between two thinking levels carries over; a value
    // still spelled as its old level, or one crossing to or from Off, resets.
    const carried = wire !== null && wire !== from && from !== 'off' && to !== 'off'
    next.set(to, carried ? wire : defaultValue(to))
    setTyped((current) => {
      const kept = new Map(current)
      kept.delete(from)
      return kept
    })
    write(next, rows.map(level => level === from ? to : level))
  }

  const addLevel = (): void => {
    const highest = Math.max(-1, ...rows.map(level => LEVELS.indexOf(level)))
    const level = LEVELS.find((candidate, index) => index > highest && !rows.includes(candidate))
      ?? LEVELS.find(candidate => !rows.includes(candidate))
    /* v8 ignore next -- the add button is disabled once every level has a row */
    if (level === undefined) return
    write(new Map(efforts).set(level, defaultValue(level)), [...rows, level])
  }

  const removeLevel = (level: Level): void => {
    const next = new Map(efforts)
    next.delete(level)
    setTyped((current) => {
      const kept = new Map(current)
      kept.delete(level)
      return kept
    })
    write(next, rows.filter(row => row !== level))
  }

  const editValue = (level: Level, text: string): void => {
    setTyped(current => new Map(current).set(level, text))
    const trimmed = text.trim()
    write(new Map(efforts).set(level, trimmed.length === 0 ? defaultValue(level) : trimmed), rows)
  }

  return (
    <div className={styles['modelReasoning']} role="group" aria-label={label}>
      <div className={styles['modelReasoningHead']}>
        <span className={`${styles['modelFieldLabel']} ${styles['modelReasoningLabel']}`}>
          {t('modelReasoning')}
          <Tooltip label={t('modelReasoningHelpText')} side="right" delayMs={0}>
            <button type="button" className={styles['helpButton']} aria-label={t('modelReasoningHelp')}>?</button>
          </Tooltip>
        </span>
        <Switch checked={efforts !== undefined} label={label} disabled={disabled} onChange={toggleEnabled} />
      </div>
      {efforts === undefined
        ? <p className={styles['advancedHint']}>{t('modelReasoningOffHint')}</p>
        : (
          <>
            {rows.length > 0
              ? (
                <div className={styles['modelReasoningRow']} aria-hidden="true">
                  <span className={styles['modelFieldLabel']}>{t('modelReasoningLevel')}</span>
                  <span className={styles['modelFieldLabel']}>{t('modelReasoningValue')}</span>
                </div>
              )
              : null}
            {rows.map((level, index) => (
              <div key={index} className={styles['modelReasoningRow']}>
                <select
                  className={`${styles['input']} ${styles['selectInput']}`}
                  value={level}
                  aria-label={`${t('modelReasoningLevel')} ${String(index + 1)}`}
                  disabled={disabled}
                  onChange={(event) => { changeLevel(level, event.target.value as Level) }}
                >
                  {LEVELS.filter(choice => choice === level || !rows.includes(choice)).map(choice => (
                    <option key={choice} value={choice}>{choice}</option>
                  ))}
                </select>
                <input
                  className={`${styles['input']} ${styles['modelReasoningValueInput']}`}
                  type="text"
                  value={typed.get(level) ?? efforts.get(level) ?? ''}
                  placeholder={level === 'off' ? t('modelReasoningOffValuePlaceholder') : level}
                  aria-label={`${level} ${t('modelReasoningValue')}`}
                  // Off only turns reasoning off; a value stored in cordis.patch.yml is shown and kept.
                  disabled={disabled || level === 'off'}
                  onChange={(event) => { editValue(level, event.target.value) }}
                />
                <button
                  type="button"
                  className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
                  aria-label={`${t('modelReasoningRemove')} ${level}`}
                  title={t('modelReasoningRemove')}
                  disabled={disabled}
                  onClick={() => { removeLevel(level) }}
                >
                  <IconTrashOutline16 size={14} />
                </button>
              </div>
            ))}
            {missingLevel ? <p className={styles['error']}>{t('modelReasoningNeedsLevel')}</p> : null}
            <button
              type="button"
              className={styles['addModelButton']}
              disabled={disabled || rows.length === LEVELS.length}
              onClick={addLevel}
            >
              <IconPlusOutline16 size={14} />
              {t('modelReasoningAdd')}
            </button>
          </>
        )}
    </div>
  )
}
