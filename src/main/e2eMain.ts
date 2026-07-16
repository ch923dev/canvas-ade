/**
 * MAIN test registry for the Playwright _electron harness (T4). Installed ONLY when the
 * compile-time __ENABLE_E2E_MAIN__ gate is baked true (dev/e2e builds — see the `define`
 * in electron.vite.config.ts) AND the CANVAS_E2E runtime env var is set (BUG-027: the
 * compile gate keeps a real packaged build from shipping this surface at all, so setting
 * CANVAS_E2E at launch can't unlock it there). Exposes the preview/pty internals the
 * renderer hook cannot see, plus the project/clipboard/input helpers the whiteboard
 * slivers need. Playwright reaches these via
 * electronApp.evaluate(() => globalThis.__canvasE2EMain.*).
 *
 * This is a registry + a two-layer flag — NOT a security change. sandbox / contextIsolation /
 * nodeIntegration are untouched; nothing here is reachable in a normal run.
 */
import { app, clipboard, ipcMain, Menu, nativeImage, type BrowserWindow } from 'electron'
import { execFileSync } from 'child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { captureOsrPng, debugCrashOsr, debugReplayOsrReadyInvalidations } from './previewOsrCapture'
import { getOsrWindow } from './previewOsr'
import {
  debugSeedOutput,
  debugSessionCounts,
  debugTerminalPid,
  debugWriteTerminal,
  disposeAllPtys
} from './pty'
import { setVoiceStubEnabled, stubKwsWake } from './voiceEngineStub'
import { isTrayResident, reopenFromTray } from './trayResidency'
import { createLifecycleDeliver, type LifecycleBoard } from './lifecycleNotifications'
import { DEFAULT_NOTIFICATIONS, type NotificationsConfig } from './notificationsConfig'
import type { LifecycleEvent } from './agentLifecycle'
import { createProject, getCurrentDir, setCurrentDir } from './projectStore'
import { createCanvasMemory } from './canvasMemory'
import { readBoardResult, recordBoardResult } from './boardResults'
import { __setMemoryDirForTest } from './boardMemory'
import { listConnectors } from './boardRegistry'
import { sendMcpCommand, type McpCommandAck } from './mcpCommand'
import type { BoardResult } from '@expanse-ade/mcp'
import type { RunningMcp } from './mcp'
import type { AppModel } from './appModel'
import type { SpawnGroupResult } from './mcpLifecycle'
import type { ResultSynthesizer } from './boardResultSynth'

/** The fixed board id the e2e/mcp.e2e.ts worker token binds to, so the write_result
 *  probe can read its own structured result back via canvas://board/{id}/result. */
const MCP_E2E_WORKER_BOARD = 'mcp-e2e-worker'

export interface E2EMain {
  terminalPid(id: string): number | null
  writeTerminal(id: string, data: string): boolean
  /** PR-2 close modal e2e: is MAIN tray-resident (window closed, sessions kept)? */
  trayResident(): boolean
  /** PR-2: drive the tray's "Open Expanse" (Playwright can't click the OS tray) — tears the
   *  tray down, re-warms the survivor list, recreates the window (the adopt-first reattach). */
  trayReopen(): Promise<void>
  /**
   * Capture a board's offscreen window's last painted frame as a PNG and write it to
   * `absPath`. Returns false if no OSR window / blank. This is the only evidence path for
   * browser-board content (the offscreen bitmap never reaches a Playwright screenshot), and
   * exercises the same `capturePage()` path the user-facing OSR screenshot uses — so a green
   * run on both legs is evidence the screenshot feature captures non-blank on each OS.
   */
  captureOsrToFile(id: string, absPath: string): Promise<boolean>
  /** SIGKILL a board's offscreen preview renderer (D2-C crashed-state probe). */
  crashOsr(id: string): boolean
  /**
   * The LIVE offscreen paint state for a board (`webContents.isPainting()`), or null when no OSR
   * window is open. The full-view-liveness probe asserts this is `true` after maximizing a board
   * that was paint-gated off-screen/below-LOD — a paused window drops invalidates, so painting:true
   * is the mechanism the modal-blank fix restores.
   */
  osrPainting(id: string): boolean | null
  /**
   * Verify the first-ready repaint CONTRACT (PR #210 idle-blank guard): re-fire `did-finish-load`
   * over an idle, already-loaded board so the PRODUCTION onReady (registerCrashReadyGate) re-runs,
   * spying on `wc.invalidate`. Returns how many times onReady called invalidate() — ≥1 with the fix
   * (startPainting + invalidate), 0 without (the regression), -1 if no OSR window. A contract spy
   * rather than a pixel assertion because the live CDP race does not surface under headless OSR (so a
   * "stays blank" pixel check cannot be made RED here), but the code path always can.
   */
  osrReplayReadyInvalidations(id: string): number
  /**
   * A board's OSR logical size = physical content size ÷ page zoom factor (S). `logicalW` is the
   * responsive-reflow width (the preset: 390 mobile / 834 tablet / 1280 desktop). The MAX_LIVE
   * revive-sizing regression guard asserts a revived (un-evicted) board keeps its preset logicalW
   * rather than the 1280×800 default its reopened window is born at. Null when no OSR window.
   */
  osrLogicalSize(
    id: string
  ): { physW: number; physH: number; zoom: number; logicalW: number; logicalH: number } | null
  /**
   * Background sessions (Phase 3): run JS inside a board's OFFSCREEN page and return the result
   * (`executeJavaScript` on the OSR webContents; null when no window is open / the eval threw).
   * The no-reload keep-alive probe plants a window-global before a project switch and reads it
   * back after — same value ⇒ same JS context ⇒ the kept page never reloaded. E2E ONLY, gated by
   * __ENABLE_E2E_MAIN__ + CANVAS_E2E like the rest of this registry (mirrors osrPainting).
   */
  osrEval(id: string, code: string): Promise<unknown>
  /** Real OS input through the live window (mouse/keyboard) — preserves transform hit-testing. */
  sendInput(evt: Parameters<BrowserWindow['webContents']['sendInputEvent']>[0]): void
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
  /**
   * Read a UTF-8 file's contents, or null if absent. The orchestration-onboarding e2e asserts the
   * SHAPE of a provisioner-written `.mcp.json` (loopback url + Bearer header) off this.
   * 🔒 The caller asserts the Authorization header shape only (`/^Bearer .+/`) — never the token.
   */
  readTextFile(absPath: string): string | null
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
  /** Background sessions: live/parked session totals (the rapid-switch zero-orphan probe). */
  ptySessionCounts(): { live: number; parked: number }
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
  /**
   * PR-5b live invoke: spawn a feature-zone cluster (terminal + optional planning/browser + a
   * Named Group + browser→terminal preview wiring) through the orchestrator's `spawnGroup` —
   * the same cap-checked write path the agent-facing `spawn_group` tool (PR-5c) will use. Lets
   * the e2e drive the REAL command path (MAIN mints ids → sendCommand → renderer cluster +
   * group) and assert the zone landed. Resolves null when the MCP server never mounted.
   */
  spawnGroupNow(input: {
    name: string
    planning?: boolean
    browser?: boolean
  }): Promise<SpawnGroupResult | null>
  /**
   * rc.6 auto-cable probe: spawn ONE board through the orchestrator's `spawnBoard` — the same
   * cap-checked write path the agent-facing `spawn_board` tool uses — including the optional
   * `sourceBoardId` (a connected caller's token-derived board id), so the e2e can prove the
   * spawner→spawned orchestration cable lands WITHOUT waiting for the ≥rc.6 package pin (whose
   * tool supplies ctx.boardId over the wire). Resolves null when the MCP server never mounted.
   */
  spawnBoardNow(input: {
    type: string
    prompt?: string
    cwd?: string
    title?: string
    sourceBoardId?: string
  }): Promise<{ id: string } | null>
  /** Seed a board's live PTY output ring with known ANSI content (output-pagination probe). */
  mcpSeedOutput(id: string, text: string): boolean
  /** Record a board's structured result (drives the empty→filled `canvas://board/{id}/result` probe). */
  mcpRecordResult(id: string, result: BoardResult): void
  /**
   * PR-4: synchronously drive the result synthesizer's settle path for a board — the same
   * `resultSynth.onSettle` the recap-mtime watcher fires, but WITHOUT its 25s debounce — so the
   * e2e proves the REAL wiring (learned transcript → `computeRecapFacts` → synthesized
   * `BoardResult`) deterministically. No-op if the synthesizer never came up.
   */
  synthesizeResultNow(boardId: string): void
  /** PR-4: read a board's recorded result back (the synthesize / non-clobber probe asserts off this). */
  boardResultFor(id: string): BoardResult
  /** Round-trip a MAIN→renderer `ping` command — the inverse-of-the-mirror command-channel probe. */
  mcpPingCommand(): Promise<McpCommandAck>
  /** The orchestration connector mirror (the relay-cable probe asserts A→B landed in MAIN). */
  mcpListConnectors(): Array<{ sourceId: string; targetId: string; kind: string }>
  /**
   * Agent Orchestration P4: mint a `connected`-tier MCP token bound to `boardId` (the same token
   * the spawn-time provisioner mints for a consented terminal), so the e2e can connect a real
   * connected client over loopback and prove cable-authorized relay end-to-end. Returns
   * `{ token, port }` (the tier is always `connected`), or null when the MCP server never mounted.
   * 🔒 The token is returned ONLY to the in-process e2e seam; it is NEVER logged.
   */
  mcpMintConnectedToken(boardId: string): { token: string; port: number } | null
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
  /**
   * Recap-refresh fix: toggle the CANVAS_LLM_MOCK env flag at runtime so a spec can drive the
   * summary loop's recap branch end-to-end (mock provider, zero egress) and then restore the
   * key-less default in its finally. The loop reads the LIVE process.env object per call, so
   * a runtime mutation takes effect on the next summarize.
   */
  setLlmMock(on: boolean): void
  /**
   * F4 (terminal-resume): run the SAME re-ensure MAIN's browser-window-focus handler runs (the
   * hook-health self-heal), so a spec can drive the heal without synthesizing a real OS focus
   * event (flaky territory — the renderer's synthetic window `focus` never reaches MAIN).
   */
  recapReEnsure(): void
  /**
   * Voice V3: toggle the canned stub engine behind voiceIpc's engine seam (voiceEngineStub.ts)
   * so the voiceComposer spec gets deterministic partial/final without a model or mic, while
   * voice.e2e.ts keeps exercising the REAL utilityProcess host (workers:1 shares one app across
   * spec files — a launch-env gate could not be per-spec). Always flip back off in the spec.
   * J4: an optional custom SCRIPT replaces the canned dictation line (the jarvis tool e2e
   * speaks "add a card …"); passing one while the stub is live swaps the engine in place.
   */
  voiceStubSet(
    on: boolean,
    script?: Array<{ atFrame: number; t: 'partial' | 'final'; text: string }>
  ): void
  /** J5: fire a deterministic wake detection through the live stub's kws port (false =
   *  no stub / no armed wake session — the spec must arm first). */
  voiceStubWake(keyword?: string): boolean
  /**
   * Desktop-notifications P5: drive a normalized lifecycle signal through the REAL MAIN delivery
   * pipeline (`createLifecycleDeliver` — the SAME gate + `notify:lifecycle` IPC push production
   * uses), routed to a self-contained e2e instance whose config / board-facts / focus are
   * test-controlled and whose OS-notification layer is a recording SPY (never a real Notification).
   * The renderer then surfaces the toast + on-canvas attention exactly as in production.
   */
  notifyDeliver(boardId: string, event: LifecycleEvent): void
  /** P5: patch the e2e notify prefs the gate reads (master + per-event + onlyWhenUnfocused). */
  notifyConfigure(patch: Partial<NotificationsConfig>): void
  /** P5: set a board's facts the gate + copy read (monitorActivity opt-out / title / agentKind). */
  notifySetBoard(boardId: string, facts: LifecycleBoard): void
  /** P5: force the window-focused input to the gate (true/false), or null to read the real window. */
  notifySetFocused(focused: boolean | null): void
  /** P5: the OS-notification SPY's recorded calls — asserts whether the OS layer fired/was skipped. */
  notifyOsCalls(): Array<{ title: string; body: string }>
  /** P5: reset the e2e notify seam (config→defaults, clear board facts + OS-spy, focus→real). */
  notifyReset(): void
}

/**
 * Desktop-notifications P5 e2e seam. A self-contained instance of the REAL delivery pipeline
 * (`createLifecycleDeliver`) with fully injected, test-controlled deps: an in-memory config +
 * board-facts map + forced-focus override, and an OS-notify SPY that records calls instead of
 * raising a real `Notification`. Lets the e2e drive a lifecycle event INTO MAIN's `deliver` and
 * assert the toast + on-canvas attention it pushes to the renderer AND whether the OS layer was
 * raised — deterministically, with no real OS notification and no 60s idle wait.
 */
interface NotifyProbe {
  deliver: (boardId: string, event: LifecycleEvent) => void
  configure: (patch: Partial<NotificationsConfig>) => void
  setBoard: (boardId: string, facts: LifecycleBoard) => void
  setFocused: (focused: boolean | null) => void
  osCalls: () => Array<{ title: string; body: string }>
  reset: () => void
}

function createNotifyProbe(win: BrowserWindow): NotifyProbe {
  const state = {
    config: { ...DEFAULT_NOTIFICATIONS } as NotificationsConfig,
    boards: new Map<string, LifecycleBoard>(),
    forcedFocus: null as boolean | null,
    osCalls: [] as Array<{ title: string; body: string }>
  }
  // The SAME deliver production runs — only the deps are test-controlled. `raise` records instead
  // of raising a real Notification; `isWindowFocused` honours the forced override when set.
  const deliver = createLifecycleDeliver({
    getWin: () => win,
    getConfig: () => state.config,
    getBoard: (id) => state.boards.get(id),
    raise: (opts) => {
      state.osCalls.push({ title: opts.title, body: opts.body })
    },
    isWindowFocused: (w) => (state.forcedFocus === null ? w.isFocused() : state.forcedFocus)
  })
  return {
    deliver: (boardId, event) => deliver({ boardId, event }),
    configure: (patch) => {
      state.config = { ...state.config, ...patch }
    },
    setBoard: (boardId, facts) => {
      state.boards.set(boardId, facts)
    },
    setFocused: (focused) => {
      state.forcedFocus = focused
    },
    osCalls: () => [...state.osCalls],
    reset: () => {
      state.config = { ...DEFAULT_NOTIFICATIONS }
      state.boards.clear()
      state.forcedFocus = null
      state.osCalls.length = 0
    }
  }
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

// BUG-027: build-time gate (electron.vite.config.ts `define`), mirroring the
// __ENABLE_AUTO_UPDATE__ pattern in src/main/index.ts. Default false for a plain
// packaged/production build, so terser/esbuild dead-code-eliminates the whole registry
// below out of the shipped bundle — the CANVAS_E2E runtime check alone was not enough,
// since nothing stopped a packaged app from having that env var set at launch. True for
// dev + e2e builds (see the define comment). Kept alongside, not instead of, the runtime
// check for defense in depth.
declare const __ENABLE_E2E_MAIN__: boolean

/**
 * Install the registry. No-op unless BOTH the compile-time __ENABLE_E2E_MAIN__ gate is on
 * (dev/e2e builds only) AND the CANVAS_E2E runtime env var is set. Call once after the
 * window exists.
 */
export function installE2EMain(
  win: BrowserWindow,
  localUrl: string,
  mcp: RunningMcp | null,
  getResultSynth: () => ResultSynthesizer | null,
  recapReEnsure: () => void
): void {
  if (!__ENABLE_E2E_MAIN__ || !process.env.CANVAS_E2E) return
  const notifyProbe = createNotifyProbe(win)
  globalThis.__canvasE2EMain = {
    terminalPid: debugTerminalPid,
    writeTerminal: debugWriteTerminal,
    trayResident: isTrayResident,
    trayReopen: reopenFromTray,
    async captureOsrToFile(id, absPath) {
      const png = await captureOsrPng(id)
      if (!png) return false
      writeFileSync(absPath, png)
      return true
    },
    crashOsr: debugCrashOsr,
    osrPainting(id) {
      const wc = getOsrWindow(id)?.webContents
      if (!wc || wc.isDestroyed()) return null
      try {
        return wc.isPainting()
      } catch {
        return null
      }
    },
    osrReplayReadyInvalidations(id) {
      return debugReplayOsrReadyInvalidations(id)
    },
    async osrEval(id, code) {
      const wc = getOsrWindow(id)?.webContents
      if (!wc || wc.isDestroyed()) return null
      try {
        return await wc.executeJavaScript(code)
      } catch {
        return null
      }
    },
    osrLogicalSize(id) {
      const osrWin = getOsrWindow(id)
      if (!osrWin || osrWin.isDestroyed()) return null
      try {
        const [physW, physH] = osrWin.getContentSize()
        const zoom = osrWin.webContents.getZoomFactor() || 1
        return {
          physW,
          physH,
          zoom,
          logicalW: Math.round(physW / zoom),
          logicalH: Math.round(physH / zoom)
        }
      } catch {
        return null
      }
    },
    sendInput(evt) {
      win.webContents.sendInputEvent(evt)
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
      // ADR 0009: the canvas doc lives under `.canvas/`, so allow a SINGLE known `.canvas/` prefix
      // (recovery probes seed `.canvas/canvas.json[.bak]`) while still rejecting any `..` traversal
      // or arbitrary nesting/separators that could escape the temp project dir.
      const rel = name.replace(/\\/g, '/')
      const inCanvas = rel.startsWith('.canvas/')
      const leaf = inCanvas ? rel.slice('.canvas/'.length) : rel
      if (rel.includes('..') || leaf.includes('/')) {
        throw new Error(`writeProjectFile: unsafe name ${name}`)
      }
      if (inCanvas) mkdirSync(join(tmp, '.canvas'), { recursive: true })
      writeFileSync(join(tmp, inCanvas ? '.canvas' : '.', leaf), contents, 'utf8')
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
    readTextFile(absPath) {
      return existsSync(absPath) ? readFileSync(absPath, 'utf8') : null
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
    ptySessionCounts() {
      return debugSessionCounts()
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
    mcpMintConnectedToken(boardId) {
      if (!mcp) return null
      const { token, port } = mcp.mintConnectedToken(boardId)
      return { token, port }
    },
    gitDiff(boardId) {
      return mcp?.gitDiff(boardId) ?? Promise.resolve('')
    },
    describeApp() {
      return mcp?.describeApp() ?? Promise.resolve(null)
    },
    spawnGroupNow(input) {
      return mcp?.spawnGroup(input) ?? Promise.resolve(null)
    },
    spawnBoardNow(input) {
      return mcp?.spawnBoard(input) ?? Promise.resolve(null)
    },
    mcpSeedOutput(id, text) {
      return debugSeedOutput(id, text)
    },
    mcpRecordResult(id, result) {
      recordBoardResult(id, result)
    },
    synthesizeResultNow(boardId) {
      getResultSynth()?.onSettle(boardId)
    },
    boardResultFor(id) {
      return readBoardResult(id)
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
    voiceStubSet(on, script) {
      setVoiceStubEnabled(on, script)
    },
    voiceStubWake(keyword) {
      return stubKwsWake(keyword)
    },
    notifyDeliver(boardId, event) {
      notifyProbe.deliver(boardId, event)
    },
    notifyConfigure(patch) {
      notifyProbe.configure(patch)
    },
    notifySetBoard(boardId, facts) {
      notifyProbe.setBoard(boardId, facts)
    },
    notifySetFocused(focused) {
      notifyProbe.setFocused(focused)
    },
    notifyOsCalls() {
      return notifyProbe.osCalls()
    },
    notifyReset() {
      notifyProbe.reset()
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
    },
    setLlmMock(on) {
      if (on) process.env.CANVAS_LLM_MOCK = '1'
      else delete process.env.CANVAS_LLM_MOCK
    },
    recapReEnsure
  }
}
