/**
 * Voice V2 — engine-host lifecycle (MAIN side).
 *
 * Owns fork/kill of the sherpa-onnx utilityProcess (`voiceEngineHost.js`, a sibling
 * main-bundle entry) and the session control seam voiceIpc drives: start hands the
 * engine end of the `voice:port` MessageChannelMain to the host (ports transfer to a
 * utilityProcess via `child.postMessage(msg, [port])`), stop round-trips
 * `session:stop` → `{t:'session:stopped', frames}`. The host is spawned lazily on the
 * first session and kept alive across sessions (the recognizer cache inside it makes
 * mic re-toggles cheap). An unexpected exit — or the host reporting its decoder worker
 * died — clears the handle AND escalates through `onEngineFailure` (V5): voiceIpc
 * auto-restarts the session once, then surfaces the renderer `error` state.
 *
 * Also hosts the V2 spike runner (CANVAS_VOICE_SPIKE gate in index.ts; kept for the V5
 * packaged validation) — it reuses the host's boot-time `{t:'spike:result'}` load proof.
 */
import { utilityProcess } from 'electron'
import type { MessagePortMain, UtilityProcess } from 'electron'
import { join } from 'path'
import type { SpikeResult, TtsSpeakReq } from './voiceEngineHost'
import type { VoiceModelPaths } from './voiceModels'
import type { TtsModelPaths } from './voiceTtsModels'
import type { KwsModelPaths } from './voiceKwsModels'

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
  /**
   * V5: observe UNEXPECTED engine failures — a host crash/exit, or the host reporting
   * its decoder worker died ({t:'decoder:error'} — the host is killed here so the next
   * start respawns clean). Never fires for dispose() or a decoder:error-triggered kill's
   * own exit event. One listener (voiceIpc's restart-once policy); null clears it.
   */
  onEngineFailure(cb: ((reason: string) => void) | null): void
  /** J2: transfer the renderer end's peer of a TTS chunk channel to the host (spawns it
   *  if needed) — the host lazily builds its TTS worker + OfflineTts off-loop. */
  startTtsSession(port: MessagePortMain, model: TtsModelPaths | null): void
  /** J2: enqueue one speak (FIFO in the host's TTS worker; chunks stream on the port). */
  ttsSpeak(req: TtsSpeakReq): void
  /** J2 barge-in: cancel the active synthesis + drain the speak queue. */
  ttsCancel(): void
  /** J2: cancel + close the TTS port. Safe when no TTS session is live. */
  stopTtsSession(): void
  /**
   * J2: observe TTS-ONLY failures ({t:'tts:engine:error'} — the TTS worker died or its
   * session init failed). The host stays up (STT unaffected); the next startTtsSession
   * respawns the worker. Does NOT fire for whole-host failures — those land on
   * onEngineFailure. One listener; null clears it.
   */
  onTtsFailure(cb: ((reason: string) => void) | null): void
  /** J5: transfer the wake-word channel's engine end to the host (spawns it if needed) —
   *  the host lazily builds its KWS worker + KeywordSpotter off-loop. */
  startKwsSession(port: MessagePortMain, model: KwsModelPaths | null): void
  /** J5: stop the wake-word session; resolves with the host's received-frame count. */
  stopKwsSession(timeoutMs?: number): Promise<{ frames: number }>
  /**
   * J5: observe KWS-ONLY failures ({t:'kws:engine:error'} — the KWS worker died or its
   * session init failed). The host stays up (STT/TTS unaffected); the next
   * startKwsSession respawns the worker. One listener; null clears it.
   */
  onKwsFailure(cb: ((reason: string) => void) | null): void
  /** Kill the host outright (app quit). Safe when never spawned. */
  dispose(): void
}

export function createVoiceEngine(
  fork: () => EngineChildLike = spawnEngineHost as () => EngineChildLike
): VoiceEngineHandle {
  let child: EngineChildLike | null = null
  let pendingStop: ((r: { frames: number }) => void) | null = null
  let pendingKwsStop: ((r: { frames: number }) => void) | null = null
  let failCb: ((reason: string) => void) | null = null
  let ttsFailCb: ((reason: string) => void) | null = null
  let kwsFailCb: ((reason: string) => void) | null = null

  const settleStop = (frames: number): void => {
    const resolve = pendingStop
    pendingStop = null
    resolve?.({ frames })
  }
  const settleKwsStop = (frames: number): void => {
    const resolve = pendingKwsStop
    pendingKwsStop = null
    resolve?.({ frames })
  }

  const ensureChild = (): EngineChildLike => {
    if (child) return child
    const c = fork()
    c.on('message', (m: unknown) => {
      const msg = m as { t?: string; frames?: number; error?: string } | null
      if (msg?.t === 'session:stopped') settleStop(msg.frames ?? 0)
      else if (msg?.t === 'kws:session:stopped') settleKwsStop(msg.frames ?? 0)
      else if (msg?.t === 'tts:engine:error' && child === c) {
        // TTS-only degradation: the host (and any live STT session) keeps running.
        ttsFailCb?.(msg.error ?? 'voice tts failed')
      } else if (msg?.t === 'kws:engine:error' && child === c) {
        // KWS-only degradation: the host keeps running; the next arm respawns the worker.
        kwsFailCb?.(msg.error ?? 'voice kws failed')
      } else if (msg?.t === 'decoder:error' && child === c) {
        // The decode thread died inside a still-running host — the host is degraded
        // (frames count but nothing transcribes). Kill it and escalate; clearing `child`
        // FIRST makes the kill's own 'exit' event a no-op below (identity guard).
        child = null
        settleStop(0)
        settleKwsStop(0)
        c.kill()
        failCb?.(msg.error ?? 'voice decoder failed')
        // A dead host takes any live KWS wake session with it (review: the wake
        // listener would otherwise keep a dead capture with no re-arm signal).
        kwsFailCb?.(msg.error ?? 'voice decoder failed')
      }
    })
    c.on('exit', () => {
      // Crash or kill: next startSession respawns; a stop waiting on the reply gets 0.
      // Identity guard: dispose()/decoder:error null `child` before killing, so only a
      // genuinely unexpected exit of the CURRENT child escalates.
      if (child !== c) return
      child = null
      settleStop(0)
      settleKwsStop(0)
      failCb?.('voice engine host exited unexpectedly')
      kwsFailCb?.('voice engine host exited unexpectedly')
    })
    child = c
    return c
  }

  return {
    startSession(port, model): void {
      ensureChild().postMessage({ t: 'session:start', model }, [port])
    },
    onEngineFailure(cb): void {
      failCb = cb
    },
    startTtsSession(port, model): void {
      ensureChild().postMessage({ t: 'tts:session:start', ttsModel: model }, [port])
    },
    // Speak/cancel/stop never SPAWN the host: without a live tts session they'd only
    // reach a worker that doesn't exist — a no-op either way, so don't pay a fork.
    ttsSpeak(req): void {
      child?.postMessage({ t: 'tts:speak', req })
    },
    ttsCancel(): void {
      child?.postMessage({ t: 'tts:cancel' })
    },
    stopTtsSession(): void {
      child?.postMessage({ t: 'tts:session:stop' })
    },
    onTtsFailure(cb): void {
      ttsFailCb = cb
    },
    startKwsSession(port, model): void {
      ensureChild().postMessage({ t: 'kws:session:start', kwsModel: model }, [port])
    },
    stopKwsSession(timeoutMs = 10000): Promise<{ frames: number }> {
      if (!child) return Promise.resolve({ frames: 0 })
      const c = child
      settleKwsStop(0) // single kws session — a second stop settles the first with 0
      return new Promise((resolve) => {
        const timer = setTimeout(() => settleKwsStop(0), timeoutMs)
        pendingKwsStop = (r) => {
          clearTimeout(timer)
          resolve(r)
        }
        c.postMessage({ t: 'kws:session:stop' })
      })
    },
    onKwsFailure(cb): void {
      kwsFailCb = cb
    },
    // 10 s = the eos drain (≤1 s) plus a wide margin. The V3-era 30 s stopgap existed
    // because a COLD recognizer init (>10 s under machine load) blocked the host loop
    // before session:stop was even processed; V5 moved init onto the decoder worker
    // thread, so the loop always answers promptly and the stopgap tightened back down.
    stopSession(timeoutMs = 10000): Promise<{ frames: number }> {
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
      settleKwsStop(0)
      const c = child
      child = null // identity guard: the kill's 'exit' must not report a failure
      c?.kill()
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
