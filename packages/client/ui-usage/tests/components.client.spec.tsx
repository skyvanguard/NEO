// @vitest-environment jsdom
/** Usage dashboard: loading, headline tiles, per-day bars, breakdown tables, refresh, and failures. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@neo/client-test-runtime'
import type { UsageDayBucket, UsageSessionRow, UsageSummary, UsageTotals } from '@neo/usage-stats/types'
import { UsageSettingsSection } from '../src/client/UsageSettingsSection.tsx'
import type { UsageSectionInjected, UsageSettingsSectionProps } from '../src/client/UsageSettingsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en) as UsageSettingsSectionProps['t']

function props(summary: UsageSectionInjected['summary']): UsageSettingsSectionProps {
  return { t, summary } as UsageSettingsSectionProps
}

function totals(partial: Partial<UsageTotals> = {}): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    ...partial,
  }
}

/** UTC calendar day `offset` days after 2026-10-27. */
const dayAt = (offset: number): string => new Date(Date.UTC(2026, 9, 27 + offset)).toISOString().slice(0, 10)

/**
 * 31 days, oldest first: the oldest one falls outside the 30-day window, the
 * last day is the busiest, the one before it a quarter of that, the rest idle.
 */
const BY_DAY: readonly UsageDayBucket[] = Array.from({ length: 31 }, (_, offset) => ({
  day: dayAt(offset),
  totals: offset === 0
    ? totals({ inputTokens: 1_000 })
    : offset === 29
      ? totals({ inputTokens: 2_000, outputTokens: 500 })
      : offset === 30
        ? totals({ inputTokens: 7_500, outputTokens: 2_500 })
        : totals(),
}))

const LAST_ACTIVE = Date.UTC(2026, 10, 26, 9, 30)

/** 26 sessions, newest first: one more than the table lists. */
const SESSIONS: readonly UsageSessionRow[] = [
  { sessionId: 'session-a1b2c3d4e5f6', workspace: '/home/neo/hunt', lastActive: LAST_ACTIVE, totals: totals({ outputTokens: 1_100_000 }) },
  { sessionId: 'imported-legacy-run', workspace: '/home/neo/lab', lastActive: LAST_ACTIVE - 60_000, totals: totals({ outputTokens: 98_765 }) },
  ...Array.from({ length: 24 }, (_, index) => ({
    sessionId: `session-filler-${String(index).padStart(2, '0')}`,
    workspace: '/home/neo/lab',
    lastActive: LAST_ACTIVE - (index + 2) * 60_000,
    totals: totals({ outputTokens: 1 }),
  })),
]

const SUMMARY: UsageSummary = {
  totals: totals({
    inputTokens: 12_000_000,
    outputTokens: 1_200_000,
    reasoningTokens: 45_300,
    cacheReadTokens: 2_400,
    cacheWriteTokens: 777,
    requests: 987,
  }),
  sessionCount: 3,
  byDay: BY_DAY,
  byWorkspace: [
    { workspace: '/home/neo/hunt', totals: totals({ inputTokens: 9_000_000, outputTokens: 1_100_000, reasoningTokens: 40_000 }) },
    { workspace: '/home/neo/lab', totals: totals({ inputTokens: 3_000_000, outputTokens: 100_000, reasoningTokens: 5_300 }) },
  ],
  sessions: SESSIONS,
  generatedAt: Date.UTC(2026, 10, 26, 12, 0),
}

const EMPTY: UsageSummary = {
  totals: totals(),
  sessionCount: 0,
  byDay: [],
  byWorkspace: [],
  sessions: [],
  generatedAt: Date.UTC(2026, 10, 26, 12, 0),
}

/** The stat tile carrying `label`. */
function tile(label: string): HTMLElement {
  const host = screen.getByText(label, { selector: 'span' }).parentElement
  if (host === null) throw new Error(`no tile labelled ${label}`)
  return host
}

/** The dashboard block under the heading `name`. */
function block(name: string): HTMLElement {
  const section = screen.getByRole('heading', { name }).closest('section')
  if (section === null) throw new Error(`no block headed ${name}`)
  return section
}

/** Cell texts of every body row in a block's table. */
function bodyRows(name: string): string[][] {
  return within(block(name)).getAllByRole('row').slice(1)
    .map(row => within(row).getAllByRole('cell').map(cell => cell.textContent ?? ''))
}

/** The per-day row for `day`. */
function dayRow(day: string): HTMLElement {
  const row = screen.getByText(day).closest('li')
  if (row === null) throw new Error(`no day row for ${day}`)
  return row
}

/** The visible width of a day's bar fill. */
function barWidth(day: string): string | undefined {
  return dayRow(day).querySelector<HTMLElement>('[style]')?.style.width
}

describe('UsageSettingsSection', () => {
  it('shows a busy placeholder until the summary arrives', async () => {
    const deferred = Promise.withResolvers<UsageSummary>()
    const summary = vi.fn(() => deferred.promise)
    render(<UsageSettingsSection {...props(summary)} />)

    const loading = screen.getByText(en.loading)
    expect(loading.closest('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()

    await act(async () => { deferred.resolve(SUMMARY) })
    expect(summary).toHaveBeenCalledOnce()
    expect(screen.queryByText(en.loading)).toBeNull()
    expect(document.querySelector('[aria-busy]')).toBeNull()
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.generated.replace('{when}', new Date(SUMMARY.generatedAt).toLocaleString()))).toBeTruthy()
  })

  it('shows each headline total compactly with the exact count as its hover title', async () => {
    render(<UsageSettingsSection {...props(async () => SUMMARY)} />)
    await screen.findByRole('heading', { name: en.title })

    for (const [label, shown, exact] of [
      // Total is input plus output; reasoning and cache reads are reported beside it.
      [en.totalTokens, '13M', '13,200,000'],
      [en.input, '12M', '12,000,000'],
      [en.output, '1.2M', '1,200,000'],
      [en.reasoning, '45K', '45,300'],
      [en.cacheRead, '2.4K', '2,400'],
      [en.requests, '987', '987'],
      [en.sessions, '3', '3'],
    ] as const) {
      expect(within(tile(label)).getByTitle(exact).textContent).toBe(shown)
    }
    // Cache writes are summed by the host but not shown as a tile.
    expect(screen.queryByTitle('777')).toBeNull()
  })

  it('charts the most recent 30 days against the busiest day', async () => {
    render(<UsageSettingsSection {...props(async () => SUMMARY)} />)
    await screen.findByRole('heading', { name: en.byDay })

    expect(within(block(en.byDay)).getAllByRole('listitem')).toHaveLength(30)
    expect(screen.queryByText(dayAt(0))).toBeNull()
    expect(screen.getByText(dayAt(1))).toBeTruthy()

    const busiest = dayAt(30)
    expect(barWidth(busiest)).toBe('100%')
    expect(within(dayRow(busiest)).getByTitle('10,000').textContent).toBe('10K')
    const quarter = dayAt(29)
    expect(barWidth(quarter)).toBe('25%')
    expect(within(dayRow(quarter)).getByTitle('2,500').textContent).toBe('2.5K')
    // An idle day draws an empty bar rather than a broken width.
    expect(barWidth(dayAt(15))).toBe('0%')
    expect(within(dayRow(dayAt(15))).getByTitle('0').textContent).toBe('0')
  })

  it('scales the bars against the busiest drawn day, not an older peak outside the window', async () => {
    const olderPeak = [{ day: dayAt(0), totals: totals({ inputTokens: 1_000_000 }) }, ...BY_DAY.slice(1)]
    render(<UsageSettingsSection {...props(async () => ({ ...SUMMARY, byDay: olderPeak }))} />)
    await screen.findByRole('heading', { name: en.byDay })

    expect(screen.queryByText(dayAt(0))).toBeNull()
    expect(barWidth(dayAt(30))).toBe('100%')
    expect(barWidth(dayAt(29))).toBe('25%')
  })

  it('lists per-workspace totals as exact counts', async () => {
    render(<UsageSettingsSection {...props(async () => SUMMARY)} />)
    await screen.findByRole('heading', { name: en.byWorkspace })

    expect(within(block(en.byWorkspace)).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual([en.workspace, en.input, en.output, en.reasoning])
    expect(bodyRows(en.byWorkspace)).toEqual([
      ['/home/neo/hunt', '9,000,000', '1,100,000', '40,000'],
      ['/home/neo/lab', '3,000,000', '100,000', '5,300'],
    ])
  })

  it('lists at most 25 recent sessions under a short id with the full id on hover', async () => {
    render(<UsageSettingsSection {...props(async () => SUMMARY)} />)
    await screen.findByRole('heading', { name: en.recentSessions })

    expect(within(block(en.recentSessions)).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual([en.session, en.workspace, en.lastActive, en.output])
    const rows = bodyRows(en.recentSessions)
    expect(rows).toHaveLength(25)
    // The `session-` prefix is dropped before shortening; other ids are only shortened.
    expect(rows[0]).toEqual(['a1b2c3d4', '/home/neo/hunt', new Date(LAST_ACTIVE).toLocaleString(), '1,100,000'])
    expect(rows[1]).toEqual(['imported', '/home/neo/lab', new Date(LAST_ACTIVE - 60_000).toLocaleString(), '98,765'])
    expect(screen.getByTitle('session-a1b2c3d4e5f6').textContent).toBe('a1b2c3d4')
    expect(screen.getByTitle('session-filler-22')).toBeTruthy()
    expect(screen.queryByTitle('session-filler-23')).toBeNull()
  })

  it('shows zeroed totals and no breakdowns before anything was recorded', async () => {
    render(<UsageSettingsSection {...props(async () => EMPTY)} />)
    await screen.findByRole('heading', { name: en.title })

    expect(within(tile(en.totalTokens)).getByTitle('0').textContent).toBe('0')
    expect(within(tile(en.sessions)).getByTitle('0').textContent).toBe('0')
    expect(screen.getByRole('button', { name: en.refresh })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: en.byDay })).toBeNull()
    expect(screen.queryByRole('heading', { name: en.byWorkspace })).toBeNull()
    expect(screen.queryByRole('heading', { name: en.recentSessions })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('re-reads the summary on refresh and shows the newer totals', async () => {
    const second = Promise.withResolvers<UsageSummary>()
    const summary = vi.fn<UsageSectionInjected['summary']>()
      .mockResolvedValueOnce(EMPTY)
      .mockReturnValueOnce(second.promise)
    render(<UsageSettingsSection {...props(summary)} />)
    await screen.findByRole('heading', { name: en.title })
    expect(screen.queryByRole('heading', { name: en.byDay })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(await screen.findByText(en.loading)).toBeTruthy()
    expect(summary).toHaveBeenCalledTimes(2)

    await act(async () => { second.resolve(SUMMARY) })
    expect(within(tile(en.totalTokens)).getByTitle('13,200,000').textContent).toBe('13M')
    expect(screen.getByRole('heading', { name: en.byDay })).toBeTruthy()
  })

  it('shows a generic failure and retries into the dashboard', async () => {
    const summary = vi.fn<UsageSectionInjected['summary']>()
      .mockRejectedValueOnce(new Error('usage.summary failed: REMOTE_ERROR: private transport detail'))
      .mockResolvedValueOnce(SUMMARY)
    render(<UsageSettingsSection {...props(summary)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText(/private transport detail/)).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(summary).toHaveBeenCalledTimes(2) })
    expect(await screen.findByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('contains a summary source that throws before returning a promise', async () => {
    const summary = vi.fn(() => { throw new Error('namespace unavailable') }) as UsageSectionInjected['summary']
    render(<UsageSettingsSection {...props(summary)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
  })

  it('keeps the newer source on screen when a replaced read settles late', async () => {
    const stale = Promise.withResolvers<UsageSummary>()
    const view = render(<UsageSettingsSection {...props(() => stale.promise)} />)
    view.rerender(<UsageSettingsSection {...props(async () => EMPTY)} />)
    await screen.findByRole('heading', { name: en.title })

    // The replaced read answering afterwards must not overwrite the newer one.
    await act(async () => { stale.resolve(SUMMARY) })
    expect(within(tile(en.totalTokens)).getByTitle('0').textContent).toBe('0')
    expect(screen.queryByRole('heading', { name: en.byDay })).toBeNull()

    const staleFailure = Promise.withResolvers<UsageSummary>()
    view.rerender(<UsageSettingsSection {...props(() => staleFailure.promise)} />)
    view.rerender(<UsageSettingsSection {...props(async () => SUMMARY)} />)
    await screen.findByRole('heading', { name: en.byDay })

    // Nor may a replaced read failing afterwards replace the dashboard with an error.
    await act(async () => { staleFailure.reject(new Error('late failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('heading', { name: en.byDay })).toBeTruthy()
  })
})
