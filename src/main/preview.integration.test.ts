import { describe, it, expect } from 'vitest'
import { registerPreviewHandlers } from './preview'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

// Checklist #17: the preview control channel is shared by all webContents. A
// foreign sender must be rejected so a previewed page can't drive another board's
// native view. preview:open throws; the navigation handlers return false.
describe('registerPreviewHandlers — foreign-sender rejection (#17)', () => {
  const mainFrame = { id: 'main-frame' }
  const foreign = { senderFrame: { id: 'preview-board-frame' } } as unknown as IpcMainInvokeEvent

  function setup(): Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown> {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    const ipcMain = {
      handle: (c: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
        handlers.set(c, fn)
    } as unknown as IpcMain
    const getWin = (): BrowserWindow =>
      ({ webContents: { mainFrame } }) as unknown as BrowserWindow
    registerPreviewHandlers(ipcMain, getWin, 'http://127.0.0.1:0/')
    return handlers
  }

  it('preview:open throws for a foreign sender (no native view created)', () => {
    const handlers = setup()
    expect(() => handlers.get('preview:open')!(foreign, { id: 'b1', bounds: {} })).toThrow(
      /forbidden sender/
    )
  })

  it('preview:navigate returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('preview:navigate')!(foreign, { id: 'b1', url: 'http://x/' })).toBe(false)
  })

  it('preview:goBack returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('preview:goBack')!(foreign, 'b1')).toBe(false)
  })

  it.each([
    ['preview:goForward', ['b1']],
    ['preview:reload', ['b1']]
  ] as const)('%s returns false for a foreign sender', (channel, args) => {
    const handlers = setup()
    expect(handlers.get(channel)!(foreign, ...args)).toBe(false)
  })

  it.each([
    ['preview:setBoundsBatch', [[]]],
    ['preview:detach', ['b1']],
    ['preview:detachAll', []],
    ['preview:attach', [{ id: 'b1', bounds: {} }]],
    ['preview:close', ['b1']],
    ['preview:closeAll', []]
  ] as const)('%s returns true for a foreign sender', (channel, args) => {
    const handlers = setup()
    expect(handlers.get(channel)!(foreign, ...args)).toBe(true)
  })

  it('preview:capture returns null for a foreign sender (async)', async () => {
    const handlers = setup()
    expect(await handlers.get('preview:capture')!(foreign, 'b1')).toBeNull()
  })
})
