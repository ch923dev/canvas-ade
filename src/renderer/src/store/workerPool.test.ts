import { describe, it, expect } from 'vitest'
import { deriveWorkerPool, WORKER_SPAWN_CAP } from './workerPool'
import { createBoard, type Board, type TerminalBoard } from '../lib/boardSchema'

function term(id: string, patch: Partial<TerminalBoard> = {}): Board {
  return { ...(createBoard('terminal', { id, x: 0, y: 0 }) as TerminalBoard), ...patch }
}
const browser = (id: string): Board => createBoard('browser', { id, x: 0, y: 0 })
const planning = (id: string): Board => createBoard('planning', { id, x: 0, y: 0 })
const command = (id: string): Board => createBoard('command', { id, x: 0, y: 0 })

describe('deriveWorkerPool', () => {
  it('splits terminals into idle vs running via the running map', () => {
    const pool = deriveWorkerPool([term('t1'), term('t2'), term('t3')], { t1: true })
    expect(pool.terminalsRunning).toBe(1)
    expect(pool.terminalsIdle).toBe(2)
    expect(pool.cap).toBe(WORKER_SPAWN_CAP)
  })

  it('counts browser and planning boards', () => {
    const pool = deriveWorkerPool([browser('b1'), browser('b2'), planning('p1')], {})
    expect(pool.browsers).toBe(2)
    expect(pool.planning).toBe(1)
  })

  it('excludes a monitorActivity:false terminal (swarm opt-out)', () => {
    const pool = deriveWorkerPool([term('t1'), term('t2', { monitorActivity: false })], {})
    expect(pool.terminalsIdle).toBe(1)
    expect(pool.terminalsRunning).toBe(0)
  })

  it('counts a monitorActivity:true terminal (explicit opt-in)', () => {
    const pool = deriveWorkerPool([term('t1', { monitorActivity: true })], {})
    expect(pool.terminalsIdle).toBe(1)
  })

  it('excludes the command board itself (orchestrator, not a worker)', () => {
    const pool = deriveWorkerPool([command('c1'), term('t1')], {})
    expect(pool.terminalsIdle).toBe(1)
    expect(pool.browsers).toBe(0)
    expect(pool.planning).toBe(0)
  })

  it('is all-zero for an empty canvas', () => {
    expect(deriveWorkerPool([], {})).toEqual({
      terminalsIdle: 0,
      terminalsRunning: 0,
      browsers: 0,
      planning: 0,
      cap: WORKER_SPAWN_CAP
    })
  })
})
