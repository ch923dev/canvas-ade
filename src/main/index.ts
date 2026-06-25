import { app, shell, BrowserWindow, ipcMain, safeStorage, Menu } from 'electron'
import { basename, join } from 'path'
import { pathToFileURL } from 'url'
import { tmpdir } from 'os'
import { writeFileSync, mkdtempSync, existsSync } from 'fs'
import writeFileAtomic from 'write-file-atomic'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  registerPtyHandlers,
  disposeAllPtys,
  listPtySessions,
  readPtyOutput,
  drainPty,
  writeToPty,
  getTerminalRuntime,
  getTerminalActivityStaleMs,
  getTerminalCwd,
  setRecapEnvProvider,
  setOrchestrationSyncProvider
} from './pty'
import { boardGitDiff } from './gitDiff'
import { registerPreviewOsrHandlers, disposeAllOsr } from './previewOsr'
import { registerDiagramHandlers, disposeDiagramWorker } from './diagramWorker'
import { registerPreviewScreenshotHandler } from './previewScreenshot'
import { readBoardResult, recordBoardResult, pruneBoardResults } from './boardResults'
import { readProjectMemory, readBoardSummary } from './boardMemory'
import {
  buildMainWindowWebPreferences,
  windowOpenDecision,
  computeAppOrigin,
  createNavGuard
} from './windowSecurity'
import { startLocalServer, type LocalServer } from './localServer'
import { runSelfTest } from './selfTest'
import { installE2EMain } from './e2eMain'
import { registerProjectHandlers } from './projectIpc'
import { registerProjectLibraryIpc } from './projectLibrary'
import { registerFileIpc } from './fileIpc'
import { createFileWatcher, type FileWatcher } from './fileWatch'
import { runSummarize, defaultDeps } from './llmService'
import { registerLlmHandlers } from './llmIpc'
import type { Encryptor } from './llmKeyStore'
import { readLlmConfig } from './llmConfig'
import { createSummaryLoop } from './summaryLoop'
import { createMemoryEngine } from './memoryEngine'
import { performGuardedQuit, makeCrashHandler } from './quit'
import { getCurrentDir, readProject } from './projectStore'
import { startMcpServer, type RunningMcp } from './mcp'
import {
  listBoardMirror,
  listConnectors,
  listGroups,
  registerBoardRegistryHandler,
  subscribeBoardStatus
} from './boardRegistry'
import { sendMcpCommand } from './mcpCommand'
import { registerOrchestratorIpc, forwardBoardStatus } from './mcpOrchestratorIpc'
import { createAuditLog } from './auditLog'
import { registerAuditHandler, getAuditLog } from './auditIpc'
import { requestConfirm } from './mcpConfirm'
import { registerClipboardHandlers } from './clipboardIpc'
import { registerShellHandlers } from './shellIpc'
import { registerPlatformIpc } from './platformIpc'
import { makeFlushChannel, makeFlushFinish } from './flushChannel'
// Terminal/agent-CLI session recap (Task 10 wiring) ────────────────────────────────
import {
  watchRecapMap,
  readRecapMap,
  installRecapHook,
  removeRecapHook,
  findNodeExecutable,
  type RecapMapEntry
} from './agentRecapMap'
import { registerRecapHandlers, readConsent } from './recapConsent'
import { registerOrchestrationHandlers } from './orchestrationConsent'
import { registerOrchestrationProvisionHandlers } from './orchestrationProvision'
import { mintTerminalToken } from './orchestration/seam'
import {
  bindProvisionedDirStore,
  loadPersistedProvisionedDirs,
  makeOrchestrationSyncProvider,
  revokeOrchestration,
  unsyncProvisioners
} from './cliProvisioners'
import {
  extractMilestones,
  isTrustedTranscriptPath,
  readTranscriptTail,
  resolveLiveTranscriptPath
} from './agentTranscript'
import { createRecapWatcher, type RecapWatcher } from './agentRecapWatcher'
import { registerRecapIpc } from './recapIpc'
import { computeRecapFacts } from './recapFacts'
import { createResultSynthesizer, type ResultSynthesizer } from './boardResultSynth'
import { initAutoUpdate, type UpdaterLike } from './autoUpdate'

// Build-time auto-update gate (electron.vite.config.ts `define`). True ONLY for signed
// production builds; fences initAutoUpdate so unsigned builds never touch the update feed.
declare const __ENABLE_AUTO_UPDATE__: boolean

let mainWindow: BrowserWindow | null = null
let localServer: LocalServer | null = null
let mcp: RunningMcp | null = null
// Terminal recap (Task 10): the session-map fs.watch disposer; torn down in shutdown().
let stopRecapWatch: (() => void) | null = null
// Terminal recap (Task 11 — Slice B): hands-free mtime watcher; one per app lifetime.
let recapWatcher: RecapWatcher | null = null
// File-tree epic (S2): the chokidar tree watcher; re-pointed on project open, closed on quit.
let fileWatcher: FileWatcher | null = null
// PR-4 (Command-board prerequisite): synthesize a board's BoardResult from its recap transcript
// when the worker agent settles. Driven off the SAME mtime watcher; torn down in shutdown().
let resultSynth: ResultSynthesizer | null = null

const SMOKE = process.env.CANVAS_SMOKE // "1"=self-test (keep open), "exit"=self-test+quit

// Smoke markers go to stdout. If the reader closes early (e.g. a truncated shell
// pipe like `pnpm start | Select-Object -First N`), the next write hits a dead
// pipe and throws EPIPE — which must NOT crash main with an uncaught-exception
// dialog. Swallow EPIPE on both the sync (throw) and async (stream 'error') paths.
if (SMOKE) process.stdout.on('error', () => {})

function smokeLog(line: string): void {
  try {
    console.log(line)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err
  }
}

function createWindow(): void {
  // Parallel-session DX: in dev, stamp the window title with this checkout's identity
  // (CANVAS_DEV_TITLE wins, else the worktree folder name) so simultaneous dev
  // instances from different worktrees are tellable apart in the taskbar/alt-tab.
  // Packaged builds keep the product title.
  const devTitle = app.isPackaged
    ? null
    : process.env['CANVAS_DEV_TITLE'] || `${basename(process.cwd())} — Expanse [dev]`
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0b',
    title: devTitle ?? 'Expanse',
    webPreferences: buildMainWindowWebPreferences(join(__dirname, '../preload/index.js'))
  })
  // The renderer's <title> overwrites the window title on load — keep the dev stamp.
  if (devTitle) mainWindow.on('page-title-updated', (e) => e.preventDefault())

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // BUG-005: offscreen preview renderers + the Mermaid worker are NOT torn down
  // automatically with their window — close them on window destruction so a macOS
  // close -> activate reopen recreates them fresh per persisted board (and no
  // renderer process leaks while no window exists).
  mainWindow.on('closed', () => {
    disposeAllOsr() // close offscreen preview renderers
    disposeDiagramWorker() // close the hidden Mermaid render worker (S4)
    // BUG-001: the window is now DESTROYED but the module ref stayed non-null, so every
    // consumer that does `mainWindow?.webContents` (e.g. the recap-map watcher onChange)
    // would hit the .webContents getter — which THROWS on a destroyed window before any
    // `isDestroyed()` guard can run. Null the ref so the destroyed-but-non-null steady
    // state disappears for ALL consumers (the canonical `getWin()` returns null instead).
    mainWindow = null
  })

  // External links open in the OS browser, never in-app. The scheme is allowlisted
  // (Bug #23) so a stray window.open of file:/smb:/custom-protocol is dropped, not
  // handed to the OS handler.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const d = windowOpenDecision(url)
    if (d.openExternal) shell.openExternal(d.openExternal)
    return { action: d.action }
  })

  // Same-frame navigation guard (Bug #16/#47): the main window must never navigate
  // away from the app's own document — an accidental file/URL drop or a stray
  // location.assign would replace the whole React app (and every live PTY + native
  // preview view) with no in-app way back. Pin to the app origin; route an external
  // http(s) target to the OS browser, drop everything else. Compare ORIGIN (not the
  // full URL) so the e2e `?e2e=1` query / in-app hash changes don't trip the guard.
  //
  // PACKAGED builds load via loadFile (file:), where every file: URL shares the
  // opaque origin "null" — origin alone can't tell renderer/index.html from
  // file:///etc/passwd (audit `packaged-fileurl-nav-allowed`). So we additionally
  // pin packaged file: nav to the EXACT app document path. In dev (loadURL) the
  // appOrigin is the http dev origin and appDocPath stays undefined → file: URLs are
  // blocked exactly as before.
  const usePackagedFile = !(is.dev && process.env['ELECTRON_RENDERER_URL'])
  const indexHtmlPath = join(__dirname, '../renderer/index.html')
  const appOrigin = computeAppOrigin(process.env['ELECTRON_RENDERER_URL'])
  const appDocPath = usePackagedFile ? pathToFileURL(indexHtmlPath).pathname : undefined
  const guardNav = createNavGuard({
    appOrigin,
    appDocPath,
    openExternal: (u) => shell.openExternal(u)
  })
  mainWindow.webContents.on('will-navigate', (details, url) => guardNav(details, url))
  mainWindow.webContents.on('will-redirect', (details, url) => guardNav(details, url))
  // will-frame-navigate (Electron ≥22) covers subframes too — the renderer has none
  // today, but this keeps the guard complete if an iframe is ever added.
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame) guardNav(details, details.url)
  })

  // Surface renderer console to main stdout during smoke runs.
  if (SMOKE) {
    mainWindow.webContents.on('console-message', (_e, _lvl, message) => {
      if (message.startsWith('RENDERER_SMOKE')) smokeLog(message)
    })
  }

  // Dev-only HTML screenshot path (committed, env-gated). Captures the renderer DOM
  // (NOT the native WebContentsView — that's what the e2e Browser capture is for).
  // Usage: $env:CANVAS_SHOT='C:\tmp\canvas.png'; pnpm start
  const shotPath = process.env.CANVAS_SHOT
  if (shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWindow!.webContents.capturePage()
          writeFileSync(shotPath, img.toPNG())
          smokeLog(`CANVAS_SHOT_DONE ${shotPath}`)
        } catch (err) {
          smokeLog(`CANVAS_SHOT_FAIL ${(err as Error).message}`)
        }
        app.quit()
      }, 800)
    })
  }

  // The Playwright e2e boot (CANVAS_E2E) needs the renderer's seeding hook
  // (window.__canvasE2E) to populate the board mirror, so load with ?e2e=1.
  const seedHarness = !!process.env.CANVAS_E2E
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    mainWindow.loadURL(seedHarness ? `${base}?e2e=1` : base)
  } else {
    // Same path the nav guard pins to via appDocPath above (indexHtmlPath).
    mainWindow.loadFile(indexHtmlPath, seedHarness ? { query: { e2e: '1' } } : undefined)
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.expanse.app')
  // F10: free Alt+V so Claude Code's clipboard-image paste reaches xterm. On Windows/
  // Linux the default menu's Alt mnemonics (Alt+V = View) eat it, and Chromium handles
  // Ctrl+C/V natively in inputs there, so dropping the menu is safe. On macOS the Edit
  // menu ROLES are what wire Cmd+C/V/X/A in inputs, and CC uses Cmd+V (not Alt+V) anyway,
  // so keep a minimal Edit/app/window-role menu there.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null
  )
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // ── Terminal/agent-CLI session recap: app-owned constants (Task 10 Step 1) ──────────
  // The session map (boardId → {sessionId, transcriptPath}) and the SessionStart hook script
  // are app-owned and live in userData / the bundled main dir — NEVER in a project folder.
  // `recordScript` resolves relative to the bundled main output (out/main); a build-time copy
  // step lands recordSession.js at out/main/hooks/ and electron-builder asarUnpacks it so the
  // external `node <path>` Claude hook has a real on-disk file at runtime (see Step 6).
  const userData = app.getPath('userData')
  const recapMapPath = join(userData, 'recap', 'session-map.jsonl')
  // BUG-003 (path half): in a packaged build __dirname resolves inside app.asar; electron-builder
  // asarUnpacks recordSession.js to app.asar.unpacked, but the baked path still points into the
  // archive unless we rewrite it. Apply the standard app.asar -> app.asar.unpacked substitution
  // when the app is packaged so the external `node <path>` process can actually read the file.
  const recordScriptRaw = join(__dirname, 'hooks', 'recordSession.js')
  const recordScript = app.isPackaged
    ? recordScriptRaw.replace('app.asar', 'app.asar.unpacked')
    : recordScriptRaw
  // The recap SessionStart hook runs recordSession.js with a Node-capable runner. We write the
  // hook in Claude Code EXEC form (no shell), so the runner must itself be Node-capable WITHOUT an
  // env var (exec-form hooks can't set env):
  //   - DEV: process.execPath is the Electron binary, which runs a .js entry AS Node → works.
  //   - PACKAGED: process.execPath is the app exe, which IGNORES a .js arg (it would boot a second
  //     window). The earlier `cmd.exe /c set ELECTRON_RUN_AS_NODE=1 && "<exe>" …` shell wrapper that
  //     worked around this was mangled by cmd.exe quote-escaping on spaced paths and blocked the
  //     agent CLI from starting. So in packaged builds we resolve a REAL `node` from PATH; if none
  //     is found, recapRunner is null and we DON'T install the hook (recap silently off — the CLI
  //     must never break for a missing recap runtime).
  const recapRunner: string | null = app.isPackaged
    ? findNodeExecutable()
    : (findNodeExecutable() ?? process.execPath)
  if (app.isPackaged && !recapRunner) {
    console.warn('[recap] No Node runtime found on PATH — session recap disabled (CLI unaffected).')
  }
  let recapMap = new Map<string, RecapMapEntry>()

  // ── Recap env provider (Task 10 Step 2): consent-gated ──────────────────────────────
  // pty.ts calls this LAST when building a spawn's env (inside its own try/catch). We inject
  // CANVAS_RECAP_BOARD for EVERY terminal spawn in a CONSENTED project — NOT only boards whose
  // launchCommand is literally `claude`, because a user commonly opens a shell board and types
  // `claude` by hand; gating on launchCommand left those sessions with an empty board id in the
  // map (the hook fired but never saw the var). The env var is just a harmless board id and is
  // only ever read by a consented-project claude SessionStart hook, so injecting it on a shell
  // that never runs claude is a no-op. The map path is baked into the hook's install args.
  setRecapEnvProvider(({ id }) => {
    const dir = getCurrentDir()
    if (!dir) return undefined
    if (readConsent(userData, dir) !== 'enabled') return undefined
    return { CANVAS_RECAP_BOARD: id }
  })

  // The local preview server is a convenience (dev/preview fallback URL), not a hard
  // boot dependency. If listen() fails (EACCES from AV/firewall loopback denial,
  // EMFILE/ENFILE under fd exhaustion, ENETDOWN), surface a clear diagnostic and
  // degrade gracefully — boot the window with an empty fallback URL rather than
  // crashing to app.exit(1) via the uncaughtException sink with no message.
  let defaultPreviewUrl = ''
  try {
    localServer = await startLocalServer()
    defaultPreviewUrl = localServer.url
  } catch (err) {
    console.error(
      'Could not bind local preview server on 127.0.0.1 — continuing without it. ' +
        'Boards open with an explicit URL still work.',
      err
    )
  }
  registerPtyHandlers(ipcMain, () => mainWindow)
  registerClipboardHandlers(ipcMain, () => mainWindow)
  // General external-open channel (scheme re-validated in MAIN) — Phase 4 terminal web-links.
  registerShellHandlers(ipcMain, () => mainWindow)
  // SYNC platform info (Windows build number) for the terminal's xterm windowsPty hint (A-Win).
  registerPlatformIpc(ipcMain)
  // File-tree epic (S1): frame-guarded, root-confined fs IPC (read/write/list/stat). The
  // chokidar watcher that emits file:treeEvent lands in S2; the channel is reserved here.
  registerFileIpc(ipcMain, () => mainWindow)
  // File-tree epic (S2): the live tree watcher. Created here; pointed at the project root by the
  // onProjectOpen hook below (open + project:current); closed in shutdown(). project:create is the
  // one path it skips — a brand-new project is empty, and the watcher arms on its next open.
  fileWatcher = createFileWatcher(() => mainWindow)
  registerBoardRegistryHandler(ipcMain, () => mainWindow)
  // 🔒 MCP dispatch audit trail (T4.1) — wired BEFORE startMcpServer (BUG-025) so the
  // getAuditLog() seam the dispatch tools append through is already non-null the instant
  // the HTTP server is live. Previously this ran ~85 lines later, so any dispatch arriving
  // in that boot window had its audit entry silently dropped (getAuditLog() → null → the
  // `?? Promise.resolve()` short-circuit), leaving an invisible gap in the forensic trail.
  // Append-only JSONL under userData (NEVER the project folder — must outlive any project).
  registerAuditHandler(ipcMain, () => mainWindow, createAuditLog({ dir: userData }))
  mcp = await startMcpServer({
    listBoards: listBoardMirror,
    // The orchestration connector graph (T4.6 relay_prompt) — mirrored from the renderer.
    listConnectors,
    // PR-5: the Named Group mirror (feature zones) — feeds the app-model's live canvas.groups.
    listGroups,
    listSessions: listPtySessions,
    // BUG-007: ms-since-last-PTY-output per board, so the MCP idle-reaper measures dormancy by
    // output silence instead of the never-flipping 'running' status bucket of a live agent shell.
    boardActivityStaleMs: getTerminalActivityStaleMs,
    subscribeStatus: subscribeBoardStatus,
    readOutput: readPtyOutput,
    readResult: readBoardResult,
    readMemory: readProjectMemory,
    readSummary: readBoardSummary,
    // The MCP write path (T3.1+): frame-guarded control-plane command → renderer.
    sendCommand: (command) => sendMcpCommand(ipcMain, () => mainWindow, command),
    // Graceful PTY drain before an MCP close_board removes the board (T3.2).
    drainPty: (id) => drainPty(id),
    // 🔒 MCP dispatch (T4.3 handoff_prompt): write into a terminal's PTY ONLY after a
    // single-use nonce + a mandatory human confirm + an audit entry have authorized it.
    writeToPty: (id, text) => writeToPty(id, text),
    // 🔒 PR-2: read-only working-tree diff for a board (simple-git in MAIN, via gitDiff.ts).
    gitDiff: (id) => boardGitDiff(id, getTerminalCwd),
    // The human-confirm gate (T4.2) — fail-closed; blocks until the user answers.
    confirm: (req) => requestConfirm(ipcMain, () => mainWindow, req),
    // Append to the append-only dispatch audit trail (T4.1). The log is wired just above
    // (registerAuditHandler — BUG-025); read lazily so the closure resolves it at dispatch time.
    audit: (e) =>
      getAuditLog()
        ?.append(e)
        .then(() => {})
        .catch((err: unknown) => {
          // A failed audit write is a forensic gap — surface it in the log even if a future
          // non-awaiting caller forgets to handle the rejection, then RE-THROW so today's
          // awaiting callers (the mcpOrchestrator dispatch paths) still see it and can react.
          console.error('[mcp-audit] append failed', err)
          throw err
        }) ?? Promise.resolve(),
    // 🔒 MCP worker-tier write (T4.4 write_result): record a board's own structured
    // result → canvas://board/{id}/result. Bound to the caller's token board by the tool.
    recordResult: (id, result) => recordBoardResult(id, result)
  })
  // Phase C / C1: the renderer → MAIN orchestrator drive (Command board). Frame-guarded
  // handle() channels (spawnGroup/dispatchPrompt/interrupt) + the per-board status push that
  // advances the kanban. `() => mcp` is null until the loopback server is up (or if it failed
  // to bind) → handlers reject cleanly. Renderer holds no token; every write still pays the gate.
  registerOrchestratorIpc(
    ipcMain,
    () => mainWindow,
    () => mcp
  )
  forwardBoardStatus(() => mainWindow, subscribeBoardStatus)
  registerPreviewOsrHandlers(ipcMain, () => mainWindow) // offscreen preview → <canvas>
  registerDiagramHandlers(ipcMain, () => mainWindow) // S4: hidden Mermaid render worker
  registerPreviewScreenshotHandler(ipcMain, () => mainWindow)

  // T-B2: encrypt the API key with Electron safeStorage. Built here (index already imports
  // electron) and injected so llmKeyStore stays Electron-free + unit-testable. Under
  // CANVAS_SMOKE=e2e the key store lives in a throwaway temp dir (exported for the probe) so
  // a test key never lands in the real userData; otherwise it lives in userData (NEVER a
  // project folder).
  const llmEncryptor: Encryptor = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b)
  }
  // Isolate the key/config/budget store under a throwaway temp dir for ANY e2e run so a test
  // key never lands in real userData. The current Playwright harness sets CANVAS_E2E (not the
  // retired CANVAS_SMOKE=e2e), so gate on both — the old SMOKE-only guard was dead (F-A).
  const llmIsolated = !!process.env.CANVAS_E2E || SMOKE === 'e2e'
  const llmDataDir = llmIsolated ? mkdtempSync(join(tmpdir(), 'canvas-e2e-llm-')) : userData
  if (llmIsolated) process.env.CANVAS_E2E_LLM_DIR = llmDataDir

  // T-M3: the Tier-2 autonomous summary loop. The detector (T-M2) emits a {boardId} intent;
  // the loop re-reads the board, summarizes via the budgeted runSummarize (own file-backed
  // key/budget on the same llmDataDir → shared cap/key), and caches the prose into .canvas/.
  // Constructing the engine with the loop's onIntent and passing it as the 5th arg means the
  // SAME engine project:save feeds (+ open/current reset) is the one that drives the loop.
  const summaryLoop = createSummaryLoop({
    llmDataDir,
    encryptor: llmEncryptor,
    getCurrentDir,
    readProject,
    // T-F1: fold each terminal board's live runtime (running/idle/exited) into its summary.
    getTerminalRuntime,
    // Terminal recap (Task 10 Step 4): distil a terminal board's transcript into milestones. The
    // loop invokes this for any terminal board in a consented project; we prefer an explicit
    // per-board transcript path on the doc, else the learned recap-map entry.
    // Security: the path is persisted in canvas.json, so a hand-crafted file could otherwise aim
    // it at an arbitrary file whose scrubbed contents would egress to the user's LLM. isTrusted-
    // TranscriptPath restricts reads to .jsonl files under Claude's config root (where the hook
    // legitimately writes), honoring the consent modal's "nothing else leaves" promise.
    // Perf: readTranscriptTail reads only the file's tail (we keep just the last N turns).
    // Defensive + read-only: a missing/untrusted path / read error / parse failure → undefined,
    // and the loop falls back to its config+runtime summary (no action surface, never throws past this).
    getAgentMilestones: (boardId, board) => {
      // BUG-002: gate the egress path on consent. readConsent is already checked at PTY-spawn
      // time and at hook-install, but the actual transcript read + LLM egress path was never
      // gated, so revoking consent did not stop ongoing summary-loop recap egress.
      const dir = getCurrentDir()
      if (!dir || readConsent(userData, dir) !== 'enabled') return undefined
      const path = resolveLiveTranscriptPath(
        (board as { agentTranscriptPath?: string })?.agentTranscriptPath ??
          recapMap.get(boardId)?.transcriptPath
      )
      if (!path || !isTrustedTranscriptPath(path) || !existsSync(path)) return undefined
      try {
        return extractMilestones(readTranscriptTail(path), { maxMilestones: 12, maxTextChars: 600 })
      } catch {
        return undefined
      }
    }
  })
  // PR-4: derive a board's BoardResult from its recap transcript. getFacts resolves the SAME
  // trusted transcript tail the recap face reads (no egress, no consent — local read only) and
  // returns null when there is no transcript yet (nothing to verdict). The synthesizer records a
  // result only for a SETTLED agent and never clobbers an explicit `write_result` (see
  // boardResultSynth.ts). Driven below off the watcher's onIntent settle signal.
  resultSynth = createResultSynthesizer({
    getFacts: (boardId) => {
      const path = resolveLiveTranscriptPath(recapMap.get(boardId)?.transcriptPath)
      if (!path || !isTrustedTranscriptPath(path) || !existsSync(path)) return null
      let runtime: ReturnType<typeof getTerminalRuntime> | undefined
      try {
        runtime = getTerminalRuntime(boardId)
      } catch {
        runtime = undefined
      }
      let tail = ''
      try {
        tail = readTranscriptTail(path)
      } catch {
        return null // unreadable/vanished transcript — no verdict
      }
      if (!tail) return null
      return computeRecapFacts(tail, runtime, Date.now())
    }
  })
  // Terminal recap (Task 11 — Slice B): create the ONE mtime watcher for this app lifetime.
  // Each learned transcript path (from the recap:learned flow below) is registered here so
  // any write to the transcript file debounce-fires summaryLoop.onIntent → auto-refreshed recap.
  // PR-4: the same settle ALSO drives the result synthesizer (a transcript write is the agent's
  // task-progress/finish signal).
  recapWatcher = createRecapWatcher({
    debounceMs: 25_000,
    onIntent: (id) => {
      void summaryLoop.onIntent({ boardId: id })
      resultSynth?.onSettle(id)
    }
  })
  const memoryEngine = createMemoryEngine({
    onIntent: (intent) => void summaryLoop.onIntent(intent)
  })
  // S1 (recap redesign): the recap face's read path. Facts are LOCAL-only (no egress ->
  // no consent gate; trusted-path guard inside the handler). The transcript path resolves
  // exactly like getAgentMilestones above: the board doc's persisted field, else the
  // learned recap-map entry (the closure reads the live `recapMap` the watcher refreshes).
  registerRecapIpc(ipcMain, {
    getWin: () => mainWindow,
    getCurrentDir,
    getTranscriptPath: (boardId) => {
      // Resolve the recorded path (board doc, else learned map), then self-heal it to the LIVE
      // transcript (newest .jsonl in its dir) so a compaction/resume rotation can't strand the
      // recap on a dead session — see resolveLiveTranscriptPath.
      let recorded: string | undefined
      const dir = getCurrentDir()
      if (dir) {
        const r = readProject(dir)
        if (r.ok) {
          const boards = (r.doc as { boards?: unknown }).boards
          const b = Array.isArray(boards)
            ? (boards as { id?: unknown }[]).find((x) => x.id === boardId)
            : undefined
          const p = (b as { agentTranscriptPath?: unknown })?.agentTranscriptPath
          if (typeof p === 'string' && p) recorded = p
        }
      }
      recorded ??= recapMap.get(boardId)?.transcriptPath
      return resolveLiveTranscriptPath(recorded)
    },
    getTerminalRuntime
  })
  registerProjectHandlers(
    ipcMain,
    () => mainWindow,
    userData,
    undefined,
    memoryEngine,
    // T-F4: manual ⟳ refresh → the SAME budgeted/passive summarize the detector drives (awaited so
    // the renderer can flip its "updating…" state off once the prose is rewritten).
    (boardId) => summaryLoop.onIntent({ boardId }),
    // Terminal recap (Task 10 Step 5): on opening an already-consented project, re-ensure the recap
    // SessionStart hook so a project consented in a prior session keeps recording. Idempotent
    // (installRecapHook no-ops when present). Best-effort — projectIpc wraps this in try/catch.
    (dir) => {
      // BUG-035 (verify follow-up): board results are per-project — an id-colliding
      // board in the next project must not inherit the previous project's verdict.
      // Clear-all on open; onBoardsObserved's prune handles deletions WITHIN a project.
      pruneBoardResults(new Set())
      // File-tree epic (S2): (re)point the live tree watcher at the now-open project root.
      // watch() closes any prior watcher first, so a project switch re-targets cleanly.
      void fileWatcher?.watch(dir)
      if (recapRunner && readConsent(userData, dir) === 'enabled') {
        installRecapHook({
          projectDir: dir,
          command: recapRunner,
          scriptPath: recordScript,
          mapPath: recapMapPath
        })
      }
    },
    // Terminal recap: prune transcript watchers to the live board set on every save/open/switch,
    // so a deleted terminal (or a switched-away project's boards) doesn't leak its fs.watch handle
    // until quit. watchRecapMap re-tracks only boards still present in the app-owned map.
    // BUG-035: also prune boardResults so stale (and potentially colliding cross-project)
    // results are not served via canvas://board/{id}/result after a project switch or deletion.
    // BUG-006: re-arm recap transcript watchers for boards that are live in the current project
    // but whose watchers were torn down by a prior retain() call (switch-away path).
    (liveBoardIds) => {
      recapWatcher?.retain(liveBoardIds)
      // PR-4: drop pending result-synthesis re-check timers for boards no longer live.
      resultSynth?.retain(liveBoardIds)
      pruneBoardResults(liveBoardIds)
      // Re-arm watchers for live boards that the in-memory recapMap knows about but whose
      // fs.watch handle was disposed when we switched away from this project.
      for (const [boardId, entry] of recapMap.entries()) {
        if (liveBoardIds.has(boardId)) {
          recapWatcher?.track(boardId, entry.transcriptPath)
        }
      }
    }
  )
  registerLlmHandlers(ipcMain, () => mainWindow, llmDataDir, undefined, llmEncryptor)
  // Project Library (list/reveal/open files saved under <project>/.canvas/{downloads,assets}).
  registerProjectLibraryIpc(ipcMain, () => mainWindow)

  // ── Recap consent IPC + hook-install policy (Task 10 Step 5) ────────────────────────
  // recap:getConsent / recap:setConsent (frame-guarded inside recapConsent.ts). The decision
  // callback is the SINGLE place that mutates the project's .claude/settings.local.json hook:
  // 'enabled' → install (idempotent), anything else → remove only OUR entry. The map path is
  // baked into the hook args here so the external Claude process appends to the app-owned map.
  registerRecapHandlers(
    ipcMain,
    () => mainWindow,
    userData,
    getCurrentDir,
    (projectPath, decision) => {
      if (decision === 'enabled') {
        // No runner (packaged + no Node on PATH) → recap can't record; leave state as-is rather
        // than running the decline-side teardown below.
        if (recapRunner) {
          installRecapHook({
            projectDir: projectPath,
            command: recapRunner,
            scriptPath: recordScript,
            mapPath: recapMapPath
          })
        }
      } else {
        removeRecapHook(projectPath, recordScript)
        // BUG-002: on decline, stop all in-flight recap activity for this project's boards
        // so transcript content stops egressing to the LLM even while a claude session runs.
        // 1. Derive the current project's live board ids from the board mirror.
        const projectBoardIds = new Set(listBoardMirror().map((b) => b.id))
        // 2. Untrack each board's transcript watcher so mtime changes no longer debounce into
        //    summaryLoop.onIntent (the "hands-free auto-refresh" path).
        for (const boardId of projectBoardIds) {
          recapWatcher?.untrack(boardId)
        }
        // 3. Drop in-memory recapMap entries for this project's boards so getAgentMilestones
        //    can't read them even if it somehow bypasses the consent check.
        for (const boardId of projectBoardIds) {
          recapMap.delete(boardId)
        }
        // 4. Rewrite session-map.jsonl, removing entries for this project's boards, so a future
        //    app restart does not re-track them via the watchRecapMap prime fire.
        try {
          const allEntries = readRecapMap(recapMapPath)
          const kept: string[] = []
          for (const [boardId, entry] of allEntries.entries()) {
            if (!projectBoardIds.has(boardId)) {
              kept.push(JSON.stringify({ boardId, ...entry }))
            }
          }
          // Atomic like every other persistence path: a torn write would otherwise leave a
          // partial JSONL that readRecapMap absorbs as an empty map (silent entry loss).
          writeFileAtomic.sync(recapMapPath, kept.length > 0 ? kept.join('\n') + '\n' : '')
        } catch {
          // Non-fatal: the consent gate in getAgentMilestones still blocks egress even if
          // the map file could not be rewritten.
        }
      }
    }
  )

  // ── Orchestration consent IPC (Agent Orchestration Onboarding P1) ───────────────────
  // orchestration:getConsent / orchestration:setConsent (frame-guarded inside the module).
  // Binds the seam consent store to `userData` as a side effect, so the seam's
  // isOrchestrationEnabled() — consumed by the P3 spawn-time provisioner hook (pty.ts) and the
  // P0 plan-write gate (mcp.ts) — resolves the right store with only a projectDir.
  //
  // onChange fires AFTER a decision is durably persisted (WT-provision P3 seam). On REVOKE,
  // remove our `canvas-ade` entry from every CLI's config (best-effort, fire-and-forget —
  // `unsyncProvisioners` isolates per-CLI failures and never rejects). On ENABLE nothing
  // proactive here: the Sync modal (explicit, project-level) and the spawn-time hook (per
  // terminal start, below) own writing the configs. Never throw here — the decision is already
  // durable (the IPC handler also wraps this in try/catch).
  //
  // W1-E / F8: hydrate the provisioned-dir registry from userData BEFORE registering the consent
  // onChange callback, so a revoke fired in THIS session cleans the bearer tokens a PRIOR session
  // wrote into divergent board cwds (the in-memory Map is empty after a restart). The userData path
  // is stable across restarts, so binding here re-points at the same store the prior session wrote.
  bindProvisionedDirStore(userData)
  loadPersistedProvisionedDirs(userData)
  registerOrchestrationHandlers(
    ipcMain,
    () => mainWindow,
    userData,
    getCurrentDir,
    (projectPath, on) => {
      if (!on) {
        // FIND-001 / F8: clean every on-disk config we wrote — incl. divergent board cwds from THIS
        // and prior sessions (now hydrated from userData) — so a revoked grant leaves NO bearer
        // token on disk. FIND-015 / F22: `revokeOrchestration` awaits that disk cleanup, THEN
        // invalidates the live connected tokens — disk tokens die BEFORE the in-memory store is
        // zeroed (no window where an on-disk token outlives the in-memory one it mirrors). Best-
        // effort + fire-and-forget: onChange returns synchronously and a locked file never blocks it.
        void revokeOrchestration(projectPath, unsyncProvisioners, () => mcp?.revokeAllConnected())
      }
    }
  )

  // Spawn-time auto-sync (WT-provision P3 hook): on each terminal start, if the project has
  // orchestration consent and the launch command starts a known CLI, write that CLI's MCP config
  // with a freshly-minted connected-tier token BEFORE the launch line runs — the live loopback
  // endpoint + bearer rotate each app restart, so re-syncing here is what fixes the
  // stale-config-after-restart failure ("tool doesn't exist"). Errors are swallowed by pty.ts's
  // spawn-time try/catch, so a provisioning failure can never break a spawn. 🔒 token never logged.
  setOrchestrationSyncProvider(
    makeOrchestrationSyncProvider({ getProjectDir: getCurrentDir, mintToken: mintTerminalToken })
  )

  // The Sync modal's data plane (status + manual sync), frame-guarded inside the module.
  registerOrchestrationProvisionHandlers(ipcMain, () => mainWindow, getCurrentDir)

  // ── Recap map watcher (Task 10 Step 3): learned transcript paths → renderer ──────────
  // The external hook appends {boardId, sessionId, transcriptPath} to the app-owned map as
  // Claude sessions start. Watch it (debounced), keep the in-memory `recapMap` fresh (read by
  // getAgentMilestones above), and push the learned per-board paths to the renderer so a board
  // can show its recap. Disposed on quit alongside the other native resources (see shutdown()).
  stopRecapWatch = watchRecapMap(recapMapPath, (m) => {
    recapMap = m
    const patches = [...m.entries()].map(([boardId, e]) => ({ boardId, ...e }))
    // Task 11 (Slice B): register each learned transcript path with the mtime watcher so
    // writes to the file auto-debounce into a summaryLoop.onIntent call. track() is idempotent
    // for already-watched boards (it disposes + re-arms), so re-reads of the map are safe.
    for (const [boardId, entry] of m.entries()) {
      recapWatcher?.track(boardId, entry.transcriptPath)
    }
    // BUG-001: this onChange runs inside agentRecapMap's bare debounce setTimeout, so a
    // throw escapes to uncaughtException -> crashShutdown(1). Optional chaining does NOT
    // stop the .webContents getter from THROWING on a destroyed-but-non-null window, so
    // guard isDestroyed() BEFORE dereferencing .webContents (mirrors flushRenderer).
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc.isDestroyed()) wc.send('recap:learned', patches)
  })

  // Manual T-B1 check (dev-only, env-gated): `CANVAS_LLM_PING=hello pnpm start` calls
  // summarize once and logs the provider's reply to MAIN stdout. With no key set this
  // logs the typed no-provider result (graceful degrade), proving the path end-to-end.
  if (process.env.CANVAS_LLM_PING && !SMOKE) {
    runSummarize(
      readLlmConfig(app.getPath('userData')),
      { system: 'Reply in one short sentence.', text: process.env.CANVAS_LLM_PING },
      defaultDeps()
    ).then((r) => console.log('LLM_PING', JSON.stringify(r)))
  }
  // (The MCP dispatch audit trail is now registered earlier, before startMcpServer — BUG-025.)

  createWindow()
  // PR-4: pass a live getter for the result synthesizer so the CANVAS_E2E seam can drive
  // `onSettle` deterministically (it is created above in this same setup scope).
  if (mainWindow) installE2EMain(mainWindow, defaultPreviewUrl, mcp, () => resultSynth)

  // Phase 5 auto-update (gated). A NO-OP in dev/unsigned builds (see autoUpdate.ts +
  // electron.vite.config.ts); in a signed production build it checks the GitHub feed,
  // auto-downloads, and surfaces an "update ready — Restart" toast in the renderer.
  // electron-updater is loaded via a DYNAMIC import inside getUpdater so it (and its
  // transitive deps, e.g. semver) are only required when the gate is open — an unsigned
  // build never imports it, so a missing/unpacked updater dep can't crash boot.
  initAutoUpdate({
    enabled: __ENABLE_AUTO_UPDATE__,
    isPackaged: app.isPackaged,
    ipc: ipcMain,
    getWin: () => mainWindow,
    getUpdater: async () => {
      // The real electron-updater autoUpdater satisfies UpdaterLike at runtime; the
      // double-cast is the deliberate boundary between our minimal interface and its
      // richly-overloaded per-event types (so autoUpdate.ts stays test-injectable).
      const mod = await import('electron-updater')
      return mod.autoUpdater as unknown as UpdaterLike
    }
    // A rejection here means the gate was open (signed build) but updater init/import
    // failed — a packaging defect. Log it; never let it become an unhandled rejection
    // that crashes main under Node 22's --unhandled-rejections=throw default.
  }).catch((err) => console.error('[auto-update] init failed', err))

  if (SMOKE && mainWindow) {
    mainWindow.webContents.once('did-finish-load', async () => {
      // BUG-026: reuse defaultPreviewUrl (already '' when startLocalServer threw) instead
      // of the non-null assertion localServer!.url — if the bind failed (EACCES/firewall/
      // fd exhaustion) localServer is null, and the assertion would throw a TypeError into
      // the uncaughtException sink → crashShutdown(1), turning a graceful degraded boot into
      // an exit-1 smoke failure with no SELFTEST_DONE line. runSelfTest tolerates an empty URL.
      const ok = await runSelfTest(defaultPreviewUrl)
      smokeLog(`SELFTEST_DONE ${JSON.stringify(ok)}`)
      if (SMOKE === 'exit') setTimeout(() => app.quit(), 400)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Idempotent teardown of every native resource (PTY trees, offscreen previews, local
 * server). Returns a Promise that resolves once the PTY tree-kill is reaped (#49)
 * so the abrupt `app.exit` and guarded `before-quit` paths can await it; the crash
 * hooks fire it best-effort without awaiting (an uncaughtException handler can't).
 */
function shutdown(): Promise<void> {
  const drained = disposeAllPtys()
  disposeAllOsr() // close offscreen preview renderers
  disposeDiagramWorker() // close the hidden Mermaid render worker (S4)
  const mcpClosed = mcp?.close() ?? Promise.resolve()
  mcp = null
  localServer?.close()
  localServer = null
  // Terminal recap (Task 10): stop the session-map fs.watch so it can't fire after teardown.
  // Idempotent — watchRecapMap's disposer is safe to call once; null it so a second shutdown()
  // (this fn is shared by before-quit + the crash sinks) is a no-op.
  stopRecapWatch?.()
  stopRecapWatch = null
  // Terminal recap (Task 11 — Slice B): dispose the mtime watcher (clears all fs.watch handles
  // and pending debounce timers) so nothing fires post-teardown.
  recapWatcher?.dispose()
  recapWatcher = null
  // File-tree epic (S2): release the chokidar tree watcher's fs handles on quit.
  void fileWatcher?.close()
  fileWatcher = null
  // PR-4: cancel any pending result-synthesis re-check timers so nothing fires post-teardown.
  resultSynth?.dispose()
  resultSynth = null
  return Promise.all([drained, mcpClosed]).then(() => undefined)
}

/**
 * Ask the renderer to flush its debounced autosave before we hard-exit (BUG-M2).
 * The quit path calls `app.exit(0)`, which never fires the renderer `beforeunload`,
 * so the autosave flush handler (useAutosave) would be skipped and the last ~1s of
 * edits lost. We post `project:flush` with a unique reply channel; the renderer runs
 * its flush (awaiting `project:save`) and replies. We resolve on the reply OR a short
 * timeout fallback so a wedged/closed renderer can never hang the quit.
 */
function flushRenderer(timeoutMs = 1500): Promise<void> {
  const win = mainWindow
  // BUG-001: accessing .webContents on a destroyed BrowserWindow throws "Object has been
  // destroyed". Guard isDestroyed() BEFORE dereferencing .webContents so the close-then-quit
  // path (Win/Linux: window close -> window-all-closed -> before-quit -> flushRenderer) cannot
  // throw into the uncaughtException sink and short-circuit the guarded-quit chain.
  if (!win || win.isDestroyed()) return Promise.resolve()
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    // 🔒 BUG-038: use CSPRNG randomUUID() (not predictable Date.now()/Math.random).
    const replyChannel = makeFlushChannel()
    const { finish, forceFinish } = makeFlushFinish({
      getWin: () => mainWindow,
      onCleanup: () => {
        ipcMain.removeAllListeners(replyChannel)
        clearTimeout(timer)
      },
      onResolve: resolve
    })
    // 🔒 BUG-038: `finish` accepts IpcMainEvent and guards against foreign-frame senders.
    // BUG-019: use ipcMain.on (not once) so a foreign-frame message that isForeignSender
    // correctly ignores does not consume the listener before the legitimate reply arrives.
    // onCleanup calls removeAllListeners(replyChannel) when finish resolves, so cleanup
    // still happens exactly once regardless of how many messages arrive on the channel.
    const timer = setTimeout(forceFinish, timeoutMs)
    ipcMain.on(replyChannel, finish)
    try {
      wc.send('project:flush', replyChannel)
    } catch {
      forceFinish() // renderer gone — nothing to flush
    }
  })
}

app.on('window-all-closed', () => {
  // Route through app.quit() (non-darwin) so the guarded before-quit handler below
  // performs the awaited PTY-tree drain (#49) instead of racing a fire-and-forget
  // shutdown() against process exit.
  if (process.platform !== 'darwin') app.quit()
})

// Guarded async quit (#49/BUG-031): on first entry, defer the quit, flush the renderer
// autosave (BUG-M2 — the hard app.exit bypasses the renderer beforeunload), drain the
// PTY tree (bounded by shutdown()'s own 2s timeout) so a deep agent child tree is reaped
// instead of orphaned, then exit. The `quitting` flag lets the post-drain app.exit(0)
// proceed without re-deferring.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  // performGuardedQuit catches a flush rejection so shutdown() (the PTY-tree drain) always
  // runs — a wedged renderer must never orphan a deep agent child tree (before-quit-flush-no-catch).
  void performGuardedQuit({
    flush: flushRenderer,
    shutdown,
    exit: (code) => app.exit(code),
    onFlushError: (err) =>
      console.error('[before-quit] renderer flush failed; proceeding to shutdown', err)
  })
})

// Crash-path / signal cleanup (#50): before-quit/window-all-closed don't fire on an uncaught
// error or an external SIGINT/SIGTERM, which would orphan the node-pty child trees. The handler
// (idempotent, best-effort tree-kill, see quit.ts) is shared by all the crash sinks.
const crashShutdown = makeCrashHandler({
  shutdown,
  exit: (code) => app.exit(code),
  logError: (err) => console.error(err)
})
process.on('uncaughtException', (err) => crashShutdown(1, err))
process.on('unhandledRejection', (reason) => crashShutdown(1, reason))
process.on('SIGINT', () => crashShutdown(0))
process.on('SIGTERM', () => crashShutdown(0))
