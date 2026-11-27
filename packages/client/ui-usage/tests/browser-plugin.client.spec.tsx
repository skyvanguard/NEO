// @vitest-environment jsdom
/** Usage section registration: the lazy Settings entry, its Remote face, locale, declarer reload, and disposal. */
import { Context, Service } from '@neo/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LocaleRuntime } from '@neo/client-locale/client'
import { SlotRegistry } from '@neo/client-runtime/client'
import { resolveSlotLabel } from '@neo/client-ui-slots'
import { usePinnedBrowserLanguages } from '@neo/client-test-runtime'
import type { UsageSummary, UsageSummaryRequest } from '@neo/usage-stats/types'
import { apply, inject, NS } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { UsageSettingsSection } from '../src/client/UsageSettingsSection.tsx'
import type { UsageSectionInjected, UsageSettingsSectionProps } from '../src/client/UsageSettingsSection.tsx'
import { es } from '../src/client/locales.ts'

usePinnedBrowserLanguages('zh-CN')

/** Root Contexts created by this file, released even when an assertion fails first. */
const roots: Context[] = []
afterEach(async () => {
  // Unmount rendered sections before the Context behind their `t` goes away.
  cleanup()
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

const ZERO = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0,
}

const SUMMARY: UsageSummary = {
  totals: { ...ZERO, inputTokens: 40_000, outputTokens: 2_000, requests: 12 },
  sessionCount: 1,
  byDay: [],
  byWorkspace: [{ workspace: '/home/neo/hunt', totals: { ...ZERO, inputTokens: 40_000, outputTokens: 2_000 } }],
  sessions: [],
  generatedAt: Date.UTC(2026, 10, 26, 12, 0),
}

type SummaryResult =
  | { readonly ok: true; readonly value: UsageSummary }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const summary = vi.fn<(request: UsageSummaryRequest) => Promise<SummaryResult>>()
    .mockResolvedValue({ ok: true, value: SUMMARY })
  ctx.provide('remote.usage', { summary })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, summary }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

/** The one Settings section this plugin registered. */
function usageEntry(slots: SlotRegistry) {
  const entry = slots.entries('settings.section')[0]
  if (entry === undefined) throw new Error('no usage section is registered')
  return entry
}

/** The registration's injected face, as the slot renderer would receive it. */
function injectedOf(slots: SlotRegistry): UsageSectionInjected {
  return (usageEntry(slots).inject as unknown as () => UsageSectionInjected)()
}

describe('ui-usage browser plugin', () => {
  it('declares only the services used by the Settings registration and Remote face', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.usage'])
  })

  it('registers a localized Usage section without reading usage eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = usageEntry(b.slots)
    expect(entry.component).toBe(UsageSettingsSection)
    expect(entry.options).toMatchObject({ id: 'usage', order: 25 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('用量')
    expect(b.summary).not.toHaveBeenCalled()

    const injected = injectedOf(b.slots)
    await expect(injected.summary()).resolves.toEqual(SUMMARY)
    // The section asks for the unfiltered, all-time summary.
    expect(b.summary).toHaveBeenCalledExactlyOnceWith({})
    b.summary.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.summary()).rejects.toThrow('usage.summary failed: REMOTE_ERROR: unavailable')
  })

  it('renders the registered section from the Host summary in the active locale', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('es')
    const sectionProps = { ...injectedOf(b.slots), t: b.locale.bind(NS) } as UsageSettingsSectionProps
    render(<UsageSettingsSection {...sectionProps} />)

    expect(await screen.findByRole('heading', { name: es.title })).toBeTruthy()
    const total = screen.getByText(es.totalTokens, { selector: 'span' }).parentElement
    if (total === null) throw new Error('no total-tokens tile')
    expect(within(total).getByTitle('42,000').textContent).toBe('42K')
    expect(screen.getByRole('cell', { name: '/home/neo/hunt' })).toBeTruthy()
    expect(b.summary).toHaveBeenCalledExactlyOnceWith({})

    // A refused read reaches the user as the localized failure, with a retry.
    b.summary.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    fireEvent.click(screen.getByRole('button', { name: es.refresh }))
    expect((await screen.findByRole('alert')).textContent).toBe(es.error)
    fireEvent.click(screen.getByRole('button', { name: es.retry }))
    expect(await screen.findByRole('heading', { name: es.title })).toBeTruthy()
    expect(b.summary).toHaveBeenCalledTimes(3)
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(usageEntry(b.slots).options.label)).toBe('Usage')
    b.locale.setLocale('es')
    expect(resolveSlotLabel(usageEntry(b.slots).options.label)).toBe('Uso')

    stop()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.section')[0]?.component).toBe(UsageSettingsSection)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    // The (ns, locale) seats are free again: the dictionary disposers ran.
    for (const id of ['zh', 'en', 'es']) {
      expect(() => b.locale.register(NS, id, {})).not.toThrow()
    }
  })

  it('the node half is a no-op Host placeholder', () => {
    // The package has no host-side behavior; this only proves the Host entry loads and runs.
    expect(() => { nodeApply() }).not.toThrow()
  })
})
