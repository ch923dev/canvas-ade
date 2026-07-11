/**
 * Jarvis J2 — the TTS playback controller hook (App root, beside useVoiceCapture).
 * Owns the player singleton for the window: adopts the `__voiceTtsPort` MessagePort MAIN
 * forwards on voice:tts:start, mirrors player state into ttsStore, hydrates the D6
 * duplex mode from voiceConfig (live re-sync on voice:config:changed), listens for
 * engine-failure pushes, and runs the barge-in loop — a store subscription that watches
 * STT partials + the slow RMS safety net (full duplex) / capture RMS alone (half
 * duplex) while audio is speaking and fires duck-flush-cancel when the user talks
 * over Jarvis.
 */
import { useEffect } from 'react'
import { createTtsPlayer, setTtsPlayer } from './ttsPlayback'
import { createBargeInDetector } from './ttsBargeIn'
import { cancelSpeech } from './ttsSession'
import { useTtsStore } from '../store/ttsStore'
import { useVoiceStore } from '../store/voiceStore'
import { FRAME_SAMPLES, TARGET_SAMPLE_RATE } from './captureMath'

/** One capture frame's duration (120 ms) — the RMS gate's accumulation tick. */
const CAPTURE_FRAME_MS = (FRAME_SAMPLES / TARGET_SAMPLE_RATE) * 1000

export function useTtsPlayback(): void {
  useEffect(() => {
    if (!window.api?.voice?.tts) return undefined // non-electron test runtimes

    const detector = createBargeInDetector(() => useTtsStore.getState().duplex)
    const player = createTtsPlayer({
      onSpeakingChange: (speaking) => {
        useTtsStore.getState().setSpeaking(speaking)
        if (!speaking) detector.reset()
      },
      onUtteranceError: (_id, error) => useTtsStore.getState().setError(error)
    })
    setTtsPlayer(player)

    const onWinMsg = (e: MessageEvent): void => {
      // Same-window pin (SEC-2 receive side): only this window's own code — the preload
      // forwarder, which already posts with an explicit same-origin target — may hand us
      // the chunk port. NOT an origin-string compare: under the packaged file:// origin
      // MessageEvent.origin serializes to "null" while location.origin is "file://",
      // so that compare drops every port (caught by the @voice e2e leg).
      if (e.source !== window) return
      const data = e.data as { __voiceTtsPort?: boolean } | null
      if (!data?.__voiceTtsPort || !e.ports[0]) return
      player.attach(e.ports[0])
      useTtsStore.getState().sessionStarted()
    }
    window.addEventListener('message', onWinMsg)

    // Engine-side failure (TTS worker or whole host died): silence anything still
    // scheduled and mark the session dead — the next speak lazily re-opens it.
    const offEvent = window.api.voice.tts.onEvent((ev) => {
      if (ev.kind !== 'error') return
      player.duckAndFlush()
      useTtsStore.getState().sessionLost(ev.reason ?? 'tts engine error')
    })

    // D6 duplex mode: hydrate + live re-sync (the Settings toggle applies immediately).
    void window.api.voice.config
      .get()
      .then((c) => useTtsStore.getState().setDuplex(c.ttsDuplex))
      .catch(() => {})
    const offConfig = window.api.voice.config.onChanged((c) =>
      useTtsStore.getState().setDuplex(c.ttsDuplex)
    )

    // Barge-in loop. Subscribed to the voice store because both signals already land
    // there per capture frame (partial text + RMS level) — no capture-pipeline coupling.
    const trigger = (): void => {
      detector.reset()
      void cancelSpeech()
    }
    const offBarge = useVoiceStore.subscribe((s, prev) => {
      const tts = useTtsStore.getState()
      if (!tts.speaking || !s.capturing) return
      if (s.partial !== prev.partial && s.partial) {
        if (detector.onPartial(s.partial, tts.recentSpokenTexts)) trigger()
      } else if (s.framesSent !== prev.framesSent) {
        if (detector.onLevel(s.level, CAPTURE_FRAME_MS)) trigger()
      }
    })

    return () => {
      window.removeEventListener('message', onWinMsg)
      offEvent()
      offConfig()
      offBarge()
      setTtsPlayer(null)
      player.dispose()
    }
  }, [])
}
