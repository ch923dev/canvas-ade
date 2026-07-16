/**
 * Jarvis J3 — the converse-mode controller (KICKOFF-J3 §2). Owns the renderer side of a
 * conversational turn: converse toggle (registers the final-transcript consumer + arms
 * mic capture), turn lifecycle (jarvis:turn:event → jarvisStore + the clause chunker →
 * serialized speakText calls), and barge-in fan-out (onBargeIn → cancel the MAIN stream +
 * drop buffered clauses). Module functions + one mount hook, mirroring voiceSession.ts.
 */
import { useEffect } from 'react'
import { useJarvisStore } from '../store/jarvisStore'
import { useVoiceStore } from '../store/voiceStore'
import { startVoice, stopVoice } from '../voice/voiceSession'
import { setFinalConsumer } from '../voice/finalConsumer'
import { onBargeIn, speakText } from '../voice/ttsSession'
import { createClauseChunker } from './clauseChunker'

let unregisterConsumer: (() => void) | null = null
let chunker = createClauseChunker()
/** Serializes speakText calls: a lazy tts session start mid-queue re-brokers the port and
 *  would drop a concurrently-started utterance — clauses must enter one at a time. */
let speakChain: Promise<void> = Promise.resolve()
/** The turn id this controller currently accepts events for (a superseded turn's late
 *  events are dropped — MAIN keeps its history either way). */
let currentTurnId: number | null = null
let voiceOpts: { sid?: number; speed?: number } = {}
/** Speak-generation stamp: bumped on barge-in / new turn / disarm. A clause already
 *  sitting in `speakChain` when the user interrupts re-checks this at fire time and
 *  skips — chunker.reset() alone only drops UN-chunked text, not queued clauses
 *  (review finding on PR #339). */
let speakEpoch = 0

function enqueueSpeak(clause: string): void {
  const epoch = speakEpoch
  speakChain = speakChain
    .then(() =>
      epoch === speakEpoch ? speakText(clause, voiceOpts).then(() => undefined) : undefined
    )
    .catch(() => {})
}

/** Send one user utterance to the brain (the registered final consumer's body). */
export function sendTurn(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  speakEpoch++ // a new turn must never speak a superseded turn's queued clauses
  // TURN-1: null synchronously — during the startTurn round-trip the superseded turn's
  // late deltas would otherwise still match the stale id and speak under the new epoch.
  currentTurnId = null
  chunker = createClauseChunker()
  void window.api.jarvis
    .startTurn(trimmed)
    .then((r) => {
      if (r.ok && r.id !== undefined) {
        currentTurnId = r.id
        useJarvisStore.getState().turnStarted(r.id, trimmed)
      } else {
        useJarvisStore.getState().turnFailed(r.reason ?? 'start-failed')
      }
    })
    .catch(() => useJarvisStore.getState().turnFailed('start-failed'))
}

/** Arm-generation token (MIC-1): bumped by every disarm AND every new arm, so an arm
 *  continuation resuming after its awaits can tell it was superseded. The panelOpen
 *  re-check rides the same predicate — a close lands `panelOpen=false` before any
 *  stale continuation runs. */
let armGeneration = 0

/** Arm/disarm converse mode. Arming loads persona config, probes TTS availability
 *  (absent model ⇒ text-only conversation), registers the final consumer and starts the
 *  mic; disarming unwinds all of it (an in-flight turn is cancelled).
 *
 *  THE MIC-GATE IS STRUCTURAL (KICKOFF-PANEL §3): arming refuses while the panel is
 *  closed — every arm affordance lives inside the open panel (or opens it in the same
 *  gesture, openJarvisPanel). Closed panel ⇒ no capture path exists. The arm chain is
 *  multi-await, so the gate is re-checked after EVERY await (MIC-1): a close landing
 *  mid-arm must never leave a consumer registered or the mic starting behind a closed
 *  panel. */
export async function setConverseMode(on: boolean): Promise<void> {
  const jarvis = useJarvisStore.getState()
  if (on && !jarvis.panelOpen) return
  if (!on) {
    armGeneration++ // any in-flight arm continuation is now stale (MIC-1)
    unregisterConsumer?.()
    unregisterConsumer = null
    currentTurnId = null
    speakEpoch++ // queued clauses die with the conversation
    chunker.reset()
    useVoiceStore.getState().setComposerSuppressed(false)
    jarvis.setConverseMode(false)
    void window.api.jarvis.cancelTurn().catch(() => {})
    // MIC-2: unconditional — `capturing` only flips true after the async arm chain, so a
    // close inside that window used to skip the stop and the port armed the mic anyway.
    // An extra stop on a not-yet-open session is a cheap MAIN no-op.
    void stopVoice()
    return
  }
  const gen = ++armGeneration
  const armStale = (): boolean => gen !== armGeneration || !useJarvisStore.getState().panelOpen
  try {
    const status = await window.api.jarvis.status()
    if (armStale()) return
    jarvis.setPersonaName(status.config.name)
    voiceOpts = {
      sid: status.config.voiceSid,
      speed: status.config.speakingRate
    }
    if (!status.hasKey && !status.mockEnabled) {
      jarvis.turnFailed('no-key')
      jarvis.setConverseMode(false)
      return
    }
  } catch {
    jarvis.turnFailed('start-failed')
    return
  }
  // TTS probe: a missing speech model degrades to a text-only conversation, never blocks.
  try {
    const tts = await window.api.voice.tts.status()
    jarvis.setSpeechReady(tts.modelStatus === 'ready')
  } catch {
    jarvis.setSpeechReady(false)
  }
  if (armStale()) return
  unregisterConsumer?.()
  unregisterConsumer = setFinalConsumer((text) => {
    // Only consume while converse mode is live (a stale registration never eats dictation).
    if (!useJarvisStore.getState().converseMode) return false
    sendTurn(text)
    return true
  })
  useVoiceStore.getState().setComposerSuppressed(true)
  jarvis.setConverseMode(true)
  if (!useVoiceStore.getState().capturing) {
    await startVoice()
    // A disarm racing the voice:start round-trip may have issued its stop BEFORE the
    // session finished starting — re-stop now that it has (the disarm already unwound
    // everything else; without this the mic would arm behind the closed panel).
    // Staleness alone is NOT enough to stop: a SUPERSEDING arm may now own a live,
    // legitimate session (voice:session:stop is a global stop with no per-arm guard in
    // MAIN — stopping here would silently kill the successor's mic while the panel
    // still shows it armed). Stop only when the current state says nobody should be
    // capturing — i.e. the staleness came from a disarm/close, not a newer arm.
    if (armStale()) {
      const live = useJarvisStore.getState()
      if (!(live.converseMode && live.panelOpen)) void stopVoice()
    }
  }
}

export function toggleConverse(): void {
  void setConverseMode(!useJarvisStore.getState().converseMode)
}

/** Open the panel AND arm the mic in one gesture (edge-tab click / hotkey). */
export function openJarvisPanel(): void {
  useJarvisStore.getState().setPanelOpen(true)
  void setConverseMode(true)
}

/** Close the panel — ALWAYS rides the full converse teardown (✕ / Esc / hotkey / project
 *  close): stop capture, cancel the in-flight turn, drop queued clauses. */
export function closeJarvisPanel(): void {
  void setConverseMode(false)
  useJarvisStore.getState().setPanelOpen(false)
}

export function toggleJarvisPanel(): void {
  if (useJarvisStore.getState().panelOpen) closeJarvisPanel()
  else openJarvisPanel()
}

/**
 * Mount-once wiring (JarvisPanel). Subscribes turn events, barge-in and config pushes;
 * cleans up on unmount (project close) — the panel closes and converse mode dies with it.
 */
export function useJarvisController(): void {
  useEffect(() => {
    if (!window.api?.jarvis) return undefined
    const store = useJarvisStore

    // HIST-1: the display transcript mirrors MAIN's per-project history. The panel mounts
    // per open project (App gates it on status==='open'), so mount = the project boundary:
    // clear the previous project's mirror, then hydrate from MAIN's canonical history
    // (read-back chosen over clear-on-switch so a reload/switch-back still shows the turns
    // the model actually remembers). MAIN keeps no timestamps — hydrated turns carry at:0,
    // which the view renders without time/day labels.
    store.getState().clearTurns()
    void window.api.jarvis.history
      .get()
      .then((h) =>
        store.getState().hydrateTurns(h.map((t) => ({ role: t.role, text: t.text, at: 0 })))
      )
      .catch(() => {})

    const offTurn = window.api.jarvis.onTurnEvent((ev) => {
      if (ev.id !== currentTurnId) return // superseded turn — drop its late events
      const s = store.getState()
      if (ev.kind === 'delta') {
        s.deltaReceived(ev.text)
        if (s.speechReady) for (const clause of chunker.push(ev.text)) enqueueSpeak(clause)
      } else if (ev.kind === 'done') {
        const rest = chunker.flush()
        if (rest && !ev.cancelled && s.speechReady) enqueueSpeak(rest)
        currentTurnId = null
        s.turnDone(ev.text, ev.cancelled)
      } else {
        currentTurnId = null
        chunker.reset()
        s.turnFailed(ev.reason)
      }
    })

    // Barge-in: the audio flush already ran (useTtsPlayback trigger) — cancel the LLM
    // stream, drop un-chunked text (chunker) AND invalidate clauses already queued in
    // the speak chain (epoch bump), so nothing speaks after the interrupt.
    const offBarge = onBargeIn(() => {
      if (!store.getState().converseMode) return
      speakEpoch++
      chunker.reset()
      void window.api.jarvis.cancelTurn().catch(() => {})
    })

    const offConfig = window.api.jarvis.config.onChanged((cfg) => {
      store.getState().setPersonaName(cfg.name)
      voiceOpts = { sid: cfg.voiceSid, speed: cfg.speakingRate }
    })

    return () => {
      offTurn()
      offBarge()
      offConfig()
      closeJarvisPanel()
    }
  }, [])
}
