import { describe, it, expect } from 'vitest'
import { registerPtyHandlers } from './pty'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

// Checklist #17 + #20 (Browser↛PTY): the PTY control channel is shared by ALL
// webContents, including per-board preview WebContentsViews that load untrusted
// localhost pages. A foreign sender (anything that isn't the main window's main
// frame) must be REJECTED — a previewed page must never be able to spawn or kill
// a shell. This proves the guard is wired into the handlers, not just that the
// pure isForeignSender works.
describe('registerPtyHandlers — foreign-sender rejection (#17/#20 Browser↛PTY)', () => {
  const mainFrame = { id: 'main-frame' }
  // A preview/browser board's frame — a real sender that is NOT the main frame.
  const foreign = { senderFrame: { id: 'preview-board-frame' } } as unknown as IpcMainInvokeEvent

  function setup(): Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown> {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    const ipcMain = {
      handle: (c: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
        handlers.set(c, fn)
    } as unknown as IpcMain
    const getWin = (): BrowserWindow => ({ webContents: { mainFrame } }) as unknown as BrowserWindow
    registerPtyHandlers(ipcMain, getWin)
    return handlers
  }

  it('pty:spawn throws for a foreign sender (no shell is spawned)', () => {
    const handlers = setup()
    expect(() => handlers.get('pty:spawn')!(foreign, { id: 'b1' })).toThrow(/forbidden sender/)
  })

  it('pty:kill returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:kill')!(foreign, 'b1')).toBe(false)
  })

  it('pty:shells returns [] for a foreign sender (no shell enumeration leaked)', () => {
    const handlers = setup()
    expect(handlers.get('pty:shells')!(foreign)).toEqual([])
  })

  it('terminal:detectPorts returns [] for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('terminal:detectPorts')!(foreign, 'b1')).toEqual([])
  })

  it('pty:disposeAll returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:disposeAll')!(foreign)).toBe(false)
  })

  it('pty:park returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:park')!(foreign, 'b1')).toBe(false)
  })

  it('pty:adopt returns { adopted: false } for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:adopt')!(foreign, 'b1')).toEqual({ adopted: false })
  })
})
