/**
 * Host-side `session.delete`: the permanent removal path over live and
 * persisted sessions — agent disposal, log removal, workspace-registry
 * forget, subagent fencing, and the streamed host increments.
 */

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@neo/cordis'
import AgentRegistry, { Inbox } from '@neo/agent'
import type { Agent, AgentFactory } from '@neo/agent'
import SessionStore, { SessionId, SessionPreparation } from '@neo/session'
import type { Session, SessionEvent, SessionHeader } from '@neo/session'
import Storage from '@neo/storage'
import { DomainFacility } from '@neo/storage-domain'
import UserQuestionService from '@neo/user-questions'
import type { DirectoryPickerCapability } from '@neo/host-directory-picker'
import WorkspaceRegistry from '@neo/workspace'
import type { HostFrame } from '@neo/host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@neo/host-apiproxy/api/rpc'
import { RpcId } from '@neo/host-apiproxy/api/rpc'
import { createApiProxy } from '@neo/host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`delete-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

async function nextHostFrame(
  stream: AsyncIterator<RpcRequest<HostFrame>>,
): Promise<RpcRequest<HostFrame>> {
  const next = await stream.next()
  if (next.done === true) throw new Error('Host stream ended before the expected increment')
  return next.value
}

function stubAgent(session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

interface DeleteHarness {
  api: ReturnType<typeof createApiProxy>
  ctx: Context
  root: string
  /** Persisted sessions still held (the harness persistence backend's rows). */
  persisted: { meta: SessionHeader; events: SessionEvent[] }[]
  /** Every id handed to the persistence backend's remove hook. */
  removed: SessionId[]
  /** Every agent handle the harness factory disposed. */
  disposals: SessionId[]
  /** Programmable per-hook failures (set by a case before the call under test). */
  failures: { remove?: (id: SessionId) => Error | undefined }
  /** When set, the factory awaits this before building an agent (holds a creation in flight). */
  hold: { create?: Promise<void> }
}

/**
 * Compose the API over real Session, Agent, Storage, Domain, and Workspace
 * services with a scripted persistence backend and a factory whose handles
 * dispose exactly like the loop's (unregister the agent, detach the session).
 */
async function harness(
  initial: { meta: SessionHeader; events: SessionEvent[] }[] = [],
): Promise<DeleteHarness> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-delete-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)

  const persisted: { meta: SessionHeader; events: SessionEvent[] }[] =
    initial.map(entry => ({ meta: { ...entry.meta }, events: [...entry.events] }))
  const removed: SessionId[] = []
  const disposals: SessionId[] = []
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve(persisted.map(entry => ({ ...entry.meta }))),
    prepare: async (id: SessionId) => {
      const entry = persisted.find(candidate => candidate.meta.id === id)
      if (entry === undefined) throw new Error(`no stored session "${id}"`)
      const session = ctx.sessions.prepare(id, {
        seed: [...entry.events],
        seedSource: 'persistence',
        meta: { ...entry.meta },
      })
      return SessionPreparation.create(session)
    },
    inspect: async (id: SessionId) => {
      const entry = persisted.find(candidate => candidate.meta.id === id)
      if (entry === undefined) throw new Error(`no stored session "${id}"`)
      return { meta: { ...entry.meta }, events: [...entry.events] }
    },
    remove: (id: SessionId) => {
      removed.push(id)
      const failure = failures.remove?.(id)
      if (failure !== undefined) return Promise.reject(failure)
      const index = persisted.findIndex(entry => entry.meta.id === id)
      if (index !== -1) persisted.splice(index, 1)
      return Promise.resolve()
    },
  } as never)
  const failures: DeleteHarness['failures'] = {}
  const hold: DeleteHarness['hold'] = {}
  await ctx.plugin(WorkspaceRegistry)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      if (hold.create !== undefined) await hold.create
      const session = ctx.sessions.prepare(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.seed === undefined ? {} : { seed: options.seed },
      })
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          disposals.push(session.id)
          unregister()
          detach()
          return Promise.resolve()
        },
      }
    },
    async resume(_ownerCtx, options) {
      const preparation = await ctx.sessionPersistence.prepare(options.resumeSessionId)
      const session = preparation.session
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      preparation[Symbol.dispose]()
      const agent = stubAgent(session)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          disposals.push(session.id)
          unregister()
          detach()
          return Promise.resolve()
        },
      }
    },
  }
  ctx.agents.setFactory(factory)
  // Structural picker fake: the gateway only reads capability(); a stable
  // object per harness mirrors the seam's stability contract.
  const picker: DirectoryPickerCapability = { kind: 'native', pick: async () => null }
  ctx.provide('directoryPicker', { capability: () => picker } as never)
  ctx.provide('sessionTitle', {
    rename: (_session: Session, title: string) => ({ title, eventSeq: 0 }),
  } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
  })
  return { api, ctx, root, persisted, removed, disposals, failures, hold }
}

function stageDir(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path)
  return path
}

describe('session.delete', () => {
  it('deletes a persisted session that is not attached, dropping its log and every registry reference', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-delete-cold-')))
    const dir = stageDir(root, 'project')
    const sessionId = sid('session-cold-delete')
    const { api, removed, disposals } = await harness([
      { meta: { version: 0, id: sessionId, createdAt: 1000, cwd: dir }, events: [] },
    ])

    // The one-time history bootstrap groups the persisted header under a workspace.
    const listed = expectOk(await api.workspace.list(request({})))
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.sessionIds).toEqual([sessionId])

    // Archiving first proves forgetSession also prunes the registry-global set.
    expect(expectOk(await api.workspace.archiveSession(request({ sessionId }))).archivedSessionIds)
      .toEqual([sessionId])

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    expect(expectOk(await api.sessions.delete(request({ sessionId }))).deleted).toBe(true)
    // The archive-set echo precedes the workspace account change.
    const archivedFrame = (await nextHostFrame(stream)).payload
    const accountFrame = (await nextHostFrame(stream)).payload
    abort.abort()

    expect(removed).toEqual([sessionId])
    expect(disposals).toEqual([])
    expect(archivedFrame).toMatchObject({ type: 'host/archived-sessions-changed', archivedSessionIds: [] })
    expect(accountFrame).toMatchObject({
      type: 'host/workspace-changed',
      workspace: { workspaceId: listed.items[0]!.workspaceId, sessionIds: [] },
    })

    const after = expectOk(await api.workspace.list(request({})))
    expect(after.items[0]?.sessionIds).toEqual([])
    expect(after.archivedSessionIds).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).not.toContain(sessionId)

    // The second delete is a definite miss: the log is gone and nothing is live.
    const again = await api.sessions.delete(request({ sessionId }))
    expect(again.result).toMatchObject({ ok: false, error: { code: 'session-not-found', details: { sessionId } } })
  })

  it('disposes the attached agent, removes its log, and streams the paired removal increments', async () => {
    const { api, ctx, root, removed, disposals } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'live') }))).workspace
    const sessionId = sid('session-live-delete')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expect(ctx.agents.get(sessionId)).toBeDefined()

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const removedFrame = nextHostFrame(stream)

    expect(expectOk(await api.sessions.delete(request({ sessionId }))).deleted).toBe(true)
    expect(await removedFrame).toMatchObject({
      payload: { type: 'host/session-removed', sessionId },
    })
    const account = (await nextHostFrame(stream)).payload
    expect(account).toMatchObject({
      type: 'host/workspace-changed',
      workspace: { workspaceId: workspace.workspaceId, sessionIds: [] },
    })
    abort.abort()

    expect(disposals).toEqual([sessionId])
    expect(removed).toEqual([sessionId])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    const after = expectOk(await api.workspace.list(request({})))
    expect(after.items[0]?.sessionIds).toEqual([])

    const again = await api.sessions.delete(request({ sessionId }))
    expect(again.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })

  it('resumes a cold session through the resolver, tracks its handle, and disposes it on delete', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-delete-resume-')))
    const dir = stageDir(root, 'resume')
    const sessionId = sid('session-resume-delete')
    const { api, ctx, removed, disposals } = await harness([
      { meta: { version: 0, id: sessionId, createdAt: 1000, cwd: dir }, events: [] },
    ])

    // A resolver-routed verb cold-resumes the session (the factory mints the
    // handle the resolver hands to onHandle).
    const renamed = await api.sessions.rename(request({ sessionId, title: 'resumed' }))
    expect(renamed.result).toMatchObject({ ok: true, value: { title: 'resumed' } })
    expect(ctx.agents.get(sessionId)).toBeDefined()

    expect(expectOk(await api.sessions.delete(request({ sessionId }))).deleted).toBe(true)
    expect(disposals).toEqual([sessionId])
    expect(removed).toEqual([sessionId])
  })

  it('refuses a live subagent-owned session with the ownership fence', async () => {
    const { api, ctx, removed } = await harness()
    const sessionId = sid('session-subagent-live')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/tmp', origin: 'subagent' } })
    ctx.agents.register(stubAgent(session))

    const response = await api.sessions.delete(request({ sessionId }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'agent-busy', details: { reason: 'use subagent delivery for this child session' } },
    })
    expect(removed).toEqual([])
    expect(ctx.sessions.get(sessionId)).toBeDefined()
    expect(ctx.agents.get(sessionId)).toBeDefined()
  })

  it('refuses an attached subagent session with no live agent', async () => {
    const { api, ctx, removed, disposals } = await harness()
    const sessionId = sid('session-subagent-attached')
    ctx.sessions.create(sessionId, { meta: { cwd: '/tmp', origin: 'subagent' } })

    const response = await api.sessions.delete(request({ sessionId }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'agent-busy' } })
    expect(removed).toEqual([])
    expect(disposals).toEqual([])
    expect(ctx.sessions.get(sessionId)).toBeDefined()
  })

  it('fails loud when a live agent has no owned handle rather than orphaning it', async () => {
    const { api, ctx, removed, disposals } = await harness()
    const sessionId = sid('session-orphan-agent')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/tmp' } })
    // Registered directly: the resolver never minted (and tracked) a handle.
    ctx.agents.register(stubAgent(session))

    const response = await api.sessions.delete(request({ sessionId }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('internal')
    expect(response.result.error.message).toContain('no owned handle to dispose')
    expect(removed).toEqual([])
    expect(disposals).toEqual([])
    expect(ctx.sessions.get(sessionId)).toBeDefined()
    expect(ctx.agents.get(sessionId)).toBeDefined()
  })

  it('folds a persistence-removal failure into internal without claiming the delete', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-delete-fail-')))
    const dir = stageDir(root, 'fail')
    const sessionId = sid('session-remove-fails')
    const h = await harness([
      { meta: { version: 0, id: sessionId, createdAt: 1000, cwd: dir }, events: [] },
    ])
    // Group + archive so there is a registry reference that forgetSession prunes.
    expectOk(await h.api.workspace.list(request({})))
    expect(expectOk(await h.api.workspace.archiveSession(request({ sessionId }))).archivedSessionIds)
      .toEqual([sessionId])
    h.failures.remove = () => new Error('disk full')

    const response = await h.api.sessions.delete(request({ sessionId }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('internal')
    expect(response.result.error.message).toContain('disk full')
    expect(h.removed).toEqual([sessionId])
    expect(h.disposals).toEqual([])
    // forgetSession ran BEFORE the failed removal: the registry no longer
    // references the id, so a surviving log re-indexes cleanly on restart and a
    // retry completes the delete instead of stranding a dangling reference.
    expect(expectOk(await h.api.workspace.list(request({}))).archivedSessionIds).not.toContain(sessionId)
  })

  it('a delete racing an in-flight creation disposes the built agent instead of orphaning it', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-delete-race-')))
    const dir = stageDir(root, 'race')
    const sessionId = sid('session-create-delete-race')
    const h = await harness()
    const workspace = expectOk(await h.api.workspace.create(request({ path: dir }))).workspace

    // Hold the factory so the creation is still in flight when the delete arrives.
    let release = (): void => {}
    h.hold.create = new Promise<void>((resolve) => { release = resolve })
    const creating = h.api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId }))
    const deleting = h.api.sessions.delete(request({ sessionId }))
    // The delete must not resolve before the creation it is waiting on.
    release()

    expectOk(await creating)
    expect(expectOk(await deleting).deleted).toBe(true)
    // The fully-built agent was disposed, not left live with its log removed.
    expect(h.disposals).toEqual([sessionId])
    expect(h.removed).toEqual([sessionId])
    expect(h.ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('a delete waiting on a creation that fails still settles cleanly as not-found', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-delete-race-fail-')))
    const dir = stageDir(root, 'race-fail')
    const sessionId = sid('session-create-fails-race')
    const h = await harness()
    const workspace = expectOk(await h.api.workspace.create(request({ path: dir }))).workspace

    // The held creation will reject; the delete waits for it to settle, then
    // proceeds over the real (empty) state instead of hanging or crashing.
    let fail = (): void => {}
    h.hold.create = new Promise<void>((_resolve, reject) => { fail = () => { reject(new Error('create boom')) } })
    // Keep the rejection handled regardless of when the factory attaches its
    // await, so rejecting before that point does not surface as an unhandled
    // rejection (the factory's await consumes it too; a second handler is inert).
    h.hold.create.catch(() => {})
    const creating = h.api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId }))
    const deleting = h.api.sessions.delete(request({ sessionId }))
    fail()

    expect((await creating).result.ok).toBe(false)
    expect((await deleting).result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    expect(h.disposals).toEqual([])
  })

  it('rejects an id neither live nor persisted as session-not-found', async () => {
    const { api, removed } = await harness()
    const response = await api.sessions.delete(request({ sessionId: sid('session-never-existed') }))
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'session-not-found', details: { sessionId: 'session-never-existed' } },
    })
    expect(removed).toEqual([])
  })
})
