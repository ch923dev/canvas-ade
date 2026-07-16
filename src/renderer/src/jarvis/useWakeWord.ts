/**
 * Jarvis J5 — the wake-word listener (D3, opt-in, OFF by default).
 *
 * THE CARVE-OUT IS STRICT (KICKOFF-PANEL §3): this is the ONE sanctioned closed-panel
 * listener, it detects a single fixed keyword locally (sherpa KeywordSpotter — no STT,
 * no transcription, no cloud), and its SOLE power is to OPEN the panel — which arms the
 * mic through the existing `openJarvisPanel` gesture and its structural gate. Turns
 * still require the open panel. The listener runs only while ALL hold:
 *   jarvis enabled ∧ wakeWordEnabled ∧ panel CLOSED ∧ voice platform supported.
 * The moment the panel opens (by wake or by hand) the wake capture stops — converse
 * capture owns the mic; when the panel closes it re-arms.
 *
 * Capture is a lean sibling of useVoiceCapture's pipeline (same worklet, same COPY
 * discipline over the port) that deliberately touches NO voiceStore state: the dictation
 * pill/flyout must never light up for a background keyword listener.
 */
import { useEffect } from 'react'
import workletUrl from '../voice/captureWorklet?worker&url'
import { micConstraints, type WorkletFrameMsg } from '../voice/captureMath'
import { useJarvisStore } from '../store/jarvisStore'
import { openJarvisPanel } from './jarvisSession'

interface WakeCapture {
  dispose: () => void
}

function createWakeCapture(port: MessagePort, onWake: () => void): WakeCapture {
  let disposed = false
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    void ctx?.close().catch(() => {
      /* already closed */
    })
    ctx = null
    try {
      port.postMessage({ t: 'eos' }) // the host's drain sentinel — LAST message
    } catch {
      /* port already neutered */
    }
    port.close()
  }

  port.onmessage = (e: MessageEvent): void => {
    const m = e.data as { t?: string; keyword?: string } | null
    if (m?.t === 'stop') dispose()
    else if (m?.t === 'wake') onWake()
  }

  const start = async (): Promise<void> => {
    const micDeviceId = await window.api.voice.config
      .get()
      .then((c) => c.micDeviceId)
      .catch(() => undefined)
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
    if (disposed) return
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'voice-capture')
    node.port.onmessage = (e: MessageEvent<WorkletFrameMsg>): void => {
      if (disposed) return
      // COPY, do not transfer (the cross-process port serializer nulls transferables).
      port.postMessage({ t: 'frame', d: e.data.frame })
    }
    source.connect(node)
    node.connect(ctx.destination)
  }
  void start().catch((err) => {
    console.error('[jarvis] wake capture start failed', err)
    dispose()
  })

  return { dispose }
}

/**
 * Mount once beside JarvisPanel (App root). Watches config + panel state and keeps the
 * wake session in exactly one of two states: LISTENING (panel closed, feature on) or
 * OFF. A detection opens the panel through the one existing gesture and stops listening
 * in the same breath.
 */
export function useWakeWord(): void {
  useEffect(() => {
    if (!window.api?.jarvis || !window.api?.voice || window.api.voice.supported === false) {
      return undefined
    }
    let alive = true
    let capture: WakeCapture | null = null
    let listening = false
    let jarvisEnabled = false
    let wakeEnabled = false
    /** A kws engine failure disarms until the next config change (no crash loops). */
    let broken = false
    /**
     * Generation stamp for the async start() continuation — the MIC-1-class guard
     * (jarvisSession's armGeneration, applied to this seam): a stale start's settle
     * must never clobber `listening` for a NEWER start, or a later disable would
     * early-return out of reconcile() and leave that newer capture live (hot mic).
     */
    let startGen = 0

    const shouldListen = (): boolean =>
      alive && jarvisEnabled && wakeEnabled && !broken && !useJarvisStore.getState().panelOpen

    const stop = (): void => {
      startGen++ // invalidate any in-flight start() continuation
      listening = false
      capture?.dispose()
      capture = null
      void window.api.voice.wake.stop().catch(() => {})
    }

    const reconcile = (): void => {
      if (listening === shouldListen()) return
      if (!shouldListen()) {
        stop()
        return
      }
      listening = true
      const gen = ++startGen
      void window.api.voice.wake
        .start()
        .then((r) => {
          // Model absent (Settings row drives the download) or refused: stand down —
          // a later config/panel change re-attempts through this reconcile.
          if (!r.ok && gen === startGen && listening) listening = false
        })
        .catch(() => {
          if (gen === startGen) listening = false
        })
    }

    // The brokered wake port arrives via the preload forwarder (SEC-2 same-window pin).
    const onWinMsg = (e: MessageEvent): void => {
      if (e.source !== window) return
      const data = e.data as { __voiceWakePort?: boolean } | null
      if (!data?.__voiceWakePort || !e.ports[0]) return
      capture?.dispose()
      if (!shouldListen()) {
        // A close/disable landed while MAIN brokered the port — refuse it cleanly.
        try {
          e.ports[0].close()
        } catch {
          /* already gone */
        }
        stop()
        return
      }
      capture = createWakeCapture(e.ports[0], () => {
        // THE ONE POWER: open the panel (arms the mic through the existing gesture).
        stop()
        openJarvisPanel()
      })
    }
    window.addEventListener('message', onWinMsg)

    const applyConfig = (cfg: { enabled: boolean; wakeWordEnabled: boolean }): void => {
      jarvisEnabled = cfg.enabled
      wakeEnabled = cfg.wakeWordEnabled
      broken = false // an explicit config change is the re-arm gesture after a failure
      reconcile()
    }
    void window.api.jarvis.config
      .get()
      .then((cfg) => {
        if (alive) applyConfig(cfg)
      })
      .catch(() => {})
    const offConfig = window.api.jarvis.config.onChanged((cfg) => applyConfig(cfg))

    const offWakeEvent = window.api.voice.wake.onEvent(() => {
      broken = true
      stop()
    })

    // Panel transitions reconcile through a plain store subscription — the effect mounts
    // ONCE (review: a [panelOpen] dependency tore down and rebuilt everything, refetching
    // config and resubscribing IPC on every open/close).
    let prevOpen = useJarvisStore.getState().panelOpen
    const offPanel = useJarvisStore.subscribe((state) => {
      if (state.panelOpen === prevOpen) return
      prevOpen = state.panelOpen
      reconcile()
    })

    reconcile()

    return () => {
      alive = false
      window.removeEventListener('message', onWinMsg)
      offConfig()
      offWakeEvent()
      offPanel()
      stop()
    }
  }, [])
}
