/**
 * Register arbitrary named system-prompt sections for one agent scope.
 *
 * Mounted inside an agent preset, each section here shadows a same-named global
 * section for that one session — exactly like `dsh-persona` shadows the
 * deployment persona. With EMPTY text, that suppresses the shadowed section:
 * the prompt registry drops empty sections at render. So a preset can blank out
 * a global section it does not want (e.g. `harness:source`, `app:web-surface`)
 * without touching the deployment composition. Scope-only: mounted globally it
 * would collide with a same-named global registration and fail loud.
 * @module @neo/dsh-prompt-section
 */

import type { Context } from '@neo/cordis'
import z from '@neo/schemastery'
import type {} from '@neo/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'prompt-section'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** One section this row registers into the mounting scope. */
export interface SectionSpec {
  /** Section name; a same name as a global section shadows it in this scope. */
  readonly name: string
  /** Ascending concatenation order (matches the shadowed section's band). */
  readonly order: number
  /** Section prose; empty text drops (suppresses) the section at render. */
  readonly text: string
}

/** Plugin config: the sections to contribute. */
export interface Config {
  readonly sections: readonly SectionSpec[]
}

/**
 * Runtime schema for the prompt-section row. Cast because schemastery infers
 * `string | null` for defaulted fields where the strict interface declares
 * required members (same pattern token-meter uses for its projection schemas).
 */
export const Config = z.object({
  sections: z.array(z.object({
    name: z.string().required(),
    order: z.number().required(),
    text: z.string().default(''),
  })).default([]),
}) as unknown as z<Config>

/**
 * Register each configured section for the mounting context's scope.
 * @param ctx - an agent scope context.
 * @param config - the sections to contribute.
 */
export function apply(ctx: Context, config: Config): void {
  for (const section of config.sections) {
    ctx.effect(
      () => ctx.systemPrompt.section({ name: section.name, order: section.order, text: section.text }),
      `prompt-section.section(${section.name})`,
    )
  }
}
