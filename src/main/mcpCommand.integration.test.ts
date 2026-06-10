import { describe, it, expect } from 'vitest'
import type { BrowserWindow, IpcMain } from 'electron'
import { sendMcpCommand } from './mcpCommand'

/** A fake main window whose `webContents.send` records what was posted. */
function fakeWin(mainFrame: object): {
  win: BrowserWindow
  sent: Array<{ channel: string; payload: { command: unknown; replyChannel: string } }>
} {
  const sent: Array<{ channel: string; payload: { command: unknown; replyChannel: string } }> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      isDestroyed: () => false,
      send: (channel: string, payload: { command: unknown; replyChannel: string }) =>
        sent.push({ channel, payload })
    }
  } as unknown as BrowserWindow
  return { win, sent }
}

/** A fake ipc bus that captures the persistent reply handler so a test can fire it. */
function fakeBus(): {
  bus: Pick<IpcMain, 'on' | 'removeListener'>
  reply: (e: unknown, ack: unknown) => void
  channel: () => string | null
} {
  let handler: ((e: unknown, ack: unknown) => void) | null = null
  let channel: string | null = null
  const bus = {
    on: (ch: string, h: (e: unknown, ack: unknown) => void) => {
      channel = ch
      handler = h
    },
    removeListener: () => {
      handler = null
    }
  } as unknown as Pick<IpcMain, 'on' | 'removeListener'>
  return { bus, reply: (e, ack) => handler?.(e, ack), channel: () => channel }
}

describe('sendMcpCommand', () => {
  it('posts the command with a reply channel and resolves with the renderer ack', async () => {
    const mainFrame = { name: 'main' }
    const { win, sent } = fakeWin(mainFrame)
    const { bus, reply, channel } = fakeBus()

    const p = sendMcpCommand(bus, () => win, { type: 'ping' })

    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe('mcp:command')
    expect(sent[0].payload.command).toEqual({ type: 'ping' })
    expect(sent[0].payload.replyChannel).toBe(channel())

    reply({ senderFrame: mainFrame }, { ok: true, type: 'ping' })
    await expect(p).resolves.toEqual({ ok: true, type: 'ping' })
  })

  it('returns no-window when the window is gone (never throws)', async () => {
    const { bus } = fakeBus()
    await expect(sendMcpCommand(bus, () => null, { type: 'ping' })).resolves.toEqual({
      ok: false,
      error: 'no-window'
    })
  })

  it('ignores a foreign-frame ack and falls through to timeout', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()

    const p = sendMcpCommand(bus, () => win, { type: 'ping' }, 30)
    reply({ senderFrame: { name: 'evil' } }, { ok: true, type: 'ping' }) // foreign → ignored
    await expect(p).resolves.toEqual({ ok: false, error: 'timeout' })
  })

  it('BUG-030: genuine ack after a foreign-frame event still resolves (listener not consumed)', async () => {
    // With bus.once, the foreign event consumed the listener and the real ack was never
    // handled — the command fell through to timeout. With bus.on, the listener stays armed.
    const mainFrame = { name: 'main' }
    const { win } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()

    const p = sendMcpCommand(bus, () => win, { type: 'ping' }, 5000)
    // First: a foreign-frame event (must NOT consume the listener)
    reply({ senderFrame: { name: 'evil' } }, { ok: true, type: 'ping' })
    // Then: the genuine renderer ack
    reply({ senderFrame: mainFrame }, { ok: true, type: 'ping' })
    await expect(p).resolves.toEqual({ ok: true, type: 'ping' })
  })

  it('BUG-031: the reply channel is a CSPRNG UUID (not Date.now()+Math.random)', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeWin(mainFrame)
    const { bus, channel } = fakeBus()
    void sendMcpCommand(bus, () => win, { type: 'ping' })
    const ch = channel()
    expect(ch).toMatch(
      /^mcp:command:ack:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    // Must NOT be the old predictable shape (Date.now():Math.random base36)
    expect(ch).not.toMatch(/^mcp:command:ack:\d+:[0-9a-z]+$/)
  })

  it('reports a malformed ack rather than passing it through', async () => {
    const mainFrame = { name: 'main' }
    const { win } = fakeWin(mainFrame)
    const { bus, reply } = fakeBus()

    const p = sendMcpCommand(bus, () => win, { type: 'ping' })
    reply({ senderFrame: mainFrame }, 'not-an-object')
    await expect(p).resolves.toEqual({ ok: false, error: 'malformed-ack' })
  })
})
