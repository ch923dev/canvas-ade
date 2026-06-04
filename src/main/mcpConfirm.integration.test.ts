import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow, IpcMain } from 'electron'
import { requestConfirm, type ConfirmRequest } from './mcpConfirm'

const REQ: ConfirmRequest = { title: 'Dispatch', body: 'Run "echo hi" in board X?' }

/** A fake main window whose `webContents.send` records what was posted. */
function fakeWin(mainFrame: object): {
  win: BrowserWindow
  sent: Array<{ channel: string; payload: { request: ConfirmRequest; replyChannel: string } }>
} {
  const sent: Array<{
    channel: string
    payload: { request: ConfirmRequest; replyChannel: string }
  }> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      isDestroyed: () => false,
      once: () => {},
      removeListener: () => {},
      send: (channel: string, payload: { request: ConfirmRequest; replyChannel: string }) =>
        sent.push({ channel, payload })
    }
  } as unknown as BrowserWindow
  return { win, sent }
}

/**
 * A fake main window whose `webContents` records its lifecycle listeners so a test can
 * fire `'destroyed'` / `'render-process-gone'` AFTER the confirm modal has been shown.
 */
function fakeWinWithLifecycle(mainFrame: object): {
  win: BrowserWindow
  fire: (event: string) => void
} {
  const listeners = new Map<string, (() => void)[]>()
  const win = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      isDestroyed: () => false,
      once: (event: string, cb: () => void) => {
        const arr = listeners.get(event) ?? []
        arr.push(cb)
        listeners.set(event, arr)
      },
      removeListener: (event: string, cb: () => void) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((f) => f !== cb)
        )
      },
      send: () => {}
    }
  } as unknown as BrowserWindow
  return {
    win,
    fire: (event: string) => (listeners.get(event) ?? []).slice().forEach((f) => f())
  }
}

/** A fake ipc bus that captures the one-shot reply handler so a test can fire it. */
function fakeBus(): {
  bus: Pick<IpcMain, 'once' | 'removeListener'>
  reply: (e: unknown, decision: unknown) => void
  channel: () => string | null
} {
  let handler: ((e: unknown, decision: unknown) => void) | null = null
  let channel: string | null = null
  const bus = {
    once: (ch: string, h: (e: unknown, decision: unknown) => void) => {
      channel = ch
      handler = h
    },
    removeListener: () => {
      handler = null
    }
  } as unknown as Pick<IpcMain, 'once' | 'removeListener'>
  return { bus, reply: (e, decision) => handler?.(e, decision), channel: () => channel }
}

describe('requestConfirm', () => {
  it('posts the request with a reply channel and resolves the human approve decision', async () => {
    const mainFrame = { name: 'main' }
    const { win, sent } = fakeWin(mainFrame)
    const { bus, reply, channel } = fakeBus()

    const p = requestConfirm(bus, () => win, REQ)
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('mcp:confirm')
    expect(sent[0].payload.request).toEqual(REQ)
    expect(sent[0].payload.replyChannel).toBe(channel())

    reply({ senderFrame: mainFrame }, { approved: true })
    await expect(p).resolves.toEqual({ approved: true })
  })

  it('resolves a deny decision', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()
    const p = requestConfirm(bus, () => win, REQ)
    reply({ senderFrame: mainFrame }, { approved: false })
    await expect(p).resolves.toEqual({ approved: false })
  })

  it('🔒 fails CLOSED on a malformed decision (treats it as deny)', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()
    const p = requestConfirm(bus, () => win, REQ)
    reply({ senderFrame: mainFrame }, 'not-an-object')
    await expect(p).resolves.toEqual({ approved: false })
  })

  it('🔒 ignores a foreign-frame reply; a safety timeout then denies', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()
    const p = requestConfirm(bus, () => win, REQ, { timeoutMs: 30 })
    reply({ senderFrame: { name: 'evil' } }, { approved: true }) // foreign → ignored
    await expect(p).resolves.toEqual({ approved: false })
  })

  it('🔒 denies (never approves) when the window is gone — no send', async () => {
    const { bus } = fakeBus()
    await expect(requestConfirm(bus, () => null, REQ)).resolves.toEqual({ approved: false })
  })

  it('🔒 denies (never hangs) when the window is destroyed AFTER send but before reply', async () => {
    const mainFrame = { name: 'main' }
    const { win, fire } = fakeWinWithLifecycle(mainFrame)
    const { bus } = fakeBus()
    const p = requestConfirm(bus, () => win, REQ)
    // No human reply ever arrives; the window is torn down instead.
    fire('destroyed')
    await expect(p).resolves.toEqual({ approved: false })
  })

  it('🔒 denies (never hangs) when the render process is gone after send', async () => {
    const mainFrame = { name: 'main' }
    const { win, fire } = fakeWinWithLifecycle(mainFrame)
    const { bus } = fakeBus()
    const p = requestConfirm(bus, () => win, REQ)
    fire('render-process-gone')
    await expect(p).resolves.toEqual({ approved: false })
  })

  it('🔒 BUG-010: a frozen renderer (no reply, no lifecycle event) denies via the default backstop timeout', async () => {
    // The gap the destroyed/render-process-gone hatches cannot cover: a hung renderer
    // keeps the process alive (neither lifecycle event fires) and never sends a reply.
    // Without a finite default timeout the promise — and the MCP tool/SSE connection
    // behind it — would hang forever. The default backstop must fire and deny.
    vi.useFakeTimers()
    try {
      const mainFrame = { name: 'main' }
      const { win } = fakeWinWithLifecycle(mainFrame)
      const { bus } = fakeBus()
      const p = requestConfirm(bus, () => win, REQ) // no opts → default backstop timeout
      let settled = false
      void p.then(() => {
        settled = true
      })
      // Before the backstop fires, the promise is still pending (a human is allowed time).
      await Promise.resolve()
      expect(settled).toBe(false)
      // Advance past the 10-minute default backstop — the frozen request now denies.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      await expect(p).resolves.toEqual({ approved: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('🔒 BUG-010: an explicit Infinity opt-out arms no timer (human may take unbounded time)', async () => {
    // A caller can opt out of the backstop with a non-finite bound; no timer is armed, so
    // the promise stays pending until a real reply/lifecycle event arrives.
    vi.useFakeTimers()
    try {
      const mainFrame = { name: 'main' }
      const { win } = fakeWinWithLifecycle(mainFrame)
      const { bus } = fakeBus()
      const p = requestConfirm(bus, () => win, REQ, { timeoutMs: Infinity })
      let settled = false
      void p.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000) // an hour — still no timer fired
      await Promise.resolve()
      expect(settled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('🔒 denies when the send throws', async () => {
    const mainFrame = { name: 'main' }
    const win = {
      isDestroyed: () => false,
      webContents: {
        mainFrame,
        isDestroyed: () => false,
        once: () => {},
        removeListener: () => {},
        send: () => {
          throw new Error('send failed')
        }
      }
    } as unknown as BrowserWindow
    const { bus } = fakeBus()
    await expect(requestConfirm(bus, () => win, REQ)).resolves.toEqual({ approved: false })
  })
})
