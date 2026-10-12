import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NEO_HOME_DISPLAY,
  NEO_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultNeoHome,
  neoHomeDisplay,
  neoHomePath,
  expandHomePath,
  resolveNeoHome,
} from '@neo/home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default NEO home directory name', () => {
    expect(NEO_HOME_DIR_NAME).toBe('.neo')
    expect(DEFAULT_NEO_HOME_DISPLAY).toBe('~/.neo')
    expect(defaultNeoHome()).toBe(join(homedir(), '.neo'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.neo')).toBe(join(homedir(), '.neo'))
    expect(expandHomePath('~\\.neo')).toBe(join(homedir(), '.neo'))
    expect(expandHomePath('/tmp/.neo')).toBe('/tmp/.neo')
    expect(expandHomePath('~other/.neo')).toBe('~other/.neo')
  })

  it('resolves explicit path before NEO_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveNeoHome('/tmp/explicit-dsh', { NEO_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveNeoHome(undefined, { NEO_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveNeoHome(undefined, {})).toBe(defaultNeoHome())
  })

  it('treats an empty or whitespace-only NEO_HOME as unset', () => {
    expect(resolveNeoHome(undefined, { NEO_HOME: '' })).toBe(defaultNeoHome())
    expect(resolveNeoHome(undefined, { NEO_HOME: '   ' })).toBe(defaultNeoHome())
  })

  it('joins child segments onto the resolved NEO_HOME', () => {
    vi.stubEnv('NEO_HOME', '~/env-dsh')
    expect(neoHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(neoHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(neoHomeDisplay(resolve(defaultNeoHome()))).toBe('~/.neo')
    expect(neoHomeDisplay('/some/other/root')).toBe('$NEO_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
