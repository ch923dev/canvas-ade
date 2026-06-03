/**
 * Test-only helper for MAIN-process IPC integration tests. Captures the handlers a
 * register*Handlers(ipcMain, …) call registers via ipcMain.handle, so a test can
 * invoke a handler directly with a chosen sender — no Electron boot. Pairs with the
 * sender fixtures below to exercise the foreign-sender guard (checklist #17/#20).
 *
 * NOT production code: nothing under src/main/*.ts (non-test) may import this, so
 * electron-vite tree-shakes it out of the app bundle. Vitest ignores it (no
 * `.test.` infix); it is only typechecked under tsconfig.node.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

export type IpcHandler = (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown

export interface IpcCapture {
  /** Pass this where the production code expects Electron's ipcMain. */
  ipcMain: IpcMain
  /** Every channel registered via ipcMain.handle, keyed by channel name. */
  handlers: Map<string, IpcHandler>
  /** Invoke a captured handler as an internal/trusted caller (no senderFrame). */
  invoke: (channel: string, ...args: unknown[]) => unknown
  /** Invoke a captured handler as a specific sender (e.g. foreignEvent). */
  invokeAs: (event: IpcMainInvokeEvent, channel: string, ...args: unknown[]) => unknown
}

/** A minimal ipcMain stub that records `handle` registrations for direct invocation. */
export function createIpcCapture(): IpcCapture {
  const handlers = new Map<string, IpcHandler>()
  const ipcMain = {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn)
    }
  } as unknown as IpcMain
  const run = (event: IpcMainInvokeEvent, channel: string, args: unknown[]): unknown => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn(event, ...args)
  }
  return {
    ipcMain,
    handlers,
    invoke: (channel, ...args) => run(internalEvent, channel, args),
    invokeAs: (event, channel, ...args) => run(event, channel, args)
  }
}

/** The trusted main-window frame identity the guard compares against. */
export const mainFrame = { id: 'main-frame' }

/** A synthetic/internal call (no senderFrame) — the guard treats it as trusted. */
export const internalEvent = { senderFrame: undefined } as unknown as IpcMainInvokeEvent

/** A real sender that is NOT the main frame (e.g. a preview board) — must be rejected. */
export const foreignEvent = {
  senderFrame: { id: 'preview-board-frame' }
} as unknown as IpcMainInvokeEvent

/** A getWin whose window resolves to the trusted mainFrame (for guard comparison).
 * Carries `isDestroyed: () => false` on the window and webContents so the hardened
 * `isForeignSender` (which guards a torn-down window before touching `.mainFrame`)
 * sees a live window. */
export const mainWin = (): BrowserWindow =>
  ({
    isDestroyed: () => false,
    webContents: { mainFrame, isDestroyed: () => false }
  }) as unknown as BrowserWindow
