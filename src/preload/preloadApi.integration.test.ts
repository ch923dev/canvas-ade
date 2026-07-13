import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasApi } from './index'

// Capture the exposed api + spy on ipcRenderer.invoke/on. vi.hoisted so the holder
// exists when the hoisted vi.mock factory runs.
// The mock's ipcRenderer mirrors a real EventEmitter (on/removeListener/listenerCount) so
// BUG-029's `listenerCount('mcp:confirm') > 0` single-subscriber gate can be exercised.
const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<unknown>>()
  return {
    invoke: vi.fn(),
    on: vi.fn((ch: string, fn: unknown) => {
      if (!listeners.has(ch)) listeners.set(ch, new Set())
      listeners.get(ch)!.add(fn)
    }),
    removeListener: vi.fn((ch: string, fn: unknown) => listeners.get(ch)?.delete(fn)),
    listenerCount: (ch: string): number => listeners.get(ch)?.size ?? 0,
    listeners,
    api: undefined as unknown
  }
})

// Mock electron so importing the preload has no Electron dependency:
//  - contextBridge.exposeInMainWorld captures the api object
//  - ipcRenderer.invoke is the spy we assert against
//  - ipcRenderer.on is spied (BUG-029: asserts it wires at most once for onConfirm);
//    removeListener is a no-op (preload registers a pty:port listener at import; it
//    must not throw)
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, value: unknown) => {
      h.api = value
    }
  },
  ipcRenderer: {
    invoke: h.invoke,
    on: h.on,
    removeListener: h.removeListener,
    listenerCount: h.listenerCount,
    // The preload reads osWinBuild once at module load via a synchronous platform:winBuild
    // round-trip — but ONLY on win32 (A-Win, #230). Without this stub every test in this file
    // throws "sendSync is not a function" on a Windows dev box (Linux CI never hits the branch).
    sendSync: vi.fn(() => null)
  }
}))

let api: CanvasApi

beforeEach(async () => {
  h.invoke.mockClear()
  h.on.mockClear()
  h.removeListener.mockClear()
  h.listeners.clear()
  // Force the `if (process.contextIsolated)` branch (the else branch references
  // `window`, undefined under the node test environment).
  ;(process as { contextIsolated?: boolean }).contextIsolated = true
  vi.resetModules()
  await import('./index') // side effect: calls exposeInMainWorld → fills h.api
  api = h.api as CanvasApi
})

// A fixed byte payload so the deep-equal in toHaveBeenCalledWith matches by reference.
const BYTES = new Uint8Array([1, 2, 3])

describe('preload api → terminal channels', () => {
  it.each([
    ['spawnTerminal', (a: CanvasApi) => a.spawnTerminal({ id: 'b1' }), ['pty:spawn', { id: 'b1' }]],
    ['killTerminal', (a: CanvasApi) => a.killTerminal('b1'), ['pty:kill', 'b1']],
    ['disposeAllTerminals', (a: CanvasApi) => a.disposeAllTerminals(), ['pty:disposeAll']],
    ['parkTerminal', (a: CanvasApi) => a.parkTerminal('b1'), ['pty:park', 'b1']],
    ['adoptTerminal', (a: CanvasApi) => a.adoptTerminal('b1'), ['pty:adopt', 'b1']],
    ['listShells', (a: CanvasApi) => a.listShells(), ['pty:shells']],
    ['detectPorts', (a: CanvasApi) => a.detectPorts('b1'), ['terminal:detectPorts', 'b1']]
  ] as const)('%s', (_label, call, expected) => {
    call(api)
    expect(h.invoke).toHaveBeenCalledWith(...expected)
  })
})

describe('preload api → preview channels', () => {
  it.each([
    [
      'openExternalPreview',
      (a: CanvasApi) => a.openExternalPreview('http://x/'),
      ['preview:openExternal', 'http://x/']
    ],
    [
      'screenshotPreview',
      (a: CanvasApi) => a.screenshotPreview('b1'),
      ['preview:screenshot', 'b1']
    ],
    ['reloadOsrPreview', (a: CanvasApi) => a.reloadOsrPreview('b1'), ['preview:osrReload', 'b1']],
    ['goBackOsrPreview', (a: CanvasApi) => a.goBackOsrPreview('b1'), ['preview:osrGoBack', 'b1']],
    [
      'goForwardOsrPreview',
      (a: CanvasApi) => a.goForwardOsrPreview('b1'),
      ['preview:osrGoForward', 'b1']
    ],
    ['closeOsrPreview', (a: CanvasApi) => a.closeOsrPreview('b1'), ['preview:osrClose', 'b1']],
    ['closeAllOsr', (a: CanvasApi) => a.closeAllOsr(), ['preview:osrCloseAll']]
  ] as const)('%s', (_label, call, expected) => {
    call(api)
    expect(h.invoke).toHaveBeenCalledWith(...expected)
  })
})

describe('preload api → project / asset / dialog / export channels', () => {
  it.each([
    [
      'project.create',
      (a: CanvasApi) => a.project.create('C:\\p', 'n', { gitInit: true }),
      ['project:create', { dir: 'C:\\p', name: 'n', opts: { gitInit: true } }]
    ],
    ['project.open', (a: CanvasApi) => a.project.open('C:\\p'), ['project:open', 'C:\\p']],
    [
      'project.save',
      (a: CanvasApi) => a.project.save({ schemaVersion: 2 }),
      ['project:save', { schemaVersion: 2 }]
    ],
    [
      // BUG-009: the optional expectedDir is forwarded so MAIN can reject a save that
      // raced a project switch (doc belongs to a no-longer-current project).
      'project.save (expectedDir)',
      (a: CanvasApi) => a.project.save({ schemaVersion: 2 }, 'C:\\p'),
      ['project:save', { schemaVersion: 2 }, 'C:\\p']
    ],
    ['project.recents', (a: CanvasApi) => a.project.recents(), ['project:recents']],
    ['project.current', (a: CanvasApi) => a.project.current(), ['project:current']],
    [
      'asset.write',
      (a: CanvasApi) => a.asset.write(BYTES, 'png'),
      ['asset:write', { bytes: BYTES, ext: 'png' }]
    ],
    ['asset.read', (a: CanvasApi) => a.asset.read('id1'), ['asset:read', 'id1']],
    ['dialog.openFolder', (a: CanvasApi) => a.dialog.openFolder(), ['dialog:openFolder']],
    [
      'export.save',
      (a: CanvasApi) => a.export.save({ bytes: BYTES, ext: 'svg', defaultName: 'board' }),
      ['export:save', { bytes: BYTES, ext: 'svg', defaultName: 'board' }]
    ],
    [
      'memory.readBoards',
      (a: CanvasApi) => a.memory.readBoards(['t1', 'b1']),
      ['memory:readBoards', ['t1', 'b1']]
    ]
  ] as const)('%s', (_label, call, expected) => {
    call(api)
    expect(h.invoke).toHaveBeenCalledWith(...expected)
  })
})

describe('preload api → llm channels (M-brain)', () => {
  it.each([
    [
      'llm.summarize',
      (a: CanvasApi) => a.llm.summarize({ text: 'hi' }),
      ['llm:summarize', { text: 'hi' }]
    ],
    ['llm.status', (a: CanvasApi) => a.llm.status(), ['llm:status']],
    [
      'llm.setKey',
      (a: CanvasApi) => a.llm.setKey({ provider: 'openrouter', key: 'sk-xyz' }),
      ['llm:setKey', { provider: 'openrouter', key: 'sk-xyz' }]
    ],
    [
      'llm.clearKey',
      (a: CanvasApi) => a.llm.clearKey({ provider: 'openrouter' }),
      ['llm:clearKey', { provider: 'openrouter' }]
    ],
    [
      'llm.setConfig',
      (a: CanvasApi) => a.llm.setConfig({ provider: 'anthropic', model: 'm' }),
      ['llm:setConfig', { provider: 'anthropic', model: 'm' }]
    ]
  ] as const)('%s', (_label, call, expected) => {
    call(api)
    expect(h.invoke).toHaveBeenCalledWith(...expected)
  })
})

// The two listener methods (onPreviewEvent, project.onFlush) use ipcRenderer.on, not
// invoke — out of the invoke-mapping contract (see spec §error-handling). They are
// covered here only to the extent that the api exposes them without throwing.
describe('preload api shape', () => {
  it('exposes the listener methods (registered via ipcRenderer.on, not invoke)', () => {
    expect(typeof api.onPreviewEvent).toBe('function')
    expect(typeof api.project.onFlush).toBe('function')
  })
})

// 🔒 BUG-029: mcp.onConfirm allowed unlimited concurrent subscribers — any second in-frame
// script could register its own listener and race the real ConfirmModal to auto-approve
// every human-confirm request. At most one subscriber may ever be wired. `h.on` also
// captures OTHER channels the preload wires at import time (e.g. 'pty:port'), so every
// assertion here filters to the 'mcp:confirm' channel specifically.
describe('preload api → mcp.onConfirm single-subscriber gate (BUG-029)', () => {
  const confirmCalls = (): unknown[][] => h.on.mock.calls.filter((c) => c[0] === 'mcp:confirm')

  it('wires the underlying IPC listener only once, even across multiple onConfirm calls', () => {
    api.mcp.onConfirm(() => {})
    expect(confirmCalls()).toHaveLength(1)

    // A second registration while the first is still active must NOT add another listener.
    api.mcp.onConfirm(() => {})
    expect(confirmCalls()).toHaveLength(1)
  })

  it('only the FIRST handler ever receives a pushed confirm request; a second never fires', () => {
    const first = vi.fn()
    const second = vi.fn()
    api.mcp.onConfirm(first)
    api.mcp.onConfirm(second) // no-op: an active subscriber already holds the channel

    const listener = confirmCalls()[0][1] as (e: unknown, msg: unknown) => void
    listener({}, { request: { title: 't', body: 'b' }, replyChannel: 'ch' })

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('a fresh subscriber can take over after the active one unsubscribes', () => {
    const unsubscribe = api.mcp.onConfirm(() => {})
    unsubscribe()
    const replacement = vi.fn()
    api.mcp.onConfirm(replacement)
    // The replacement wired its own listener (a second real 'mcp:confirm' ipcRenderer.on call).
    expect(confirmCalls()).toHaveLength(2)
  })
})

// 🔒 The BATCH confirm channel (relay_prompts) gets the SAME BUG-029 single-subscriber gate on
// its own 'mcp:confirm:batch' channel — no second in-frame script may race the BatchConfirmModal.
describe('preload api → mcp.onConfirmBatch single-subscriber gate (relay_prompts)', () => {
  const batchCalls = (): unknown[][] => h.on.mock.calls.filter((c) => c[0] === 'mcp:confirm:batch')

  it('wires the underlying IPC listener only once, even across multiple onConfirmBatch calls', () => {
    api.mcp.onConfirmBatch(() => {})
    expect(batchCalls()).toHaveLength(1)
    api.mcp.onConfirmBatch(() => {}) // no-op: an active subscriber already holds the channel
    expect(batchCalls()).toHaveLength(1)
  })

  it('forwards the batch request and a reply fn to the FIRST handler only', () => {
    const first = vi.fn()
    const second = vi.fn()
    api.mcp.onConfirmBatch(first)
    api.mcp.onConfirmBatch(second) // no-op
    const listener = batchCalls()[0][1] as (e: unknown, msg: unknown) => void
    listener({}, { request: { title: 'Relay 2 prompts', items: [] }, replyChannel: 'ch' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0][0]).toEqual({ title: 'Relay 2 prompts', items: [] })
    expect(typeof first.mock.calls[0][1]).toBe('function') // the reply fn
    expect(second).not.toHaveBeenCalled()
  })
})

// 🔒 PR-2: the close-modal channel gets the SAME BUG-029 single-subscriber gate — the worst a
// racing in-frame listener could do is answer 'cancel' (MAIN's fail-safe floor), but the
// decision authority still stays with the one real CloseSessionsModal.
describe('preload api → closeGuard.onCloseQuery single-subscriber gate (PR-2)', () => {
  const queryCalls = (): unknown[][] => h.on.mock.calls.filter((c) => c[0] === 'closeGuard:query')

  it('wires the underlying IPC listener only once, even across multiple onCloseQuery calls', () => {
    api.closeGuard.onCloseQuery(() => {})
    expect(queryCalls()).toHaveLength(1)
    api.closeGuard.onCloseQuery(() => {}) // no-op: an active subscriber already holds the channel
    expect(queryCalls()).toHaveLength(1)
  })

  it('forwards the session rows and a reply fn to the FIRST handler only', () => {
    const first = vi.fn()
    const second = vi.fn()
    api.closeGuard.onCloseQuery(first)
    api.closeGuard.onCloseQuery(second) // no-op
    const listener = queryCalls()[0][1] as (e: unknown, msg: unknown) => void
    listener({}, { sessions: [{ id: 'b1' }], replyChannel: 'ch' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0][0]).toEqual([{ id: 'b1' }])
    expect(typeof first.mock.calls[0][1]).toBe('function') // the reply fn
    expect(second).not.toHaveBeenCalled()
  })
})
