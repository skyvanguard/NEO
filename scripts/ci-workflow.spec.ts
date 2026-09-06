import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

// The upstream deepseek-harness CI relied on self-hosted Wine/Windows runners
// this fork does not have. This spec validates the fork's minimal Linux CI
// (.github/workflows/ci.yml): it must exist, trigger on push/PR, and keep the
// gate steps that catch the regressions we care about — chiefly the built
// typert artifact probe that guards against an undeclared runtime dep.

const root = resolve(import.meta.dirname, '..')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loadWorkflow(relativePath: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, relativePath), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${relativePath} must be a mapping`)
  return workflow
}

describe('CI workflow', () => {
  const workflow = loadWorkflow('.github/workflows/ci.yml')

  it('triggers on pushes to master and on pull requests', () => {
    const on = workflow.on
    if (!isRecord(on)) throw new TypeError('workflow must define triggers')
    expect(isRecord(on.push) && on.push.branches).toContain('master')
    expect('pull_request' in on).toBe(true)
  })

  it('runs the Linux gate job on ubuntu with an isolated pnpm setup', () => {
    const jobs = workflow.jobs
    if (!isRecord(jobs)) throw new TypeError('workflow must define jobs')
    const linux = jobs.linux
    if (!isRecord(linux) || !Array.isArray(linux.steps)) {
      throw new TypeError('workflow must define a linux job with steps')
    }
    expect(linux['runs-on']).toBe('ubuntu-latest')
    const pnpmSetup = linux.steps.find((step): step is Record<string, unknown> =>
      isRecord(step) && typeof step.uses === 'string' && step.uses.startsWith('pnpm/action-setup@'))
    expect(pnpmSetup, 'linux job must set up pnpm').toBeDefined()
    expect(pnpmSetup).toMatchObject({ with: { dest: '${{ runner.temp }}/setup-pnpm' } })
  })

  it('keeps the gate steps that guard against regressions', () => {
    const jobs = workflow.jobs
    if (!isRecord(jobs)) throw new TypeError('workflow must define jobs')
    const linux = jobs.linux
    if (!isRecord(linux) || !Array.isArray(linux.steps)) throw new TypeError('workflow must define a linux job with steps')
    const runs = linux.steps
      .filter((step): step is Record<string, unknown> & { run: string } =>
        isRecord(step) && typeof step.run === 'string')
      .map(step => step.run)
    // The probe that would have caught the undeclared-zod deploy failure.
    expect(runs.some(run => run.includes('verify-built-package-invariants'))).toBe(true)
    expect(runs.some(run => run.includes('build:lib'))).toBe(true)
    expect(runs.some(run => run.includes('typecheck'))).toBe(true)
    expect(runs.some(run => run.includes('lint'))).toBe(true)
    expect(runs.some(run => run.includes('test'))).toBe(true)
  })
})
