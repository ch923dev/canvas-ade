import { describe, it, expect } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

// The single IPC trust-boundary guard (was copy-pasted in preview/projectIpc/pty/llmIpc).
// Adopts preview's robust shape: a window can resolve while its webContents is already
// destroyed during shutdown (a late in-flight invoke racing teardown), and touching
// `.webContents.mainFrame` then throws — so an unresolved OR destroyed window must DENY
// WITHOUT touching the frame.
describe('isForeignSender', () => {
  const mainFrame = { name: 'main' } as unknown as IpcMainInvokeEvent['senderFrame']
  const foreignFrame = { name: 'foreign' } as unknown as IpcMainInvokeEvent['senderFrame']
  const liveWin = (): BrowserWindow =>
    ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame }
    }) as unknown as BrowserWindow

  it('allows a synthetic/internal call (no senderFrame)', () => {
    expect(isForeignSender({ senderFrame: null }, () => liveWin())).toBe(false)
  })

  it('blocks a real foreign frame', () => {
    expect(isForeignSender({ senderFrame: foreignFrame }, () => liveWin())).toBe(true)
  })

  it('allows the live main frame', () => {
    expect(isForeignSender({ senderFrame: mainFrame }, () => liveWin())).toBe(false)
  })

  it('denies a real sender when the window is unresolved (getWin → null)', () => {
    expect(isForeignSender({ senderFrame: mainFrame }, () => null)).toBe(true)
  })

  it('denies WITHOUT touching .mainFrame when the window itself is destroyed', () => {
    const destroyed = {
      isDestroyed: () => true,
      webContents: {
        isDestroyed: () => false,
        get mainFrame(): never {
          throw new Error('Object has been destroyed')
        }
      }
    } as unknown as BrowserWindow
    expect(isForeignSender({ senderFrame: mainFrame }, () => destroyed)).toBe(true)
  })

  it('denies WITHOUT touching .mainFrame when only the webContents is destroyed', () => {
    const wcDestroyed = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => true,
        get mainFrame(): never {
          throw new Error('Object has been destroyed')
        }
      }
    } as unknown as BrowserWindow
    expect(isForeignSender({ senderFrame: mainFrame }, () => wcDestroyed)).toBe(true)
  })
})
