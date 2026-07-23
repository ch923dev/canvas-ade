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
import { DEFAULT_TTS_MODEL_ID } from './voiceTtsModels'

/** Default cloud STT model (Phase 1.5 pick: gpt-4o-transcribe + biasing + formatRestore = 85.5%). */
export const DEFAULT_STT_MODEL = 'gpt-4o-transcribe'

/** Phase 3 cloud TTS defaults: gpt-4o-mini-tts (steerable, cheaper, current-gen) + the `alloy`
 *  voice. Both free-text on disk so a newer OpenAI model/voice can be typed/picked without a code
 *  change; inert while `ttsEngine === 'kokoro'`. */
export const DEFAULT_TTS_CLOUD_MODEL = 'gpt-4o-mini-tts'
export const DEFAULT_TTS_VOICE = 'alloy'

/** Cap on the persisted voice prompt-history ring. The flyout surfaces a small Recent slice; the
 *  Settings › Voice pane shows the full list up to this bound. Repair enforces it no matter what a
 *  writer sends, so a runaway array on disk can never grow the file unbounded. */
export const MAX_PROMPT_HISTORY = 200

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
  /** Phase 2: the cloud STT model when `engine === 'cloud'`. Default gpt-4o-transcribe (the
   *  Phase 1.5 pick). Free-text so a newer OpenAI transcription model can be typed in without a
   *  code change; inert while `engine === 'sherpa-onnx'`. */
  sttModel: string
  /** Default true; the pill widget can be hidden entirely (Settings toggle, live-apply). */
  showPill: boolean
  /** Screen-fixed px (viewport-clamped again on restore — displays change between runs). */
  pillPosition?: { x: number; y: number }
  /** J2: key into the pinned TTS catalog (Kokoro default). Same discipline as `modelId`:
   *  an id that leaves the catalog is PRESERVED on disk; voiceIpc falls back to the
   *  default at tts session start without rewriting the user's choice. */
  ttsModelId: string
  /** J2 barge-in mode (D6). 'full' = transcription-gated interrupt (mic frames keep
   *  flowing to STT while speaking; a confirmed non-echo partial cancels playback).
   *  'half' = half-duplex fallback for machines where AEC can't stop self-capture: mic
   *  frames are suppressed during playback and a sustained elevated-RMS burst is the
   *  interrupt instead. */
  ttsDuplex: 'full' | 'half'
  /** Phase 3: which TTS engine synthesizes Jarvis speech. 'kokoro' = the local on-device catalog
   *  voice (default); 'cloud' = OpenAI /v1/audio/speech (needs the shared `openai` key — a
   *  cloud-selected-but-keyless config falls back to local at session start, never silently). INDEPENDENT
   *  of the STT `engine` field, so cloud dictation + local speech (or the reverse) can be mixed. */
  ttsEngine: 'kokoro' | 'cloud'
  /** Phase 3: the OpenAI speech model when `ttsEngine === 'cloud'`. Default gpt-4o-mini-tts.
   *  Free-text (tts-1 / tts-1-hd typeable); inert while `ttsEngine === 'kokoro'`. */
  ttsCloudModel: string
  /** Phase 3: the OpenAI voice when `ttsEngine === 'cloud'` (alloy/echo/fable/onyx/nova/shimmer …).
   *  Free-text so a new voice can be typed; inert while `ttsEngine === 'kokoro'`. */
  ttsVoice: string
  /** Voice prompt history — the prompts the user SENT via dictation, newest first, capped at
   *  MAX_PROMPT_HISTORY. The flyout shows a Recent slice for one-click reuse; Settings › Voice
   *  shows the whole list to browse/copy/delete. Durable *config* in userData (never a project
   *  file) — SPEC §2 still holds: ephemeral session state (draft/partial) is never serialized;
   *  this is the record of what the user chose to send, not in-flight recognition state. */
  promptHistory: string[]
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
    showPill: true,
    promptHistory: [],
    ttsModelId: DEFAULT_TTS_MODEL_ID,
    ttsDuplex: 'full',
    sttModel: DEFAULT_STT_MODEL,
    ttsEngine: 'kokoro',
    ttsCloudModel: DEFAULT_TTS_CLOUD_MODEL,
    ttsVoice: DEFAULT_TTS_VOICE
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
  // Prompt history: keep only non-empty strings, trim each, and hard-cap to the ring bound —
  // any non-array / malformed value on disk repairs to an empty list.
  const promptHistory = Array.isArray(o.promptHistory)
    ? o.promptHistory
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
        .slice(0, MAX_PROMPT_HISTORY)
    : []
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
    pillPosition,
    promptHistory,
    ttsModelId: optStr(o.ttsModelId) ?? d.ttsModelId,
    ttsDuplex: o.ttsDuplex === 'half' ? 'half' : 'full',
    sttModel: optStr(o.sttModel) ?? d.sttModel,
    ttsEngine: o.ttsEngine === 'cloud' ? 'cloud' : 'kokoro',
    ttsCloudModel: optStr(o.ttsCloudModel) ?? d.ttsCloudModel,
    ttsVoice: optStr(o.ttsVoice) ?? d.ttsVoice
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
