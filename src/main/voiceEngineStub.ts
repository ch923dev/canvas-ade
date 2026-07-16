/**
 * Voice V3 — the e2e stub engine (plan §V3 testing). A fake `VoiceEngineHandle` behind
 * the SAME `VoiceIpcDeps.engine` seam voiceIpc.test.ts uses: it holds the session
 * MessagePortMain like the real utilityProcess host and speaks the identical port
 * protocol — counts `{t:'frame'}`, posts the canned `{t:'partial'}`/`{t:'final'}` script
 * below keyed by FRAME COUNT (deterministic under the fake-media tone's ~8.3 frames/s;
 * no model, no mic), honors the `{t:'eos'}` drain before reporting frames, and posts
 * `{t:'stop'}` so the renderer capture releases cleanly. All messages plain JSON — never
 * a transferable in a cross-process port transfer list (sharp edge 2).
 *
 * RUNTIME-TOGGLED, not env-gated at launch: Playwright runs every spec file in ONE
 * worker-scoped app, so a launch-env stub would also hijack voice.e2e.ts and lose the
 * real-engine coverage V2 paid for. The only setter is `__canvasE2EMain.voiceStubSet`
 * (e2eMain — compile-gated __ENABLE_E2E_MAIN__ AND runtime CANVAS_E2E), so a normal run
 * can never activate this; `currentVoiceStubEngine()` is a dormant null everywhere else.
 */
import type { MessagePortMain } from 'electron'
import type { VoiceEngineHandle } from './voiceEngine'

/** Canned recognition script — the voiceComposer e2e asserts these exact texts. Frames
 *  arrive ~8.3/s, so the dimmed-tail window (first partial → final) is ~1.4 s — wide
 *  enough that the spec's tail-visibility poll can never race the final. */
export const VOICE_STUB_SCRIPT: ReadonlyArray<{
  atFrame: number
  t: 'partial' | 'final'
  text: string
}> = [
  { atFrame: 2, t: 'partial', text: 'refactor the' },
  { atFrame: 6, t: 'partial', text: 'refactor the preview cap' },
  { atFrame: 14, t: 'final', text: 'refactor the preview cap' }
]

interface StubSession {
  port: MessagePortMain
  frames: number
  eos: boolean
  onEos: (() => void) | null
}

export function createStubVoiceEngine(
  script: ReadonlyArray<{
    atFrame: number
    t: 'partial' | 'final'
    text: string
  }> = VOICE_STUB_SCRIPT
): VoiceEngineHandle & { fireKwsWake: (keyword?: string) => boolean } {
  let session: StubSession | null = null
  let kwsSession: StubSession | null = null

  /** Signal teardown to the renderer end; close only after the eos drain (or timeout). */
  const release = (s: StubSession, onDrained: () => void): void => {
    try {
      s.port.postMessage({ t: 'stop' })
    } catch {
      /* port already gone */
    }
    if (s.eos) {
      s.port.close()
      onDrained()
      return
    }
    const timer = setTimeout(() => {
      s.onEos = null
      s.port.close()
      onDrained()
    }, 1000)
    s.onEos = () => {
      clearTimeout(timer)
      s.port.close()
      onDrained()
    }
  }

  return {
    startSession(port, _model): void {
      // Restart-idempotent like the real host: the replaced session's renderer end gets
      // {t:'stop'} so a stale capture releases the mic.
      if (session) {
        const old = session
        session = null
        release(old, () => {})
      }
      const s: StubSession = { port, frames: 0, eos: false, onEos: null }
      session = s
      port.on('message', (e) => {
        const m = e.data as { t?: string } | null
        if (m?.t === 'frame') {
          s.frames++
          for (const step of script) {
            if (step.atFrame === s.frames) s.port.postMessage({ t: step.t, text: step.text })
          }
        } else if (m?.t === 'eos') {
          s.eos = true
          s.onEos?.()
        }
      })
      port.start()
    },
    stopSession(): Promise<{ frames: number }> {
      const s = session
      session = null
      if (!s) return Promise.resolve({ frames: 0 })
      return new Promise((resolve) => release(s, () => resolve({ frames: s.frames })))
    },
    onEngineFailure(): void {
      /* the stub never crashes — nothing to observe */
    },
    // J2 TTS: the stub covers dictation e2e only. TTS never activates through it —
    // voiceIpc gates tts:start on model status, and the stub runs model-less, so these
    // are inert no-ops that just satisfy the handle shape.
    startTtsSession(): void {},
    ttsSpeak(): void {},
    ttsCancel(): void {},
    stopTtsSession(): void {},
    onTtsFailure(): void {},
    // J5 KWS: the stub holds the wake port + counts frames like the real host; a spec
    // fires the detection deterministically via stubKwsWake() (no model, no audio).
    startKwsSession(port, _model): void {
      if (kwsSession) {
        const old = kwsSession
        kwsSession = null
        release(old, () => {})
      }
      const s: StubSession = { port, frames: 0, eos: false, onEos: null }
      kwsSession = s
      port.on('message', (e) => {
        const m = e.data as { t?: string } | null
        if (m?.t === 'frame') s.frames++
        else if (m?.t === 'eos') {
          s.eos = true
          s.onEos?.()
        }
      })
      port.start()
    },
    stopKwsSession(): Promise<{ frames: number }> {
      const s = kwsSession
      kwsSession = null
      if (!s) return Promise.resolve({ frames: 0 })
      return new Promise((resolve) => release(s, () => resolve({ frames: s.frames })))
    },
    onKwsFailure(): void {},
    /** Test trigger: post a wake detection on the live kws port (false = no session). */
    fireKwsWake(keyword = 'HEY JARVIS'): boolean {
      if (!kwsSession) return false
      try {
        kwsSession.port.postMessage({ t: 'wake', keyword })
        return true
      } catch {
        return false
      }
    },
    dispose(): void {
      const s = session
      session = null
      if (s) release(s, () => {})
      const k = kwsSession
      kwsSession = null
      if (k) release(k, () => {})
    }
  }
}

// ── the runtime toggle (only reachable through e2eMain's gated registry) ──
let active: (VoiceEngineHandle & { fireKwsWake: (keyword?: string) => boolean }) | null = null

/** The live stub, or null in every normal run (voiceIpc's engine() falls through). */
export function currentVoiceStubEngine(): VoiceEngineHandle | null {
  return active
}

/** J5 e2e: fire a deterministic wake detection through the live stub's kws port.
 *  False when no stub / no armed wake session — the spec asserts the arm first. */
export function stubKwsWake(keyword?: string): boolean {
  return active?.fireKwsWake(keyword) ?? false
}

/**
 * J4: an optional CUSTOM script replaces the canned one (the jarvis tool e2e speaks
 * "add a card …" instead of the dictation line). Passing a script while a stub is live
 * swaps it (dispose + recreate) so a spec can re-script between captures.
 */
export function setVoiceStubEnabled(
  on: boolean,
  script?: ReadonlyArray<{ atFrame: number; t: 'partial' | 'final'; text: string }>
): void {
  if (on) {
    if (active && script) {
      active.dispose()
      active = null
    }
    active ??= createStubVoiceEngine(script)
    return
  }
  active?.dispose()
  active = null
}
