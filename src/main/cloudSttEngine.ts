/**
 * Voice cloud STT — the composite VoiceEngineHandle (MAIN, in-process; no utilityProcess, so
 * the OpenAI key never crosses a process boundary). Phase 2, decision #4: it WRAPS the local
 * sherpa handle and overrides ONLY the three STT methods (startSession / stopSession /
 * onEngineFailure); TTS (Kokoro) + wake-word delegate straight through, untouched.
 *
 * Batch transcribe-on-release (decision #3): while the hotkey is held the renderer streams
 * {t:'frame'} Int16 PCM over the session port; the engine buffers it. On {t:'eos'} (the
 * renderer's release sentinel) it assembles a 16 kHz WAV, calls OpenAI once, runs the
 * deterministic formatRestore pass over the result, and delivers it.
 *
 * DELIVERY IS OUT-OF-BAND (not the port). useVoiceCapture.ts closes its end of the session
 * port synchronously right after posting {t:'eos'}, so a batch final produced ~0.8 s later
 * cannot ride back on it (local STT never needs to — it streams finals WHILE held). So the
 * result is emitted through the injected `emit` side-channel (voiceIpc → voice:transcript
 * IPC); frames + eos still flow renderer→MAIN over the port unchanged. The pill/flyout show a
 * `transcribing…` state for the gap (there are no cloud partials — the dimmed tail stays empty).
 */
import type { MessagePortMain } from 'electron'
import type { VoiceModelPaths } from './voiceModels'
import type { VoiceEngineHandle } from './voiceEngine'
import { encodeWav } from './voiceWav'
import { restoreFormatting } from './voiceFormatRestore'
import { CloudTranscribeError, type CloudTranscribe } from './openaiTranscribe'

/** Side-channel event the engine emits (voiceIpc forwards it on the voice:transcript IPC). */
export type CloudSttEvent =
  | { kind: 'transcribing' } // eos received, OpenAI round-trip in flight
  | { kind: 'final'; text: string } // formatRestore-corrected transcript
  | { kind: 'error'; reason: string } // network / quota / timeout — fail-visible, draft kept

/** The repo symbol sets, read fresh per transcription (task C provider). */
export interface CloudSymbolSets {
  /** ≤30 freq-ranked symbols for the biasing prompt (long glossaries backfire). */
  bias: readonly string[]
  /** Full uncapped symbol set for the formatRestore dictionary. */
  dict: readonly string[]
}

export interface CloudSttDeps {
  /** The wrapped local handle: TTS/KWS/dispose delegate to it; STT is overridden here. */
  local: VoiceEngineHandle
  /** WAV + bias → raw transcript (openaiTranscribe; injectable for tests). */
  transcribe: CloudTranscribe
  /** Deliver a result/status to the renderer (voiceIpc: webContents.send('voice:transcript')). */
  emit: (ev: CloudSttEvent) => void
  /** Symbol sets, resolved fresh per utterance so a project switch is picked up live. */
  getSymbols: () => CloudSymbolSets
  /** Safety-net drain timeout if {t:'eos'} never arrives (renderer died). Mirrors the stub. */
  eosTimeoutMs?: number
}

interface CloudSession {
  port: MessagePortMain
  seq: number
  frames: number
  chunks: Buffer[]
  eos: boolean
  finished: boolean
  onEos: (() => void) | null
}

export function createCloudSttEngine(deps: CloudSttDeps): VoiceEngineHandle {
  const { local, transcribe, emit, getSymbols } = deps
  const eosTimeoutMs = deps.eosTimeoutMs ?? 1000
  let session: CloudSession | null = null
  let latestSeq = 0

  /** Assemble + transcribe once per session, on {t:'eos'} (or the drain timeout). */
  const finishCapture = async (s: CloudSession): Promise<void> => {
    if (s.finished) return
    s.finished = true
    const pcm = s.chunks.length ? Buffer.concat(s.chunks) : Buffer.alloc(0)
    s.chunks = []
    if (pcm.length === 0) return // nothing captured — no API call, no state change
    emit({ kind: 'transcribing' })
    try {
      const { bias, dict } = getSymbols()
      const raw = await transcribe({ wav: encodeWav(pcm), keyterms: bias })
      if (s.seq !== latestSeq) return // a newer hold superseded this one — drop the stale result
      emit({ kind: 'final', text: restoreFormatting(raw, dict) })
    } catch (err) {
      if (s.seq !== latestSeq) return
      const reason = err instanceof CloudTranscribeError ? err.reason : 'network'
      emit({ kind: 'error', reason })
    }
  }

  /** Signal teardown to the renderer, then finish capture on the eos drain (or timeout). */
  const release = (s: CloudSession, onDrained: (frames: number) => void): void => {
    try {
      s.port.postMessage({ t: 'stop' })
    } catch {
      /* port already gone */
    }
    if (s.eos) {
      onDrained(s.frames)
      return
    }
    const timer = setTimeout(() => {
      s.onEos = null
      void finishCapture(s) // eos never came — transcribe what we buffered
      onDrained(s.frames)
    }, eosTimeoutMs)
    s.onEos = () => {
      clearTimeout(timer)
      onDrained(s.frames)
    }
  }

  return {
    startSession(port: MessagePortMain, _model: VoiceModelPaths | null): void {
      // Restart-idempotent like the real host: the replaced session's renderer end gets
      // {t:'stop'} so a stale capture releases the mic. Bumping latestSeq also suppresses any
      // in-flight transcription of the replaced session (its stale final would be wrong).
      if (session) {
        const old = session
        session = null
        release(old, () => {})
      }
      const s: CloudSession = {
        port,
        seq: ++latestSeq,
        frames: 0,
        chunks: [],
        eos: false,
        finished: false,
        onEos: null
      }
      session = s
      port.on('message', (e) => {
        const m = e.data as { t?: string; d?: ArrayBuffer } | null
        if (m?.t === 'frame') {
          s.frames++
          if (m.d instanceof ArrayBuffer) s.chunks.push(Buffer.from(m.d))
        } else if (m?.t === 'eos') {
          s.eos = true
          s.onEos?.()
          void finishCapture(s)
        }
      })
      port.start()
    },
    stopSession(): Promise<{ frames: number }> {
      const s = session
      session = null
      if (!s) return Promise.resolve({ frames: 0 })
      return new Promise((resolve) => release(s, (frames) => resolve({ frames })))
    },
    // Cloud STT failures surface through `emit` (voice:transcript {kind:'error'}), NOT this —
    // this observes the LOCAL host's lifecycle so a TTS/KWS user still gets host-death events.
    onEngineFailure(cb): void {
      local.onEngineFailure(cb)
    },
    // ── TTS + wake-word: unchanged, straight delegation to the wrapped local host ──
    startTtsSession(port, model): void {
      local.startTtsSession(port, model)
    },
    ttsSpeak(req): void {
      local.ttsSpeak(req)
    },
    ttsCancel(): void {
      local.ttsCancel()
    },
    stopTtsSession(): void {
      local.stopTtsSession()
    },
    onTtsFailure(cb): void {
      local.onTtsFailure(cb)
    },
    startKwsSession(port, model): void {
      local.startKwsSession(port, model)
    },
    stopKwsSession(timeoutMs): Promise<{ frames: number }> {
      return local.stopKwsSession(timeoutMs)
    },
    onKwsFailure(cb): void {
      local.onKwsFailure(cb)
    },
    dispose(): void {
      const s = session
      session = null
      if (s) release(s, () => {})
      local.dispose()
    }
  }
}
