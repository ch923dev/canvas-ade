import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  registerOrchestratorIpc,
  forwardBoardStatus,
  type OrchestratorDrive,
  type BoardStatusEvent
} from './mcpOrchestratorIpc'

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/** A fake ipc bus that captures each registered `handle()` so a test can invoke it. */
function fakeIpc(): { ipc: Pick<IpcMain, 'handle'>; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ipc = {
    handle: (channel: string, h: Handler) => handlers.set(channel, h)
  } as unknown as Pick<IpcMain, 'handle'>
  return { ipc, handlers }
}

const mainFrame = { name: 'main' }
const liveWin = {
  isDestroyed: () => false,
  webContents: { mainFrame, isDestroyed: () => false }
} as unknown as BrowserWindow

/** Build an invoke event with a given sender frame (undefined ⇒ synthetic/internal). */
const ev = (frame: object | undefined): IpcMainInvokeEvent =>
  ({ senderFrame: frame }) as unknown as IpcMainInvokeEvent

/** A spy orchestrator facet recording calls; spawnGroup returns a fixed cluster. */
function spyMcp(): OrchestratorDrive {
  return {
    spawnGroup: vi.fn(async () => ({
      groupId: 'g1',
      terminalId: 't1',
      planningId: 'p1'
    })),
    dispatchPrompt: vi.fn(async () => ({ delivery: 'ready' as const })),
    handoffPrompt: vi.fn(async () => ({ present: true, status: 'success', summary: 'done' })),
    awaitSettled: vi.fn(async () => ({ present: true, status: 'success', summary: 'settled' })),
    interrupt: vi.fn(async () => {}),
    gitDiff: vi.fn(async () => 'diff --git a/x b/x\n+added\n-removed')
  }
}

describe('registerOrchestratorIpc', () => {
  it('spawnGroup: main-frame invoke calls through and returns the cluster', async () => {
    const mcp = spyMcp()
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => mcp
    )

    const res = await handlers.get('mcp:spawnGroup')!(ev(mainFrame), {
      name: 'Auth feature',
      browser: true
    })
    expect(mcp.spawnGroup).toHaveBeenCalledWith({
      name: 'Auth feature',
      planning: false,
      browser: true
    })
    expect(res).toEqual({ groupId: 'g1', terminalId: 't1', planningId: 'p1' })
  })

  it('spawnGroup: forwards an agentic launchCommand for the worker terminal', async () => {
    const mcp = spyMcp()
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => mcp
    )

    await handlers.get('mcp:spawnGroup')!(ev(mainFrame), { name: 'x', launchCommand: 'claude' })
    expect(mcp.spawnGroup).toHaveBeenCalledWith({
      name: 'x',
      planning: false,
      browser: false,
      launchCommand: 'claude'
    })
  })

  it('dispatchPrompt: forwards { boardId, text } to the gated orchestrator path', async () => {
    const mcp = spyMcp()
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => mcp
    )

    await handlers.get('mcp:dispatchPrompt')!(ev(mainFrame), { boardId: 't1', text: 'go' })
    expect(mcp.dispatchPrompt).toHaveBeenCalledWith('t1', 'go')
  })

  it('handoffPrompt: dispatches + awaits, returning the worker result', async () => {
    const mcp = spyMcp()
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => mcp
    )

    const res = await handlers.get('mcp:handoffPrompt')!(ev(mainFrame), {
      boardId: 't1',
      text: 'go'
    })
    expect(mcp.handoffPrompt).toHaveBeenCalledWith('t1', 'go')
    expect(res).toEqual({ present: true, status: 'success', summary: 'done' })
  })

  it('awaitSettled: forwards the board id and returns the settled result (read-only)', async () => {
    const mcp = spyMcp()
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => mcp
    )

    const res = await handlers.get('mcp:awaitSettled')!(ev(mainFrame), 't1')
    expect(mcp.awaitSettled).toHaveBeenCalledWith('t1')
    expect(res).toEqual({ present: true, status: 'success', summary: 'settled' })
  })

  it('interrupt: forwards the board id', async () => {
    const mcp = spyMcp()
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => mcp
    )

    await handlers.get('mcp:interrupt')!(ev(mainFrame), 't1')
    expect(mcp.interrupt).toHaveBeenCalledWith('t1')
  })

  it('gitDiff: forwards the board id and returns the raw diff (read-only, Phase D)', async () => {
    const mcp = spyMcp()
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => mcp
    )

    const res = await handlers.get('mcp:gitDiff')!(ev(mainFrame), 't1')
    expect(mcp.gitDiff).toHaveBeenCalledWith('t1')
    expect(res).toBe('diff --git a/x b/x\n+added\n-removed')
    await expect(handlers.get('mcp:gitDiff')!(ev(mainFrame), 123)).rejects.toThrow(/boardId/)
  })

  it('🔒 a foreign sender frame is denied on every channel (no orchestrator call)', async () => {
    const mcp = spyMcp()
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => mcp
    )
    const foreign = ev({ name: 'evil' })

    await expect(handlers.get('mcp:spawnGroup')!(foreign, { name: 'x' })).rejects.toThrow(
      'forbidden'
    )
    await expect(
      handlers.get('mcp:dispatchPrompt')!(foreign, { boardId: 't1', text: 'go' })
    ).rejects.toThrow('forbidden')
    await expect(
      handlers.get('mcp:handoffPrompt')!(foreign, { boardId: 't1', text: 'go' })
    ).rejects.toThrow('forbidden')
    await expect(handlers.get('mcp:awaitSettled')!(foreign, 't1')).rejects.toThrow('forbidden')
    await expect(handlers.get('mcp:interrupt')!(foreign, 't1')).rejects.toThrow('forbidden')
    await expect(handlers.get('mcp:gitDiff')!(foreign, 't1')).rejects.toThrow('forbidden')
    expect(mcp.spawnGroup).not.toHaveBeenCalled()
    expect(mcp.dispatchPrompt).not.toHaveBeenCalled()
    expect(mcp.handoffPrompt).not.toHaveBeenCalled()
    expect(mcp.awaitSettled).not.toHaveBeenCalled()
    expect(mcp.interrupt).not.toHaveBeenCalled()
    expect(mcp.gitDiff).not.toHaveBeenCalled()
  })

  it('rejects when the orchestrator is unavailable (loopback server down)', async () => {
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => null
    )
    await expect(handlers.get('mcp:spawnGroup')!(ev(mainFrame), { name: 'x' })).rejects.toThrow(
      'orchestrator-unavailable'
    )
  })

  it('validates malformed args rather than dereferencing them', async () => {
    const mcp = spyMcp()
    const { ipc, handlers } = fakeIpc()
    registerOrchestratorIpc(
      ipc,
      () => liveWin,
      () => mcp
    )

    await expect(handlers.get('mcp:spawnGroup')!(ev(mainFrame), {})).rejects.toThrow(/name/)
    await expect(
      handlers.get('mcp:dispatchPrompt')!(ev(mainFrame), { boardId: 't1' })
    ).rejects.toThrow(/boardId, text/)
    await expect(handlers.get('mcp:interrupt')!(ev(mainFrame), 123)).rejects.toThrow(/boardId/)
    expect(mcp.spawnGroup).not.toHaveBeenCalled()
    expect(mcp.dispatchPrompt).not.toHaveBeenCalled()
    expect(mcp.interrupt).not.toHaveBeenCalled()
  })
})

describe('forwardBoardStatus', () => {
  it('forwards each status change to the renderer on mcp:status', () => {
    const sent: Array<{ channel: string; change: BoardStatusEvent }> = []
    const win = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, change: BoardStatusEvent) => sent.push({ channel, change })
      }
    } as unknown as BrowserWindow

    let emit: ((c: BoardStatusEvent) => void) | null = null
    const unsub = vi.fn()
    const off = forwardBoardStatus(
      () => win,
      (listener) => {
        emit = listener
        return unsub
      }
    )
    emit!({ id: 't1', status: 'running' })
    emit!({ id: 't1', status: 'idle', monitorActivity: false })
    expect(sent).toEqual([
      { channel: 'mcp:status', change: { id: 't1', status: 'running' } },
      { channel: 'mcp:status', change: { id: 't1', status: 'idle', monitorActivity: false } }
    ])
    off()
    expect(unsub).toHaveBeenCalled()
  })

  it('drops a status change when the window is torn down (never throws)', () => {
    const win = {
      isDestroyed: () => true,
      webContents: {
        isDestroyed: () => true,
        send: () => {
          throw new Error('should not send to a dead window')
        }
      }
    } as unknown as BrowserWindow

    let emit: ((c: BoardStatusEvent) => void) | null = null
    forwardBoardStatus(
      () => win,
      (listener) => {
        emit = listener
        return () => {}
      }
    )
    expect(() => emit!({ id: 't1', status: 'idle' })).not.toThrow()
  })
})
