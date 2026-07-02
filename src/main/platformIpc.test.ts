// src/main/platformIpc.test.ts
// Unit coverage for the pure Windows-build parser behind the A-Win xterm windowsPty hint, plus the
// frame-guard on the `platform:winBuild` sync IPC channel (BUG-045: this was the one handler in the
// codebase that answered any sender unconditionally).
import { describe, it, expect } from 'vitest'
import { release } from 'os'
import { winBuildFromRelease, registerPlatformIpc } from './platformIpc'

describe('winBuildFromRelease — parse the build from os.release()', () => {
  it('extracts the build segment from a Windows release string', () => {
    expect(winBuildFromRelease('10.0.22631')).toBe(22631) // Win 11 23H2
    expect(winBuildFromRelease('10.0.19045')).toBe(19045) // Win 10 22H2
    expect(winBuildFromRelease('10.0.26100')).toBe(26100) // Win 11 24H2
  })

  it('tolerates a trailing build-revision suffix', () => {
    expect(winBuildFromRelease('10.0.22631.4317')).toBe(22631)
  })

  it('returns null for unparseable release strings (only ever called on win32, where release() is "10.0.BUILD")', () => {
    expect(winBuildFromRelease('')).toBeNull()
    expect(winBuildFromRelease('garbage')).toBeNull()
    expect(winBuildFromRelease('10.0')).toBeNull() // no build segment
  })
})

describe('registerPlatformIpc — frame-guarded platform:winBuild (BUG-045)', () => {
  type Handler = (e: { senderFrame?: unknown; returnValue?: unknown }) => void
  function fakeIpc(): { handlers: Record<string, Handler>; on: (c: string, h: Handler) => void } {
    const handlers: Record<string, Handler> = {}
    return { handlers, on: (c, h) => (handlers[c] = h) }
  }

  it('answers an internal call (no senderFrame) with the parsed build', () => {
    const ipc = fakeIpc()
    registerPlatformIpc(ipc as never, () => null)
    const e: { senderFrame?: unknown; returnValue?: unknown } = {}
    ipc.handlers['platform:winBuild'](e)
    expect(e.returnValue).toBe(process.platform === 'win32' ? winBuildFromRelease(release()) : null)
  })

  it('denies a foreign sender (truthy senderFrame, no matching window) with null', () => {
    const ipc = fakeIpc()
    registerPlatformIpc(ipc as never, () => null)
    const e: { senderFrame?: unknown; returnValue?: unknown } = { senderFrame: {} }
    ipc.handlers['platform:winBuild'](e)
    expect(e.returnValue).toBeNull()
  })
})
