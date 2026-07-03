/**
 * Voice V3 — app-level voice config in userData (SPEC §5), MINIMAL slice pulled forward
 * from the V4 settings work: only what the pill needs today (`showPill` + the persisted
 * drag position). V4 adds the remaining fields (engine/model/language/hotkey/…) to this
 * same file. Mirrors `llmConfig.ts`: pure file I/O keyed by an explicit userDataDir
 * (testable without Electron's `app`), atomic write, read-repair on any malformed value.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

export interface VoiceConfig {
  /** Default true; the pill widget can be hidden entirely (Settings toggle lands in V4). */
  showPill: boolean
  /** Screen-fixed px (viewport-clamped again on restore — displays change between runs). */
  pillPosition?: { x: number; y: number }
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'voice-config.json')
}

function defaults(): VoiceConfig {
  return { showPill: true }
}

/** Coerce an unknown parsed value into a valid VoiceConfig (read/write both funnel here). */
export function repairVoiceConfig(p: unknown): VoiceConfig {
  if (typeof p !== 'object' || p === null) return defaults()
  const o = p as Partial<VoiceConfig>
  const pos = o.pillPosition
  const pillPosition =
    typeof pos === 'object' && pos !== null && Number.isFinite(pos.x) && Number.isFinite(pos.y)
      ? { x: pos.x, y: pos.y }
      : undefined
  return { showPill: typeof o.showPill === 'boolean' ? o.showPill : true, pillPosition }
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
