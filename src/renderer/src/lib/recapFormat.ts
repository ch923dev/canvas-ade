/**
 * S1 (recap redesign): pure display formatters for the recap face. Renderer-local on
 * purpose (MAIN has its own hhmm/relTime - the process boundary forbids a shared import);
 * all pure + total so they unit-test without DOM or clock.
 */

/** Epoch ms -> local "HH:MM" ("--:--" for a missing/zero timestamp). */
export function hhmm(ts: number): string {
  if (!ts) return '--:--'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Coarse relative-age phrase for a non-negative ms delta ("just now" / "3m ago"). */
export function relAge(deltaMs: number): string {
  const s = Math.max(0, Math.round(deltaMs / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}

/** Compact duration label for a session span ("40s" / "47m" / "2h 05m"). */
export function spanLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h ${String(rem).padStart(2, '0')}m` : `${h}h`
}

/** Last path segment for chip display (tolerates both separators; never empty for a path). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/** Token count -> compact context label ("62k" for >= 1000, else the exact count). */
export function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
}
