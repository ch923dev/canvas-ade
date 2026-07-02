/**
 * Voice V2 — engine-host lifecycle (MAIN side).
 *
 * Owns fork/kill of the sherpa-onnx utilityProcess (`voiceEngineHost.js`, a sibling
 * main-bundle entry) and the session control seam voiceIpc drives: start hands the
 * engine end of the `voice:port` MessageChannelMain to the host (ports transfer to a
 * utilityProcess via `child.postMessage(msg, [port])`), stop round-trips
 * `session:stop` → `{t:'session:stopped', frames}`. The host is spawned lazily on the
 * first session and kept alive across sessions (the recognizer cache inside it makes
 * mic re-toggles cheap); an unexpected exit just clears the handle so the next start
 * respawns — V5 hardens this into a surfaced error state with auto-restart-once.
 *
 * Also hosts the V2 spike runner (CANVAS_VOICE_SPIKE gate in index.ts; kept for the V5
 * packaged validation) — it reuses the host's boot-time `{t:'spike:result'}` load proof.
 */
import { utilityProcess } from 'electron'
import type { MessagePortMain, UtilityProcess } from 'electron'
import { join } from 'path'
import type { SpikeResult } from './voiceEngineHost'
import type { VoiceModelPaths } from './voiceModels'

export function spawnEngineHost(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'voiceEngineHost.js'), [], {
    serviceName: 'voice-engine',
    stdio: 'pipe'
  })
  // Surface host output in MAIN's console — addon load errors + the debug cadence log.
  child.stdout?.on('data', (d) => console.log(`[voice-engine] ${String(d).trimEnd()}`))
  child.stderr?.on('data', (d) => console.error(`[voice-engine] ${String(d).trimEnd()}`))
  return child
}

/** Structural slice of UtilityProcess so the engine handle is unit-testable without electron. */
export interface EngineChildLike {
  postMessage(message: unknown, transfer?: MessagePortMain[]): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

export interface VoiceEngineHandle {
  /** Transfer the engine end of a session channel to the host (spawns it if needed). */
  startSession(port: MessagePortMain, model: VoiceModelPaths | null): void
  /** Stop the live session; resolves with the host's received-frame count. */
  stopSession(timeoutMs?: number): Promise<{ frames: number }>
  /** Kill the host outright (app quit). Safe when never spawned. */
  dispose(): void
}

export function createVoiceEngine(
  fork: () => EngineChildLike = spawnEngineHost as () => EngineChildLike
): VoiceEngineHandle {
  let child: EngineChildLike | null = null
  let pendingStop: ((r: { frames: number }) => void) | null = null

  const settleStop = (frames: number): void => {
    const resolve = pendingStop
    pendingStop = null
    resolve?.({ frames })
  }

  const ensureChild = (): EngineChildLike => {
    if (child) return child
    const c = fork()
    c.on('message', (m: unknown) => {
      const msg = m as { t?: string; frames?: number } | null
      if (msg?.t === 'session:stopped') settleStop(msg.frames ?? 0)
    })
    c.on('exit', () => {
      // Crash or kill: next startSession respawns; a stop waiting on the reply gets 0.
      child = null
      settleStop(0)
    })
    child = c
    return c
  }

  return {
    startSession(port, model): void {
      ensureChild().postMessage({ t: 'session:start', model }, [port])
    },
    stopSession(timeoutMs = 3000): Promise<{ frames: number }> {
      if (!child) return Promise.resolve({ frames: 0 })
      const c = child
      // A second stop while one is pending settles the first with 0 (single session).
      settleStop(0)
      return new Promise((resolve) => {
        const timer = setTimeout(() => settleStop(0), timeoutMs)
        pendingStop = (r) => {
          clearTimeout(timer)
          resolve(r)
        }
        c.postMessage({ t: 'session:stop' })
      })
    },
    dispose(): void {
      settleStop(0)
      child?.kill()
      child = null
    }
  }
}

export type SpikeOutcome = Omit<SpikeResult, 't'>

/**
 * Fork the host, await its boot-time `{t:'spike:result'}`, kill the host. Resolves —
 * never rejects — so the index.ts gate can print/exit on a plain result. A host that
 * dies before posting (e.g. the addon crashes the process outright) resolves as a
 * failure via the 'exit' listener; a wedged host trips the timeout.
 */
export function runEngineSpike(timeoutMs = 15000): Promise<SpikeOutcome> {
  return new Promise((resolve) => {
    const child = spawnEngineHost()
    let settled = false
    const settle = (r: SpikeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(r)
    }
    const timer = setTimeout(
      () => settle({ ok: false, error: `spike timeout after ${timeoutMs}ms` }),
      timeoutMs
    )
    child.on('message', (m: unknown) => {
      const r = m as SpikeResult | null
      if (r?.t === 'spike:result') {
        const { t: _t, ...rest } = r
        settle(rest)
      }
    })
    child.on('exit', (code) => settle({ ok: false, error: `host exited (${code}) before result` }))
  })
}
