/**
 * Voice V2 — MAIN-side engine handle units: lazy spawn, session start port transfer,
 * stop round-trip (frames from {t:'session:stopped'}), timeout fallback, crash recovery,
 * dispose. All against a fake EngineChildLike; the spike runner is exercised through a
 * mocked utilityProcess.fork.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { MessagePortMain } from 'electron'

const h = vi.hoisted(() => {
  class FakeChild {
    posted: Array<{ msg: unknown; transfer?: unknown[] }> = []
    listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    killed = false
    on(event: string, listener: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? []
      arr.push(listener)
      this.listeners.set(event, arr)
      return this
    }
    postMessage(msg: unknown, transfer?: unknown[]): void {
      this.posted.push({ msg, transfer })
    }
    kill(): boolean {
      this.killed = true
      return true
    }
    emit(event: string, ...args: unknown[]): void {
      for (const l of this.listeners.get(event) ?? []) l(...args)
    }
    stdout = null
    stderr = null
  }
  const forked: FakeChild[] = []
  return { FakeChild, forked }
})

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn(() => {
      const c = new h.FakeChild()
      h.forked.push(c)
      return c
    })
  }
}))

import { createVoiceEngine, runEngineSpike, type EngineChildLike } from './voiceEngine'

const fakePort = {} as MessagePortMain

describe('createVoiceEngine', () => {
  let child: InstanceType<typeof h.FakeChild>
  let fork: Mock<() => EngineChildLike>

  beforeEach(() => {
    child = new h.FakeChild()
    fork = vi.fn(() => child as unknown as EngineChildLike)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns lazily once and transfers the session port with the model paths', () => {
    const engine = createVoiceEngine(fork)
    expect(fork).not.toHaveBeenCalled()
    const model = { encoder: 'E', decoder: 'D', joiner: 'J', tokens: 'T' }
    engine.startSession(fakePort, model)
    engine.startSession(fakePort, null)
    expect(fork).toHaveBeenCalledTimes(1)
    expect(child.posted).toEqual([
      { msg: { t: 'session:start', model }, transfer: [fakePort] },
      { msg: { t: 'session:start', model: null }, transfer: [fakePort] }
    ])
  })

  it('stopSession round-trips frames from session:stopped', async () => {
    const engine = createVoiceEngine(fork)
    engine.startSession(fakePort, null)
    const pending = engine.stopSession()
    expect(child.posted.at(-1)?.msg).toEqual({ t: 'session:stop' })
    child.emit('message', { t: 'session:stopped', frames: 42 })
    await expect(pending).resolves.toEqual({ frames: 42 })
  })

  it('stopSession resolves 0 when no host was ever spawned', async () => {
    await expect(createVoiceEngine(fork).stopSession()).resolves.toEqual({ frames: 0 })
    expect(fork).not.toHaveBeenCalled()
  })

  it('stopSession times out to 0 frames when the host never answers', async () => {
    vi.useFakeTimers()
    const engine = createVoiceEngine(fork)
    engine.startSession(fakePort, null)
    const pending = engine.stopSession(1000)
    vi.advanceTimersByTime(1001)
    await expect(pending).resolves.toEqual({ frames: 0 })
  })

  it('a host exit settles a pending stop with 0 and respawns on the next start', async () => {
    const engine = createVoiceEngine(fork)
    engine.startSession(fakePort, null)
    const pending = engine.stopSession()
    child.emit('exit', 1)
    await expect(pending).resolves.toEqual({ frames: 0 })
    engine.startSession(fakePort, null)
    expect(fork).toHaveBeenCalledTimes(2)
  })

  it('dispose kills the host; safe when never spawned', () => {
    const engine = createVoiceEngine(fork)
    engine.dispose() // no child yet — must not throw
    engine.startSession(fakePort, null)
    engine.dispose()
    expect(child.killed).toBe(true)
  })

  it('an unexpected host exit fires onEngineFailure; dispose does not (V5)', () => {
    const engine = createVoiceEngine(fork)
    const onFail = vi.fn()
    engine.onEngineFailure(onFail)
    engine.startSession(fakePort, null)
    child.emit('exit', 1)
    expect(onFail).toHaveBeenCalledWith('voice engine host exited unexpectedly')

    onFail.mockClear()
    engine.startSession(fakePort, null) // respawn (same fake child instance)
    engine.dispose()
    child.emit('exit', 0) // the kill's own exit event
    expect(onFail).not.toHaveBeenCalled()
  })

  it('decoder:error kills the host, fires onEngineFailure once, settles a pending stop (V5)', async () => {
    const engine = createVoiceEngine(fork)
    const onFail = vi.fn()
    engine.onEngineFailure(onFail)
    engine.startSession(fakePort, null)
    const pending = engine.stopSession()
    child.emit('message', { t: 'decoder:error', error: 'worker exited (1)' })
    expect(child.killed).toBe(true)
    expect(onFail).toHaveBeenCalledExactlyOnceWith('worker exited (1)')
    await expect(pending).resolves.toEqual({ frames: 0 })
    // The kill's trailing exit event must not escalate a second time.
    child.emit('exit', 0)
    expect(onFail).toHaveBeenCalledTimes(1)
    // Next start respawns a fresh host.
    engine.startSession(fakePort, null)
    expect(fork).toHaveBeenCalledTimes(2)
  })
})

describe('runEngineSpike (mocked utilityProcess.fork)', () => {
  beforeEach(() => {
    h.forked.length = 0
  })

  it('resolves the spike result and kills the host', async () => {
    const pending = runEngineSpike(5000)
    const child = h.forked[0]
    child.emit('message', { t: 'spike:result', ok: true, version: '1.13.3' })
    await expect(pending).resolves.toEqual({ ok: true, version: '1.13.3' })
    expect(child.killed).toBe(true)
  })

  it('an early host exit resolves as failure', async () => {
    const pending = runEngineSpike(5000)
    h.forked[0].emit('exit', 3)
    await expect(pending).resolves.toEqual({ ok: false, error: 'host exited (3) before result' })
  })
})
