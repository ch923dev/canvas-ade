import { describe, it, expect, vi } from 'vitest'
import { initAutoUpdate, type UpdaterLike, type UpdateStatus } from './autoUpdate'

type EventArg = { version?: string; percent?: number; message?: string }

/** A fake autoUpdater that records event listeners so the test can fire them. The
 *  vi.fn()s carry concrete implementations so their call signatures satisfy UpdaterLike. */
function makeUpdater() {
  const listeners = new Map<string, (info: EventArg) => void>()
  const checkForUpdates = vi.fn((): Promise<unknown> => Promise.resolve(undefined))
  const quitAndInstall = vi.fn((): void => {})
  const updater: UpdaterLike & { fire: (event: string, info?: EventArg) => void } = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on(event, listener) {
      listeners.set(event, listener)
      return updater
    },
    checkForUpdates,
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

describe('initAutoUpdate — security gate', () => {
  it('is a complete no-op when disabled (unsigned build)', async () => {
    const updater = makeUpdater()
    const getUpdater = vi.fn(() => Promise.resolve(updater))
    const { ipc, handlers } = makeIpc()
    await initAutoUpdate({
      enabled: false,
      isPackaged: true,
      ipc: ipc as never,
      getWin: () => null,
      getUpdater
    })
    expect(getUpdater).not.toHaveBeenCalled() // electron-updater is never even imported
    expect(handlers.size).toBe(0) // no update:install handler registered
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
      getUpdater
    })
    expect(getUpdater).not.toHaveBeenCalled()
    expect(handlers.size).toBe(0)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })
})

describe('initAutoUpdate — wired (signed production build)', () => {
  async function setup(winOpts?: { destroyed?: boolean; wcDestroyed?: boolean }): Promise<{
    updater: ReturnType<typeof makeUpdater>
    sent: UpdateStatus[]
    handlers: Map<string, (e: unknown, ...a: unknown[]) => unknown>
    logError: ReturnType<typeof vi.fn>
  }> {
    const updater = makeUpdater()
    const { win, sent } = makeWin(winOpts)
    const { ipc, handlers } = makeIpc()
    const logError = vi.fn()
    await initAutoUpdate({
      enabled: true,
      isPackaged: true,
      ipc: ipc as never,
      getWin: () => win as never,
      getUpdater: () => Promise.resolve(updater),
      logError
    })
    return { updater, sent, handlers, logError }
  }

  it('configures auto-download + kicks off the first check', async () => {
    const { updater } = await setup()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('forwards each updater event as the right renderer status', async () => {
    const { updater, sent } = await setup()
    updater.fire('checking-for-update')
    updater.fire('update-available', { version: '1.2.3' })
    updater.fire('update-not-available')
    updater.fire('download-progress', { percent: 42.7 })
    updater.fire('update-downloaded', { version: '1.2.3' })
    expect(sent).toEqual([
      { state: 'checking' },
      { state: 'available', version: '1.2.3' },
      { state: 'none' },
      { state: 'downloading', percent: 43 },
      { state: 'ready', version: '1.2.3' }
    ])
  })

  it('forwards an error event + logs it', async () => {
    const { updater, sent, logError } = await setup()
    updater.fire('error', { message: 'feed unreachable' })
    expect(sent).toEqual([{ state: 'error', message: 'feed unreachable' }])
    expect(logError).toHaveBeenCalled()
  })

  it('never throws / sends when the window is destroyed', async () => {
    const { updater, sent } = await setup({ destroyed: true })
    expect(() => updater.fire('update-downloaded', { version: '9' })).not.toThrow()
    expect(sent).toEqual([])
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
