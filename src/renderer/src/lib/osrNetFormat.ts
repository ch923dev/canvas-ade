/**
 * Pure formatters + the row filter for the DevTools Network panel. Kept out of the component so the
 * table math is unit-tested (file-size doctrine: pure logic → lib/*.ts). All inputs are
 * already-capped record fields from the renderer mirror.
 */
import type { NetRecord } from '../../../preload'

/** Human byte size: "35 B" · "88 kB" · "4.0 MB" (DevTools-style, base-1000). */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** Request duration: "6 ms" · "1.2 s". Needs both timestamps; otherwise "—". */
export function formatDuration(startTs: number, endTs: number | undefined): string {
  if (endTs === undefined || endTs < startTs) return '—'
  const ms = endTs - startTs
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** The short row name: the last path segment, or the host for a root/empty path. */
export function urlName(url: string): string {
  if (!url) return '(empty)'
  try {
    const u = new URL(url)
    const segs = u.pathname.split('/').filter(Boolean)
    return segs.length ? segs[segs.length - 1] : u.host
  } catch {
    // Non-URL (data:, blob:, malformed) — take the tail after the last slash, capped.
    const tail = url.split(/[?#]/)[0].split('/').filter(Boolean).pop()
    return (tail ?? url).slice(0, 80)
  }
}

/** The status cell text: a number, "(failed)" / the error tag, or "—" while pending. */
export function statusLabel(rec: NetRecord): string {
  if (rec.failed) return rec.failed.canceled ? '(canceled)' : '(failed)'
  return rec.status !== undefined ? String(rec.status) : '—'
}

/** Case-insensitive substring filter over name/url/method/type/status. Empty query passes all. */
export function filterRecords(records: NetRecord[], query: string): NetRecord[] {
  const q = query.trim().toLowerCase()
  if (!q) return records
  return records.filter((r) => {
    const hay = `${r.url} ${r.method} ${r.type} ${statusLabel(r)}`.toLowerCase()
    return hay.includes(q)
  })
}
