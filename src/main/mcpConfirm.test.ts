import { describe, it, expect } from 'vitest'
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
      send: (channel: string, payload: { request: ConfirmRequest; replyChannel: string }) =>
        sent.push({ channel, payload })
    }
  } as unknown as BrowserWindow
  return { win, sent }
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

  it('🔒 denies when the send throws', async () => {
    const mainFrame = { name: 'main' }
    const win = {
      isDestroyed: () => false,
      webContents: {
        mainFrame,
        isDestroyed: () => false,
        send: () => {
          throw new Error('send failed')
        }
      }
    } as unknown as BrowserWindow
    const { bus } = fakeBus()
    await expect(requestConfirm(bus, () => win, REQ)).resolves.toEqual({ approved: false })
  })
})
