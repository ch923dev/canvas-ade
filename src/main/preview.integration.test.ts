import { describe, it, expect } from 'vitest'
import { registerPreviewHandlers } from './preview'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'

// Checklist #17: the preview control channel is shared by all webContents. A
// foreign sender must be rejected so a previewed page can't drive another board's
// native view. preview:open throws; the navigation handlers return false.
describe('registerPreviewHandlers — foreign-sender rejection (#17)', () => {
  function setup(): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')
    return cap
  }

  it('preview:open throws for a foreign sender (no native view created)', () => {
    const cap = setup()
    expect(() => cap.invokeAs(foreignEvent, 'preview:open', { id: 'b1', bounds: {} })).toThrow(
      /forbidden sender/
    )
  })

  it('preview:navigate returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'preview:navigate', { id: 'b1', url: 'http://x/' })).toBe(
      false
    )
  })

  it('preview:goBack returns false for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'preview:goBack', 'b1')).toBe(false)
  })

  it.each([
    ['preview:goForward', ['b1']],
    ['preview:reload', ['b1']]
  ] as const)('%s returns false for a foreign sender', (channel, args) => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, channel, ...args)).toBe(false)
  })

  it.each([
    ['preview:setBoundsBatch', [[]]],
    ['preview:detach', ['b1']],
    ['preview:detachAll', []],
    ['preview:attach', [{ id: 'b1', bounds: {} }]],
    ['preview:close', ['b1']],
    ['preview:closeAll', []]
  ] as const)('%s returns true for a foreign sender', (channel, args) => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, channel, ...args)).toBe(true)
  })

  it('preview:capture returns null for a foreign sender (async)', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'preview:capture', 'b1')).toBeNull()
  })
})
