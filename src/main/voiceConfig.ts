/**
 * Voice V4 — app-level voice config in userData (SPEC §5). V3 pulled the minimal slice
 * forward (`showPill` + the persisted drag position); V4 adds the remaining fields:
 * engine / modelId / language / micDeviceId / hotkey / autoSendOnFinal / cloudProvider.
 * Mirrors `llmConfig.ts`: pure file I/O keyed by an explicit userDataDir (testable
 * without Electron's `app`), atomic write, read-repair on any malformed value. Every
 * field is optional on disk — an older (V3) config file opens clean, missing fields
 * repair to the defaults below.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import { DEFAULT_VOICE_MODEL_ID } from './voiceModels'

export interface VoiceConfig {
  /** 'cloud' persists for forward-compat but is greyed "coming soon" in v1 — no code
   *  path honors it (sessions always run the local sherpa host). */
  engine: 'sherpa-onnx' | 'cloud'
  /** Key into the pinned model catalog. An id that leaves the catalog is PRESERVED on
   *  disk (the backdrop scene-id discipline) — voiceIpc falls back to the default at
   *  session start without rewriting the user's choice. */
  modelId: string
  /** 'auto' | ISO 639-1. Both v1 catalog models are English; persisted for the picker
   *  and the future cloud tier. */
  language: string
  /** getUserMedia deviceId (exact constraint, falling back to default when it's gone). */
  micDeviceId?: string
  /** In-app accelerator, e.g. 'Ctrl+Shift+M' ('Cmd+Shift+M' on mac). undefined = default. */
  hotkey?: string
  /** Reserved (SPEC §2): the literal type makes true unrepresentable — repair ALWAYS
   *  writes false, no matter what is on disk. NO code path may honor true. */
  autoSendOnFinal: false
  /** Placeholder for the cloud tier; unused in v1. */
  cloudProvider?: string
  /** Default true; the pill widget can be hidden entirely (Settings toggle, live-apply). */
  showPill: boolean
  /** Screen-fixed px (viewport-clamped again on restore — displays change between runs). */
  pillPosition?: { x: number; y: number }
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'voice-config.json')
}

function defaults(): VoiceConfig {
  return {
    engine: 'sherpa-onnx',
    modelId: DEFAULT_VOICE_MODEL_ID,
    language: 'auto',
    autoSendOnFinal: false,
    showPill: true
  }
}

/** A non-empty string, or undefined (the optional-field repair shape). */
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Coerce an unknown parsed value into a valid VoiceConfig (read/write both funnel here). */
export function repairVoiceConfig(p: unknown): VoiceConfig {
  const d = defaults()
  if (typeof p !== 'object' || p === null) return d
  const o = p as Partial<Record<keyof VoiceConfig, unknown>>
  const pos = o.pillPosition as { x?: unknown; y?: unknown } | undefined
  const pillPosition =
    typeof pos === 'object' &&
    pos !== null &&
    typeof pos.x === 'number' &&
    typeof pos.y === 'number' &&
    Number.isFinite(pos.x) &&
    Number.isFinite(pos.y)
      ? { x: pos.x, y: pos.y }
      : undefined
  return {
    engine: o.engine === 'cloud' ? 'cloud' : 'sherpa-onnx',
    modelId: optStr(o.modelId) ?? d.modelId,
    language: optStr(o.language) ?? d.language,
    micDeviceId: optStr(o.micDeviceId),
    hotkey: optStr(o.hotkey),
    // Hard-false forever in v1 (SPEC §2): even a hand-edited `true` on disk repairs away.
    autoSendOnFinal: false,
    cloudProvider: optStr(o.cloudProvider),
    showPill: typeof o.showPill === 'boolean' ? o.showPill : true,
    pillPosition
  }
}

/** Read the persisted config, repairing anything malformed to the defaults. */
export function readVoiceConfig(userDataDir: string): VoiceConfig {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return defaults()
  try {
    return repairVoiceConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return defaults()
  }
}

/** Persist the config. Atomic write, like llmConfig/recentProjects. */
export function writeVoiceConfig(userDataDir: string, cfg: VoiceConfig): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(
    fileFor(userDataDir),
    JSON.stringify(repairVoiceConfig(cfg), null, 2),
    'utf8'
  )
}
