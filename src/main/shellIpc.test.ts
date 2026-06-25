// src/main/shellIpc.test.ts
import { describe, it, expect, vi } from 'vitest'
import { registerShellHandlers } from './shellIpc'

type Handler = (e: { senderFrame?: unknown }, ...args: unknown[]) => unknown
function fakeIpc(): { handlers: Record<string, Handler>; handle: (c: string, h: Handler) => void } {
  const handlers: Record<string, Handler> = {}
  return { handlers, handle: (c, h) => (handlers[c] = h) }
}
// No senderFrame → isForeignSender returns false (internal/allowed), like the e2e harness.
const internal = {}
// Truthy senderFrame + getWin()=null → isForeignSender true.
const foreign = { senderFrame: {} }

describe('shellIpc', () => {
  it('shell:openExternal delegates to the injected open() and returns its result', async () => {
    const ipc = fakeIpc()
    const open = vi.fn(() => true)
    registerShellHandlers(ipc as never, () => null, open)
    const ok = await ipc.handlers['shell:openExternal'](internal, 'https://example.com/')
    expect(open).toHaveBeenCalledWith('https://example.com/')
    expect(ok).toBe(true)
  })

  it('returns the openExternalSafe verdict for a blocked scheme (false)', async () => {
    const ipc = fakeIpc()
    // Stand-in that mirrors openExternalSafe: only http/https/mailto succeed.
    const open = vi.fn((url: string) => /^(https?|mailto):/.test(url))
    registerShellHandlers(ipc as never, () => null, open)
    expect(await ipc.handlers['shell:openExternal'](internal, 'file:///C:/Windows/calc.exe')).toBe(
      false
    )
    expect(await ipc.handlers['shell:openExternal'](internal, 'mailto:a@b.com')).toBe(true)
  })

  it('coerces a non-string argument to "" (open() then rejects it) rather than throwing', async () => {
    const ipc = fakeIpc()
    const open = vi.fn((url: string) => url.length > 0)
    registerShellHandlers(ipc as never, () => null, open)
    expect(await ipc.handlers['shell:openExternal'](internal, undefined)).toBe(false)
    expect(open).toHaveBeenCalledWith('')
  })

  it('denies a foreign sender WITHOUT calling open()', async () => {
    const ipc = fakeIpc()
    const open = vi.fn(() => true)
    registerShellHandlers(ipc as never, () => null, open)
    expect(await ipc.handlers['shell:openExternal'](foreign, 'https://example.com/')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
