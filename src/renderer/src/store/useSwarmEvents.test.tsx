import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useSwarmEvents } from './useSwarmEvents'
import { runFor, useSwarmStore } from './swarmStore'
import { useCanvasStore } from './canvasStore'
import type { SwarmRunEventPayload, SwarmTurnEventPayload } from '../../../preload/swarm'

/** Probe mounts the router hook exactly like App.tsx does. */
function Probe(): null {
  useSwarmEvents()
  return null
}

type TurnHandler = (ev: SwarmTurnEventPayload) => void
type RunHandler = (ev: SwarmRunEventPayload) => void

let onTurn: TurnHandler
let onRun: RunHandler

beforeEach(() => {
  cleanup()
  useSwarmStore.getState().clearAll()
  ;(window as unknown as { api: unknown }).api = {
    swarm: {
      onTurnEvent: vi.fn((h: TurnHandler) => {
        onTurn = h
        return () => {}
      }),
      onRunEvent: vi.fn((h: RunHandler) => {
        onRun = h
        return () => {}
      })
    }
  }
  render(<Probe />)
})

describe('useSwarmEvents — turn stream → chat bubbles', () => {
  it('deltas open one streaming bubble per turn; done settles it; runs stay isolated', () => {
    onTurn({ runId: 'a', id: 1, kind: 'delta', text: 'Plan ' })
    onTurn({ runId: 'a', id: 1, kind: 'delta', text: 'drawn.' })
    onTurn({ runId: 'b', id: 2, kind: 'delta', text: 'other run' })
    let a = runFor(useSwarmStore.getState().runs, 'a')
    expect(a.turnActive).toBe(true)
    expect(a.messages).toHaveLength(1)
    expect(a.messages[0]).toMatchObject({ role: 'orch', text: 'Plan drawn.', streaming: true })
    expect(runFor(useSwarmStore.getState().runs, 'b').messages[0].text).toBe('other run')
    onTurn({ runId: 'a', id: 1, kind: 'done', text: 'Plan drawn.', cancelled: false })
    a = runFor(useSwarmStore.getState().runs, 'a')
    expect(a.turnActive).toBe(false)
    expect(a.messages[0].streaming).toBeUndefined()
    // b's turn is untouched by a's done.
    expect(runFor(useSwarmStore.getState().runs, 'b').messages[0].streaming).toBe(true)
  })

  it('a tool-only turn (done with text, no deltas) still lands one settled bubble', () => {
    onTurn({ runId: 'a', id: 3, kind: 'done', text: 'Dispatched 3 workers.', cancelled: false })
    const a = runFor(useSwarmStore.getState().runs, 'a')
    expect(a.messages).toHaveLength(1)
    expect(a.messages[0]).toMatchObject({ role: 'orch', text: 'Dispatched 3 workers.' })
  })

  it('error settles the stream and lands a status line (no-key mapped to settings hint)', () => {
    onTurn({ runId: 'a', id: 4, kind: 'delta', text: 'partial' })
    onTurn({ runId: 'a', id: 4, kind: 'error', reason: 'no-key' })
    const a = runFor(useSwarmStore.getState().runs, 'a')
    expect(a.turnActive).toBe(false)
    expect(a.messages.at(-1)).toMatchObject({ role: 'status' })
    expect(a.messages.at(-1)!.text).toContain('Context · LLM')
  })

  it('act events: confirm/denied surface as status lines, running/ok stay silent', () => {
    onTurn({
      runId: 'a',
      id: 5,
      kind: 'act',
      name: 'spawn_worker',
      summary: 'spawn_worker',
      phase: 'confirm'
    })
    onTurn({
      runId: 'a',
      id: 5,
      kind: 'act',
      name: 'spawn_worker',
      summary: 'spawned b-1',
      phase: 'ok'
    })
    onTurn({
      runId: 'a',
      id: 5,
      kind: 'act',
      name: 'dispatch_task',
      summary: 'dispatch',
      phase: 'denied'
    })
    const texts = runFor(useSwarmStore.getState().runs, 'a').messages.map((m) => m.text)
    expect(texts).toEqual(['waiting for your confirm — spawn_worker', 'denied — dispatch'])
  })
})

describe('useSwarmEvents — board-lifecycle bridge (canvasStore → swarmStore)', () => {
  it('a deleted swarm board drops its run; a deleted worker leaves every run', () => {
    const boards = [
      { id: 'sb', type: 'swarm', x: 0, y: 0, w: 10, h: 10, title: 'run' },
      { id: 'w1', type: 'terminal', x: 0, y: 0, w: 10, h: 10, title: 'w' }
    ]
    useCanvasStore.setState({ boards: boards as never })
    const s = useSwarmStore.getState()
    s.addUserMessage('sb', 'goal')
    s.addWorker('sb', 'w1')
    // Worker board deleted → membership drops, run survives.
    useCanvasStore.setState({ boards: [boards[0]] as never })
    expect(runFor(useSwarmStore.getState().runs, 'sb').workerIds).toEqual([])
    expect(useSwarmStore.getState().runs.has('sb')).toBe(true)
    // Swarm board deleted → the run dies with it.
    useCanvasStore.setState({ boards: [] as never })
    expect(useSwarmStore.getState().runs.has('sb')).toBe(false)
  })
})

describe('useSwarmEvents — run mirror events', () => {
  it('workerSpawned/planDrawn/activity/workerSettled land on the right run', () => {
    onRun({
      runId: 'a',
      ev: { kind: 'workerSpawned', workerId: 'w1', role: 'builder', title: 'b-1' }
    })
    onRun({ runId: 'a', ev: { kind: 'planDrawn', planBoardId: 'p1' } })
    onRun({ runId: 'a', ev: { kind: 'activity', workerId: 'w1', text: 'Migrating…' } })
    onRun({
      runId: 'a',
      ev: { kind: 'workerSettled', workerId: 'w1', provenance: 'synthesized', status: 'done' }
    })
    const a = runFor(useSwarmStore.getState().runs, 'a')
    expect(a.workerIds).toEqual(['w1'])
    expect(a.planBoardId).toBe('p1')
    expect(a.workerMeta.w1).toMatchObject({
      role: 'builder',
      activity: 'Migrating…',
      provenance: 'synthesized'
    })
    expect(runFor(useSwarmStore.getState().runs, 'b').workerIds).toEqual([])
  })
})
