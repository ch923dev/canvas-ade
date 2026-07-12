/**
 * Jarvis J3 — persona/app config in userData (PLAN §3.5, REVIEW D4′/D7). Mirrors
 * voiceConfig.ts: pure file I/O keyed by an explicit userDataDir (testable without
 * Electron's `app`), atomic write, and one repair funnel BOTH read and write pass
 * through so on-disk state can never diverge from the type — even a hand-edited file.
 * The API key is NOT here — Jarvis reuses the llmKeyStore `anthropic` slot (D1).
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

export type JarvisTonePreset = 'butler' | 'mission-control' | 'pair-programmer' | 'custom'
export type JarvisVerbosity = 'concise' | 'normal' | 'narrative'
/** D8 spoken-announce policy (persisted now; the announce path itself lands in J4). */
export type JarvisAnnouncePolicy = 'all' | 'attention' | 'chips-only'
/** D4′ v1: in-memory per-project history ('session') or none. 'project' (persisted under
 *  .canvas/memory/jarvis/) is the J5 slice — the union widens then, no repair change needed. */
export type JarvisHistoryMode = 'session' | 'off'

/** Persona free-text cap — user-trusted but still bounded (PLAN §7 Security). */
export const MAX_CUSTOM_TONE_LEN = 1000
export const MAX_PERSONA_NAME_LEN = 40

/** The two offered brains (mock: Brain › Model). Any string persists (a future model id
 *  survives a downgrade), but the picker offers these. */
export const JARVIS_MODELS = ['claude-opus-4-8', 'claude-haiku-4-5'] as const
export const DEFAULT_JARVIS_MODEL = 'claude-opus-4-8'

export interface JarvisConfig {
  /** Whether the Jarvis island renders at all (Settings toggle, live-apply). */
  enabled: boolean
  /** Persona name — prompt identity + island label. */
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
  /** Claude model id for the brain session. */
  model: string
  historyMode: JarvisHistoryMode
  /** Island screen position (viewport-clamped again on restore); undefined = top-right dock. */
  islandPosition?: { x: number; y: number }
}

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
    model: DEFAULT_JARVIS_MODEL,
    historyMode: 'session'
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
  const pos = o.islandPosition as { x?: unknown; y?: unknown } | undefined
  const islandPosition =
    typeof pos === 'object' &&
    pos !== null &&
    typeof pos.x === 'number' &&
    typeof pos.y === 'number' &&
    Number.isFinite(pos.x) &&
    Number.isFinite(pos.y)
      ? { x: pos.x, y: pos.y }
      : undefined
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
    // Any non-empty string persists (scene-id discipline: an id from a future build is
    // preserved; the request builder falls back at use time if the API rejects it).
    model: typeof o.model === 'string' && o.model.length > 0 ? o.model.slice(0, 256) : d.model,
    historyMode: optEnum(o.historyMode, ['session', 'off'] as const, d.historyMode),
    islandPosition
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
