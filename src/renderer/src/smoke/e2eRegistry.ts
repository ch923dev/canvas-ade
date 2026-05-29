/**
 * In-process E2E test surface (Stage 1). Everything here is INERT unless the page
 * was loaded with `?e2e=1` (set only by MAIN under `CANVAS_SMOKE=e2e`). This is a
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
