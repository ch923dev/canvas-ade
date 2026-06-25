/**
 * In-process E2E test surface. Everything here is INERT unless the page
 * was loaded with `?e2e=1` (set only by MAIN under `CANVAS_E2E`). This is a
 * registry + a flag — NOT a security change: `sandbox`/`contextIsolation`/
 * `nodeIntegration` are untouched, and nothing here is reachable in normal runs.
 */
import type { Terminal } from '@xterm/xterm'

/** True only when MAIN loaded the page with the e2e query flag. */
export function isE2E(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('e2e') === '1'
  } catch {
    return false
  }
}

/**
 * Live xterm instances by board id, populated by TerminalBoard ONLY in e2e mode so
 * the hook can read the framebuffer (`term.buffer.active`) — proving the full
 * PTY → MessagePort → renderer → xterm bridge without scraping the DOM.
 */
export const e2eTerminals = new Map<string, Terminal>()

/**
 * Per-board log of bytes the terminal posted to its PTY (input direction), populated
 * by TerminalBoard ONLY in e2e mode so the harness can assert Shift+Enter / paste
 * produced the right sequence without depending on agent-specific echo behavior.
 */
export const e2eTerminalInput = new Map<string, string[]>()

/** Append one posted input chunk for `id` (no-op outside e2e). */
export function appendTerminalInput(id: string, d: string): void {
  if (!isE2E()) return
  const arr = e2eTerminalInput.get(id) ?? []
  arr.push(d)
  e2eTerminalInput.set(id, arr)
}

/**
 * Per-board terminal web-link activator (Phase 4), populated by useTerminalSpawn ONLY in e2e mode.
 * It is the EXACT function the WebLinksAddon hands a clicked URI to (scheme/modifier gate →
 * destination routing → Browser board create/route or shell:openExternal), so the harness can drive
 * the real routing deterministically without synthesizing an xterm link-click (whose mousedown→
 * mouseup→activate chain doesn't fire under synthetic input). The addon's REAL URL detection is
 * covered separately by the hover assertion. `mods` mirrors the MouseEvent modifier flags.
 */
export const e2eTerminalLink = new Map<
  string,
  (uri: string, mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => void
>()

/**
 * Per-board getter for the Lane-A write coalescer's HELD byte count (terminal-crisp umbrella),
 * populated by useTerminalSpawn ONLY in e2e mode. While a terminal is gated (off-screen /
 * below-LOD) its PTY output is held, not rendered; a spec reads this back (`terminalHeldBytes`)
 * to prove the session keeps producing data (the held buffer grows) while the rendered framebuffer
 * stays frozen — and that the buffer drains to ~0 once the terminal is revealed and flushes.
 */
export const e2eTerminalHeld = new Map<string, () => number>()
