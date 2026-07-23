/**
 * Voice V1 — renderer capture controller (SPEC §4, HANDOFF-V1).
 *
 * Mounted once at the App root. The MessagePort transferred by MAIN *is* the start
 * signal: `window.api.voice.start()` → MAIN brokers a `MessageChannelMain`, keeps the
 * engine end (a logger stub in V1, the utilityProcess host in V2) and posts the other
 * port here (`voice:port` → preload re-post as `__voicePort`, the `pty:port` pattern).
 * On port arrival this hook runs getUserMedia → AudioContext → `captureWorklet` and
 * forwards each ~120 ms Int16 frame over the port (transferred, zero-copy). MAIN posting
 * `{t:'stop'}` on the port (voice:session:stop) tears the capture down and releases the
 * mic. Level / silent-zeros state land in `voiceStore` (ephemeral only).
 *
 * The worklet loads via `?worker&url` — the CSP-safe same-origin emitted chunk (prod CSP
 * has no worker-src carve-out; blob: URLs are blocked by design — sharp edge #2).
 */
import { useEffect } from 'react'
import workletUrl from './captureWorklet?worker&url'
import { createSilenceWatchdog, micConstraints, type WorkletFrameMsg } from './captureMath'
import { useVoiceStore } from '../store/voiceStore'
import { suppressMicForward } from '../store/ttsStore'
import { consumeFinal } from './finalConsumer'

interface ActiveCapture {
  dispose: () => void
}

/**
 * Route a finalized transcript segment into the dictation composer. Shared by BOTH delivery
 * paths: the local engine posts {t:'final'} over the session port (streamed while held), and
 * the cloud engine emits it out-of-band on voice:transcript (batch, after the port closed).
 * An armed converse consumer (Jarvis) takes the final instead of the draft (J3 seam).
 */
function applyFinal(text: string): void {
  if (!consumeFinal(text)) useVoiceStore.getState().finalReceived(text)
  else useVoiceStore.getState().partialReceived('')
}

/** Renderer → MAIN frame message over the voice port (the stub/engine end counts these). */
interface VoiceFrameMsg {
  t: 'frame'
  d: ArrayBuffer
}

function createCapture(port: MessagePort): ActiveCapture {
  let disposed = false
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  const watchdog = createSilenceWatchdog()

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    void ctx?.close().catch(() => {
      /* already closed */
    })
    ctx = null
    // End-of-stream sentinel — the LAST message on this port. The engine host defers its
    // session:stopped frame count until it sees this (port messages are ordered within a
    // port, unlike port-vs-parentPort delivery, which races — a stop could otherwise be
    // counted before queued frames arrive, e.g. while a cold recognizer init blocks the
    // host loop). Harmless when the host end is already closed (replacement/unmount).
    try {
      port.postMessage({ t: 'eos' })
    } catch {
      /* port already neutered */
    }
    port.close()
    useVoiceStore.getState().captureStopped()
  }

  // MAIN's engine end signals teardown over the data plane (voice:session:stop → {t:'stop'}),
  // so a bare devtools `window.api.voice.stop()` still releases the mic. V3: transcript
  // events ({t:'partial'|'final', text} — host emits partial only on text change) route
  // into the composer state the flyout renders. Nothing here reorders dispose(): {t:'eos'}
  // stays the LAST message posted on this port (the drain handshake, sharp edge 1).
  port.onmessage = (e: MessageEvent): void => {
    const m = e.data as { t?: string; text?: string } | null
    if (m?.t === 'stop') dispose()
    else if (m?.t === 'partial' && typeof m.text === 'string') {
      useVoiceStore.getState().partialReceived(m.text)
    } else if (m?.t === 'final' && typeof m.text === 'string') {
      // Local streaming final over the port; the same routing the cloud side-channel uses.
      applyFinal(m.text)
    }
  }

  const start = async (): Promise<void> => {
    // V4: the configured mic, as an `exact` deviceId constraint. A device that has gone
    // away rejects (OverconstrainedError) → retry the system default rather than dying —
    // dictation should survive the user unplugging their headset between sessions.
    const micDeviceId = await window.api.voice.config
      .get()
      .then((c) => c.micDeviceId)
      .catch(() => undefined)
    // V0's default-session posture grants audio-only media for the app page — no per-call
    // permission code here. A missing OS grant does NOT reject: it yields a live all-zeros
    // stream (electron#42714) — that case is the watchdog's job, not this catch's.
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(micDeviceId))
    } catch (err) {
      if (!micDeviceId) throw err
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(undefined))
    }
    if (disposed) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    ctx = new AudioContext()
    await ctx.audioWorklet.addModule(workletUrl)
    if (disposed) return // dispose() already closed ctx; the graph was never built
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'voice-capture')
    node.port.onmessage = (e: MessageEvent<WorkletFrameMsg>): void => {
      if (disposed) return
      const { frame, rms } = e.data
      const msg: VoiceFrameMsg = { t: 'frame', d: frame }
      // COPY, do not transfer: this port's peer is a MessagePortMain in MAIN, and Electron's
      // cross-process port serializer delivers `e.data` as null when a non-port transferable
      // rides the transfer list (verified against Electron 42 — the message event still fires,
      // payload gone). A structured-clone copy arrives intact; at 3840 B × ~8.3/s (~32 KB/s)
      // the copy is noise. The worklet→node hop above stays zero-copy (same process).
      // J2 half-duplex gate (D6 fallback): while TTS speaks in 'half' mode the frame is
      // NOT forwarded — the STT host never transcribes self-capture. Level/RMS below
      // keep flowing (the meter and the RMS barge-in gate run renderer-side).
      if (!suppressMicForward()) port.postMessage(msg)
      const s = useVoiceStore.getState()
      s.frameSent(rms)
      s.setMicSilent(watchdog.push(rms))
    }
    source.connect(node)
    // The worklet outputs silence; connecting it keeps the graph pulled so process() runs.
    node.connect(ctx.destination)
    useVoiceStore.getState().captureStarted()
  }
  void start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[voice] capture start failed', err)
    dispose()
  })

  return { dispose }
}

/** Mount once (App root). Listens for the voice MessagePort and runs the capture session. */
export function useVoiceCapture(): void {
  useEffect(() => {
    if (!window.api?.voice) return undefined // non-electron test runtimes (App.tsx discipline)
    let session: ActiveCapture | null = null
    const onWinMsg = (e: MessageEvent): void => {
      // Same-window pin (SEC-2 receive side, matching useTtsPlayback — see the note
      // there on why this is NOT an origin-string compare): only the preload forwarder
      // may hand us the frame port.
      if (e.source !== window) return
      const data = e.data as { __voicePort?: boolean } | null
      if (!data?.__voicePort || !e.ports[0]) return
      session?.dispose() // a re-start replaces any live session (MAIN disposed its end too)
      session = createCapture(e.ports[0])
    }
    window.addEventListener('message', onWinMsg)
    // V5 SPEC §3 `error`: MAIN's crash policy pushes engine events. 'restarted' is
    // transparent — the fresh voice:port above replaces the capture (dispose folds any
    // provisional tail into the draft, so nothing is lost across the swap). 'error'
    // (restart budget spent) stops the capture HERE — the dead host can never post the
    // usual {t:'stop'} — keeps the draft, and opens the flyout on its error row.
    const offEngine = window.api.voice.onEngineEvent?.((ev) => {
      const s = useVoiceStore.getState()
      if (ev.kind === 'error') {
        session?.dispose()
        session = null
        s.setEngineError(true)
        s.setFlyoutOpen(true)
      } else if (ev.kind === 'restarted') {
        s.setEngineError(false)
      }
    })
    // Phase 2 cloud STT: batch result/status delivered out-of-band (the session port is closed
    // right after {t:'eos'}). 'transcribing' drives the gap affordance; 'final' folds into the
    // draft via the same applyFinal routing; 'error' is fail-visible (draft kept, flyout opens).
    const offTranscript = window.api.voice.onTranscript?.((ev) => {
      const s = useVoiceStore.getState()
      if (ev.kind === 'transcribing') {
        s.setTranscribing(true)
        s.setFlyoutOpen(true)
      } else if (ev.kind === 'final') {
        s.setTranscribing(false)
        applyFinal(ev.text)
      } else if (ev.kind === 'error') {
        s.setTranscribing(false)
        s.setCloudError(ev.reason)
        s.setFlyoutOpen(true)
      }
    })
    return () => {
      window.removeEventListener('message', onWinMsg)
      offEngine?.()
      offTranscript?.()
      session?.dispose()
    }
  }, [])
}
