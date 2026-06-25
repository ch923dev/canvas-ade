/**
 * Pure URL helpers for clickable terminal links (Phase 4 — correctness pack). The EFFECTFUL
 * wiring (the WebLinksAddon handler, spawning/routing a Browser board, the shell:openExternal
 * IPC) lives in TerminalBoard + useTerminalSpawn and is covered by the @terminal e2e. What is
 * isolated here are the DECIDABLE seams — the scheme allowlist, host classification, and the
 * board-vs-external destination decision — unit-tested without an xterm instance or the canvas
 * store.
 *
 * No '@xterm/addon-web-links' runtime import (the addon hands the handler a plain string URI), so
 * this module loads fine under jsdom/node. Mirrors terminalSearch.ts.
 */

/** Where a clicked terminal link is sent. */
export type LinkDestination = 'board' | 'external'

/** Host class behind the smart default: the user's OWN running app vs anything else. */
export type LinkHostClass = 'local' | 'remote'

/**
 * Schemes a terminal link may activate. Mirrors the MAIN allowlist
 * (src/main/previewShared.ts › isAllowedExternal, "Bug #23"): http/https can open in a Browser
 * board OR externally, mailto only externally. Everything else — file:, javascript:, data:, and
 * custom app schemes — is REJECTED here as a renderer pre-filter, and re-rejected in MAIN before
 * shell.openExternal (never trust the renderer for an OS-level open). Pure (WHATWG URL parse).
 */
export function isOpenableScheme(rawUrl: string): boolean {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:'
}

/**
 * Is this host the user's OWN machine / LAN — i.e. a running dev server the OSR preview engine
 * exists to show? Covers the loopback names + IPv4/IPv6 loopback, the unspecified bind address
 * `0.0.0.0` (what a dev server prints when it binds all interfaces), mDNS `*.local`, and the three
 * RFC 1918 private ranges (10/8, 172.16/12, 192.168/16). Case-insensitive; tolerates an IPv6 host
 * arriving with `URL.hostname`'s `[...]` brackets. Anything else (public IPs, real domains) is remote.
 */
export function isLocalHost(host: string): boolean {
  if (!host) return false
  const h = host.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 URL brackets
  // Loopback / unspecified names.
  if (h === 'localhost' || h.endsWith('.localhost')) return true // RFC 6761 loopback names
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true // IPv6 loopback
  if (h === '0.0.0.0') return true // unspecified bind address
  if (h === 'local' || h.endsWith('.local')) return true // mDNS
  // IPv4 dotted quad → loopback (127/8) + the three RFC 1918 private ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (a > 255 || b > 255 || c > 255 || d > 255) return false // not a valid octet → not a v4 address
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 10) return true // 10.0.0.0/8
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  return false
}

/**
 * Classify an http(s) link's host as local (the user's app → Browser board) or remote (→ external
 * browser). An unparseable URL or one with no host defaults to `remote` — the safe side (open in
 * the OS browser rather than spawning an in-canvas board for something we couldn't classify).
 */
export function classifyLinkHost(rawUrl: string): LinkHostClass {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return 'remote'
  }
  return isLocalHost(u.hostname) ? 'local' : 'remote'
}

/**
 * Resolve where a clicked link goes. Smart default by host — a local dev URL opens in a Browser
 * board (what the OSR preview is for), every other http(s) URL opens in the OS browser. `shiftKey`
 * is the explicit FLIP (force a localhost link external, or pull a remote link into a board).
 * `mailto:` is always external (a board can't render mail) — Shift is a no-op there.
 */
export function resolveLinkDestination(
  rawUrl: string,
  opts: { shiftKey: boolean }
): LinkDestination {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return 'external'
  }
  if (u.protocol === 'mailto:') return 'external'
  const base: LinkDestination = isLocalHost(u.hostname) ? 'board' : 'external'
  if (!opts.shiftKey) return base
  return base === 'board' ? 'external' : 'board'
}
