// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@neo/client-web-react'
import { WelcomeNotice } from '../src/client/WelcomeNotice.tsx'
import type { WelcomeNoticeProps } from '../src/client/WelcomeNotice.tsx'
import { WelcomeNoticeStore } from '../src/client/welcome-store.ts'
import { OnboardingModal } from '../src/client/OnboardingModal.tsx'
import { en, zh } from '../src/client/locales.ts'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_COPY, WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

function response<T>(value: T) {
  return { rpcId: 'welcome-rpc' as never, result: { ok: true as const, value } }
}

function mount(version?: string, mutateImpl: () => Promise<unknown> = () => Promise.resolve(response({}))) {
  const appRoot = document.createElement('div')
  appRoot.id = 'root'
  document.body.append(appRoot)
  const mutate = vi.fn(mutateImpl)
  const api = {
    settings: {
      describe: () => Promise.resolve(response({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
          schema: {},
          value: version === undefined ? {} : { [WELCOME_NOTICE_ACK_FIELD]: version },
          base: {},
          user: {},
          applies: 'live' as const,
          secrets: [],
          revision: 0,
        }],
      })),
      mutate,
    },
  }
  const controller = new WelcomeNoticeStore(api as never)
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: WelcomeNoticeProps = {
    stepId: 'welcome-notice',
    complete,
    openSection: vi.fn(),
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    controller,
    useWelcome: bindSnapshotSelector(controller.store),
    t: key => zh[key],
  }
  return { ...render(<WelcomeNotice {...props} />), complete, controller, mutate, appRoot }
}

describe('WelcomeNotice', () => {
  it('uses the exact owner copy in both GUI locales', () => {
    expect(WELCOME_NOTICE_COPY.en).toEqual({
      title: 'Welcome to NEO',
      body: 'NEO is a private, local-first agent harness for offensive security. It runs entirely on your own infrastructure — a local model reasons, a local toolkit executes, and nothing leaves the box.\n\nFree your mind.',
      continueLabel: 'Continue',
    })
    expect(en.welcomeBody).toBe(WELCOME_NOTICE_COPY.en.body)
    expect(zh.welcomeBody).toBe(WELCOME_NOTICE_COPY.zh.body)
  })

  it('renders one blocking modal action and focuses the title', async () => {
    const h = mount()
    const dialog = await screen.findByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    for (const paragraph of WELCOME_NOTICE_COPY.zh.body.split('\n\n')) {
      expect(screen.getByText(paragraph, { exact: true })).toBeTruthy()
    }
    expect(dialog.querySelectorAll('p')).toHaveLength(2)
    expect(dialog.querySelectorAll('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: WELCOME_NOTICE_COPY.zh.title }))
    expect(h.appRoot.inert).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('[class*="mask"]')!)
    expect(h.complete).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('completes only after the acknowledgement write commits', async () => {
    const h = mount()
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }))
    await act(async () => { await Promise.resolve() })
    expect(h.mutate).toHaveBeenCalledOnce()
    expect(h.complete).toHaveBeenCalledOnce()
  })

  it('skips itself when this exact version was already acknowledged', async () => {
    const h = mount(WELCOME_NOTICE_VERSION)
    await act(async () => { await h.controller.load() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.complete).toHaveBeenCalledOnce()
  })

  it('keeps the sole action disabled while saving and reports a refused write', async () => {
    let resolveWrite!: (value: unknown) => void
    const write = new Promise<unknown>((resolve) => { resolveWrite = resolve })
    const h = mount(undefined, () => write)
    await screen.findByRole('dialog')
    const action = screen.getByRole<HTMLButtonElement>('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel })
    fireEvent.click(action)
    expect(action.disabled).toBe(true)
    resolveWrite({
      rpcId: 'welcome-refused' as never,
      result: {
        ok: false,
        error: {
          code: 'settings-rejected',
          message: 'read only',
          details: { ns: WELCOME_NOTICE_SETTINGS_NAMESPACE },
        },
      },
    })
    expect((await screen.findByRole('alert')).textContent).toBe(zh.welcomeError)
    expect(h.complete).not.toHaveBeenCalled()
  })
})

describe('OnboardingModal', () => {
  it('keeps focus on the control a step focuses and leaves the title out of the tab order', () => {
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const before = appRoot.inert
    const view = render(
      <OnboardingModal title="Choose a model">
        <input aria-label="Model" autoFocus />
      </OnboardingModal>,
    )

    expect(screen.getByRole('dialog', { name: 'Choose a model' })).toBeTruthy()
    // Without `focusTitle` the modal does not pull focus to its heading, which
    // the welcome step above relies on the opposite way.
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Model' }))
    expect(screen.getByRole('heading', { name: 'Choose a model' }).hasAttribute('tabindex')).toBe(false)
    expect(appRoot.inert).toBe(true)

    // Closing the step hands the application root back as it found it.
    view.unmount()
    expect(appRoot.inert).toBe(before)
  })

  it('still opens in a document that has no application root to make inert', () => {
    expect(document.getElementById('root')).toBeNull()
    const view = render(<OnboardingModal title="Welcome"><p>Step body</p></OnboardingModal>)

    expect(screen.getByRole('dialog', { name: 'Welcome' })).toBeTruthy()
    expect(screen.getByText('Step body')).toBeTruthy()
    view.unmount()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
