/** Cumulative token-usage section registered into Web Settings. */

import type {} from '@neo/dsh-client-locale/client'
import type { ClientContext } from '@neo/dsh-client-runtime/client'
import type {} from '@neo/dsh-client-ui-settings/client'
// Pulls the `ctx.remote` Context augmentation and the `usage` namespace.
import type {} from '@neo/dsh-api-remotes/client'
import { UsageSettingsSection, type UsageSectionInjected } from './UsageSettingsSection.tsx'
import { en, es, zh, type UsageLocaleKey } from './locales.ts'

export type { UsageSectionInjected, UsageSettingsSectionProps } from './UsageSettingsSection.tsx'
export type { UsageLocaleKey } from './locales.ts'

declare module '@neo/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cumulative usage panel copy. */
    'settings.usage': UsageLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.usage'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.usage']

/** Contribute the cumulative Usage section to Web Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, es }), 'ui-usage: dictionaries')

  const t = ctx.locale.bind(NS)
  const summary: UsageSectionInjected['summary'] = async () => {
    const result = await ctx.remote.usage.summary({})
    if (!result.ok) {
      throw new Error(`usage.summary failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const injected = (): UsageSectionInjected => ({ summary })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'usage',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, UsageSettingsSection))
}
