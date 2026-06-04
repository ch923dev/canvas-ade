import { describe, expect, it } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { getAuditLog, registerAuditHandler } from './auditIpc'
import type { AuditEntry, AuditLog } from './auditLog'

/** Minimal fake AuditLog capturing read() calls. */
function fakeLog(entries: AuditEntry[] = []): AuditLog & { reads: unknown[] } {
  const reads: unknown[] = []
  return {
    reads,
    append: async () => entries[0],
    read: async (opts) => {
      reads.push(opts)
      return entries
    }
  }
}

type Handler = (e: IpcMainInvokeEvent, opts?: { limit?: number }) => unknown

/** Capture the handler registered on a fake ipcMain.handle('audit:read', …). */
function fakeIpc(): {
  bus: Pick<IpcMain, 'handle'>
  invoke: (e: Partial<IpcMainInvokeEvent>, opts?: { limit?: number }) => Promise<unknown>
} {
  let handler: Handler | null = null
  const bus = {
    handle: (channel: string, fn: Handler): void => {
      if (channel === 'audit:read') handler = fn
    }
  } as unknown as Pick<IpcMain, 'handle'>
  return {
    bus,
    invoke: async (e, opts) => handler!(e as IpcMainInvokeEvent, opts)
  }
}

const FRAME = { _: 'main-frame' }
const win = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, mainFrame: FRAME }
} as unknown as BrowserWindow

describe('registerAuditHandler', () => {
  const entries: AuditEntry[] = [
    {
      seq: 2,
      ts: 2,
      type: 'handoff_prompt',
      targetId: 'b',
      prompt: 'p2',
      nonce: 'n2',
      status: 'completed'
    },
    {
      seq: 1,
      ts: 1,
      type: 'handoff_prompt',
      targetId: 'b',
      prompt: 'p1',
      nonce: 'n1',
      status: 'dispatched'
    }
  ]

  it('returns the log entries for a main-frame sender', async () => {
    const log = fakeLog(entries)
    const ipc = fakeIpc()
    registerAuditHandler(ipc.bus, () => win, log)
    const result = await ipc.invoke(
      { senderFrame: FRAME as unknown as IpcMainInvokeEvent['senderFrame'] },
      { limit: 5 }
    )
    expect(result).toEqual(entries)
    expect(log.reads).toEqual([{ limit: 5 }])
  })

  it('🔒 denies a foreign-frame sender (returns [], never reads the log)', async () => {
    const log = fakeLog(entries)
    const ipc = fakeIpc()
    registerAuditHandler(ipc.bus, () => win, log)
    const result = await ipc.invoke({
      senderFrame: { _: 'evil-iframe' } as unknown as IpcMainInvokeEvent['senderFrame']
    })
    expect(result).toEqual([])
    expect(log.reads).toHaveLength(0) // guard short-circuits BEFORE touching the log
  })

  it('exposes the registered log via getAuditLog (the dispatch-tool / e2e seam)', () => {
    const log = fakeLog()
    registerAuditHandler(fakeIpc().bus, () => win, log)
    expect(getAuditLog()).toBe(log)
  })
})
