/**
 * Jarvis J4 — the turn LOOP through the mock brain + a fake canvas facet: a scripted
 * "add a card …" utterance streams, assembles the add_card tool call, executes it through
 * jarvisTools (act lifecycle events pushed), feeds the tool_result back, and the second
 * hop answers GROUNDED in that result. Plus the deny path (spawn pre-confirm declined ⇒
 * denied act + nothing-changed reply) and the toolless fallback (no facet ⇒ no acts).
 * Same electron-free harness as jarvisIpc.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerJarvisHandlers, type JarvisIpcDeps, type JarvisTurnEvent } from './jarvisIpc'
import type { JarvisCanvasFacet } from './jarvisTools'
import type { AppModel } from './appModel'

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const KANBAN_ID = 'abcdef12-0000-0000-0000-000000000000'

function fakeModel(): AppModel {
  return {
    version: 1,
    boardTypes: [],
    tools: [],
    canvas: {
      boards: [{ id: KANBAN_ID, type: 'kanban', title: 'Sprint board', status: 'idle' }],
      connectors: [],
      groups: []
    },
    rules: { spawnCap: 4, everyWriteGated: true }
  }
}

function makeFacet(over: Partial<JarvisCanvasFacet> = {}): JarvisCanvasFacet {
  return {
    describeApp: async () => fakeModel(),
    spawnBoard: vi.fn(async () => ({ id: 'spawned-1' })),
    dispatchPrompt: vi.fn(async () => ({ delivery: 'ready' as const })),
    addCard: vi.fn(async () => ({ id: 'card-42' })),
    updateCard: vi.fn(async () => {}),
    moveCard: vi.fn(async () => {}),
    visualizePlan: vi.fn(async () => ({ id: 'viz-1' })),
    focusViewport: vi.fn(async () => ({ focused: 'all' as const })),
    tidyCanvas: vi.fn(async () => ({ moved: 0 })),
    boardCards: vi.fn(async () => ({
      isKanban: true,
      columns: [{ id: 'col-1', title: 'Backlog' }]
    })),
    ...over
  }
}

interface Harness {
  invoke: (channel: string, ...args: unknown[]) => unknown
  events: (id: number) => JarvisTurnEvent[]
  waitForDone: (id: number) => Promise<JarvisTurnEvent[]>
  dir: string
}

function makeHarness(over: {
  facet?: JarvisCanvasFacet | null
  confirm?: JarvisIpcDeps['confirm']
}): Harness {
  const handlers: Record<string, Handler> = {}
  const ipcMain = {
    handle: (channel: string, fn: Handler): void => {
      handlers[channel] = fn
    }
  } as unknown as IpcMain
  const sent: Array<{ channel: string; payload: unknown }> = []
  const mainFrame = { id: 'main' }
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload })
    }
  } as unknown as BrowserWindow
  const dir = mkdtempSync(join(tmpdir(), 'jarvisipc-tools-'))
  registerJarvisHandlers(ipcMain, () => win, {
    getUserData: () => dir,
    getProjectKey: () => 'M:/proj',
    getFacet: async () => over.facet ?? null,
    confirm: over.confirm,
    stream: { fetch: vi.fn(), env: { CANVAS_LLM_MOCK: '1' } }
  })
  const ownEvent = { senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const events = (id: number): JarvisTurnEvent[] =>
    sent
      .filter((s) => s.channel === 'jarvis:turn:event')
      .map((s) => s.payload as JarvisTurnEvent)
      .filter((ev) => ev.id === id)
  return {
    invoke: (channel, ...args) => handlers[channel](ownEvent, ...args),
    events,
    async waitForDone(id) {
      for (let i = 0; i < 400; i++) {
        const evs = events(id)
        if (evs.some((ev) => ev.kind === 'done' || ev.kind === 'error')) return evs
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error('turn never completed')
    },
    dir
  }
}

describe('jarvisIpc J4 turn loop', () => {
  it('executes the scripted add_card behind the loop and answers grounded in its result', async () => {
    const facet = makeFacet()
    const h = makeHarness({ facet })
    try {
      const r = h.invoke('jarvis:turn:start', {
        text: 'add a card smoke test to board abcdef12'
      }) as { ok: boolean; id: number }
      expect(r.ok).toBe(true)
      const evs = await h.waitForDone(r.id)
      // The tool executed against the resolved full board id, default first column.
      expect(facet.addCard).toHaveBeenCalledWith(KANBAN_ID, {
        columnId: 'col-1',
        title: 'smoke test'
      })
      // Act lifecycle: gated ⇒ 'confirm' first, then 'ok' with the validated summary.
      const acts = evs.filter((ev) => ev.kind === 'act')
      expect(acts.map((a) => (a.kind === 'act' ? a.phase : ''))).toEqual(['confirm', 'ok'])
      expect(acts[0]).toMatchObject({ name: 'add_card', gated: true })
      expect(acts[1]).toMatchObject({ phase: 'ok' })
      if (acts[1].kind === 'act') expect(acts[1].summary).toContain('smoke test')
      // The second hop's spoken text quotes the tool result (card-42), never invention.
      const done = evs.find((ev) => ev.kind === 'done')
      expect(done && done.kind === 'done' ? done.text : '').toContain('card-42')
      // History records the full spoken text (both hops joined).
      const hist = h.invoke('jarvis:history:get') as Array<{ role: string; text: string }>
      expect(hist[hist.length - 1].text).toContain('card-42')
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('a human DENY at the gate lands a denied act and a nothing-changed reply', async () => {
    // The orchestrator gate denies (the thrown deny → outcome mapping) — the same shape a
    // declined panel act-card produces end to end.
    const denyFacet = makeFacet({
      addCard: vi.fn(async () => {
        throw new Error('add_card: write denied by the human gate')
      })
    })
    const h = makeHarness({ facet: denyFacet })
    try {
      const r = h.invoke('jarvis:turn:start', { text: 'add a card x to board abcdef12' }) as {
        ok: boolean
        id: number
      }
      const evs = await h.waitForDone(r.id)
      const acts = evs.filter((ev) => ev.kind === 'act')
      expect(acts.map((a) => (a.kind === 'act' ? a.phase : ''))).toEqual(['confirm', 'denied'])
      const done = evs.find((ev) => ev.kind === 'done')
      expect(done && done.kind === 'done' ? done.text : '').toContain('Nothing was changed')
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it('no facet ⇒ toolless turn: the scripted grammar just echoes, zero act events', async () => {
    const h = makeHarness({ facet: null })
    try {
      const r = h.invoke('jarvis:turn:start', { text: 'add a card x to board abcdef12' }) as {
        ok: boolean
        id: number
      }
      const evs = await h.waitForDone(r.id)
      expect(evs.filter((ev) => ev.kind === 'act')).toEqual([])
      const done = evs.find((ev) => ev.kind === 'done')
      expect(done && done.kind === 'done' ? done.text : '').not.toContain('card-42')
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('MAX_TOOL_HOPS runaway cap', () => {
  it('a model that returns tool_use on EVERY hop terminates after exactly 4 tool rounds', async () => {
    // Real stream path (no mock): every request answers one auto-allow tool call +
    // stop_reason 'tool_use' — an infinite loop if the cap regresses. 4 rounds execute,
    // the 5th request's calls are NOT executed (the cap breaks first), the turn settles.
    const frame = (j: object): string => `data: ${JSON.stringify(j)}\n\n`
    let requests = 0
    const payload = [
      frame({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tu', name: 'tidy_canvas', input: {} }
      }),
      frame({ type: 'content_block_stop' }),
      frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      frame({ type: 'message_stop' })
    ].join('')
    const facet = makeFacet()
    const handlers: Record<string, Handler> = {}
    const ipcMain = {
      handle: (channel: string, fn: Handler): void => {
        handlers[channel] = fn
      }
    } as unknown as IpcMain
    const sent: Array<{ channel: string; payload: unknown }> = []
    const mainFrame = { id: 'main' }
    const win = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        mainFrame,
        send: (channel: string, payload: unknown) => sent.push({ channel, payload })
      }
    } as unknown as BrowserWindow
    const dir = mkdtempSync(join(tmpdir(), 'jarvisipc-hops-'))
    try {
      registerJarvisHandlers(ipcMain, () => win, {
        getUserData: () => dir,
        getProjectKey: () => 'M:/proj',
        getFacet: async () => facet,
        stream: {
          fetch: async () => {
            requests++
            return {
              ok: true,
              status: 200,
              body: (async function* (): AsyncIterable<Uint8Array> {
                yield new TextEncoder().encode(payload)
              })()
            }
          },
          env: { ANTHROPIC_API_KEY: 'sk-test' } // real path, no CANVAS_LLM_MOCK
        }
      })
      const ownEvent = { senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
      const r = handlers['jarvis:turn:start'](ownEvent, { text: 'tidy everything forever' }) as {
        ok: boolean
        id: number
      }
      expect(r.ok).toBe(true)
      for (let i = 0; i < 400; i++) {
        const done = sent
          .filter((s) => s.channel === 'jarvis:turn:event')
          .map((s) => s.payload as JarvisTurnEvent)
          .some((ev) => ev.id === r.id && (ev.kind === 'done' || ev.kind === 'error'))
        if (done) break
        await new Promise((res) => setTimeout(res, 5))
      }
      // Exactly 4 executed tool rounds (the cap), 5 paid requests (1 + one per round),
      // and a settled turn — never a runaway.
      expect(facet.tidyCanvas).toHaveBeenCalledTimes(4)
      expect(requests).toBe(5)
      const evs = sent
        .filter((s) => s.channel === 'jarvis:turn:event')
        .map((s) => s.payload as JarvisTurnEvent)
        .filter((ev) => ev.id === r.id)
      expect(evs.some((ev) => ev.kind === 'done')).toBe(true)
      expect(evs.filter((ev) => ev.kind === 'act' && ev.phase === 'ok').length).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
