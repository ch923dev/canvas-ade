/**
 * Jarvis J3 — ephemeral conversation/island state (the voiceStore discipline:
 * session-state ONLY, never serialized, never routed into boardSchema or a board patch
 * key). The jarvisSession controller writes it; the island, tail and history view read it.
 */
import { create } from 'zustand'

/** Island visual states (mock B1–B5; 'acting'/'confirm' arrive with J4 tools). */
export type JarvisIslandState = 'idle' | 'listening' | 'thinking' | 'speaking'

/** One display turn (the renderer mirror; MAIN keeps the canonical history). */
export interface JarvisDisplayTurn {
  role: 'user' | 'assistant'
  text: string
  /** Barge-in truncated this reply (rendered with an interrupted marker). */
  interrupted?: boolean
  /** Epoch ms for the history view's time stamps. */
  at: number
}

interface JarvisState {
  /** Converse mode armed: finals route to the brain, the island listens/answers. */
  converseMode: boolean
  /** Turn id currently streaming (null = no turn in flight). */
  activeTurnId: number | null
  /** True from turn start until the first delta (the island's `thinking` window). */
  awaitingReply: boolean
  /** Streaming reply text of the in-flight turn (the tail renders it live). */
  streamText: string
  /** The last user utterance sent (the tail's "You ·" row). */
  lastUserText: string
  /** Display transcript, oldest first (session mirror of MAIN's history). */
  turns: JarvisDisplayTurn[]
  /** Tail overlay visibility (auto-opens on a turn; Esc dismisses). */
  tailOpen: boolean
  /** D4′ conversation view (tail expanded to the scrollable session transcript). */
  viewOpen: boolean
  /** Last brain error surfaced to the island ('no-key' gets a Settings CTA). */
  lastError: string | null
  /** Persona mirror for labels (island header, tail meta). */
  personaName: string
  /** TTS availability probed at converse-enable — false = text-only conversation. */
  speechReady: boolean
  setConverseMode: (on: boolean) => void
  turnStarted: (id: number, userText: string) => void
  deltaReceived: (text: string) => void
  turnDone: (text: string, cancelled: boolean) => void
  turnFailed: (reason: string) => void
  setTailOpen: (open: boolean) => void
  setViewOpen: (open: boolean) => void
  setPersonaName: (name: string) => void
  setSpeechReady: (ready: boolean) => void
  hydrateTurns: (turns: JarvisDisplayTurn[]) => void
  clearTurns: () => void
}

export const useJarvisStore = create<JarvisState>((set) => ({
  converseMode: false,
  activeTurnId: null,
  awaitingReply: false,
  streamText: '',
  lastUserText: '',
  turns: [],
  tailOpen: false,
  viewOpen: false,
  lastError: null,
  personaName: 'Jarvis',
  speechReady: false,
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
      tailOpen: true,
      lastError: null
    }),
  deltaReceived: (text) => set((s) => ({ streamText: s.streamText + text, awaitingReply: false })),
  turnDone: (text, cancelled) =>
    set((s) => ({
      activeTurnId: null,
      awaitingReply: false,
      streamText: '',
      turns: [
        ...s.turns,
        { role: 'user' as const, text: s.lastUserText, at: Date.now() },
        { role: 'assistant' as const, text, interrupted: cancelled, at: Date.now() }
      ]
    })),
  turnFailed: (reason) =>
    set({ activeTurnId: null, awaitingReply: false, streamText: '', lastError: reason }),
  setTailOpen: (open) => set((s) => (s.tailOpen === open ? s : { tailOpen: open })),
  setViewOpen: (open) => set((s) => (s.viewOpen === open ? s : { viewOpen: open })),
  setPersonaName: (personaName) =>
    set((s) => (s.personaName === personaName ? s : { personaName })),
  setSpeechReady: (speechReady) =>
    set((s) => (s.speechReady === speechReady ? s : { speechReady })),
  hydrateTurns: (turns) => set({ turns }),
  clearTurns: () => set({ turns: [] })
}))
