/**
 * Pure helpers for the Browser board's audio volume control (4A volume). Kept out of the component
 * so the level→icon mapping is unit-tested directly.
 */
import type { IconName } from '../canvas/Icon'

export type VolumeIconName = Extract<IconName, 'volume' | 'volume-low' | 'volume-x'>

/**
 * The speaker glyph for the current audio state: muted OR zero level ⇒ `volume-x` (silent), a
 * reduced level ⇒ `volume-low` (single wave), otherwise `volume` (full). Mute wins over level so the
 * icon always reads "silent" while muted, regardless of the stored slider position.
 */
export function volumeIcon(opts: { muted: boolean; volume: number }): VolumeIconName {
  if (opts.muted || opts.volume <= 0) return 'volume-x'
  if (opts.volume < 0.5) return 'volume-low'
  return 'volume'
}
