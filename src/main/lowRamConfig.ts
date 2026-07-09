/**
 * Low-RAM mode (AUDIT §5) — the umbrella toggle that packages the C1/H4/H5 knobs for the 8 GB
 * target. Auto-enabled when TOTAL system RAM ≤ 8 GiB; a userData override wins.
 *
 * Decided ONCE at boot from `os.totalmem()` — BYTES, cross-platform ([os.totalmem]). NOT `freemem()`
 * / Electron `getSystemMemoryInfo().free` (those fluctuate and read low on Linux — cache counted as
 * used; and Electron's is KB, not bytes). Cached so every knob (MAIN + the renderer's supersample
 * cap, fetched via `platform:lowRam`) sees one consistent value for the run.
 *
 * Knobs it flips: C1 MAX_BACKGROUND 3→1 + idle TTL 10→4 min (backgroundSessions); H4 OSR trim budget
 * 8→3 (backgroundSessions); H5 OSR_MAX_SUPERSAMPLE 2→1 (osrSizing, renderer) + setFrameRate 30→20
 * (previewOsr). M1 (sidecar) + M11 (lazy MCP) are always-on wins, NOT gated by this.
 */
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

/** 8 GiB in bytes — the auto-enable threshold (≤ ⇒ low-RAM). */
export const LOW_RAM_THRESHOLD_BYTES = 8 * 1024 ** 3

let boundUserData: string | null = null
let cached: boolean | null = null

/** Bind the userData dir (for the override file) + reset the cache. Called once at boot. */
export function bindLowRamConfig(userDataDir: string): void {
  boundUserData = userDataDir
  cached = null
}

/** Pure detector (injectable total for tests): low-RAM iff total system RAM ≤ 8 GiB. */
export function detectLowRam(totalBytes: number): boolean {
  return totalBytes <= LOW_RAM_THRESHOLD_BYTES
}

/** The persisted manual override (`<userData>/low-ram.json` `{mode:'on'|'off'}`), or undefined to
 *  auto-detect. Hand-editable now; a Settings toggle can write it later. Absent/corrupt ⇒ auto. */
function readOverride(): 'on' | 'off' | undefined {
  if (!boundUserData) return undefined
  try {
    const raw: unknown = JSON.parse(readFileSync(join(boundUserData, 'low-ram.json'), 'utf8'))
    const mode = (raw as { mode?: unknown }).mode
    return mode === 'on' || mode === 'off' ? mode : undefined
  } catch {
    return undefined
  }
}

/** Is low-RAM mode on this run? Override wins over auto-detect; cached (a boot decision). */
export function isLowRam(): boolean {
  if (cached === null) {
    const override = readOverride()
    cached = override === undefined ? detectLowRam(totalmem()) : override === 'on'
  }
  return cached
}
