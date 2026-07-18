/**
 * Jarvis — ephemeral conversation/panel state (the voiceStore discipline: session-state
 * ONLY, never serialized, never routed into boardSchema or a board patch key). The
 * jarvisSession controller writes it; the panel + edge tab read it.
 *
 * J4 (hands): the transcript grows `act` rows (tool-call lifecycle — mock rev 2 exhibit F)
 * and the store owns the SINGLE pending-confirm slot: MAIN blocks a gated tool call on a
 * human decision; the routed request parks here (title/body + the reply closure) and the
 * panel renders it as the pending act-card. Fail-closed everywhere: a supersede, a panel
 * close, or a converse teardown answers `false` — approval only ever comes from the ✓ tap
 * or an exact spoken yes.
 */
import { create } from 'zustand'

/**
 * Display-transcript hard cap (P1-B): `turns` grows ~3 rows per settled turn (user + act
 * chips + assistant) and was previously unbounded for the life of a project open — one
 * long conversation grew store memory AND the panel DOM without limit (JarvisPanel maps
 * the whole array). 240 rows ≈ 80 turns keeps every visible semantic intact: comfortably
 * above the panel's HISTORY_WINDOW chip threshold (24) and MAIN's own prompt-history cap
 * (MAX_HISTORY_TURNS = 200 messages). Oldest rows drop first; MAIN's canonical history
 * (jarvisHistoryStore) has its own separate bounds and is untouched.
 */
export const MAX_DISPLAY_ROWS = 240

/** One turn-act lifecycle phase (mirrors MAIN's JarvisActPhase). */
export type JarvisActPhase = 'confirm' | 'running' | 'ok' | 'denied' | 'error'

/** One tool-call row in the transcript (the J4 turn-act record). */
export interface JarvisActRow {
  actId: number
  name: string
  summary: string
  phase: JarvisActPhase
  gated: boolean
}

/** One display row (the renderer mirror; MAIN keeps the canonical text history). */
export interface JarvisDisplayTurn {
  role: 'user' | 'assistant' | 'act'
  text: string
  /** Barge-in truncated this reply (rendered with an interrupted marker). */
  interrupted?: boolean
  /** Epoch ms for the history view's time stamps. */
  at: number
  /** The act payload when role === 'act' (resolved rows folded into the transcript). */
  act?: JarvisActRow
}

/** The parked human-confirm decision a gated Jarvis tool call is blocked on. */
export interface JarvisPendingConfirm {
  title: string
  body: string
  /** Resolve MAIN's gate. Idempotence is the store's job (answer clears the slot). */
  reply: (decision: { approved: boolean }) => void
}

interface JarvisState {
  /** Converse mode armed: finals route to the brain, the panel listens/answers. */
  converseMode: boolean
  /** Turn id currently streaming (null = no turn in flight). */
  activeTurnId: number | null
  /** True from turn start until the first delta (the core's `thinking` window). */
  awaitingReply: boolean
  /** Streaming reply text of the in-flight turn (the panel body renders it live). */
  streamText: string
  /** The last user utterance sent (the panel's "You ·" row). */
  lastUserText: string
  /** Display transcript, oldest first (session mirror of MAIN's history). */
  turns: JarvisDisplayTurn[]
  /** Tool-call rows of the ACTIVE turn (folded into `turns` when the turn settles). */
  acts: JarvisActRow[]
  /** The single parked confirm (at most one — MAIN executes tools sequentially). */
  pendingConfirm: JarvisPendingConfirm | null
  /** The right-side panel is open — THE mic-gate bit: converse mode can only arm while
   *  this is true, and flipping it false always rides the full converse teardown
   *  (closeJarvisPanel). The collapsed edge tab renders while false. */
  panelOpen: boolean
  /** Last brain error surfaced to the panel ('no-key' gets a Settings CTA). */
  lastError: string | null
  /** Persona mirror for labels (panel header, edge tab). */
  personaName: string
  /** TTS availability probed at converse-enable — false = text-only conversation. */
  speechReady: boolean
  /** Listen-hold: buffered finals awaiting the send (the panel's composing row). */
  composing: string
  /** Listen-mode mirror (auto/manual) — drives the composing row's hint copy. */
  listenMode: 'auto' | 'manual'
  setConverseMode: (on: boolean) => void
  turnStarted: (id: number, userText: string) => void
  deltaReceived: (text: string) => void
  turnDone: (text: string, cancelled: boolean) => void
  turnFailed: (reason: string) => void
  /** Upsert one act row by actId (MAIN's `act` turn events). */
  actEvent: (act: JarvisActRow) => void
  /** Park a routed Jarvis confirm (ConfirmModal routes origin:'jarvis' here). */
  confirmRequested: (
    req: { title: string; body: string },
    reply: JarvisPendingConfirm['reply']
  ) => void
  /** Answer + clear the parked confirm. Safe no-op when none is pending. */
  answerPendingConfirm: (approved: boolean) => void
  setPanelOpen: (open: boolean) => void
  setPersonaName: (name: string) => void
  setSpeechReady: (ready: boolean) => void
  setComposing: (text: string) => void
  setListenMode: (mode: 'auto' | 'manual') => void
  hydrateTurns: (turns: JarvisDisplayTurn[]) => void
  clearTurns: () => void
}

export const useJarvisStore = create<JarvisState>((set, get) => ({
  converseMode: false,
  activeTurnId: null,
  awaitingReply: false,
  streamText: '',
  lastUserText: '',
  turns: [],
  acts: [],
  pendingConfirm: null,
  panelOpen: false,
  lastError: null,
  personaName: 'Jarvis',
  speechReady: false,
  composing: '',
  listenMode: 'manual',
  setConverseMode: (on) =>
    set((s) =>
      s.converseMode === on ? s : { converseMode: on, ...(on ? { lastError: null } : {}) }
    ),
  turnStarted: (id, userText) =>
    set({
      activeTurnId: id,
      awaitingReply: true,
      streamText: '',
      lastUserText: userText,
      lastError: null,
      acts: []
    }),
  deltaReceived: (text) => set((s) => ({ streamText: s.streamText + text, awaitingReply: false })),
  turnDone: (text, cancelled) =>
    set((s) => {
      // P1-A hygiene: a confirm still parked when its turn settles belongs to a DEAD gate
      // (MAIN settles the gate before the turn can finish — cancel/abort included). Deny +
      // clear so the slot never leaks into the next turn; the reply is a no-op MAIN-side
      // (its channel listener is already torn down).
      s.pendingConfirm?.reply({ approved: false })
      return {
        activeTurnId: null,
        awaitingReply: false,
        streamText: '',
        acts: [],
        pendingConfirm: null,
        // P1-B: cap on append — oldest display rows drop first (see MAX_DISPLAY_ROWS).
        turns: [
          ...s.turns,
          { role: 'user' as const, text: s.lastUserText, at: Date.now() },
          // Resolved act rows fold into the transcript between the user line and the reply
          // (exhibit F: the chip is part of the turn's record, not transient chrome).
          ...s.acts.map(
            (a): JarvisDisplayTurn => ({ role: 'act', text: a.summary, at: Date.now(), act: a })
          ),
          { role: 'assistant' as const, text, interrupted: cancelled, at: Date.now() }
        ].slice(-MAX_DISPLAY_ROWS)
      }
    }),
  turnFailed: (reason) =>
    set((s) => {
      // Same dead-gate hygiene as turnDone: an errored turn must not leave a parked slot.
      s.pendingConfirm?.reply({ approved: false })
      return {
        activeTurnId: null,
        awaitingReply: false,
        streamText: '',
        acts: [],
        pendingConfirm: null,
        lastError: reason
      }
    }),
  actEvent: (act) =>
    set((s) => {
      const i = s.acts.findIndex((a) => a.actId === act.actId)
      const acts = i >= 0 ? s.acts.map((a, j) => (j === i ? act : a)) : [...s.acts, act]
      return { acts }
    }),
  confirmRequested: (req, reply) =>
    set((s) => {
      // 🔒 A second confirm while one is parked cannot happen from MAIN's sequential tool
      // loop, but fail closed anyway: deny the OLD one (never leave a gate un-answerable).
      s.pendingConfirm?.reply({ approved: false })
      return { pendingConfirm: { title: req.title, body: req.body, reply } }
    }),
  answerPendingConfirm: (approved) => {
    const pending = get().pendingConfirm
    if (!pending) return
    set((s) => ({
      pendingConfirm: null,
      // Optimistic hint: an approved gate is now executing — flip the parked 'confirm'
      // act row to 'running' until MAIN's outcome event lands (denied paints from MAIN).
      acts: approved
        ? s.acts.map((a) => (a.phase === 'confirm' ? { ...a, phase: 'running' as const } : a))
        : s.acts
    }))
    pending.reply({ approved })
  },
  setPanelOpen: (open) => set((s) => (s.panelOpen === open ? s : { panelOpen: open })),
  setPersonaName: (personaName) =>
    set((s) => (s.personaName === personaName ? s : { personaName })),
  setSpeechReady: (speechReady) =>
    set((s) => (s.speechReady === speechReady ? s : { speechReady })),
  setComposing: (composing) => set((s) => (s.composing === composing ? s : { composing })),
  setListenMode: (listenMode) => set((s) => (s.listenMode === listenMode ? s : { listenMode })),
  // Same cap on hydrate (MAIN's history:get is bounded below it today — belt+braces).
  hydrateTurns: (turns) => set({ turns: turns.slice(-MAX_DISPLAY_ROWS) }),
  clearTurns: () => set({ turns: [] })
}))
