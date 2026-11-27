/**
 * Background-job plugin, browser half: contributes one session-header action
 * that renders this session's `ctx.jobs` records. The data arrives entirely
 * through the `jobsBySession` list mirror, so the plugin issues no RPC and
 * holds no state of its own beyond popover visibility.
 */
import type { ClientContext, JobView, SessionId } from '@neo/client-runtime/client'
import { JobListAction, type JobListInjected } from './JobListAction.tsx'
import type {} from '@neo/client-locale/client'
import { en, es, NS, zh, type JobKey } from './locales.ts'

declare module '@neo/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}

export type { JobListActionProps, JobListInjected } from './JobListAction.tsx'

/** Required services for locale registration and header-slot contribution. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, es }), 'ui-job: dictionaries')
  const jobActions = (): JobListInjected => ({
    killJob(sessionId: SessionId, jobId: JobView['id']) {
      // Fire-and-return: the row settles through the `session/jobs` feed once
      // the job stops. `killJob` folds transport errors to a failed result
      // (never a rejection) and the list has no error strip, so a transient
      // failure is dropped — the user can click again.
      void ctx.sessions.killJob(sessionId, jobId)
    },
  })
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'job-list',
      // After the subagent catalog: session lineage reads before process work.
      order: 20,
      locale: NS,
      inject: jobActions,
    }, JobListAction),
  )
}
