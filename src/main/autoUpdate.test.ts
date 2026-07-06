import { describe, it, expect, vi } from 'vitest'
import {
  initAutoUpdate,
  cmpVersion,
  coerceUpdateMeta,
  type UpdaterLike,
  type UpdateStatus,
  type UpdateMeta
} from './autoUpdate'

type EventArg = { version?: string; percent?: number; message?: string }

/** Let all queued microtasks + a macrotask drain — the launch/`update:check` flow is now
 *  async (getMeta → checkForUpdates), so assertions run after this flush. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A fake autoUpdater that records event listeners so the test can fire them. The
 *  vi.fn()s carry concrete implementations so their call signatures satisfy UpdaterLike. */
function makeUpdater() {
  const listeners = new Map<string, (info: EventArg) => void>()
  const checkForUpdates = vi.fn((): Promise<unknown> => Promise.resolve(undefined))
  const downloadUpdate = vi.fn((): Promise<unknown> => Promise.resolve(undefined))
  const quitAndInstall = vi.fn((): void => {})
  const updater: UpdaterLike & { fire: (event: string, info?: EventArg) => void } = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(event, listener) {
      listeners.set(event, listener)
      return updater
    },
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    fire: (event, info) => listeners.get(event)?.(info ?? {})
  }
  return updater
}

/** A fake window whose webContents.send records every pushed status. */
function makeWin(opts: { destroyed?: boolean; wcDestroyed?: boolean } = {}): {
  win: {
    isDestroyed: () => boolean
    webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
  }
  sent: UpdateStatus[]
} {
  const sent: UpdateStatus[] = []
  const send = vi.fn((_ch: string, payload: UpdateStatus) => void sent.push(payload))
  return {
    sent,
    win: {
      isDestroyed: () => opts.destroyed ?? false,
      webContents: { isDestroyed: () => opts.wcDestroyed ?? false, send }
    }
  }
}

/** A fake ipcMain.handle that records the registered handler by channel. */
function makeIpc(): {
  ipc: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void }
  handlers: Map<string, (e: unknown, ...a: unknown[]) => unknown>
} {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  return { handlers, ipc: { handle: (ch, fn) => void handlers.set(ch, fn) } }
}

describe('cmpVersion — dotted numeric compare (0.x.y scheme)', () => {
  it('orders major/minor/patch and ignores pre-release suffixes', () => {
    expect(cmpVersion('0.9.0', '0.10.0')).toBe(-1)
    expect(cmpVersion('0.10.0', '0.9.0')).toBe(1)
    expect(cmpVersion('1.2.3', '1.2.3')).toBe(0)
    expect(cmpVersion('0.9.4', '0.9.4-beta.2')).toBe(0) // suffix stripped
    expect(cmpVersion('0.9', '0.9.1')).toBe(-1) // missing patch treated as 0
  })

  it('never throws on a non-string arg — a malformed floor parses to 0.0.0, never forces', () => {
    // A hand-edited manifest could drop the quotes: `"minSupported": 0.9`. Before the String()
    // root guard this threw `(0.9).split is not a function` inside the sync update handler.
    expect(() => cmpVersion('1.0.0', 0.9 as unknown as string)).not.toThrow()
    expect(cmpVersion('1.0.0', 0.9 as unknown as string)).toBe(1) // 1.0.0 > garbage(→0.0.0)
    expect(() => cmpVersion('1.0.0', null as unknown as string)).not.toThrow()
  })
})

describe('coerceUpdateMeta — runtime schema check on the fetched manifest (fails OPEN)', () => {
  it('passes a well-formed manifest through intact', () => {
    expect(
      coerceUpdateMeta({ minSupported: '0.10.0', tiers: { '0.11.0': 'recommended' } })
    ).toEqual({ minSupported: '0.10.0', tiers: { '0.11.0': 'recommended' } })
  })

  it('drops a non-string minSupported (the crash vector) → no floor', () => {
    // `"minSupported": 0.9` (quotes dropped by a hand edit) must NOT survive to cmpVersion.
    const meta = coerceUpdateMeta({ minSupported: 0.9 })!
    expect(meta.minSupported).toBeUndefined()
  })

  it('keeps only valid version→tier entries, dropping malformed ones', () => {
    expect(
      coerceUpdateMeta({ tiers: { '1.0.0': 'recommended', '2.0.0': 'bogus', '3.0.0': 5 } })
    ).toEqual({ tiers: { '1.0.0': 'recommended' } })
  })

  it('returns null for a non-object payload (array / string / number / null)', () => {
    expect(coerceUpdateMeta(null)).toBeNull()
    expect(coerceUpdateMeta('nope')).toBeNull()
    expect(coerceUpdateMeta(42)).toBeNull()
  })
})

describe('initAutoUpdate — security gate', () => {
  it('is a complete no-op when disabled (unsigned build)', async () => {
    const updater = makeUpdater()
    const getUpdater = vi.fn(() => Promise.resolve(updater))
    const getMeta = vi.fn(() => Promise.resolve<UpdateMeta | null>(null))
    const { ipc, handlers } = makeIpc()
    await initAutoUpdate({
      enabled: false,
      isPackaged: true,
      ipc: ipc as never,
      getWin: () => null,
      currentVersion: '1.0.0',
      getUpdater,
      getMeta
    })
    expect(getUpdater).not.toHaveBeenCalled() // electron-updater is never even imported
    expect(getMeta).not.toHaveBeenCalled()
    expect(handlers.size).toBe(0) // no update:* handlers registered
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('is a no-op when not packaged (dev build), even if enabled', async () => {
    const updater = makeUpdater()
    const getUpdater = vi.fn(() => Promise.resolve(updater))
    const { ipc, handlers } = makeIpc()
    await initAutoUpdate({
      enabled: true,
      isPackaged: false,
      ipc: ipc as never,
      getWin: () => null,
      currentVersion: '1.0.0',
      getUpdater,
      getMeta: () => Promise.resolve(null)
    })
    expect(getUpdater).not.toHaveBeenCalled()
    expect(handlers.size).toBe(0)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })
})

describe('initAutoUpdate — wired (signed production build)', () => {
  async function setup(opts?: {
    winOpts?: { destroyed?: boolean; wcDestroyed?: boolean }
    currentVersion?: string
    meta?: UpdateMeta | null
    metaReject?: boolean
  }): Promise<{
    updater: ReturnType<typeof makeUpdater>
    sent: UpdateStatus[]
    handlers: Map<string, (e: unknown, ...a: unknown[]) => unknown>
    logError: ReturnType<typeof vi.fn>
    getMeta: ReturnType<typeof vi.fn>
  }> {
    const updater = makeUpdater()
    const { win, sent } = makeWin(opts?.winOpts)
    const { ipc, handlers } = makeIpc()
    const logError = vi.fn()
    const getMeta = vi.fn(() =>
      opts?.metaReject
        ? Promise.reject<UpdateMeta | null>(new Error('feed down'))
        : Promise.resolve<UpdateMeta | null>(opts?.meta ?? null)
    )
    await initAutoUpdate({
      enabled: true,
      isPackaged: true,
      ipc: ipc as never,
      getWin: () => win as never,
      currentVersion: opts?.currentVersion ?? '1.0.0',
      getUpdater: () => Promise.resolve(updater),
      getMeta,
      logError
    })
    await flush() // drain the launch check (getMeta → checkForUpdates)
    return { updater, sent, handlers, logError, getMeta }
  }

  it('manual model: NO auto-download, but kicks off the first (silent) check', async () => {
    const { updater, getMeta } = await setup()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(getMeta).toHaveBeenCalledTimes(1) // meta refreshed before the check
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    // The launch check must NOT auto-download — the user drives that.
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('forwards each updater event; an untagged update is optional', async () => {
    const { updater, sent } = await setup()
    updater.fire('checking-for-update')
    updater.fire('update-available', { version: '1.2.3' })
    updater.fire('update-not-available')
    updater.fire('download-progress', { percent: 42.7 })
    updater.fire('update-downloaded', { version: '1.2.3' })
    expect(sent).toEqual([
      { state: 'checking' },
      { state: 'available', version: '1.2.3', tier: 'optional' },
      { state: 'none' },
      { state: 'downloading', percent: 43 },
      { state: 'ready', version: '1.2.3' }
    ])
  })

  it('tags a recommended release from the tier manifest', async () => {
    const { updater, sent } = await setup({ meta: { tiers: { '1.2.3': 'recommended' } } })
    updater.fire('update-available', { version: '1.2.3' })
    expect(sent).toEqual([{ state: 'available', version: '1.2.3', tier: 'recommended' }])
  })

  it('emits mandatory when the running version is below the minSupported floor', async () => {
    const { updater, sent } = await setup({
      currentVersion: '0.9.0',
      meta: { minSupported: '0.10.0', tiers: { '0.11.0': 'recommended' } }
    })
    // Below the floor → forced, regardless of the release's own (recommended) tag.
    updater.fire('update-available', { version: '0.11.0' })
    expect(sent).toEqual([{ state: 'mandatory', version: '0.11.0' }])
  })

  it('at/above the floor is NOT forced (floor is strict-less-than)', async () => {
    const { updater, sent } = await setup({
      currentVersion: '0.10.0',
      meta: { minSupported: '0.10.0' }
    })
    updater.fire('update-available', { version: '0.11.0' })
    expect(sent).toEqual([{ state: 'available', version: '0.11.0', tier: 'optional' }])
  })

  it('fails OPEN on a MALFORMED (not merely unreachable) manifest — never throws or forces', async () => {
    // A corrupted/hand-edited manifest with a non-string floor. The `update-available` handler
    // is SYNC and electron-updater invokes it inside its own async flow, so a throw here would
    // surface as an unhandled rejection and crash main (Node 22 throw-default). It must not.
    const { updater, sent } = await setup({
      currentVersion: '0.0.1',
      meta: { minSupported: 0.9, tiers: 'nope' } as unknown as UpdateMeta
    })
    expect(() => updater.fire('update-available', { version: '9.9.9' })).not.toThrow()
    expect(sent).toEqual([{ state: 'available', version: '9.9.9', tier: 'optional' }])
  })

  it('fails OPEN when the tier manifest is unreachable — never a spurious force', async () => {
    const { updater, sent, logError } = await setup({ currentVersion: '0.0.1', metaReject: true })
    // Even a very old version can't be forced when the floor can't be read.
    updater.fire('update-available', { version: '9.9.9' })
    expect(sent).toEqual([{ state: 'available', version: '9.9.9', tier: 'optional' }])
    expect(logError).toHaveBeenCalled() // the fetch failure is logged, not thrown
    // The check still ran despite the meta failure.
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('forwards an error event + logs it', async () => {
    const { updater, sent, logError } = await setup()
    updater.fire('error', { message: 'feed unreachable' })
    expect(sent).toEqual([{ state: 'error', message: 'feed unreachable' }])
    expect(logError).toHaveBeenCalled()
  })

  it('never throws / sends when the window is destroyed', async () => {
    const { updater, sent } = await setup({ winOpts: { destroyed: true } })
    expect(() => updater.fire('update-downloaded', { version: '9' })).not.toThrow()
    expect(sent).toEqual([])
  })

  it('update:check re-checks the feed for the trusted main frame; denies a foreign sender', async () => {
    const { updater, handlers } = await setup()
    const check = handlers.get('update:check')!
    expect(check).toBeTypeOf('function')
    // Boot check already ran once. No senderFrame → internal/trusted → allowed → now twice.
    expect(check({})).toBe(true)
    await flush()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    // Foreign sender → denied, no extra check.
    expect(check({ senderFrame: { foreign: true } })).toBe(false)
    await flush()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('update:download starts the download for the trusted main frame; denies a foreign sender', async () => {
    const { updater, handlers } = await setup()
    const download = handlers.get('update:download')!
    expect(download).toBeTypeOf('function')
    expect(download({})).toBe(true)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(download({ senderFrame: { foreign: true } })).toBe(false)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('update:install calls quitAndInstall for the trusted main frame', async () => {
    const { updater, handlers } = await setup()
    const install = handlers.get('update:install')!
    expect(install).toBeTypeOf('function')
    // No senderFrame → synthetic/internal call → allowed (isForeignSender returns false).
    const result = install({})
    expect(result).toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('update:install denies a foreign sender (does not install)', async () => {
    const { updater, handlers } = await setup()
    const install = handlers.get('update:install')!
    // A senderFrame that is not the window's main frame → foreign → denied.
    const result = install({ senderFrame: { foreign: true } })
    expect(result).toBe(false)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })
})
