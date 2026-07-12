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

/** Arm/disarm converse mode. Arming loads persona config, probes TTS availability
 *  (absent model ⇒ text-only conversation), registers the final consumer and starts the
 *  mic; disarming unwinds all of it (an in-flight turn is cancelled). */
export async function setConverseMode(on: boolean): Promise<void> {
  const jarvis = useJarvisStore.getState()
  if (!on) {
    unregisterConsumer?.()
    unregisterConsumer = null
    currentTurnId = null
    speakEpoch++ // queued clauses die with the conversation
    chunker.reset()
    useVoiceStore.getState().setComposerSuppressed(false)
    jarvis.setConverseMode(false)
    void window.api.jarvis.cancelTurn().catch(() => {})
    if (useVoiceStore.getState().capturing) void stopVoice()
    return
  }
  try {
    const status = await window.api.jarvis.status()
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
  unregisterConsumer?.()
  unregisterConsumer = setFinalConsumer((text) => {
    // Only consume while converse mode is live (a stale registration never eats dictation).
    if (!useJarvisStore.getState().converseMode) return false
    sendTurn(text)
    return true
  })
  useVoiceStore.getState().setComposerSuppressed(true)
  jarvis.setConverseMode(true)
  if (!useVoiceStore.getState().capturing) void startVoice()
}

export function toggleConverse(): void {
  void setConverseMode(!useJarvisStore.getState().converseMode)
}

/**
 * Mount-once wiring (JarvisIsland). Subscribes turn events, barge-in and config pushes;
 * cleans up on unmount (project close) — converse mode does not survive the island.
 */
export function useJarvisController(): void {
  useEffect(() => {
    if (!window.api?.jarvis) return undefined
    const store = useJarvisStore

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
      void setConverseMode(false)
    }
  }, [])
}
