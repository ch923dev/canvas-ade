/**
 * Shared harness context for the in-process board e2e (CANVAS_SMOKE=e2e). Built once
 * by the runner and threaded through every probe. Carries the renderer-eval helpers,
 * the MAIN-side debug accessors (preview + pty internals the renderer can't see), a
 * MUTABLE ids bag the seed probes populate and later probes read, and the sentinels.
 */
import type { BrowserWindow } from 'electron'
import { debugCaptureView, debugViewIds, debugViewWebContentsId } from '../preview'
import { debugTerminalPid, debugWriteTerminal } from '../pty'

/** Sentinel echoed into a terminal board to prove the PTY↔xterm data plane. */
export const TERM_SENTINEL = 'CANVAS_E2E_TERM_OK'
/** Second sentinel — proves a respawned (config-changed) session is live (fix #1). */
export const TERM_SENTINEL2 = 'CANVAS_E2E_RESPAWN_OK'
/** Marker written into a live terminal to prove scrollback replay on undo-adopt (#15). */
export const ADOPT_MARKER = 'CANVAS_E2E_ADOPT_MARKER'
/** URL printed into the terminal so port detection succeeds (parser drops the slash). */
export const DETECTED_URL = 'http://localhost:3000'

/** Shared sequential state across the playlist (order-bound): seeded ids + carried flags. */
export interface E2EIds {
  termId?: string
  browserId?: string
  planId?: string
  deadId?: string
  /** The `browser` probe's capturePage verdict — gesture/focus probes gate on it. */
  browserOk?: boolean
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface E2ECtx {
  readonly win: BrowserWindow
  readonly localUrl: string
  /** executeJavaScript in the renderer's main world; T must be JSON-serializable. */
  evalIn<T>(expr: string): Promise<T>
  /** Poll `fn` until it resolves truthy or the timeout elapses. */
  poll(fn: () => Promise<boolean>, timeoutMs: number, stepMs?: number): Promise<boolean>
  delay(ms: number): Promise<void>
  /** MAIN-side internals the renderer eval can't reach (preview + pty). */
  readonly dbg: {
    terminalPid: typeof debugTerminalPid
    writeTerminal: typeof debugWriteTerminal
    captureView: typeof debugCaptureView
    viewIds: typeof debugViewIds
    viewWebContentsId: typeof debugViewWebContentsId
  }
  /** Shared sequential state — seed probes WRITE, later probes READ. */
  readonly ids: E2EIds
  readonly TERM_SENTINEL: string
  readonly TERM_SENTINEL2: string
  readonly ADOPT_MARKER: string
  readonly DETECTED_URL: string
}

export function makeContext(win: BrowserWindow, localUrl: string): E2ECtx {
  const evalIn = <T>(expr: string): Promise<T> =>
    win.webContents.executeJavaScript(expr, true) as Promise<T>

  const poll = async (
    fn: () => Promise<boolean>,
    timeoutMs: number,
    stepMs = 120
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await fn()) return true
      if (Date.now() > deadline) return false
      await delay(stepMs)
    }
  }

  return {
    win,
    localUrl,
    evalIn,
    poll,
    delay,
    dbg: {
      terminalPid: debugTerminalPid,
      writeTerminal: debugWriteTerminal,
      captureView: debugCaptureView,
      viewIds: debugViewIds,
      viewWebContentsId: debugViewWebContentsId
    },
    ids: {},
    TERM_SENTINEL,
    TERM_SENTINEL2,
    ADOPT_MARKER,
    DETECTED_URL
  }
}
