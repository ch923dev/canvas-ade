/**
 * Jarvis J3 — persona/app config in userData (PLAN §3.5, REVIEW D4′/D7). Mirrors
 * voiceConfig.ts: pure file I/O keyed by an explicit userDataDir (testable without
 * Electron's `app`), atomic write, and one repair funnel BOTH read and write pass
 * through so on-disk state can never diverge from the type — even a hand-edited file.
 * The brain's provider/model/key/budget are NOT here — Jarvis rides the shared
 * Context·LLM config (llmConfig + llmKeyStore + llmBudget); this file is persona-only.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

export type JarvisTonePreset = 'butler' | 'mission-control' | 'pair-programmer' | 'custom'
export type JarvisVerbosity = 'concise' | 'normal' | 'narrative'
/** D8 spoken-announce policy (persisted now; the announce path itself lands in J4). */
export type JarvisAnnouncePolicy = 'all' | 'attention' | 'chips-only'
/** D4′: 'project' persists per-project history under .canvas/memory/jarvis/ (J5 — consent-
 *  gated per project, jarvisHistoryStore); 'session' keeps it in MAIN memory only; 'off'
 *  sends no history to the model at all. */
export type JarvisHistoryMode = 'project' | 'session' | 'off'
/** Listen-hold: how converse mode decides an utterance is COMPLETE before it goes to the
 *  brain. STT finals fire on ~0.8–1 s pauses (dictation-tuned — harmless there, they only
 *  append to a draft), so converse buffers them instead of sending each fragment:
 *  'auto' sends the buffer after `listenHoldMs` of continued silence (speech resets it);
 *  'manual' never auto-sends — the user says a send word or presses Send in the panel.
 *  DEFAULT IS 'manual' (user decision 2026-07-17): an auto window kept cutting real
 *  prompts short — nothing ships until the user explicitly confirms. */
export type JarvisListenMode = 'auto' | 'manual'

/** Listen-hold patience bounds/default (ms of post-final silence before an auto send). */
export const MIN_LISTEN_HOLD_MS = 1000
export const MAX_LISTEN_HOLD_MS = 10000
export const DEFAULT_LISTEN_HOLD_MS = 2500

/** Persona free-text cap — user-trusted but still bounded (PLAN §7 Security). */
export const MAX_CUSTOM_TONE_LEN = 1000
export const MAX_PERSONA_NAME_LEN = 40

export interface JarvisConfig {
  /** Whether the Jarvis surface (panel + edge tab) renders at all (Settings toggle, live-apply). */
  enabled: boolean
  /** Persona name — prompt identity + panel/edge-tab label. */
  name: string
  tonePreset: JarvisTonePreset
  /** Free tone text when tonePreset === 'custom'; ignored otherwise, capped on repair. */
  customToneText: string
  /** TTS speaking rate multiplier (voice:tts:speak `speed`), clamped 0.5–2.0. */
  speakingRate: number
  verbosity: JarvisVerbosity
  /** TTS speaker id override for the configured model; undefined = the model's default
   *  (kokoro af_sky). Preserved even if out of range — the engine clamps at use time. */
  voiceSid?: number
  announcePolicy: JarvisAnnouncePolicy
  historyMode: JarvisHistoryMode
  /** J5 D3: the opt-in wake word (OFF by default). Its SOLE power is opening the panel
   *  (KICKOFF-PANEL §3 carve-out) — turns still require the open panel. */
  wakeWordEnabled: boolean
  /** How converse decides the utterance is done (see JarvisListenMode). */
  listenMode: JarvisListenMode
  /** 'auto' patience: ms of silence after the last final before the buffer sends. */
  listenHoldMs: number
}
/* Retired (panel surface rev, 2026-07-13): `islandPosition` — the island is gone and the
 * panel docks. Retired (shared Context·LLM rewire, 2026-07-17): `model` — the brain now
 * rides the shared llmConfig provider+model, so Jarvis keeps no model of its own. The
 * repair funnel silently accepts old files that still carry either key (unknown keys are
 * simply not emitted), so the fields drop on the next write with no migration. */

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'jarvis-config.json')
}

export function jarvisDefaults(): JarvisConfig {
  return {
    enabled: true,
    name: 'Jarvis',
    tonePreset: 'butler',
    customToneText: '',
    speakingRate: 1.05,
    verbosity: 'concise',
    announcePolicy: 'attention',
    historyMode: 'session',
    wakeWordEnabled: false,
    listenMode: 'manual',
    listenHoldMs: DEFAULT_LISTEN_HOLD_MS
  }
}

function optEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

/** Coerce an unknown parsed value into a valid JarvisConfig (read/write both funnel here). */
export function repairJarvisConfig(p: unknown): JarvisConfig {
  const d = jarvisDefaults()
  if (typeof p !== 'object' || p === null) return d
  const o = p as Partial<Record<keyof JarvisConfig, unknown>>
  const name =
    typeof o.name === 'string' && o.name.trim().length > 0
      ? o.name.trim().slice(0, MAX_PERSONA_NAME_LEN)
      : d.name
  const rate =
    typeof o.speakingRate === 'number' && Number.isFinite(o.speakingRate)
      ? Math.min(2, Math.max(0.5, o.speakingRate))
      : d.speakingRate
  const voiceSid =
    typeof o.voiceSid === 'number' && Number.isInteger(o.voiceSid) && o.voiceSid >= 0
      ? o.voiceSid
      : undefined
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    name,
    tonePreset: optEnum(
      o.tonePreset,
      ['butler', 'mission-control', 'pair-programmer', 'custom'] as const,
      d.tonePreset
    ),
    customToneText:
      typeof o.customToneText === 'string' ? o.customToneText.slice(0, MAX_CUSTOM_TONE_LEN) : '',
    speakingRate: rate,
    verbosity: optEnum(o.verbosity, ['concise', 'normal', 'narrative'] as const, d.verbosity),
    voiceSid,
    announcePolicy: optEnum(
      o.announcePolicy,
      ['all', 'attention', 'chips-only'] as const,
      d.announcePolicy
    ),
    historyMode: optEnum(o.historyMode, ['project', 'session', 'off'] as const, d.historyMode),
    wakeWordEnabled: o.wakeWordEnabled === true, // opt-in: anything but true is false
    listenMode: optEnum(o.listenMode, ['auto', 'manual'] as const, d.listenMode),
    listenHoldMs:
      typeof o.listenHoldMs === 'number' && Number.isFinite(o.listenHoldMs)
        ? Math.min(MAX_LISTEN_HOLD_MS, Math.max(MIN_LISTEN_HOLD_MS, Math.round(o.listenHoldMs)))
        : d.listenHoldMs
  }
}

/** Read the persisted config, repairing anything malformed to the defaults. */
export function readJarvisConfig(userDataDir: string): JarvisConfig {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return jarvisDefaults()
  try {
    return repairJarvisConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return jarvisDefaults()
  }
}

/** Persist the config. Atomic write, like voiceConfig/llmConfig. */
export function writeJarvisConfig(userDataDir: string, cfg: JarvisConfig): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(
    fileFor(userDataDir),
    JSON.stringify(repairJarvisConfig(cfg), null, 2),
    'utf8'
  )
}
