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
import { createUtteranceHold, matchSendSpeech, type JarvisListenMode } from './utteranceHold'

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

/** Listen-hold config mirror (arm-time status + config:changed pushes keep it fresh). */
let listenCfg: { mode: JarvisListenMode; holdMs: number } = { mode: 'auto', holdMs: 2500 }
/** The converse utterance buffer: finals accumulate here until the hold decides the
 *  prompt is DONE (auto silence window / manual send) — the "Jarvis cut me off" fix. */
const hold = createUtteranceHold({
  onSend: (text) => sendTurn(text),
  onChange: (pending) => useJarvisStore.getState().setComposing(pending)
})

/** Panel Send button — ship the composing buffer now (no-op when empty). */
export function sendComposingNow(): void {
  hold.flush()
}

function applyListenConfig(cfg: { listenMode?: JarvisListenMode; listenHoldMs?: number }): void {
  listenCfg = {
    mode: cfg.listenMode ?? 'auto',
    holdMs: cfg.listenHoldMs ?? 2500
  }
  useJarvisStore.getState().setListenMode(listenCfg.mode)
}

function enqueueSpeak(clause: string): void {
  const epoch = speakEpoch
  speakChain = speakChain
    .then(() =>
      epoch === speakEpoch ? speakText(clause, voiceOpts).then(() => undefined) : undefined
    )
    .catch(() => {})
}

/**
 * J4: map a spoken final to a confirm answer for the PENDING act-card. Deliberately
 * exact-match on short affirmatives/negatives (after trimming punctuation) — "no, put it
 * on the other board" must NOT read as a deny; it supersedes the turn instead, which
 * auto-denies fail-closed (sendTurn). Exported for units.
 */
export function matchConfirmSpeech(text: string): boolean | null {
  const t = text
    .toLowerCase()
    .replace(/[.,!?…]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const YES = [
    'yes',
    'yeah',
    'yep',
    'yup',
    'sure',
    'confirm',
    'approve',
    'do it',
    'go ahead',
    'ok',
    'okay'
  ]
  const NO = ['no', 'nope', 'cancel', 'deny', 'stop', "don't", 'do not', 'never mind', 'nevermind']
  if (YES.includes(t)) return true
  if (NO.includes(t)) return false
  return null
}

/** Send one user utterance to the brain (the registered final consumer's body). */
export function sendTurn(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  // J4 fail-closed supersede: a NEW utterance while an act-card awaits its ✓/✗ answers
  // that gate `false` BEFORE the new turn starts — MAIN's blocked tool call resolves
  // denied and the dead turn unwinds; nothing executes off a question the user talked past.
  useJarvisStore.getState().answerPendingConfirm(false)
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
    hold.clear() // the composing buffer dies with the conversation (never auto-sends later)
    // J4: a pending act-card dies with the conversation — DENIED (fail-closed; MAIN's
    // blocked tool call resolves instead of waiting out the 10-minute backstop).
    jarvis.answerPendingConfirm(false)
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
    applyListenConfig(status.config)
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
    const live = useJarvisStore.getState()
    if (!live.converseMode) return false
    // J4: while an act-card awaits its answer, an exact spoken yes/no answers THAT gate
    // (bound to the parked reply — a later confirm gets its own slot/channel). Anything
    // else falls through to sendTurn, which auto-denies the gate before superseding.
    if (live.pendingConfirm) {
      const answer = matchConfirmSpeech(text)
      if (answer !== null) {
        live.answerPendingConfirm(answer)
        return true
      }
    }
    // Listen-hold: finals BUFFER instead of sending — a ~1 s thinking pause no longer
    // ships half the prompt (the endpoint rules are dictation-tuned; see utteranceHold).
    // An exact send word ships the buffer now, in both modes; otherwise 'auto' re-arms
    // the silence window and 'manual' waits for the send word / panel Send.
    if (matchSendSpeech(text)) hold.flush()
    else hold.pushFinal(text, listenCfg.mode, listenCfg.holdMs)
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
      } else if (ev.kind === 'act') {
        // J4: tool-call lifecycle → the transcript's act rows (pending card / chips).
        s.actEvent({
          actId: ev.actId,
          name: ev.name,
          summary: ev.summary,
          phase: ev.phase,
          gated: ev.gated
        })
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
      applyListenConfig(cfg)
      voiceOpts = { sid: cfg.voiceSid, speed: cfg.speakingRate }
    })

    // Listen-hold: a live partial = the user resumed speaking — cancel the armed hold so
    // the buffer keeps growing (the final that ends this speech re-arms it). Empty
    // partials are ignored: the consumer clears the tail after every buffered final.
    const offPartial = useVoiceStore.subscribe((s, prev) => {
      if (s.partial !== prev.partial && s.partial.length > 0) hold.touchPartial(true)
    })

    return () => {
      offTurn()
      offBarge()
      offConfig()
      offPartial()
      closeJarvisPanel()
    }
  }, [])
}
