/**
 * Env-gated MAIN test registry for the Playwright _electron harness (T4). Installed
 * ONLY when CANVAS_E2E is set; exposes the preview/pty internals the renderer hook
 * cannot see, plus the project/clipboard/input helpers the whiteboard slivers need.
 * Playwright reaches these via electronApp.evaluate(() => globalThis.__canvasE2EMain.*).
 *
 * This is a registry + an env flag — NOT a security change. sandbox / contextIsolation /
 * nodeIntegration are untouched; nothing here is reachable in a normal run.
 */
import { app, clipboard, ipcMain, Menu, nativeImage, type BrowserWindow } from 'electron'
import { execFileSync } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  debugCaptureView,
  debugCaptureViewPng,
  debugCrashView,
  debugFocusView,
  debugSendInputToView,
  debugViewBounds,
  debugViewIds,
  debugViewWebContentsId
} from './preview'
import { debugSeedOutput, debugTerminalPid, debugWriteTerminal, disposeAllPtys } from './pty'
import { createProject, getCurrentDir, setCurrentDir } from './projectStore'
import { createCanvasMemory } from './canvasMemory'
import { recordBoardResult } from './boardResults'
import { __setMemoryDirForTest } from './boardMemory'
import { listConnectors } from './boardRegistry'
import { sendMcpCommand, type McpCommandAck } from './mcpCommand'
import type { BoardResult } from '@expanse-ade/mcp'
import type { RunningMcp } from './mcp'
import type { AppModel } from './appModel'

/** The fixed board id the e2e/mcp.e2e.ts worker token binds to, so the write_result
 *  probe can read its own structured result back via canvas://board/{id}/result. */
const MCP_E2E_WORKER_BOARD = 'mcp-e2e-worker'

export interface E2EMain {
  terminalPid(id: string): number | null
  writeTerminal(id: string, data: string): boolean
  captureView(id: string): Promise<{ attached: boolean; empty: boolean }>
  /**
   * Capture a board's live native-view pixels and write them as a PNG to `absPath`.
   * Returns true if a non-blank image was written, false otherwise (missing/detached/
   * off-screen/un-composited). This is the only evidence path for browser-board content
   * — a WebContentsView paints above all HTML, so Playwright screenshots can't see it.
   */
  captureViewToFile(id: string, absPath: string): Promise<boolean>
  viewIds(): string[]
  viewWebContentsId(id: string): number | null
  /** Forcefully crash a board's preview renderer (D2-C crashed-state probe). */
  crashView(id: string): boolean
  /** The native view's live bounds + attached flag, for the alignment probe (native vs .bb-frame). */
  viewBounds(
    id: string
  ): { attached: boolean; bounds: { x: number; y: number; width: number; height: number } } | null
  /** Real OS input through the live window (mouse/keyboard) — preserves transform hit-testing. */
  sendInput(evt: Parameters<BrowserWindow['webContents']['sendInputEvent']>[0]): void
  /** D4-B/A3: give a board's native preview view OS keyboard focus (= clicking into it). */
  focusView(id: string): boolean
  /** D4-B/A3: real input through a board's native VIEW (Esc runs the focus-return path). */
  sendInputToView(
    id: string,
    evt: Parameters<BrowserWindow['webContents']['sendInputEvent']>[0]
  ): boolean
  /** True when the HOST window's webContents is the focused one (A3 focus-return assert). */
  hostFocused(): boolean
  /** Mint a temp project dir + set it current (e2e has no project dir). Returns the path. */
  createTempProject(prefix: string, name: string): Promise<string>
  /** Clear the current dir + delete the temp project (best-effort). */
  teardownProject(tmp: string): void
  /**
   * Write a bare file (e.g. a deliberately corrupt `canvas.json` or a good
   * `canvas.json.bak`) into a temp project dir — the corrupt-doc recovery probe seeds
   * the on-disk state the real `project:open` → `applyOpenResult` → `reopenFromBak`
   * cascade then reads back. `name` must be a bare filename (no separator / `..`).
   */
  writeProjectFile(tmp: string, name: string, contents: string): void
  /** Put a w×h opaque-red RGBA bitmap on the system clipboard (for the paste sliver). */
  putRedBitmapOnClipboard(w: number, h: number): void
  /** True if an absolute path exists on disk (assert a pasted blob landed). */
  fileExists(absPath: string): boolean
  /** Join a temp-project path with a relative asset path (cross-platform). */
  joinPath(...parts: string[]): string
  /** The in-process local preview server URL — a deterministic page the browser probe seeds. */
  localUrl(): string
  /**
   * Of the given pids, which are still alive (present in the OS process table).
   * The process-tree probe captures a child's EXACT pid (printed by the child) then
   * asserts it is gone after the kill — robust against walking the fragile full OS
   * pid→ppid graph (Windows reuses pids and roots many processes at System/Idle).
   */
  pidsAlive(pids: number[]): number[]
  /** Tear down EVERY pty session (live + parked) — the real MAIN kill path. */
  disposeAllPtys(): Promise<void>
  /** Put plain text on the system clipboard (paste-text sliver). */
  putTextOnClipboard(text: string): void
  /** Read the system clipboard text (assert a copy landed). */
  readClipboardText(): string
  /** True when no application menu is set (F10: Alt+V reaches xterm on Windows/Linux). */
  applicationMenuIsNull(): boolean
  /**
   * Terminal-recap T16: persist a canned `board-<id>.md` into the CURRENT project's
   * `.canvas/memory/` so the renderer's `window.api.memory.readBoards([id])` (RecapView's
   * loader) returns it on flip. e2e never opens a project (App boots dir:null), so if no
   * dir is current this mints + sets a throwaway temp project first (mirrors
   * createTempProject). Returns false if the write was rejected (e.g. unsafe board id).
   */
  writeRecapMd(boardId: string, md: string): Promise<boolean>
  /**
   * MCP tier-smoke port (e2e/mcp.e2e.ts) — the loopback MCP server's port + the two
   * tier tokens, so the test process can connect its own orchestrator + worker clients
   * over 127.0.0.1 (the client moved out of MAIN into the Playwright runner). The worker
   * token is bound to a FIXED board id (`workerBoardId`) so the write_result probe can
   * read its own structured result back. Returns null when the server never mounted.
   */
  mcpInfo(): {
    port: number
    orchestratorToken: string
    workerToken: string
    workerBoardId: string
  } | null
  /**
   * PR-2 live invoke: the read-only working-tree diff for a board, via the orchestrator path
   * (terminal-type check + 100 KB clamp → registry.gitDiff → boardGitDiff → simple-git). Lets a
   * driver seed a terminal in a git repo and SEE a real diff, since the package exposes no
   * `git_diff` MCP tool yet. Resolves '' when the server never mounted.
   */
  gitDiff(boardId: string): Promise<string>
  /**
   * PR-3 live invoke: the read-only app self-model (board types · tool catalog · live canvas ·
   * rules), via the orchestrator. Lets the e2e assert the live model shape before any UI consumes
   * it. Resolves null when the MCP server never mounted.
   */
  describeApp(): Promise<AppModel | null>
  /** Seed a board's live PTY output ring with known ANSI content (output-pagination probe). */
  mcpSeedOutput(id: string, text: string): boolean
  /** Record a board's structured result (drives the empty→filled `canvas://board/{id}/result` probe). */
  mcpRecordResult(id: string, result: BoardResult): void
  /** Round-trip a MAIN→renderer `ping` command — the inverse-of-the-mirror command-channel probe. */
  mcpPingCommand(): Promise<McpCommandAck>
  /** The orchestration connector mirror (the relay-cable probe asserts A→B landed in MAIN). */
  mcpListConnectors(): Array<{ sourceId: string; targetId: string; kind: string }>
  /**
   * Memory probe (T1.7): point the Brain/Memory engine at a fresh EMPTY temp dir and
   * return its root — `canvas://memory` must then read the graceful-empty shell. Always
   * pair with `mcpMemoryEnd` to revert the global dir override + delete the temp root.
   */
  mcpMemoryBegin(): string | null
  /** Memory probe: write the `MEMORY.md` + `board-memprobe.md` fixtures under the begun root. */
  mcpMemoryServe(root: string): void
  /** Memory probe: revert the dir override + delete the temp root (call in a finally). */
  mcpMemoryEnd(root: string): void
  /**
   * Recap redesign S1: persist a canned `board-<id>.recap.json` narrative sidecar into the
   * current project's `.canvas/memory/` (the rebuilt RecapView's narrative source). Same
   * temp-project self-minting as writeRecapMd.
   */
  writeRecapJson(boardId: string, narrative: unknown): Promise<boolean>
  /**
   * Recap redesign S1: seed a fixture transcript JSONL under a throwaway CLAUDE_CONFIG_DIR
   * (process.env is set so isTrustedTranscriptPath accepts it) and return its absolute
   * path - the test then seeds a board with `agentTranscriptPath` pointing at it, proving
   * the zero-LLM Layer-0 facts path end-to-end.
   */
  seedRecapTranscript(jsonl: string): string
  /**
   * Recap redesign S1 (N1): restore process.env.CLAUDE_CONFIG_DIR to its pre-seed value. Call
   * in the finally of any spec that used seedRecapTranscript so the mutation cannot leak into a
   * later e2e file (which would otherwise validate real transcripts against the throwaway root).
   */
  restoreClaudeConfigDir(): void
  /**
   * Recap redesign S1: register a board->transcript mapping through the PRODUCTION learned
   * path - append a session line to the real userData session-map.jsonl exactly as the
   * external recordSession.js hook does; watchRecapMap then flows it into the live in-memory
   * map that recap:get's getTranscriptPath falls back to. (In e2e the renderer has no open
   * project, so the board-doc field never reaches disk - the map IS the path that works.)
   */
  recordRecapSession(boardId: string, transcriptPath: string): void
}

/**
 * T16: write a canned recap md for `boardId` into the current project's `.canvas/memory/`,
 * via the canonical writer (`createCanvasMemory(dir).writeBoard`). e2e never opens a project
 * (App boots dir:null → MAIN's getCurrentDir() is null → memory:readBoards returns {}), so
 * mint + set a throwaway temp project dir first if none is current (mirrors createTempProject).
 */
async function writeRecapMdToCurrentProject(boardId: string, md: string): Promise<boolean> {
  let dir = getCurrentDir()
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'canvas-e2e-recap-'))
    await createProject(dir, 'recap-e2e', {})
    setCurrentDir(dir)
  }
  return createCanvasMemory(dir).writeBoard(boardId, md)
}

// Recap redesign S1 (N1): seedRecapTranscript mutates process.env.CLAUDE_CONFIG_DIR so MAIN's
// trust check (isTrustedTranscriptPath / resolveLiveTranscriptPath both default to process.env)
// accepts the throwaway fixture root DURING the facts test. We capture the prior value here and
// restore it via restoreClaudeConfigDir() in the spec's finally, so the mutation can never leak
// into a later e2e file. It can NOT be restored synchronously/on a microtask: recap:get reads the
// env in a LATER macrotask, so an early restore would untrust the fixture before the assertions.
// The wrapper object distinguishes "never saved" from "saved as undefined".
let savedClaudeConfigDir: { value: string | undefined } | undefined

/**
 * Every live pid on the OS — Windows via PowerShell CIM, POSIX via `ps`. Used by
 * the env-gated pidsAlive to test whether specific captured pids still exist.
 */
function liveOsPids(): Set<number> {
  let out = ''
  try {
    if (process.platform === 'win32') {
      out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId }'
        ],
        { encoding: 'utf8' }
      )
    } else {
      out = execFileSync('ps', ['-eo', 'pid='], { encoding: 'utf8' })
    }
  } catch {
    return new Set()
  }
  return new Set(
    out
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  )
}

declare global {
  var __canvasE2EMain: E2EMain | undefined
}

/** Install the registry. No-op unless CANVAS_E2E is set. Call once after the window exists. */
export function installE2EMain(win: BrowserWindow, localUrl: string, mcp: RunningMcp | null): void {
  if (!process.env.CANVAS_E2E) return
  globalThis.__canvasE2EMain = {
    terminalPid: debugTerminalPid,
    writeTerminal: debugWriteTerminal,
    captureView: debugCaptureView,
    async captureViewToFile(id, absPath) {
      const png = await debugCaptureViewPng(id)
      if (!png) return false
      writeFileSync(absPath, png)
      return true
    },
    viewIds: debugViewIds,
    viewWebContentsId: debugViewWebContentsId,
    crashView: debugCrashView,
    viewBounds: debugViewBounds,
    sendInput(evt) {
      win.webContents.sendInputEvent(evt)
    },
    focusView: debugFocusView,
    sendInputToView: debugSendInputToView,
    hostFocused() {
      return win.webContents.isFocused()
    },
    async createTempProject(prefix, name) {
      const tmp = mkdtempSync(join(tmpdir(), prefix))
      await createProject(tmp, name, {})
      setCurrentDir(tmp)
      return tmp
    },
    teardownProject(tmp) {
      setCurrentDir(null)
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    },
    writeProjectFile(tmp, name, contents) {
      // Bare filename only — never let a probe escape the temp dir via a separator or `..`.
      if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        throw new Error(`writeProjectFile: unsafe name ${name}`)
      }
      writeFileSync(join(tmp, name), contents, 'utf8')
    },
    putRedBitmapOnClipboard(w, h) {
      const buf = Buffer.alloc(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = 255 // R
        buf[i * 4 + 3] = 255 // A (G/B stay 0 → opaque red)
      }
      clipboard.clear()
      clipboard.writeImage(nativeImage.createFromBitmap(buf, { width: w, height: h }))
    },
    putTextOnClipboard(text) {
      clipboard.writeText(text)
    },
    readClipboardText() {
      return clipboard.readText()
    },
    fileExists(absPath) {
      return existsSync(absPath)
    },
    joinPath(...parts) {
      return join(...parts)
    },
    localUrl() {
      return localUrl
    },
    pidsAlive(pids) {
      const live = liveOsPids()
      return pids.filter((p) => live.has(p))
    },
    disposeAllPtys() {
      return disposeAllPtys()
    },
    applicationMenuIsNull() {
      return Menu.getApplicationMenu() === null
    },
    writeRecapMd(boardId, md) {
      return writeRecapMdToCurrentProject(boardId, md)
    },
    mcpInfo() {
      if (!mcp) return null
      return {
        port: mcp.port,
        orchestratorToken: mcp.orchestratorToken,
        workerToken: mcp.mintWorkerToken(MCP_E2E_WORKER_BOARD),
        workerBoardId: MCP_E2E_WORKER_BOARD
      }
    },
    gitDiff(boardId) {
      return mcp?.gitDiff(boardId) ?? Promise.resolve('')
    },
    describeApp() {
      return mcp?.describeApp() ?? Promise.resolve(null)
    },
    mcpSeedOutput(id, text) {
      return debugSeedOutput(id, text)
    },
    mcpRecordResult(id, result) {
      recordBoardResult(id, result)
    },
    mcpPingCommand() {
      return sendMcpCommand(ipcMain, () => win, { type: 'ping' })
    },
    mcpListConnectors() {
      // Project to plain serializable fields — ConnectorMirror may carry more than the
      // probe asserts, and only {sourceId,targetId,kind} crosses the evaluate bridge.
      return listConnectors().map((c) => ({
        sourceId: c.sourceId,
        targetId: c.targetId,
        kind: c.kind
      }))
    },
    mcpMemoryBegin() {
      const root = mkdtempSync(join(tmpdir(), 'canvas-mem-e2e-'))
      __setMemoryDirForTest(root) // empty dir → canvas://memory reads {present:false}
      return root
    },
    mcpMemoryServe(root) {
      const memDir = join(root, '.canvas', 'memory')
      mkdirSync(memDir, { recursive: true })
      writeFileSync(join(memDir, 'MEMORY.md'), '# e2e memory', 'utf8')
      writeFileSync(join(memDir, 'board-memprobe.md'), 'memprobe summary', 'utf8')
    },
    mcpMemoryEnd(root) {
      __setMemoryDirForTest(null)
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    },
    async writeRecapJson(boardId, narrative) {
      let dir = getCurrentDir()
      if (!dir) {
        dir = mkdtempSync(join(tmpdir(), 'canvas-e2e-recap-'))
        await createProject(dir, 'recap-e2e', {})
        setCurrentDir(dir)
      }
      return createCanvasMemory(dir).writeBoardRecap(boardId, narrative)
    },
    seedRecapTranscript(jsonl) {
      const root = mkdtempSync(join(tmpdir(), 'canvas-e2e-claude-'))
      const dir = join(root, 'projects', 'fixture')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'session.jsonl')
      writeFileSync(path, jsonl, 'utf8')
      if (!savedClaudeConfigDir) savedClaudeConfigDir = { value: process.env.CLAUDE_CONFIG_DIR }
      process.env.CLAUDE_CONFIG_DIR = root
      return path
    },
    restoreClaudeConfigDir() {
      if (!savedClaudeConfigDir) return
      if (savedClaudeConfigDir.value === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir.value
      savedClaudeConfigDir = undefined
    },
    recordRecapSession(boardId, transcriptPath) {
      const mapPath = join(app.getPath('userData'), 'recap', 'session-map.jsonl')
      mkdirSync(dirname(mapPath), { recursive: true })
      // Same append-only line shape recordSession.js writes; last-write-wins per boardId.
      appendFileSync(
        mapPath,
        JSON.stringify({
          boardId,
          sessionId: 'e2e-session',
          transcriptPath,
          cwd: '',
          source: 'e2e',
          ts: Date.now()
        }) + '\n'
      )
    }
  }
}
