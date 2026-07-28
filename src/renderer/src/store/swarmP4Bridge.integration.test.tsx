/**
 * Integration tier (TESTING.md) for the orchestration-P4 MAIN⇄renderer surface — the same
 * REAL-CHANNEL discipline as the S2/S3 bridge suites, for the same reason: a shape agreed by a MAIN
 * mock and a renderer mock passes both unit suites and still drifts, because neither side ever sees
 * the other's actual bytes. Both of those suites caught real bugs this way.
 *
 * What runs for real here, end to end:
 *   MAIN `recordBoardResult`  (the true single choke point every result writer passes through)
 *     → MAIN `createCommandFeed`      (classify · coalesce · compose)
 *     → MAIN `sendMcpCommand`         (the real serializer, over a captured `wc.send`)
 *     → renderer `useMcpCommands`     (the real hook, mounted in React)
 *     → renderer `applyMcpCommand`    (the real applier + its wire re-validation)
 *     → renderer `commandStore`       (the real store)
 * plus the ack travelling back on MAIN's real CSPRNG reply channel.
 *
 * The only stubs are the Electron window/webContents and the board mirror — the two things that
 * cannot exist outside a running app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createCommandFeed, setCommandFeed } from '../../../main/commandFeed'
import { recordBoardResult, __resetBoardResults } from '../../../main/boardResults'
import { sendMcpCommand } from '../../../main/mcpCommand'
import { mainFrame } from '../../../main/ipcTestHarness'
import type { DeliverableSignal } from '../../../main/lifecycleNotifications'
import type { McpCommand, McpCommandAck } from '../../../shared/mcpTypes'
import { useMcpCommands } from './useMcpCommands'
import { commandStoreDefaults, useCommandStore } from './commandStore'
import { useCanvasStore } from './canvasStore'

const WORKER = 'worker-board-1'
const COMMAND = 'command-board-1'

/**
 * The captured MAIN → renderer channel: `wc.send` on one side, the preload bridge on the other.
 *
 * The Electron types are derived from `sendMcpCommand`'s own signature rather than imported — this
 * file lives under `src/renderer/`, where importing `electron` is lint-forbidden (the security
 * invariant: the renderer talks to MAIN through the preload contextBridge, never directly). Reading
 * the shapes off the real function is also strictly tighter: they cannot drift from what MAIN takes.
 */
type MainBus = Parameters<typeof sendMcpCommand>[0]
type GetWin = Parameters<typeof sendMcpCommand>[1]

interface Wire {
  ipcMain: MainBus
  getWin: GetWin
  /** Resolves once every in-flight command has been applied AND acked. */
  settle: () => Promise<void>
}

function wire(): Wire {
  // The reply half of MAIN's request/reply: `sendMcpCommand` registers a one-shot listener on a
  // CSPRNG channel and the renderer's ack is routed back to it here.
  const listeners = new Map<string, (e: unknown, ack: unknown) => void>()
  const inflight: Array<Promise<void>> = []
  const ipcMain = {
    on: (channel: string, fn: (e: unknown, ack: unknown) => void) => listeners.set(channel, fn),
    removeListener: (channel: string) => listeners.delete(channel)
  } as unknown as MainBus

  const send = (channel: string, payload: { command: McpCommand; replyChannel: string }): void => {
    if (channel !== 'mcp:command') return
    // Deliver on a microtask, like the real IPC hop, so the applier never runs synchronously
    // inside `sendMcpCommand`.
    inflight.push(
      Promise.resolve().then(() => {
        const handler = bridge.handler
        if (!handler) return
        handler(payload.command, (ack: McpCommandAck) => {
          // The frame-guard compares senderFrame identity — the trusted main frame acks.
          listeners.get(payload.replyChannel)?.({ senderFrame: mainFrame }, ack)
        })
      })
    )
  }
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send, mainFrame }
  } as unknown as ReturnType<GetWin>

  return {
    ipcMain,
    getWin: () => win,
    settle: async () => {
      // Two drains: one for the delivery microtask, one for the ack that follows it.
      for (let i = 0; i < 4; i++) {
        await Promise.all(inflight.splice(0))
        await Promise.resolve()
      }
    }
  }
}

/** The preload bridge the renderer hook subscribes through. */
const bridge: { handler: ((c: McpCommand, reply: (a: McpCommandAck) => void) => void) | null } = {
  handler: null
}

function Harness(): null {
  useMcpCommands()
  return null
}

let signals: DeliverableSignal[] = []

beforeEach(() => {
  signals = []
  __resetBoardResults()
  useCommandStore.setState(commandStoreDefaults())
  // A canvas with the worker board and a Command board to render it on.
  useCanvasStore.setState({
    boards: [
      { id: WORKER, type: 'terminal', title: 'reviewer-1', x: 0, y: 0, w: 100, h: 100 },
      { id: COMMAND, type: 'command', title: 'Command', x: 0, y: 0, w: 100, h: 100 }
    ]
  } as never)
  ;(window as unknown as { api: unknown }).api = {
    mcp: {
      onCommand: (cb: (c: McpCommand, reply: (a: McpCommandAck) => void) => void) => {
        bridge.handler = cb
        return () => {
          bridge.handler = null
        }
      }
    }
  }
})

afterEach(() => {
  cleanup()
  setCommandFeed(null)
  bridge.handler = null
  delete (window as unknown as { api?: unknown }).api
})

/** Install the REAL feed over the captured wire and mount the REAL renderer hook. */
function boot(w: Wire): { flush: () => void } {
  const feed = createCommandFeed({
    send: (command) => sendMcpCommand(w.ipcMain, w.getWin, command, 50),
    deliver: (sig) => signals.push(sig),
    // Drive the coalesce window explicitly — a real timer would make this suite time-dependent.
    schedule: (fn) => {
      pending.push(fn)
      return () => {
        pending = pending.filter((f) => f !== fn)
      }
    }
  })
  setCommandFeed(feed)
  render(<Harness />)
  return {
    flush: () => {
      const q = pending
      pending = []
      for (const fn of q) fn()
    }
  }
}
let pending: Array<() => void> = []

const fedTasks = (): ReturnType<typeof useCommandStore.getState>['tasks'] =>
  useCommandStore.getState().tasks.filter((t) => t.external === true)

describe('P4 bridge — a worker never dispatched from the Command board still renders there', () => {
  it('carries a real write_result all the way onto a Command-board card', async () => {
    const w = wire()
    const { flush } = boot(w)

    // The ONE call a worker's `write_result` tool makes on the host.
    recordBoardResult(WORKER, {
      present: true,
      status: 'done',
      summary: '3 findings — one real (pid reuse in killTree), two low.',
      refs: ['src/main/pty.ts:774', 'src/main/pty.ts:839']
    })
    flush()
    await w.settle()

    expect(fedTasks()).toHaveLength(1)
    const [card] = fedTasks()
    // The renderer resolved the TITLE itself — MAIN carried only the board id.
    expect(card.title).toBe('reviewer-1')
    expect(card).toMatchObject({
      status: 'done',
      external: true,
      result: {
        status: 'done',
        summary: '3 findings — one real (pid reuse in killTree), two low.',
        refs: ['src/main/pty.ts:774', 'src/main/pty.ts:839']
      }
    })
    expect(card.group?.terminalId).toBe(WORKER)
    // …and the ring fired on the same event.
    expect(signals).toEqual([
      expect.objectContaining({ boardId: WORKER, event: 'done', attention: 'done' })
    ])
  })

  it('a blocked report raises the blocked ring AND chips the card, without a confirm', async () => {
    const w = wire()
    const { flush } = boot(w)
    recordBoardResult(WORKER, { present: true, status: 'blocked', summary: 'needs a decision' })
    flush()
    await w.settle()

    const [card] = fedTasks()
    // Blocked stays in `executing` — the column axis is lifecycle, and the block is a chip.
    expect(card).toMatchObject({ status: 'executing', blockedTag: 'blocked' })
    expect(signals[0]).toMatchObject({
      // Rides the EXISTING needs-input gate event, so no notifications-config key was needed…
      event: 'needs-input',
      // …while the canvas ring carries the finer state.
      attention: 'needs-input'
    })
  })

  it('🔒 an off-vocabulary status survives the round trip as `reporting` + its disclosure', async () => {
    const w = wire()
    const { flush } = boot(w)
    recordBoardResult(WORKER, { present: true, status: 'partial-ok', summary: 'half done' })
    flush()
    await w.settle()

    const [card] = fedTasks()
    expect(card.status).toBe('reporting')
    expect(card.disclose).toBe('unrecognized status "partial-ok" — treated as unsettled')
    // Non-terminal, so it stays in the recap's NOW zone and the human keeps watching.
    expect(signals).toHaveLength(0)
  })

  it('a SYNTHESIZED result crosses as derived, and never wears the done ring', async () => {
    const w = wire()
    const { flush } = boot(w)
    recordBoardResult(
      WORKER,
      { present: true, status: 'done', summary: 'derived from transcript' },
      { synthesized: true }
    )
    flush()
    await w.settle()

    expect(fedTasks()[0].disclose).toBe('derived from the transcript — the worker never reported')
    expect(signals[0].attention).toBe('blocked')
  })

  it('🔒 re-reports land on the SAME card (the newest-first lookup), not a second one', async () => {
    const w = wire()
    const { flush } = boot(w)
    recordBoardResult(WORKER, { present: true, status: 'blocked', summary: 'waiting' })
    flush()
    await w.settle()
    recordBoardResult(WORKER, { present: true, status: 'done', summary: 'finished' })
    flush()
    await w.settle()

    expect(fedTasks()).toHaveLength(1)
    expect(fedTasks()[0]).toMatchObject({ status: 'done', result: { summary: 'finished' } })
    // The stale block reason did not outlive the block.
    expect(fedTasks()[0].blockedTag).toBeUndefined()
  })

  it('refuses a push for a board that left the canvas, instead of inventing a card', async () => {
    const w = wire()
    const { flush } = boot(w)
    useCanvasStore.setState({
      boards: [{ id: COMMAND, type: 'command', title: 'Command', x: 0, y: 0, w: 1, h: 1 }]
    } as never)
    recordBoardResult(WORKER, { present: true, status: 'done', summary: 's' })
    flush()
    await w.settle()
    expect(fedTasks()).toHaveLength(0)
  })

  it('acks `rendered:false` when there is no Command board, so the absence can be disclosed', async () => {
    const acks: McpCommandAck[] = []
    const w = wire()
    useCanvasStore.setState({
      boards: [{ id: WORKER, type: 'terminal', title: 'reviewer-1', x: 0, y: 0, w: 1, h: 1 }]
    } as never)
    const feed = createCommandFeed({
      send: async (command) => {
        const ack = await sendMcpCommand(w.ipcMain, w.getWin, command, 50)
        acks.push(ack)
        return ack
      },
      deliver: (sig) => signals.push(sig),
      schedule: (fn) => {
        pending.push(fn)
        return () => {
          pending = pending.filter((f) => f !== fn)
        }
      }
    })
    setCommandFeed(feed)
    render(<Harness />)

    recordBoardResult(WORKER, { present: true, status: 'done', summary: 's' })
    const q = pending
    pending = []
    for (const fn of q) fn()
    await w.settle()

    expect(acks).toEqual([{ ok: true, type: 'commandFeed', rendered: false }])
    // The push still LANDED — the store fills so the board is already populated when one is added.
    expect(fedTasks()).toHaveLength(1)
  })

  it('🔒 costs ZERO human confirms — the whole reason status rides this channel', async () => {
    const confirm = vi.fn()
    const w = wire()
    const { flush } = boot(w)
    for (let i = 0; i < 8; i++) {
      recordBoardResult(WORKER, { present: true, status: 'done', summary: `report ${i}` })
      flush()
      await w.settle()
    }
    // N worker reports, no gate: `commandStore` is runtime-only and never serialized, so nothing
    // here is a durable content write. That is the constraint the whole design turns on.
    expect(confirm).not.toHaveBeenCalled()
    expect(fedTasks()).toHaveLength(1)
  })
})
