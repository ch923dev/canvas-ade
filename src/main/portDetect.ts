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
  type Hit = { host: string; port: number; scheme: string; idx: number; text: string }
  const found: Hit[] = []
  for (const m of text.matchAll(URL_RE)) {
    const scheme = m[1].toLowerCase()
    const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    found.push({ host: browsableHost(m[2]), port, scheme, idx: m.index ?? 0, text: m[0] })
  }
  // Drop terminal soft-wrap fragments. A long URL printed into a narrow terminal
  // board wraps at the column width, and ConPTY bakes that wrap into the raw output
  // detectPorts reads — leaving a truncated PREFIX of the real URL (e.g. a bare
  // `http://localhost` → :80, or `http://localhost:300` before the real
  // `http://localhost:3000`). The fragment's matched text is always a strict prefix
  // of the fuller match; a genuinely distinct URL never is. (Edge case: two real
  // ports in a prefix relation like :80 vs :8000 — vanishingly rare, accepted.)
  const real = found.filter(
    (a) => !found.some((b) => b.text.length > a.text.length && b.text.startsWith(a.text))
  )
  // Dedupe by host:port, keeping the LAST (most-recent) occurrence.
  const byKey = new Map<string, Hit>()
  for (const f of real) {
    const key = `${f.host}:${f.port}`
    const prev = byKey.get(key)
    if (!prev || f.idx > prev.idx) byKey.set(key, f)
  }
  return [...byKey.values()]
    .sort((a, b) => b.idx - a.idx) // most-recent first
    .map((f) => ({ url: `${f.scheme}://${f.host}:${f.port}`, host: f.host, port: f.port }))
}
