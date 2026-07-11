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
    readImagePng: vi.fn(() => null),
    currentDir: vi.fn(() => '/proj'),
    stage: vi.fn(() => '/proj/.canvas/tmp/paste-b-1.png'),
    ...over
  }
}

describe('clipboardIpc', () => {
  it('clipboard:writeText writes through and verifies by readback', async () => {
    const ipc = fakeIpc()
    // A clipboard that actually lands: readText returns what was last written.
    let held = ''
    const d = deps({
      writeText: vi.fn((t: string) => {
        held = t
      }),
      readText: vi.fn(() => held)
    })
    registerClipboardHandlers(ipc as never, () => null, d)
    const ok = await ipc.handlers['clipboard:writeText'](internal, 'copied')
    expect(d.writeText).toHaveBeenCalledWith('copied')
    expect(d.writeText).toHaveBeenCalledTimes(1) // landed first try → no retries
    expect(ok).toBe(true)
  })

  describe('terminal-copy fix: verified write with retry (Windows silently drops contended writes)', () => {
    it('retries when the readback mismatches and succeeds once the write lands', async () => {
      const ipc = fakeIpc()
      // First two writes are dropped (readback shows stale content), the third lands.
      let held = 'stale'
      let drops = 2
      const d = deps({
        writeText: vi.fn((t: string) => {
          if (drops > 0) drops--
          else held = t
        }),
        readText: vi.fn(() => held)
      })
      registerClipboardHandlers(ipc as never, () => null, d)
      const ok = await ipc.handlers['clipboard:writeText'](internal, 'copied')
      expect(d.writeText).toHaveBeenCalledTimes(3)
      expect(ok).toBe(true)
    })

    it('returns false (honest failure) when every attempt is dropped — renderer keeps the highlight', async () => {
      const ipc = fakeIpc()
      const d = deps({ writeText: vi.fn(), readText: vi.fn(() => 'stale') })
      registerClipboardHandlers(ipc as never, () => null, d)
      const ok = await ipc.handlers['clipboard:writeText'](internal, 'copied')
      expect(d.writeText).toHaveBeenCalledTimes(3)
      expect(ok).toBe(false)
    })
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
      expect(await ipc.handlers['terminal:stageClipboardImage'](foreign, 'b')).toBeNull()
      expect(d.stage).not.toHaveBeenCalled()
      expect(await ipc.handlers['terminal:cleanupStagedImages'](foreign, 'b')).toBe(false)
    })
  })

  describe('untested handlers', () => {
    it('terminal:cleanupStagedImages returns true (no-op) when no project is open', async () => {
      const ipc = fakeIpc()
      registerClipboardHandlers(ipc as never, () => null, deps({ currentDir: () => null }))
      expect(await ipc.handlers['terminal:cleanupStagedImages'](internal, 'b')).toBe(true)
    })
  })

  describe('BUG-025: stageClipboardImage write failure silently drops image paste', () => {
    it('returns null (not throws) when stage throws ENOSPC — IPC handler must not propagate filesystem errors', async () => {
      // Reproduce: stage() throws (e.g. disk full / NTFS permission denied)
      const ipc = fakeIpc()
      const stageFails = vi.fn(() => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      })
      registerClipboardHandlers(
        ipc as never,
        () => null,
        deps({ readImagePng: () => Buffer.from([1, 2]), stage: stageFails })
      )
      // BUG: before the fix, stage() throws out of the ipc.handle callback → rejected invoke
      // → pasteIntoTerminal rejects → void discard → silent failure.
      // AFTER FIX: handler catches the throw and returns null, so invoke resolves to null
      // and pasteIntoTerminal falls through to the text-paste branch.
      const result = await ipc.handlers['terminal:stageClipboardImage'](internal, 'b')
      expect(stageFails).toHaveBeenCalled()
      expect(result).toBeNull()
    })

    it('returns null (not throws) when stage throws EPERM — antivirus / read-only path', async () => {
      const ipc = fakeIpc()
      const stageEperm = vi.fn(() => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      })
      registerClipboardHandlers(
        ipc as never,
        () => null,
        deps({ readImagePng: () => Buffer.from([255, 216]), stage: stageEperm })
      )
      const result = await ipc.handlers['terminal:stageClipboardImage'](internal, 'b')
      expect(stageEperm).toHaveBeenCalled()
      expect(result).toBeNull()
    })
  })
})
