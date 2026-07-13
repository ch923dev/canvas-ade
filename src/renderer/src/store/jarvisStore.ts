/**
 * Jarvis — ephemeral conversation/panel state (the voiceStore discipline: session-state
 * ONLY, never serialized, never routed into boardSchema or a board patch key). The
 * jarvisSession controller writes it; the panel + edge tab read it.
 */
import { create } from 'zustand'

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
  setConverseMode: (on: boolean) => void
  turnStarted: (id: number, userText: string) => void
  deltaReceived: (text: string) => void
  turnDone: (text: string, cancelled: boolean) => void
  turnFailed: (reason: string) => void
  setPanelOpen: (open: boolean) => void
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
  panelOpen: false,
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
  setPanelOpen: (open) => set((s) => (s.panelOpen === open ? s : { panelOpen: open })),
  setPersonaName: (personaName) =>
    set((s) => (s.personaName === personaName ? s : { personaName })),
  setSpeechReady: (speechReady) =>
    set((s) => (s.speechReady === speechReady ? s : { speechReady })),
  hydrateTurns: (turns) => set({ turns }),
  clearTurns: () => set({ turns: [] })
}))
