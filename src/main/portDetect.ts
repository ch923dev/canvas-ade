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
// Matches localhost, IPv4 loopback/any-addr, and bracket-enclosed IPv6 forms
// (short forms like [::], [::1] plus expanded forms like [0:0:0:0:0:0:0:1]).
// browsableHost() below filters non-loopback bracket forms.
const IPV6_BRACKET = /\[[0-9a-fA-F:]+(?:\.\d{1,3}){0,3}\]/
const URL_RE = new RegExp(
  `(https?):\\/\\/(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|${IPV6_BRACKET.source})(?::(\\d{1,5}))?`,
  'gi'
)

/** Returns true for IPv6 addresses that resolve to loopback or any-address. */
function isLoopbackOrWildcardIPv6(h: string): boolean {
  // Normalise: strip brackets, lowercase
  const inner = h.slice(1, -1).toLowerCase()
  // IPv4-mapped loopback forms — check before expandIPv6 which bails on IPv4 suffixes
  if (inner === '::ffff:127.0.0.1' || inner === '::ffff:7f00:1') return true
  // Expand :: shorthand to full 8-group decimal representation for uniform comparison
  const expanded = expandIPv6(inner)
  if (expanded === null) return false
  const allZeros = '0:0:0:0:0:0:0:0'
  const loopback = '0:0:0:0:0:0:0:1'
  return expanded === allZeros || expanded === loopback
}

/** Expands an IPv6 address string (already lowercased, no brackets) to 8 colon-separated decimal groups. */
function expandIPv6(addr: string): string | null {
  // Handle IPv4-mapped suffix — not a pure hex address, pass through as-is for
  // the special-case check in isLoopbackOrWildcardIPv6.
  if (/\d+\.\d+\.\d+\.\d+$/.test(addr)) return null
  const sides = addr.split('::')
  if (sides.length > 2) return null
  const left = sides[0] ? sides[0].split(':') : []
  const right = sides.length === 2 ? (sides[1] ? sides[1].split(':') : []) : []
  const missing = 8 - left.length - right.length
  if (missing < 0) return null
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8) return null
  // Normalise each group: strip leading zeros, keep as decimal-equivalent
  return groups.map((g) => String(parseInt(g, 16))).join(':')
}

/** A host you can actually point a browser at — wildcard/any-address → localhost. */
function browsableHost(host: string): string {
  const h = host.toLowerCase()
  if (h === '0.0.0.0') return 'localhost'
  if (h.startsWith('[') && h.endsWith(']')) {
    if (isLoopbackOrWildcardIPv6(h)) return 'localhost'
    // Non-loopback IPv6: return as-is (callers dedupe by host:port)
    return h
  }
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
