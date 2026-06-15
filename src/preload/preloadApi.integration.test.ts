import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasApi } from './index'

// Capture the exposed api + spy on ipcRenderer.invoke. vi.hoisted so the holder
// exists when the hoisted vi.mock factory runs.
const h = vi.hoisted(() => ({ invoke: vi.fn(), api: undefined as unknown }))

// Mock electron so importing the preload has no Electron dependency:
//  - contextBridge.exposeInMainWorld captures the api object
//  - ipcRenderer.invoke is the spy we assert against
//  - ipcRenderer.on / removeListener are no-ops (preload registers a pty:port
//    listener at import; it must not throw)
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, value: unknown) => {
      h.api = value
    }
  },
  ipcRenderer: {
    invoke: h.invoke,
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

let api: CanvasApi

beforeEach(async () => {
  h.invoke.mockClear()
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
