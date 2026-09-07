import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@neo/client-ui-slots'
import type { UsageSummary, UsageTotals } from '@neo/usage-stats/types'
import css from './UsageSettingsSection.module.css'

/** Registration-side Remote face used by the section. */
export interface UsageSectionInjected {
  /** Read a cumulative token-usage summary across every session. */
  summary: () => Promise<UsageSummary>
}

/** Full component props assembled by the Settings slot renderer. */
export type UsageSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.usage'>
  & InjectFace<UsageSectionInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly summary: UsageSummary }

/** Full number with thousands separators. */
const full = (n: number): string => n.toLocaleString('en-US')

/** Compact number (e.g. 1.2M, 45.3K) for the headline tiles. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return String(n)
}

/** Local date-time of an epoch-ms value. */
const when = (ms: number): string => new Date(ms).toLocaleString()

/** One headline stat tile. */
function Tile({ label, value, title }: { label: string; value: number; title?: string }): ReactNode {
  return (
    <div className={css.tile}>
      <span className={css.tileValue} title={title ?? full(value)}>{compact(value)}</span>
      <span className={css.tileLabel}>{label}</span>
    </div>
  )
}

/** A max value for scaling the per-day bars. */
const peak = (rows: readonly { totals: UsageTotals }[]): number =>
  Math.max(1, ...rows.map(r => r.totals.inputTokens + r.totals.outputTokens))

/** Render the cumulative token-usage dashboard. */
export function UsageSettingsSection({ summary, t }: UsageSettingsSectionProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    void Promise.resolve().then(() => summary()).then(
      (value) => { if (current) setState({ status: 'ready', summary: value }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [summary, request])

  const refresh = (): void => { setRequest(v => v + 1) }

  if (state.status === 'loading') {
    return <div className={css.section} aria-busy="true"><p className={css.status}>{t('loading')}</p></div>
  }
  if (state.status === 'error') {
    return (
      <div className={css.section}>
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={refresh}>{t('retry')}</button>
        </div>
      </div>
    )
  }

  const s = state.summary
  const total = s.totals.inputTokens + s.totals.outputTokens
  const dayPeak = peak(s.byDay)
  const recentDays = s.byDay.slice(-30)

  return (
    <div className={css.section}>
      <div className={css.heading}>
        <div>
          <h3>{t('title')}</h3>
          <p className={css.subtitle}>{t('generated', { when: when(s.generatedAt) })}</p>
        </div>
        <button type="button" className={css.refresh} onClick={refresh}>{t('refresh')}</button>
      </div>

      <div className={css.tiles}>
        <Tile label={t('totalTokens')} value={total} />
        <Tile label={t('input')} value={s.totals.inputTokens} />
        <Tile label={t('output')} value={s.totals.outputTokens} />
        <Tile label={t('reasoning')} value={s.totals.reasoningTokens} />
        <Tile label={t('cacheRead')} value={s.totals.cacheReadTokens} />
        <Tile label={t('requests')} value={s.totals.requests} />
        <Tile label={t('sessions')} value={s.sessionCount} />
      </div>

      {recentDays.length > 0 ? (
        <section className={css.block}>
          <h4>{t('byDay')}</h4>
          <ul className={css.days}>
            {recentDays.map((d) => {
              const dayTotal = d.totals.inputTokens + d.totals.outputTokens
              return (
                <li className={css.dayRow} key={d.day}>
                  <span className={css.dayLabel}>{d.day}</span>
                  <span className={css.dayBar}>
                    <span className={css.dayFill} style={{ width: `${Math.round((dayTotal / dayPeak) * 100)}%` }} />
                  </span>
                  <span className={css.dayValue} title={full(dayTotal)}>{compact(dayTotal)}</span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {s.byWorkspace.length > 0 ? (
        <section className={css.block}>
          <h4>{t('byWorkspace')}</h4>
          <table className={css.table}>
            <thead>
              <tr><th>{t('workspace')}</th><th>{t('input')}</th><th>{t('output')}</th><th>{t('reasoning')}</th></tr>
            </thead>
            <tbody>
              {s.byWorkspace.map(w => (
                <tr key={w.workspace}>
                  <td className={css.name}>{w.workspace}</td>
                  <td>{full(w.totals.inputTokens)}</td>
                  <td>{full(w.totals.outputTokens)}</td>
                  <td>{full(w.totals.reasoningTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {s.sessions.length > 0 ? (
        <section className={css.block}>
          <h4>{t('recentSessions')}</h4>
          <table className={css.table}>
            <thead>
              <tr><th>{t('session')}</th><th>{t('workspace')}</th><th>{t('lastActive')}</th><th>{t('output')}</th></tr>
            </thead>
            <tbody>
              {s.sessions.slice(0, 25).map(row => (
                <tr key={row.sessionId}>
                  <td className={css.mono} title={row.sessionId}>{row.sessionId.replace(/^session-/, '').slice(0, 8)}</td>
                  <td className={css.name}>{row.workspace}</td>
                  <td>{when(row.lastActive)}</td>
                  <td>{full(row.totals.outputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  )
}
