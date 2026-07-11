import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { authApi } from './authApi'
import { forwardPtyPort, terminalApi } from './terminalApi'
import { projectSessionsApi } from './projectSessionsApi'
import { recapApi, type RecapRefreshOutcome } from './recapApi'
import { notifyApi } from './notifyApi'
import { mcpServersApi } from './mcpServersApi'
import { mcpApi } from './mcpApi'
import { forwardVoicePort, forwardVoiceTtsPort, voiceApi } from './voice'

// ── Phase 2.1 terminal — shell-list + launchCommand + spawn result ──
/** Lifecycle state surfaced to the Terminal board (mirrors main `PtyState`). */
export type PtyState = 'spawning' | 'running' | 'exited' | 'spawn-failed'

// ── MCP board mirror + confirm gates + orchestrator drive — the `mcp` namespace and its mirror
// types live in mcpApi.ts (max-lines ratchet; the recapApi.ts precedent). Re-exported so existing
// import sites keep their paths.
export type { ConfirmRequest, ConfirmBatchRequest, AuditEntry } from './mcpApi'

/** A discoverable shell for the per-board picker (mirrors main `ShellInfo`). */
export interface ShellInfo {
  path: string
  label: string
  default?: boolean
}

export interface SpawnTerminalOpts {
  id: string
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  /** Free-text agentic CLI written as the first PTY line (e.g. `claude`). */
  launchCommand?: string
  /** Desktop-notifications P3: the board's `monitorActivity` opt-out (schema v10). `false` silences
   *  this session's generic-PTY lifecycle notifications (exit done/error + idle needs-input). */
  monitorActivity?: boolean
}

/** Result of `pty:spawn`: on failure `pid` is -1 and `state` is `spawn-failed`. */
export interface SpawnTerminalResult {
  id: string
  shell: string
  pid: number
  state: PtyState
  error?: string
}

/** A localhost URL detected from a terminal's dev-server output (Slice C′). */
export interface DetectedUrl {
  url: string
  host: string
  port: number
}

/** Mirrors main `ScreenshotResult` (preview:screenshot). assetId is the relative
 *  `assets/<sha1>.png` path, or null when nothing was saved. `clipboardOk` reports
 *  whether the clipboard copy actually landed (BUG-028: the write can throw).
 *  `ok:false` with reason `not-live` means the view is detached or off-screen so
 *  `capturePage()` would return a blank image; reason `forbidden` means the sender
 *  was not the trusted app renderer (should never occur from normal app flow). */
export type PreviewScreenshotResult =
  | { ok: true; assetId: string | null; clipboardOk: boolean }
  | { ok: false; reason: 'not-live' | 'forbidden' }

/**
 * Preview lifecycle event (Phase 2.2 browser). Structurally mirrors the main
 * process `PreviewEvent` (re-declared here to keep preload decoupled from main).
 */
export type PreviewEvent =
  | { id: string; type: 'did-finish-load'; url: string }
  | { id: string; type: 'did-navigate'; url: string; canGoBack: boolean; canGoForward: boolean }
  | { id: string; type: 'did-fail-load'; url: string; errorCode: number; errorDescription: string }
  // A fresh main-frame navigation STARTED — lets the renderer clear a stale
  // `load-failed` latch so a successful reload/back/forward promotes to `connected`
  // (Bug #5). Kept in sync with the main-process union.
  | { id: string; type: 'did-start-navigation' }
  // The preview's renderer process died (D2-C) — the board shows a crashed state
  // with a Reload CTA. Kept in sync with the main-process union.
  | { id: string; type: 'render-process-gone'; reason: string }

// ── OSR: offscreen preview → <canvas> ──
// One offscreen-rendered frame pushed main → renderer (OS-3 Phase 2 / 2C — dirty-rect aware).
// `buffer` is the NativeImage bitmap (BGRA) of the DIRTY region only; the renderer keeps its
// <canvas> at `full` size and blits the swizzled buffer at `dirty`'s offset. A full repaint
// reports `dirty == full`. Mirrors main `OsrFramePayload` (preload stays decoupled from main).
export interface OsrRect {
  x: number
  y: number
  width: number
  height: number
}
export interface OsrFrame {
  id: string
  full: { width: number; height: number }
  dirty: OsrRect
  buffer: Uint8Array
}
/** DevTools Network/WS records mirrored to the renderer (MAIN caps every page string). Mirrors the
 *  main `previewOsrNetwork` model — kept in lockstep across the process boundary (like OsrFrame). */
export interface NetHeader {
  name: string
  value: string
}
export interface NetTiming {
  requestTime: number
  dnsStart: number
  dnsEnd: number
  connectStart: number
  connectEnd: number
  sslStart: number
  sslEnd: number
  sendStart: number
  sendEnd: number
  receiveHeadersEnd: number
}
export interface NetRecord {
  requestId: string
  url: string
  method: string
  type: string
  status?: number
  statusText?: string
  mimeType?: string
  fromCache?: boolean
  decodedLength?: number
  cacheSource?: 'disk' | 'memory' | 'sw' | 'prefetch'
  remoteAddress?: string
  referrerPolicy?: string
  reqHeaders?: NetHeader[]
  resHeaders?: NetHeader[]
  startTs: number
  endTs?: number
  encodedDataLength?: number
  timing?: NetTiming
  finishMono?: number
  failed?: { errorText: string; blockedReason?: string; canceled?: boolean }
  initiator?: string
  initiatorRequestId?: string // JD-4: structured initiator's triggering requestId (body-free metadata)
  loaderId?: string
  preserved?: boolean
  navBoundary?: boolean
  sessionId?: string
  frameId?: string
  crossOrigin?: boolean
}
export interface WsFrame {
  dir: 'sent' | 'recv'
  opcode: number
  ts: number
  length: number
  payload: string
  truncated: boolean
}
export interface WsRecord {
  requestId: string
  url: string
  createdTs: number
  closedTs?: number
  reqHeaders?: NetHeader[]
  resHeaders?: NetHeader[]
  frames: WsFrame[]
}
/** A coalesced Network batch on `preview:osrNet` (id-dispatched, like OsrFrame). */
export interface OsrNetMessage {
  id: string
  kind: 'replay' | 'delta' | 'cleared'
  records?: NetRecord[]
  ws?: WsRecord[]
  dropped?: number
  preserve?: boolean
}
/** A lazily-fetched, MAIN-capped body (or an error). */
export interface OsrNetBody {
  body?: string
  base64?: boolean
  truncated?: boolean
  error?: string
}
// ── Data-shape inference wire types — MIRROR main `previewOsrShape.ts` (ShapeNode/ShapeSampleWire/
//    OsrNetSchemaResult). Value-LESS skeletons: types/keys/format only, never raw values (ADR 0010). ──
export type ShapeType = 'string' | 'number' | 'bool' | 'null' | 'object' | 'array' | 'unknown'
export type FormatHint = 'uuid' | 'date-time' | 'email' | 'uri' | 'int64'
export interface ShapeNode {
  types: ShapeType[]
  format?: FormatHint
  children?: Record<string, ShapeNode>
  elem?: ShapeNode
}
export interface ShapeSampleWire {
  root: ShapeNode
  complete: boolean
}
/** Result of a sampling pass: value-less skeletons + how many were requested vs actually sampled. */
export interface OsrNetSchemaResult {
  samples?: ShapeSampleWire[]
  requested?: number
  sampled?: number
  error?: string
}
// ── id-lineage wire types — MIRROR main `previewOsrLineage.ts`. VALUE-LESS edge list: the id NAME +
//    source/target requestIds + location only, never the matched value (ADR 0010 amendment §B). ──
export interface RequestLineageEdgeWire {
  idName: string
  fromRequestId: string
  toRequestId: string
  location: 'path' | 'query' | 'body'
  confidence: 'body-match'
}
/** Result of the MAIN body-side lineage pass: the value-less edge list + bounded-pass counters. */
export interface OsrNetLineageResult {
  edges?: RequestLineageEdgeWire[]
  producersScanned?: number
  consumersScanned?: number
  valuesTracked?: number
  error?: string
}
/** The offscreen page's cursor, mirrored onto the host <canvas>. `image` (a data URL) +
 *  `hotspot` are present only for type:'custom'. Mirrors main `OsrCursorPayload`. */
export interface OsrCursor {
  id: string
  type: string
  image?: string
  hotspot?: { x: number; y: number }
  scale?: number
}
/** A renderer-built input event forwarded to the offscreen view (M3 scaffold). */
export type OsrInputEvent = Parameters<Electron.WebContents['sendInputEvent']>[0]
/** OS-3 Phase 3 — clipboard/selection verb routed to the offscreen WebContents' edit methods. */
export type OsrEditAction = 'copy' | 'cut' | 'paste' | 'selectAll'
/** OS-3 Phase 3 — text commit (`commit`) vs in-progress IME preview (`compose`). */
export type OsrImeKind = 'compose' | 'commit'

// ── OS-3 Phase 4 — native widgets & dialogs (mirror main `previewOsrWidgets.ts`) ──
/** A JS dialog the previewed page opened (beforeunload is auto-handled in MAIN, never sent). */
export type OsrDialogType = 'alert' | 'confirm' | 'prompt'
export interface OsrDialogEvent {
  id: string
  dialogType: OsrDialogType
  message: string
  defaultPrompt: string
}
export type OsrPopupKind = 'select' | 'date' | 'color'
export interface OsrSelectOption {
  label: string
  value: string
  selected: boolean
  disabled: boolean
}
/** A native popup widget opening — `rect` is in PAGE CSS px; the renderer maps it into the frame. */
export interface OsrPopupEvent {
  id: string
  kind: OsrPopupKind
  rect: { x: number; y: number; width: number; height: number }
  value: string
  options?: OsrSelectOption[]
  multiple?: boolean
}
export interface OsrAudibleEvent {
  id: string
  audible: boolean
}
export type OsrDownloadState = 'start' | 'progress' | 'done' | 'fail' | 'throttled'
export interface OsrDownloadEvent {
  id: string
  state: OsrDownloadState
  name: string
  savePath?: string
  received?: number
  total?: number
}

// ── Project Library — files saved under <project>/.canvas/{downloads,assets} (mirrors main/projectLibrary) ──
export type LibraryKind = 'download' | 'asset'
export interface LibraryItem {
  name: string
  /** Path relative to `.canvas/` (the reveal/open key) — e.g. `downloads/report.pdf`. */
  relPath: string
  size: number
  mtime: number
  kind: LibraryKind
}
export interface LibraryListing {
  downloadsDir: string
  downloads: LibraryItem[]
  assets: LibraryItem[]
}

// ── Phase 3 persistence — project I/O types (factored to projectTypes.ts under the ratchet;
// re-exported so renderer import sites are unchanged). Background project sessions (Phase 2):
// BackgroundProjectInfo + the project.* methods live in projectSessionsApi.ts.
export type { RecentProject, ProjectResult } from './projectTypes'
export type { BackgroundProjectInfo } from './projectSessionsApi'
import type { RecentProject, ProjectResult } from './projectTypes'

// ── File-tree epic (S1) — root-confined fs surface (mirrors main `fileIpc.ts`) ──
/** One directory entry from `file.listDir` (symlinks are skipped MAIN-side). */
export interface FileEntry {
  name: string
  isDir: boolean
}
/** A file/dir stat projection from `file.stat`. */
export interface FileStat {
  size: number
  mtimeMs: number
  isDir: boolean
}
/** Result of `file.writeText` — `conflict` when an `expectedMtimeMs` was passed but the file changed
 *  on disk since (FIND-002: no blind overwrite). `mtimeMs` is the current on-disk mtime either way. */
export type WriteTextResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; conflict: true; mtimeMs: number }
/**
 * A live file-tree change pushed MAIN → renderer on `file:treeEvent`. The chokidar
 * watcher that EMITS this lands in S2; the contract (channel + payload) is defined here in
 * S1 so the preload has a single owner. `path` is RELATIVE to the project root.
 */
export interface FileTreeEvent {
  type: 'add' | 'change' | 'unlink'
  path: string
}

// ── M-brain T-B1/T-B2 — mirrors main `SummarizeResult` / `LlmStatus` (preload stays decoupled) ──
export type LlmSummarizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-provider' }
  | { ok: false; reason: 'budget-exceeded' }
  | { ok: false; reason: 'provider-error'; message: string }

export interface LlmStatus {
  hasProvider: boolean
  /** Mirrors main `ProviderName` — keep in sync if a provider is added. */
  provider: 'openrouter' | 'openai' | 'anthropic' | 'local'
  model: string
  baseUrl?: string
  hasKey: boolean
  /** T-F6: false when the OS can't encrypt a key (e.g. Linux without a keyring). */
  encryptionAvailable: boolean
  /** T-B3 budget (MCP-05): LLM calls consumed today + the configured/default per-day cap. */
  callsToday: number
  maxCallsPerDay?: number
  defaultMaxCallsPerDay: number
}

export type LlmWriteResult = { ok: boolean; reason?: string }

// ── Terminal-recap T12 + recap redesign S1: consent state, bundle mirrors, and the recap
// namespace live in recapApi.ts (max-lines ratchet; the terminalApi.ts precedent). Types are
// re-exported below so existing importers keep their paths.
export type {
  RecapConsentState,
  RecapStatus,
  RecapFacts,
  RecapNarrative,
  RecapBundle,
  RecapRefreshOutcome,
  RecapHealthView
} from './recapApi'

// ── Agent Orchestration Onboarding P1: per-project orchestration consent ──
// MIRRORS src/main/orchestrationConsent.ts OrchestrationConsentState (process boundary → no
// shared import). A SEPARATE consent from recap (decision 2026-06-19).
export type OrchestrationConsentState = 'enabled' | 'declined' | 'undecided'

// The Sync modal's data plane. Shapes MIRROR src/main/cliProvisioners/shared.ts
// (CliId / ProvisionStatus / SyncResult) across the process boundary — keep in lockstep.
// 🔒 the endpoint token is PRE-MASKED in MAIN; the raw token never crosses the bridge.
export type OrchestrationCliId = 'claude' | 'codex' | 'gemini' | 'opencode'
export interface OrchestrationProvisionStatus {
  endpoint: { host: string; port: number; maskedToken: string }
  rows: { id: OrchestrationCliId; label: string; configLabel: string; detected: boolean }[]
}
export interface OrchestrationSyncResult {
  id: OrchestrationCliId
  status: 'synced' | 'error'
  detail: string
  path?: string
}

// External MCP servers (feature: add external MCP servers). The namespace + its mirror types live in
// mcpServersApi.ts (max-lines ratchet; the recapApi.ts precedent); re-export so the renderer barrel
// import keeps resolving them.
export type {
  McpCliId,
  McpTransport,
  McpMaskedSecret,
  McpTestResult,
  MaskedMcpServer,
  McpServerSaveInput,
  McpSaveResult
} from './mcpServersApi'

// ── PREV-02: ONE shared IPC listener per OSR stream, fanned out by board id ──
// Before: every Browser board called `ipcRenderer.on('preview:osrFrame', …)`, so N boards meant N
// listeners that EACH ran (and id-checked) on EVERY board's frame — O(N) work per frame. Now a
// single listener per channel dispatches to the one handler registered for that frame's board id.
// Board ids are unique (one mounted BrowserBoard per id, even relocated into full view), so the map
// holds at most one handler per board.
const osrFrameHandlers = new Map<string, (f: OsrFrame) => void>()
const osrCursorHandlers = new Map<string, (c: OsrCursor) => void>()
// A SET of handlers per board id (JD-4): the Network panel AND a Data-Flow board can both subscribe to
// the same source board's capture; the store stays the single source of truth, every listener applies.
const osrNetHandlers = new Map<string, Set<(m: OsrNetMessage) => void>>()
let osrFrameWired = false
let osrCursorWired = false
let osrNetWired = false
function ensureOsrFrameListener(): void {
  if (osrFrameWired) return
  osrFrameWired = true
  ipcRenderer.on('preview:osrFrame', (_e: IpcRendererEvent, f: OsrFrame) => {
    osrFrameHandlers.get(f.id)?.(f)
  })
}
function ensureOsrCursorListener(): void {
  if (osrCursorWired) return
  osrCursorWired = true
  ipcRenderer.on('preview:osrCursor', (_e: IpcRendererEvent, c: OsrCursor) => {
    osrCursorHandlers.get(c.id)?.(c)
  })
}
function ensureOsrNetListener(): void {
  if (osrNetWired) return
  osrNetWired = true
  ipcRenderer.on('preview:osrNet', (_e: IpcRendererEvent, m: OsrNetMessage) => {
    osrNetHandlers.get(m.id)?.forEach((fn) => fn(m))
  })
}

// ── Phase 5 auto-update — MIRRORS main `UpdateStatus` (src/main/autoUpdate.ts). The
// process boundary means no shared import; keep the two in lockstep, same as PtyState. ──
/** The two non-blocking loudness levels an available update can carry (mirrors main). */
export type UpdateTier = 'optional' | 'recommended'
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string; tier: UpdateTier }
  | { state: 'mandatory'; version: string }
  | { state: 'none' }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

// Phase 1 accounts: AuthStatus + the `auth` namespace live in ./authApi (max-lines ratchet);
// re-exported here so the renderer's import path stays stable.
export type { AuthStatus } from './authApi'

// Windows OS build number (null off Windows), read SYNC once at preload load so the renderer has it
// synchronously when constructing xterm (A-Win: the `windowsPty` hint — see main/platformIpc.ts +
// useTerminalSpawn). One-time sendSync of a static value; the handler is registered at app init,
// before this preload runs.
const osWinBuild: number | null =
  process.platform === 'win32' ? (ipcRenderer.sendSync('platform:winBuild') as number | null) : null

// BUG-057: MAIN-owned decision, read SYNC once at preload load (same pattern as osWinBuild
// above) — whether the renderer's in-process e2e test-surface (`window.__canvasE2E`, the
// terminal registries in e2eRegistry.ts) should be enabled. contextBridge deep-freezes the
// exposed `api` object, so a renderer-context script can read this but can never overwrite it
// or otherwise self-enable the surface (the prior gate was the client-mutable `?e2e=1` URL
// query alone).
const e2eEnabled: boolean = ipcRenderer.sendSync('platform:e2eEnabled') as boolean

// Low-RAM (AUDIT §5): MAIN decides once from os.totalmem; read SYNC at load (same pattern). The
// renderer caps OSR_MAX_SUPERSAMPLE at 1× off this (osrSizing.setLowRamMode at boot).
const lowRam: boolean = ipcRenderer.sendSync('platform:lowRam') as boolean

const api = {
  /** Windows OS build number, or null off Windows (A-Win xterm windowsPty hint). */
  osWinBuild,
  /** MAIN-owned: true only when the Playwright harness set CANVAS_E2E (see BUG-057). */
  e2eEnabled,
  /** Low-RAM mode (AUDIT §5): auto-enabled when total RAM ≤ 8 GiB (MAIN decides). */
  lowRam,
  // ── Terminal (control plane; data flows over a MessagePort) ──
  spawnTerminal: (opts: SpawnTerminalOpts): Promise<SpawnTerminalResult> =>
    ipcRenderer.invoke('pty:spawn', opts),
  killTerminal: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:kill', id),
  // PTY-1: reap EVERY session (live + parked) on project switch — `killTerminal`
  // per-board missed parked (deleted-but-undoable) sessions, leaking child trees.
  disposeAllTerminals: (): Promise<boolean> => ipcRenderer.invoke('pty:disposeAll'),
  // Park the session on delete (keep the proc alive for adopt-on-undo, #15).
  parkTerminal: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:park', id),
  // Adopt a parked session on undo; { adopted:false } → caller spawns fresh (#15).
  adoptTerminal: (id: string): Promise<{ adopted: boolean; pid?: number }> =>
    ipcRenderer.invoke('pty:adopt', id),
  // Phase 2.1: OS-aware shell list (best-default first) for the board picker.
  listShells: (): Promise<ShellInfo[]> => ipcRenderer.invoke('pty:shells'),
  // Slice C′: parse the dev-server URL(s) out of a board's PTY output (read-only).
  detectPorts: (id: string): Promise<DetectedUrl[]> =>
    ipcRenderer.invoke('terminal:detectPorts', id),
  // Stage the clipboard image to <project>/.canvas/tmp and return its absolute path
  // (null = no image / no project). The renderer injects the path into the PTY.
  stageClipboardImage: (boardId: string): Promise<string | null> =>
    ipcRenderer.invoke('terminal:stageClipboardImage', boardId),
  cleanupStagedImages: (boardId: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:cleanupStagedImages', boardId),
  // webUtils.getPathForFile replaces the removed File.path (Electron 32+). Called from
  // the terminal drop handler to get a dropped file's real OS path for injection.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ── Clipboard (MAIN-owned; sandbox-clean) ──
  clipboard: {
    writeText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:writeText', text),
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText')
  },

  // General "open this URL in the OS browser" — scheme re-validated in MAIN (shellIpc →
  // openExternalSafe). Used by app surfaces outside the preview subsystem (Phase 4 terminal
  // web-links). Returns whether MAIN actually opened it (false = scheme blocked / unparseable).
  openExternalUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternal', url),

  // ── Browser preview — engine-agnostic control plane (shared by the offscreen engine) ──
  // Open the preview's current URL in the OS browser (scheme-gated in main).
  openExternalPreview: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:openExternal', url),
  // Screenshot the live preview -> clipboard + project assets/. { ok:false, reason:'not-live' }
  // when the offscreen window is missing/off-screen (capturePage is blank then).
  screenshotPreview: (id: string): Promise<PreviewScreenshotResult> =>
    ipcRenderer.invoke('preview:screenshot', id),
  /**
   * Subscribe to preview lifecycle events (did-navigate / did-fail-load /
   * did-finish-load), keyed by board id. Returns an unsubscribe fn. The listener
   * gets ONLY the event payload (never the IpcRendererEvent) so the renderer can't
   * reach ipcRenderer.
   */
  onPreviewEvent: (listener: (ev: PreviewEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, ev: PreviewEvent): void => listener(ev)
    ipcRenderer.on('preview:event', handler)
    return () => ipcRenderer.removeListener('preview:event', handler)
  },

  // ── Offscreen preview → <canvas> (the occlusion fix, ADR 0002) ──
  // Render a Browser board's page offscreen and stream frames to a DOM <canvas> (a clipping,
  // z-ordering DOM node). The sole Browser-preview engine since 5C deleted the native path.
  openOsrPreview: (args: { id: string; url: string }): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrOpen', args),
  closeOsrPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:osrClose', id),
  // Tear down EVERY offscreen window in one shot (project switch / e2e reset) — deterministic
  // sweep that doesn't wait on per-board React unmount cleanup.
  closeAllOsr: (): Promise<boolean> => ipcRenderer.invoke('preview:osrCloseAll'),
  sendOsrInput: (id: string, event: OsrInputEvent): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrInput', { id, event }),
  // Reload a crashed/failed preview board (relaunches the offscreen renderer).
  reloadOsrPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:osrReload', id),
  // URL-bar Back/Forward — navigate the offscreen webContents history.
  goBackOsrPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:osrGoBack', id),
  goForwardOsrPreview: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrGoForward', id),
  // OS-3 Phase 1: resize the offscreen surface (M1 supersample + M4 responsive logical width).
  // Sent by the settle-gated sizing hook (useOffscreenSizing) ONLY on a settled-zoom / preset /
  // board-resize change — never per camera frame.
  resizeOsr: (
    id: string,
    size: { logicalW: number; logicalH: number; supersample: number }
  ): Promise<boolean> => ipcRenderer.invoke('preview:osrResize', { id, ...size }),
  // OS-3 Phase 2 (M2 / 2A): set a board's desired paint state. Sent by the settle-gated
  // liveness manager (useOffscreenLiveness) ONLY when visibility flips — `false` freezes the
  // offscreen pump (CPU→0, last frame stays), `true` resumes + invalidates.
  setOsrPaint: (id: string, painting: boolean): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrSetPaint', { id, painting }),
  // Per-interaction focus emulation: enable on canvas focus, disable on blur (P0 — so the
  // caret/:focus ring show while interacting AND the page's blur/focusout still fire).
  setOsrFocus: (id: string, focused: boolean): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrFocus', { id, focused }),
  // OS-3 Phase 3 (3C): clipboard / select-all routed to the offscreen page's own edit methods
  // (wc.copy/cut/paste/selectAll) — the trusted bridge over the page's denied navigator.clipboard.
  osrEditCommand: (id: string, action: OsrEditAction): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrEdit', { id, action }),
  // OS-3 Phase 3 (3A+3B): commit text / drive IME composition into the offscreen page via the
  // attached CDP debugger (Input.insertText / Input.imeSetComposition). All TEXT routes here from
  // the hidden composition-proxy <textarea>; raw key events stay on sendOsrInput.
  osrIme: (id: string, kind: OsrImeKind, text: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrIme', { id, kind, text }),
  // PREV-02: register the per-board frame handler on the ONE shared listener (lazily wired). The
  // listener never id-checks N handlers — it dispatches straight to this board's. Returns an
  // unsubscribe that removes only this board's entry (and only if it's still the current one).
  onPreviewOsrFrame: (id: string, listener: (f: OsrFrame) => void): (() => void) => {
    ensureOsrFrameListener()
    osrFrameHandlers.set(id, listener)
    return () => {
      if (osrFrameHandlers.get(id) === listener) osrFrameHandlers.delete(id)
    }
  },
  // DevTools Network inspector (per board). Subscribe replays the MAIN ring buffer once + streams
  // coalesced deltas; unsubscribe stops ALL further IPC (zero-IPC-when-closed). Body fetch is lazy +
  // capped in MAIN (the approved exfil surface). All re-validated against live MAIN state.
  subscribeOsrNet: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrNetSubscribe', id),
  unsubscribeOsrNet: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrNetUnsubscribe', id),
  clearOsrNet: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:osrNetClear', id),
  setOsrNetPreserve: (id: string, preserve: boolean): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrNetSetPreserve', { id, preserve }),
  getOsrNetBody: (
    id: string,
    requestId: string,
    kind: 'response' | 'request' = 'response'
  ): Promise<OsrNetBody> => ipcRenderer.invoke('preview:osrNetGetBody', { id, requestId, kind }),
  /** Sample response bodies for a template (opt-in, capped, MAIN-side) → value-less shape skeletons. */
  sampleOsrNetSchema: (id: string, requestIds: string[]): Promise<OsrNetSchemaResult> =>
    ipcRenderer.invoke('preview:osrNetSampleSchema', { id, requestIds }),
  // JD-4 id-lineage: the MAIN body-side value-read pass. Returns only the value-less edge list.
  lineageOsrNet: (id: string, requestIds?: string[]): Promise<OsrNetLineageResult> =>
    ipcRenderer.invoke('preview:osrNetLineage', { id, requestIds }),
  onPreviewOsrNet: (id: string, listener: (m: OsrNetMessage) => void): (() => void) => {
    ensureOsrNetListener()
    const set = osrNetHandlers.get(id) ?? new Set()
    set.add(listener)
    osrNetHandlers.set(id, set)
    return () => {
      const s = osrNetHandlers.get(id)
      if (!s) return
      s.delete(listener)
      if (s.size === 0) osrNetHandlers.delete(id)
    }
  },
  // Cursor stream: the offscreen page's cursor type, applied to the board's <canvas>
  // so the preview shows an I-beam over inputs / pointer over links (a bitmap has none).
  // PREV-02: same shared-listener fan-out by board id as the frame stream.
  onPreviewOsrCursor: (id: string, listener: (c: OsrCursor) => void): (() => void) => {
    ensureOsrCursorListener()
    osrCursorHandlers.set(id, listener)
    return () => {
      if (osrCursorHandlers.get(id) === listener) osrCursorHandlers.delete(id)
    }
  },

  // ── OS-3 Phase 4 — native widgets & dialogs ──
  // 4A — manual mute toggle (effective mute = manual || off-screen, applied in MAIN).
  setOsrMuted: (id: string, muted: boolean): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrSetMuted', { id, muted }),
  // 4A (volume) — set the emulated audio volume (0–1). MAIN clamps + injects el.volume onto the
  // page's HTML5 media (no native OSR volume API; Web Audio honors only mute).
  setOsrVolume: (id: string, volume: number): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrSetVolume', { id, volume }),
  // 4B — answer the surfaced JS dialog (accept + optional prompt text) → handleJavaScriptDialog.
  respondOsrDialog: (id: string, accept: boolean, promptText?: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrDialogRespond', { id, accept, promptText }),
  // 4E — commit / dismiss a native popup overlay's choice (commit writes value + fires input/change).
  commitOsrPopup: (id: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrPopupCommit', { id, value }),
  dismissOsrPopup: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrPopupDismiss', id),
  // 4D — reveal a completed download in the OS file manager (toast Show action).
  revealOsrDownload: (savePath: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrRevealDownload', savePath),
  // Event streams (MAIN → renderer): JS dialog opened · native popup opening · audible flip ·
  // download progress. Each returns an unsubscribe fn, mirroring the frame/cursor pumps.
  onPreviewOsrDialog: (listener: (d: OsrDialogEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, d: OsrDialogEvent): void => listener(d)
    ipcRenderer.on('preview:osrDialog', handler)
    return () => ipcRenderer.removeListener('preview:osrDialog', handler)
  },
  onPreviewOsrPopup: (listener: (p: OsrPopupEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, p: OsrPopupEvent): void => listener(p)
    ipcRenderer.on('preview:osrPopup', handler)
    return () => ipcRenderer.removeListener('preview:osrPopup', handler)
  },
  onPreviewOsrAudible: (listener: (a: OsrAudibleEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, a: OsrAudibleEvent): void => listener(a)
    ipcRenderer.on('preview:osrAudible', handler)
    return () => ipcRenderer.removeListener('preview:osrAudible', handler)
  },
  onPreviewOsrDownload: (listener: (d: OsrDownloadEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, d: OsrDownloadEvent): void => listener(d)
    ipcRenderer.on('preview:osrDownload', handler)
    return () => ipcRenderer.removeListener('preview:osrDownload', handler)
  },

  // ── Phase 3 persistence ──
  project: {
    create: (dir: string, name: string, opts: { gitInit?: boolean }): Promise<ProjectResult> =>
      ipcRenderer.invoke('project:create', { dir, name, opts }),
    open: (dir: string): Promise<ProjectResult> => ipcRenderer.invoke('project:open', dir),
    // T5: deep-validation recovery — fetch ONLY canvas.json.bak so the renderer can retry
    // `fromObject` against the last good snapshot when the primary is envelope-valid but
    // deep-corrupt (MAIN's own .bak fallback only covers parse/envelope failures).
    reopenFromBak: (dir: string): Promise<ProjectResult> =>
      ipcRenderer.invoke('project:reopenFromBak', dir),
    // BUG-009: optional expectedDir — when supplied, MAIN rejects the write unless it
    // still matches the current open dir (guards autosave racing a project switch).
    // Forwarded only when present so dir-less call sites keep their exact IPC shape.
    // C3: returns `{ ok:false, code }` (Node write errno) on a write failure, `{ ok:false }` with no
    // code on a non-error rejection (foreign sender / no project / cross-project race). The renderer
    // maps `code` → accurate copy (saveError.ts) instead of always saying "check disk space".
    save: (
      doc: unknown,
      expectedDir?: string
    ): Promise<{ ok: true } | { ok: false; code?: string }> =>
      expectedDir === undefined
        ? ipcRenderer.invoke('project:save', doc)
        : ipcRenderer.invoke('project:save', doc, expectedDir),
    // M1: write ONLY the camera/backdrop session sidecar (.canvas/session.json). Same optional
    // expectedDir dir-pin as save() — guards a session write racing a project switch.
    saveSession: (session: unknown, expectedDir?: string): Promise<boolean> =>
      expectedDir === undefined
        ? ipcRenderer.invoke('project:saveSession', session)
        : ipcRenderer.invoke('project:saveSession', session, expectedDir),
    recents: (): Promise<RecentProject[]> => ipcRenderer.invoke('project:recents'),
    // Both are LIST-ONLY mutations (never touch the project folder) and return the
    // fresh list so the caller can re-render without a second recents() round-trip.
    removeRecent: (path: string): Promise<RecentProject[]> =>
      ipcRenderer.invoke('project:removeRecent', path),
    clearRecents: (): Promise<RecentProject[]> => ipcRenderer.invoke('project:clearRecents'),
    current: (): Promise<ProjectResult | null> => ipcRenderer.invoke('project:current'),
    // Background project sessions (Phase 2) — factored to projectSessionsApi.ts (ratchet).
    ...projectSessionsApi,
    /**
     * Register a handler that main invokes (`project:flush`) right before it hard-exits
     * on quit (BUG-M2). The hard `app.exit(0)` bypasses the renderer `beforeunload`, so
     * the autosave flush would otherwise never run and the last ~1s edit is lost. The
     * handler runs (awaiting the underlying `project:save`) and main awaits the reply
     * before exiting. Returns an unsubscribe fn.
     */
    onFlush: (handler: () => void | Promise<void>): (() => void) => {
      const listener = async (_e: IpcRendererEvent, replyChannel: string): Promise<void> => {
        try {
          await handler()
        } finally {
          ipcRenderer.send(replyChannel)
        }
      }
      ipcRenderer.on('project:flush', listener)
      return () => ipcRenderer.removeListener('project:flush', listener)
    },
    /**
     * Global project-switch hotkey (globalHotkey.ts): MAIN foregrounds the window then sends the
     * cycle DIRECTION (1 = next / -1 = prev). The renderer owns the ordered recents ring + the
     * performProjectSwitch pipeline. Returns an unsubscribe fn.
     */
    onCycleProject: (handler: (dir: 1 | -1) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, dir: 1 | -1): void => handler(dir)
      ipcRenderer.on('project:cycleHotkey', listener)
      return () => ipcRenderer.removeListener('project:cycleHotkey', listener)
    }
  },
  // ── Global project-switch hotkey settings (Settings › Shortcuts) ──
  hotkey: {
    /** Read the persisted accelerators. Null only from a foreign frame (guarded in MAIN). */
    get: (): Promise<HotkeyConfig | null> => ipcRenderer.invoke('hotkey:get'),
    /** Persist + re-register. `failed` lists accelerators that couldn't bind (already in use). */
    set: (cfg: HotkeyConfig): Promise<{ ok: boolean; failed: string[] }> =>
      ipcRenderer.invoke('hotkey:set', cfg),
    /** Accelerators from the last registration (incl. the pre-window startup one) that couldn't
     *  bind. Pulled on mount to surface a cold-start conflict the push path can't reach. */
    failures: (): Promise<string[]> => ipcRenderer.invoke('hotkey:failures')
  },
  // ── Desktop-notification preferences (Settings › Notifications) ──
  notifications: {
    /** Read the persisted prefs. Null only from a foreign frame (guarded in MAIN). */
    get: (): Promise<NotificationsConfig | null> => ipcRenderer.invoke('notifications:get'),
    /** Persist the prefs (sanitized in MAIN). The delivery gate reads them fresh per event. */
    set: (cfg: NotificationsConfig): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('notifications:set', cfg)
  },
  // ── Phase 3 / W4 assets — write pasted/dropped bytes, read them back as bytes ──
  asset: {
    write: (
      bytes: Uint8Array,
      ext: string
    ): Promise<{ assetId: string } | { error: string; code?: string }> =>
      ipcRenderer.invoke('asset:write', { bytes, ext }),
    read: (assetId: string): Promise<Uint8Array | null> => ipcRenderer.invoke('asset:read', assetId)
  },
  // ── File-tree epic (S1) — root-confined fs (every channel guarded + contained in MAIN) ──
  // The renderer only ever sends a RELATIVE path; MAIN re-resolves it against the realpath'd
  // project root and re-validates (no fs/Node ever reaches the sandboxed renderer).
  file: {
    readText: (path: string): Promise<string> => ipcRenderer.invoke('file:readText', path),
    // S3 (additive): raw bytes for the File-board image preview — `readText` is UTF-8
    // only (lossy on binary). MAIN re-resolves + guards identically; the renderer
    // size-gates via `stat` first and wraps the result in a Blob URL (CSP `img-src`
    // already allows `blob:`).
    readBytes: (path: string): Promise<Uint8Array> => ipcRenderer.invoke('file:readBytes', path),
    // S3 (additive): the resolved absolute on-disk path ("Copy absolute path").
    realPath: (path: string): Promise<string> => ipcRenderer.invoke('file:realPath', path),
    // S3 (additive): a GitHub blob permalink @ HEAD ("Copy GitHub link"); MAIN runs simple-git.
    gitPermalink: (
      path: string
    ): Promise<{ ok: true; url: string } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('file:gitPermalink', path),
    writeText: (path: string, text: string, expectedMtimeMs?: number): Promise<WriteTextResult> =>
      ipcRenderer.invoke('file:writeText', { path, text, expectedMtimeMs }),
    listDir: (path: string): Promise<FileEntry[]> => ipcRenderer.invoke('file:listDir', path),
    stat: (path: string): Promise<FileStat> => ipcRenderer.invoke('file:stat', path),
    /**
     * Subscribe to live tree changes (S2 emits them on `file:treeEvent`). Returns an
     * unsubscribe fn; the listener gets ONLY the event payload (never the IpcRendererEvent),
     * matching onPreviewEvent. No emitter exists yet in S1 — the channel is the contract.
     */
    onTreeEvent: (cb: (ev: FileTreeEvent) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, ev: FileTreeEvent): void => cb(ev)
      ipcRenderer.on('file:treeEvent', h)
      return () => ipcRenderer.removeListener('file:treeEvent', h)
    }
  },
  // ── S4 — render Mermaid source → SVG in the hidden MAIN worker (Planning Diagram element) ──
  diagram: {
    render: (req: {
      source: string
      themeVars?: Record<string, string>
      id: string
    }): Promise<{ ok: true; svg: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('diagram:render', req)
  },
  // ── Project Library — browse files saved under <project>/.canvas/{downloads,assets} (MAIN-confined) ──
  library: {
    list: (): Promise<LibraryListing | null> => ipcRenderer.invoke('project:listLibrary'),
    reveal: (relPath: string): Promise<boolean> =>
      ipcRenderer.invoke('project:revealLibraryItem', relPath),
    open: (relPath: string): Promise<boolean> =>
      ipcRenderer.invoke('project:openLibraryItem', relPath)
  },
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder')
  },
  export: {
    save: (args: {
      bytes: Uint8Array
      ext: 'png' | 'svg'
      defaultName: string
    }): Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string; code?: string }
    > => ipcRenderer.invoke('export:save', args)
  },
  // ── Phase 5 · S1: save the live terminal buffer to a user-chosen .txt (MAIN dialog + atomic write) ──
  // ── Phase 5 · S1 save-output + S3 snapshot persist/restore (factored to terminalApi.ts) ──
  terminal: terminalApi,
  // ── M-memory T-M4: read cached Tier-2 prose for the panel (pure disk read; MAIN-guarded) ──
  memory: {
    readBoards: (ids: string[]): Promise<Record<string, string>> =>
      ipcRenderer.invoke('memory:readBoards', ids),
    // T-F4: force a re-summary of one board (bypasses the debounce; still budget/key-gated +
    // passive in MAIN). {ok:false} when no project is open / over cap. Renderer re-reads prose after.
    // Recap-refresh fix: `outcome` reports what the summarize actually did (recap regenerated /
    // skipped + why / LLM unavailable / coalesced onto an in-flight run) so the recap face can
    // surface the reason instead of silently showing the unchanged sidecar.
    refresh: (boardId: string): Promise<{ ok: boolean; outcome?: RecapRefreshOutcome }> =>
      ipcRenderer.invoke('memory:refresh', boardId)
  },
  // ── M-brain T-B1/T-B2: provider-agnostic LLM (MAIN owns the key/egress) ──
  llm: {
    summarize: (input: { system?: string; text: string }): Promise<LlmSummarizeResult> =>
      ipcRenderer.invoke('llm:summarize', input),
    status: (): Promise<LlmStatus> => ipcRenderer.invoke('llm:status'),
    setKey: (args: { provider: LlmStatus['provider']; key: string }): Promise<LlmWriteResult> =>
      ipcRenderer.invoke('llm:setKey', args),
    clearKey: (args: { provider: LlmStatus['provider'] }): Promise<LlmWriteResult> =>
      ipcRenderer.invoke('llm:clearKey', args),
    setConfig: (args: {
      provider: LlmStatus['provider']
      model: string
      baseUrl?: string
      maxCallsPerDay?: number
    }): Promise<LlmWriteResult> => ipcRenderer.invoke('llm:setConfig', args)
  },

  // ── Terminal-recap T12: consent + learned/updated pushes (factored to recapApi.ts) ──
  recap: recapApi,

  // ── Desktop notifications: MAIN → renderer lifecycle pushes (factored to notifyApi.ts) ──
  notify: notifyApi,

  // ── Agent Orchestration Onboarding P1: per-project orchestration consent ──
  // The one-time "Enable agent orchestration?" grant (the mock's Step 1). Separate from recap
  // consent (separate userData store). getConsent drives the once-per-project first-init prompt
  // + the Settings toggle; setConsent persists the grant/revoke and (in MAIN) fires the P3
  // provisioner sync/unsync.
  orchestration: {
    getConsent: (): Promise<OrchestrationConsentState> =>
      ipcRenderer.invoke('orchestration:getConsent'),
    setConsent: (decision: 'enabled' | 'declined'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('orchestration:setConsent', decision),
    // The Sync modal's data plane (P3 provisioners, wired by the onboarding lane). Status is
    // null while MAIN probes / when no server is mounted; sync resolves a per-CLI result.
    getProvisionStatus: (): Promise<OrchestrationProvisionStatus | null> =>
      ipcRenderer.invoke('orchestration:getProvisionStatus'),
    sync: (ids: OrchestrationCliId[]): Promise<OrchestrationSyncResult[]> =>
      ipcRenderer.invoke('orchestration:syncProvisioners', ids),
    // App-wide MCP spawn concurrency cap (runaway-swarm guard). getSpawnCap returns the effective
    // cap (default 4); setSpawnCap persists an in-range integer [1,16] and returns a typed result.
    getSpawnCap: (): Promise<number> => ipcRenderer.invoke('orchestration:getSpawnCap'),
    setSpawnCap: (cap: number): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('orchestration:setSpawnCap', cap)
  },

  // ── External MCP servers: register the user's OWN MCP servers, written into each selected agent
  //    CLI's config so terminal agents can use them (factored to mcpServersApi.ts). ──
  mcpServers: mcpServersApi,

  // ── Phase 5 auto-update (electron-updater; main owns the feed/download) ──
  update: {
    /**
     * Subscribe to update lifecycle status (checking → available → downloading →
     * ready / error), pushed by main. Returns an unsubscribe fn. The listener gets
     * ONLY the status payload (never the IpcRendererEvent). No events ever arrive in
     * an unsigned/dev build — the gate in main never wires the updater.
     */
    onStatus: (listener: (status: UpdateStatus) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, status: UpdateStatus): void => listener(status)
      ipcRenderer.on('update:status', handler)
      return () => ipcRenderer.removeListener('update:status', handler)
    },
    /** Manually re-check the feed (the Settings "Check for updates" button). Reports
     *  availability via onStatus; never starts a download (autoDownload is off in main). */
    check: (): Promise<boolean> => ipcRenderer.invoke('update:check'),
    /** Start downloading the available update (the Settings "Download update" button /
     *  toast action). Progress + completion arrive via onStatus. */
    download: (): Promise<boolean> => ipcRenderer.invoke('update:download'),
    /** Install the downloaded update + relaunch — fired from the "ready" state. */
    install: (): Promise<boolean> => ipcRenderer.invoke('update:install')
  },

  // ── Phase 1 accounts (auth/identity; presence-only — a token NEVER crosses this boundary). The
  //    namespace lives in ./authApi to keep this file under the max-lines ratchet. ──
  auth: authApi,

  // ── MCP board mirror + confirm gates + orchestrator drive (factored to mcpApi.ts) ──
  mcp: mcpApi,

  // ── Voice dictation V1 (control plane; audio frames flow over a MessagePort) ──
  voice: voiceApi
}

// Data-plane MessagePort re-posts into the main world (ports can't cross the contextBridge):
// the per-board PTY port (terminalApi.forwardPtyPort) and the voice capture + TTS chunk
// ports (voice.ts).
forwardPtyPort()
forwardVoicePort()
forwardVoiceTtsPort()

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // Fallback when contextIsolation is somehow off (should never happen).
  ;(window as unknown as Record<string, unknown>).api = api
}

/** Mirrors main `hotkeyConfig.HotkeyConfig` (duplicated across the bundle boundary, like
 *  projectSessionsApi's interfaces). Electron Accelerator strings for the two switch chords. */
export interface HotkeyConfig {
  enabled: boolean
  next: string
  prev: string
}

/** Mirrors main `notificationsConfig.NotificationsConfig` (duplicated across the bundle boundary).
 *  Master switch + per-event toggles + the OS-only "only when unfocused" suppression. */
export interface NotificationsConfig {
  enabled: boolean
  onDone: boolean
  onInput: boolean
  onError: boolean
  onlyWhenUnfocused: boolean
}

export type CanvasApi = typeof api
