/**
 * Spatial-awareness mirror contract (SPEC C1 + the C9 "Mirror additions to C1") — the single source of
 * the view + per-board context shapes the renderer publishes on `mcp:boards` and MAIN sanitizes
 * (`boardRegistry.ts`) and serves (`canvas://layout` v2). Imported by MAIN, preload and renderer (the
 * `src/shared/mcpTypes.ts` precedent). Types + the C1 sanitizer bounds — no logic.
 *
 * EVERYTHING here is SESSION state: never persisted, never routed into a board patch key (the
 * scene/session split). D9: only CLASSIFICATIONS cross — never a raw launch line, `launchCommand` or env.
 */
import type { Rect } from './spatialGeometry'

// Rect is DEFINED in spatialGeometry.ts (L7, which merges first) and re-exported here.
export type { Rect } from './spatialGeometry'

// ── C1 bounds: MAIN's `mcp:boards` sanitizer enforces these (a producer may pre-clamp to them) ──
/** Pane size bounds, CSS px (clamped). */
export const VIEW_PANE_MIN = 1
export const VIEW_PANE_MAX = 16384
/** Camera zoom bounds (clamped) — must equal the renderer camera range `canvasView.Z_MIN`/`Z_MAX`
 *  (parity unit test in `useMcpPublish.test.tsx`). */
export const VIEW_ZOOM_MIN = 0.1
export const VIEW_ZOOM_MAX = 2.5
/** devicePixelRatio is valid in (0, VIEW_DPR_MAX]. */
export const VIEW_DPR_MAX = 8
/** Context-signal bounds: a cwd path (chars), a board-id reference (chars), a port list (entries). */
export const MAX_CONTEXT_CWD = 1024
export const MAX_CONTEXT_ID = 200
export const MAX_CONTEXT_PORTS = 8

/** The user's live view of the canvas. Session state — NEVER persisted. */
export interface CanvasView {
  /** Visible canvas pane in CSS px (the React Flow pane element, not the window). */
  pane: { w: number; h: number }
  /** window.devicePixelRatio */
  dpr: number
  /** React Flow transform: world→screen is (p * zoom + {x,y}). */
  camera: { x: number; y: number; zoom: number }
  /** The world-space rect currently on screen (derived from pane + camera). */
  visibleWorld: Rect
}

/** MAIN-only enrichment from Electron's `screen` API (never sent by the renderer). */
export interface DisplayInfo {
  /** The work area of the display holding the window (screen.getDisplayMatching), in DIP. */
  workArea: Rect
  scaleFactor: number
  maximized: boolean
  fullscreen: boolean
}

/**
 * Context signals added to each board in the snapshot (all optional, all sanitized in MAIN). The
 * first four exist today and are published by `useMcpPublish`; `agent` / `ports` / `callsPorts` /
 * `lastFocusedAt` are the C9 role signals whose PRODUCERS land later (lane L11) — MAIN already
 * accepts + sanitizes them.
 */
export interface BoardContextFields {
  /** Terminal boards only: the configured working directory. */
  cwd?: string
  /** Browser boards only: the terminal that drives it. */
  previewSourceId?: string
  /** A worker terminal docked in a swarm board — not canvas geometry. */
  dockedIn?: string
  /** Data-flow boards only: the browser board whose capture it analyzes. */
  sourceBoardId?: string
  /** C9 (D9): the terminal runs a known agent CLI — a classification, never the launch line. */
  agent?: boolean
  /** C9: a terminal's detected loopback listening ports (≤ 8, each 1..65535). */
  ports?: number[]
  /** C9 (D10): the loopback ports a browser's page requested (≤ 8, each 1..65535). */
  callsPorts?: number[]
  /** C9: when the user last focused this board (epoch ms). */
  lastFocusedAt?: number
}
