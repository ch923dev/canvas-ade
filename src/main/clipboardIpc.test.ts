// src/main/clipboardIpc.test.ts
import { describe, it, expect, vi } from 'vitest'
import { registerClipboardHandlers, type ClipboardDeps } from './clipboardIpc'

type Handler = (e: { senderFrame?: unknown }, ...args: unknown[]) => unknown
function fakeIpc(): { handlers: Record<string, Handler>; handle: (c: string, h: Handler) => void } {
  const handlers: Record<string, Handler> = {}
  return { handlers, handle: (c, h) => (handlers[c] = h) }
}
// No senderFrame → isForeignSender returns false (internal/allowed), like the e2e harness.
const internal = {}

function deps(over: Partial<ClipboardDeps> = {}): ClipboardDeps {
  return {
    writeText: vi.fn(),
    readText: vi.fn(() => 'hello'),
    hasImage: vi.fn(() => false),
    readImagePng: vi.fn(() => null),
    currentDir: vi.fn(() => '/proj'),
    stage: vi.fn(() => '/proj/.canvas/tmp/paste-b-1.png'),
    ...over
  }
}

describe('clipboardIpc', () => {
  it('clipboard:writeText writes through to deps', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerClipboardHandlers(ipc as never, () => null, d)
    const ok = await ipc.handlers['clipboard:writeText'](internal, 'copied')
    expect(d.writeText).toHaveBeenCalledWith('copied')
    expect(ok).toBe(true)
  })

  it('clipboard:readText returns the clipboard text', async () => {
    const ipc = fakeIpc()
    registerClipboardHandlers(ipc as never, () => null, deps())
    expect(await ipc.handlers['clipboard:readText'](internal)).toBe('hello')
  })

  it('stageClipboardImage returns null when no image', async () => {
    const ipc = fakeIpc()
    registerClipboardHandlers(ipc as never, () => null, deps({ readImagePng: () => null }))
    expect(await ipc.handlers['terminal:stageClipboardImage'](internal, 'b')).toBeNull()
  })

  it('stageClipboardImage returns null when no project is open', async () => {
    const ipc = fakeIpc()
    registerClipboardHandlers(
      ipc as never,
      () => null,
      deps({ readImagePng: () => Buffer.from([1]), currentDir: () => null })
    )
    expect(await ipc.handlers['terminal:stageClipboardImage'](internal, 'b')).toBeNull()
  })

  it('stageClipboardImage stages the PNG and returns its path', async () => {
    const ipc = fakeIpc()
    const stage = vi.fn(() => '/proj/.canvas/tmp/paste-b-1.png')
    registerClipboardHandlers(
      ipc as never,
      () => null,
      deps({ readImagePng: () => Buffer.from([1, 2]), stage })
    )
    const p = await ipc.handlers['terminal:stageClipboardImage'](internal, 'b')
    expect(stage).toHaveBeenCalledWith('/proj', 'b', Buffer.from([1, 2]))
    expect(p).toBe('/proj/.canvas/tmp/paste-b-1.png')
  })

  describe('foreign-sender rejection', () => {
    const foreign = { senderFrame: {} } // truthy senderFrame + getWin()=null → isForeignSender true

    it('every handler denies a foreign sender with a safe value', async () => {
      const ipc = fakeIpc()
      const d = deps({ readImagePng: () => Buffer.from([1]) })
      registerClipboardHandlers(ipc as never, () => null, d)
      expect(await ipc.handlers['clipboard:writeText'](foreign, 'x')).toBe(false)
      expect(d.writeText).not.toHaveBeenCalled()
      expect(await ipc.handlers['clipboard:readText'](foreign)).toBe('')
      expect(await ipc.handlers['clipboard:hasImage'](foreign)).toBe(false)
      expect(await ipc.handlers['terminal:stageClipboardImage'](foreign, 'b')).toBeNull()
      expect(d.stage).not.toHaveBeenCalled()
      expect(await ipc.handlers['terminal:cleanupStagedImages'](foreign, 'b')).toBe(false)
    })
  })

  describe('untested handlers', () => {
    it('clipboard:hasImage returns the deps value', async () => {
      const ipc = fakeIpc()
      registerClipboardHandlers(ipc as never, () => null, deps({ hasImage: () => true }))
      expect(await ipc.handlers['clipboard:hasImage'](internal)).toBe(true)
    })

    it('terminal:cleanupStagedImages returns true (no-op) when no project is open', async () => {
      const ipc = fakeIpc()
      registerClipboardHandlers(ipc as never, () => null, deps({ currentDir: () => null }))
      expect(await ipc.handlers['terminal:cleanupStagedImages'](internal, 'b')).toBe(true)
    })
  })
})
