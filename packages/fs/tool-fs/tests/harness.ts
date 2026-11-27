import { Context } from '@neo/cordis'
import type { Agent } from '@neo/agent'
import AgentLoop from '@neo/agent-loop'
import { mountAgentLoopTestDependencies } from '@neo/agent-loop-testkit'
import LocalFileSystem from '@neo/fs-local'
import * as FsPolicy from '@neo/fs-observation-policy'
import * as ToolFs from '@neo/tool-fs'
import * as LlmPiAi from '@neo/llm-pi-ai'

/**
 * Build the real fs-tool stack for with-key e2e tests. The model is a live
 * OpenAI-compatible endpoint: `LLM_BASE_URL` (default: a local llama-server)
 * authenticated with `LLM_API_KEY`. Agents have no session cwd, so `fsCwd` is
 * their workspace; `persona` configures the deployment prompt.
 * This helper lives outside the e2e glob so imports do not register tests.
 */
export async function fsHarness(fsCwd: string, persona = ''): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmPiAi, {
    providers: {
      'deepseek-official': {
        api: 'openai-completions',
        baseURL: process.env.LLM_BASE_URL ?? 'http://127.0.0.1:8080/v1',
        apiKeyEnv: 'LLM_API_KEY',
        models: [{ id: 'deepseek-v4-flash' }],
      },
    },
  })
  await ctx.plugin(LocalFileSystem, { cwd: fsCwd })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  return ctx
}

export function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}
