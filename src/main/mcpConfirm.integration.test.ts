import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow, IpcMain } from 'electron'
import {
  requestConfirm,
  requestConfirmBatch,
  type ConfirmBatchRequest,
  type ConfirmRequest
} from './mcpConfirm'

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
  listenerCount: () => number
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
    fire: (event: string) => (listeners.get(event) ?? []).slice().forEach((f) => f()),
    listenerCount: () => [...listeners.values()].reduce((n, arr) => n + arr.length, 0)
  }
}

/** A fake ipc bus that captures the persistent reply handler so a test can fire it. */
function fakeBus(): {
  bus: Pick<IpcMain, 'on' | 'removeListener'>
  reply: (e: unknown, decision: unknown) => void
  channel: () => string | null
  has: () => boolean
} {
  let handler: ((e: unknown, decision: unknown) => void) | null = null
  let channel: string | null = null
  const bus = {
    on: (ch: string, h: (e: unknown, decision: unknown) => void) => {
      channel = ch
      handler = h
    },
    removeListener: () => {
      handler = null
    }
  } as unknown as Pick<IpcMain, 'on' | 'removeListener'>
  return {
    bus,
    reply: (e, decision) => handler?.(e, decision),
    channel: () => channel,
    has: () => handler !== null
  }
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

  it('🔒 BUG-022: the reply channel is a CSPRNG UUID (unguessable, not Date.now()/Math.random)', async () => {
    // The OLD channel was `mcp:confirm:reply:${Date.now()}:${Math.random().toString(36)}`
    // — both components are predictable, so a renderer could precompute/guess the channel
    // for a given request and forge an early {approved:true}. The fix uses randomUUID().
    const mainFrame = { name: 'main' }
    const { win: win1, sent: sent1 } = fakeWin(mainFrame)
    const { bus: bus1 } = fakeBus()
    void requestConfirm(bus1, () => win1, REQ)

    const ch = sent1[0].payload.replyChannel
    // A v4 UUID suffix — 8-4-4-4-12 hex with the version/variant nibbles fixed.
    const uuidV4 =
      /^mcp:confirm:reply:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(ch).toMatch(uuidV4)
    // It must NOT be the OLD predictable shape (two colon-separated numeric/base36 parts).
    expect(ch).not.toMatch(/^mcp:confirm:reply:\d+:[0-9a-z]+$/)

    // Two distinct requests must yield two distinct channels (no collision/reuse).
    const { win: win2, sent: sent2 } = fakeWin(mainFrame)
    const { bus: bus2 } = fakeBus()
    void requestConfirm(bus2, () => win2, REQ)
    expect(sent2[0].payload.replyChannel).not.toBe(ch)
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

  it('🔒 BUG-030: genuine reply after a foreign-frame event still resolves (listener not consumed)', async () => {
    // With bus.once, a foreign event consumed the listener and the genuine human reply
    // was never handled — the request fell through to the timeout and denied.
    // With bus.on + finish() removeListener, the listener stays armed after the foreign
    // event, so the genuine reply resolves correctly.
    const mainFrame = { name: 'main' }
    const { win } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()
    const p = requestConfirm(bus, () => win, REQ, { timeoutMs: 5000 })
    // First: a foreign-frame event (should NOT consume the listener)
    reply({ senderFrame: { name: 'evil' } }, { approved: true })
    // Then: the genuine human reply
    reply({ senderFrame: mainFrame }, { approved: true })
    await expect(p).resolves.toEqual({ approved: true })
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

const BATCH: ConfirmBatchRequest = {
  title: 'Relay 3 prompts',
  items: [
    { label: 'A → B', body: 'npm run build' },
    { label: 'A → C', body: 'npm test' },
    { label: 'A → D', body: 'rm -rf dist' }
  ]
}
const DENY3 = { decisions: [{ approved: false }, { approved: false }, { approved: false }] }

/** A fake main window whose `webContents.send` records the batch payload posted. */
function fakeBatchWin(mainFrame: object): {
  win: BrowserWindow
  sent: Array<{ channel: string; payload: { request: ConfirmBatchRequest; replyChannel: string } }>
} {
  const sent: Array<{
    channel: string
    payload: { request: ConfirmBatchRequest; replyChannel: string }
  }> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      isDestroyed: () => false,
      once: () => {},
      removeListener: () => {},
      send: (channel: string, payload: { request: ConfirmBatchRequest; replyChannel: string }) =>
        sent.push({ channel, payload })
    }
  } as unknown as BrowserWindow
  return { win, sent }
}

describe('requestConfirmBatch', () => {
  it('posts to mcp:confirm:batch and resolves the per-row decisions', async () => {
    const mainFrame = { name: 'main' }
    const { win, sent } = fakeBatchWin(mainFrame)
    const { bus, reply, channel } = fakeBus()

    const p = requestConfirmBatch(bus, () => win, BATCH)
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('mcp:confirm:batch')
    expect(sent[0].payload.request).toEqual(BATCH)
    expect(sent[0].payload.replyChannel).toBe(channel())

    reply(
      { senderFrame: mainFrame },
      { decisions: [{ approved: true }, { approved: false }, { approved: true }] }
    )
    await expect(p).resolves.toEqual({
      decisions: [{ approved: true }, { approved: false }, { approved: true }]
    })
  })

  it('🔒 fail-closed: a SHORT reply denies the missing rows (approved only where explicit)', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeBatchWin(mainFrame)
    const { bus, reply } = fakeBus()
    const p = requestConfirmBatch(bus, () => win, BATCH)
    reply({ senderFrame: mainFrame }, { decisions: [{ approved: true }] }) // only row 0
    await expect(p).resolves.toEqual({
      decisions: [{ approved: true }, { approved: false }, { approved: false }]
    })
  })

  it('🔒 fail-closed: a malformed (non-array) reply denies EVERY row', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeBatchWin(mainFrame)
    const { bus, reply } = fakeBus()
    const p = requestConfirmBatch(bus, () => win, BATCH)
    reply({ senderFrame: mainFrame }, { decisions: 'nope' })
    await expect(p).resolves.toEqual(DENY3)
  })

  it('🔒 fail-closed: a row whose `approved` is not strictly true is denied', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeBatchWin(mainFrame)
    const { bus, reply } = fakeBus()
    const p = requestConfirmBatch(bus, () => win, BATCH)
    reply(
      { senderFrame: mainFrame },
      { decisions: [{ approved: 'yes' }, { approved: 1 }, { approved: true }] }
    )
    await expect(p).resolves.toEqual({
      decisions: [{ approved: false }, { approved: false }, { approved: true }]
    })
  })

  it('🔒 denies every row when the window is gone — no send', async () => {
    const { bus } = fakeBus()
    await expect(requestConfirmBatch(bus, () => null, BATCH)).resolves.toEqual(DENY3)
  })

  it('🔒 ignores a foreign-frame reply; the safety timeout then denies every row', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeBatchWin(mainFrame)
    const { bus, reply } = fakeBus()
    const p = requestConfirmBatch(bus, () => win, BATCH, { timeoutMs: 30 })
    reply(
      { senderFrame: { name: 'evil' } },
      { decisions: [{ approved: true }, { approved: true }, { approved: true }] }
    )
    await expect(p).resolves.toEqual(DENY3)
  })
})

// ── J4: the Jarvis origin stamp (jarvisToolContext ALS → panel routing) ──
describe('J4 origin stamp', () => {
  it('stamps origin:"jarvis" ONLY inside runAsJarvisToolCall', async () => {
    const { runAsJarvisToolCall } = await import('./jarvisToolContext')
    const mainFrame = { name: 'main' }
    const { win, sent } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()
    const p = runAsJarvisToolCall(() => requestConfirm(bus, () => win, REQ))
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0].payload.request.origin).toBe('jarvis')
    reply({ senderFrame: mainFrame }, { approved: true })
    await expect(p).resolves.toEqual({ approved: true })
  })

  it('outside the marker there is NO origin — and a caller cannot forge one', async () => {
    const mainFrame = { name: 'main' }
    const { win, sent } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()
    const forged = { ...REQ, origin: 'jarvis' } as ConfirmRequest
    const p = requestConfirm(bus, () => win, forged)
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0].payload.request.origin).toBeUndefined()
    reply({ senderFrame: mainFrame }, { approved: false })
    await expect(p).resolves.toEqual({ approved: false })
  })
})

// ── P1-A: cancel/supersede abort — the turn's AbortSignal reaches a pending confirm ──
describe('P1-A abort wiring', () => {
  it('🔒 an abort while the confirm is pending settles denied and tears down every listener', async () => {
    const mainFrame = { name: 'main' }
    const { win, listenerCount } = fakeWinWithLifecycle(mainFrame)
    const { bus, reply, has } = fakeBus()
    const ctrl = new AbortController()
    const p = requestConfirm(bus, () => win, REQ, { signal: ctrl.signal })
    expect(has()).toBe(true) // armed while pending
    ctrl.abort()
    await expect(p).resolves.toEqual({ approved: false })
    // Listener hygiene: the reply-channel listener and both lifecycle hatches are gone —
    // the pre-fix behavior held all of them for up to the 10-minute backstop.
    expect(has()).toBe(false)
    expect(listenerCount()).toBe(0)
    // A late human approve changes nothing (the channel listener is torn down).
    reply({ senderFrame: mainFrame }, { approved: true })
    await expect(p).resolves.toEqual({ approved: false })
  })

  it('🔒 a pre-aborted signal denies immediately — the modal is never posted', async () => {
    const mainFrame = { name: 'main' }
    const { win, sent } = fakeWin(mainFrame)
    const { bus } = fakeBus()
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(requestConfirm(bus, () => win, REQ, { signal: ctrl.signal })).resolves.toEqual({
      approved: false
    })
    expect(sent).toHaveLength(0)
  })

  it('🔒 the signal rides the tool-call ALS — a turn abort settles a deep-gate confirm denied', async () => {
    // Models the deep orchestrator gates (dispatch/kanban/visualize): requestConfirm is
    // called with NO explicit signal, inside runAsJarvisToolCall(fn, signal) — the ALS
    // must carry the turn's signal through the await chain to the gate.
    const { runAsJarvisToolCall } = await import('./jarvisToolContext')
    const mainFrame = { name: 'main' }
    const { win, sent } = fakeWin(mainFrame)
    const { bus, has } = fakeBus()
    const ctrl = new AbortController()
    const p = runAsJarvisToolCall(() => requestConfirm(bus, () => win, REQ), ctrl.signal)
    await vi.waitFor(() => expect(sent.length).toBe(1))
    ctrl.abort()
    await expect(p).resolves.toEqual({ approved: false })
    expect(has()).toBe(false)
  })

  it('an approve that lands BEFORE the abort still approves (the human answered in time)', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()
    const ctrl = new AbortController()
    const p = requestConfirm(bus, () => win, REQ, { signal: ctrl.signal })
    reply({ senderFrame: mainFrame }, { approved: true })
    ctrl.abort() // too late — the decision already settled
    await expect(p).resolves.toEqual({ approved: true })
  })
})
