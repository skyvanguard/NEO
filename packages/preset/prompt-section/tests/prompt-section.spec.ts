import { Context } from '@neo/cordis'
import SystemPrompt, { PERSONA_SECTION, renderPrompt } from '@neo/system-prompt'
import { createScope, type ScopeKey } from '@neo/scope'
import { afterEach, describe, expect, it } from 'vitest'
import * as PromptSection from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * A row config as cordis.yml authors it, before the plugin schema validates it
 * and fills defaults; the `Config` interface describes the validated value.
 */
function authored(config: unknown): PromptSection.Config {
  return config as PromptSection.Config
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, { persona: 'deployment identity' })
  return ctx
}

/** The assembled text of one named section as one scope sees it. */
async function sectionText(ctx: Context, name: string, scope?: ScopeKey): Promise<string | undefined> {
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return assembly.sections.find(section => section.name === name)?.text
}

describe('the prompt-section row', () => {
  it('shadows a same-named global section for its scope only', async () => {
    const ctx = await harness()
    ctx.systemPrompt.section({ name: 'app:web-surface', order: 40, text: 'global web guidance' })
    const key: ScopeKey = { agent: 'a1' }

    await createScope(ctx, key).ctx.plugin(PromptSection, {
      sections: [{ name: 'app:web-surface', order: 40, text: 'preset web guidance' }],
    })

    expect(await sectionText(ctx, 'app:web-surface', key)).toBe('preset web guidance')
    expect(await sectionText(ctx, 'app:web-surface')).toBe('global web guidance')
  })

  it('suppresses the shadowed global section when a section omits its text', async () => {
    const ctx = await harness()
    ctx.systemPrompt.section({ name: 'harness:source', order: 10, text: 'global source notes' })
    const key: ScopeKey = { agent: 'a1' }

    await createScope(ctx, key).ctx.plugin(PromptSection, authored({
      sections: [{ name: 'harness:source', order: 10 }],
    }))

    // The schema defaults the text to empty: the slot stays occupied for this
    // scope, so the global text is gone there, and render drops the empty section.
    expect(await sectionText(ctx, 'harness:source', key)).toBe('')
    const scoped = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
    expect(scoped).not.toContain('global source notes')
    expect(scoped).toContain('deployment identity')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('global source notes')
  })

  it('registers every configured section at its configured order', async () => {
    const ctx = await harness()
    const key: ScopeKey = { agent: 'a1' }

    await createScope(ctx, key).ctx.plugin(PromptSection, {
      sections: [
        { name: 'preset:late', order: 200, text: 'late guidance' },
        { name: 'preset:early', order: -50, text: 'early guidance' },
      ],
    })

    const scopedNames = (await ctx.systemPrompt.assemble({ scope: key })).sections.map(section => section.name)
    // -50 sorts before the order-0 persona, 200 after it.
    expect(scopedNames).toContain('preset:early')
    expect(scopedNames.indexOf('preset:early')).toBeLessThan(scopedNames.indexOf(PERSONA_SECTION))
    expect(scopedNames.indexOf('preset:late')).toBeGreaterThan(scopedNames.indexOf(PERSONA_SECTION))
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key })))
      .toMatch(/early guidance[\s\S]*deployment identity[\s\S]*late guidance/)
    const globalNames = (await ctx.systemPrompt.assemble()).sections.map(section => section.name)
    expect(globalNames).not.toContain('preset:early')
    expect(globalNames).not.toContain('preset:late')
  })

  it('contributes nothing when mounted without sections', async () => {
    const ctx = await harness()
    const key: ScopeKey = { agent: 'a1' }
    const before = await ctx.systemPrompt.assemble({ scope: key })

    await createScope(ctx, key).ctx.plugin(PromptSection, authored({}))

    expect((await ctx.systemPrompt.assemble({ scope: key })).sections).toEqual(before.sections)
  })

  it('restores the shadowed global sections when its fiber unloads', async () => {
    const ctx = await harness()
    ctx.systemPrompt.section({ name: 'app:web-surface', order: 40, text: 'global web guidance' })
    const key: ScopeKey = { agent: 'a1' }
    const fiber = await createScope(ctx, key).ctx.plugin(PromptSection, {
      sections: [
        { name: 'app:web-surface', order: 40, text: '' },
        { name: 'preset:extra', order: 50, text: 'extra guidance' },
      ],
    })
    expect(await sectionText(ctx, 'app:web-surface', key)).toBe('')
    expect(await sectionText(ctx, 'preset:extra', key)).toBe('extra guidance')

    await fiber.dispose()

    expect(await sectionText(ctx, 'app:web-surface', key)).toBe('global web guidance')
    expect(await sectionText(ctx, 'preset:extra', key)).toBeUndefined()
  })

  it('rejects an unscoped mount that collides with a global section of the same name', async () => {
    const ctx = await harness()

    await expect(ctx.plugin(PromptSection, {
      sections: [{ name: PERSONA_SECTION, order: 0, text: 'composition identity' }],
    })).rejects.toThrow(`"${PERSONA_SECTION}" is already registered`)
  })

  it.each([
    ['a name', { order: 1, text: 'x' }],
    ['an order', { name: 'preset:x', text: 'x' }],
  ])('rejects a section without %s at load', async (_missing, section) => {
    const ctx = await harness()
    const key: ScopeKey = { agent: 'a1' }

    await expect(createScope(ctx, key).ctx.plugin(PromptSection, authored({ sections: [section] })))
      .rejects.toThrow(/missing required value/)
    expect((await ctx.systemPrompt.assemble({ scope: key })).sections.map(entry => entry.name))
      .not.toContain('preset:x')
  })
})
