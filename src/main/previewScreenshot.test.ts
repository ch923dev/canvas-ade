import { describe, it, expect, vi } from 'vitest'
import { registerPreviewScreenshotHandler, type ScreenshotDeps } from './previewScreenshot'

// Minimal ipcMain capture (mirrors clipboardIpc.test.ts style).
function makeIpc(): {
  ipc: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void }
  invoke: (ch: string, e: unknown, ...a: unknown[]) => unknown
} {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  return {
    ipc: { handle: (ch, fn) => handlers.set(ch, fn) },
    invoke: (ch, e, ...a) => handlers.get(ch)!(e, ...a)
  }
}

const PNG = Buffer.from([1, 2, 3])
function deps(over: Partial<ScreenshotDeps> = {}): ScreenshotDeps {
  return {
    capture: vi.fn(async () => PNG),
    writeImage: vi.fn(),
    currentDir: vi.fn(() => '/proj'),
    saveAsset: vi.fn(async () => ({ assetId: 'assets/abc.png' })),
    ...over
  }
}

// No senderFrame -> isForeignSender returns false (internal/allowed), like the e2e harness.
// (See ipcGuard.ts: `if (!e.senderFrame) return false`)
const validEvent = {}
// Truthy senderFrame + getWin()=null -> isForeignSender returns true (foreign).
// (See clipboardIpc.test.ts `foreign` and ipcGuard.ts guard logic)
const foreignEvent = { senderFrame: {} }

describe('preview:screenshot', () => {
  it('copies to clipboard AND saves an asset when a project is open', async () => {
    const m = makeIpc()
    const d = deps()
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).toHaveBeenCalledWith(PNG)
    expect(d.saveAsset).toHaveBeenCalledWith('/proj', PNG, 'png')
    expect(res).toEqual({ ok: true, assetId: 'assets/abc.png' })
  })

  it('copies to clipboard only when no project is open', async () => {
    const m = makeIpc()
    const d = deps({ currentDir: () => null })
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).toHaveBeenCalled()
    expect(d.saveAsset).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, assetId: null })
  })

  it('returns not-live when the view is detached/off-screen (capture null)', async () => {
    const m = makeIpc()
    const d = deps({ capture: async () => null })
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: false, reason: 'not-live' })
  })

  it('still reports success (assetId null) when the file write fails', async () => {
    const m = makeIpc()
    const d = deps({
      saveAsset: async () => {
        throw new Error('ENOSPC')
      }
    })
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).toHaveBeenCalled()
    expect(res).toEqual({ ok: true, assetId: null })
  })

  it('rejects a foreign sender (no capture, no clipboard)', async () => {
    const m = makeIpc()
    const d = deps()
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', foreignEvent, 'b1')
    expect(d.capture).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: false, reason: 'forbidden' })
  })
})
