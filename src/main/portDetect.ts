/**
 * Pure dev-server URL detector (Slice C′). Reads raw PTY output (with ANSI codes)
 * and extracts the localhost URLs a dev server printed (`Local: http://...`). No
 * Electron/Node imports → unit-testable in the node env. Read-only by nature.
 */
export interface DetectedUrl {
  url: string
  host: string
  port: number
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const URL_RE = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{1,5}))?/gi

/** A host you can actually point a browser at — wildcard/any-address → localhost. */
function browsableHost(host: string): string {
  const h = host.toLowerCase()
  if (h === '0.0.0.0' || h === '[::]' || h === '[::1]') return 'localhost'
  return h
}

export function parsePortsFromOutput(raw: string): DetectedUrl[] {
  if (!raw) return []
  const text = raw.replace(ANSI, '')
  const found: { host: string; port: number; scheme: string; idx: number }[] = []
  for (const m of text.matchAll(URL_RE)) {
    const scheme = m[1].toLowerCase()
    const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    found.push({ host: browsableHost(m[2]), port, scheme, idx: m.index ?? 0 })
  }
  // Dedupe by host:port, keeping the LAST (most-recent) occurrence.
  const byKey = new Map<string, { host: string; port: number; scheme: string; idx: number }>()
  for (const f of found) {
    const key = `${f.host}:${f.port}`
    const prev = byKey.get(key)
    if (!prev || f.idx > prev.idx) byKey.set(key, f)
  }
  return [...byKey.values()]
    .sort((a, b) => b.idx - a.idx) // most-recent first
    .map((f) => ({ url: `${f.scheme}://${f.host}:${f.port}`, host: f.host, port: f.port }))
}
