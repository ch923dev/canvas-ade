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
import { createSilenceWatchdog, type WorkletFrameMsg } from './captureMath'
import { useVoiceStore } from '../store/voiceStore'

interface ActiveCapture {
  dispose: () => void
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
    port.close()
    useVoiceStore.getState().captureStopped()
  }

  // MAIN's engine end signals teardown over the data plane (voice:session:stop → {t:'stop'}),
  // so a bare devtools `window.api.voice.stop()` still releases the mic.
  port.onmessage = (e: MessageEvent): void => {
    const m = e.data as { t?: string } | null
    if (m?.t === 'stop') dispose()
  }

  const start = async (): Promise<void> => {
    // V0's default-session posture grants audio-only media for the app page — no per-call
    // permission code here. A missing OS grant does NOT reject: it yields a live all-zeros
    // stream (electron#42714) — that case is the watchdog's job, not this catch's.
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
      port.postMessage(msg)
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
      const data = e.data as { __voicePort?: boolean } | null
      if (!data?.__voicePort || !e.ports[0]) return
      session?.dispose() // a re-start replaces any live session (MAIN disposed its end too)
      session = createCapture(e.ports[0])
    }
    window.addEventListener('message', onWinMsg)
    return () => {
      window.removeEventListener('message', onWinMsg)
      session?.dispose()
    }
  }, [])
}
