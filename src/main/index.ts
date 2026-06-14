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
  setRecapEnvProvider
} from './pty'
import { registerPreviewHandlers, disposeAll as disposeAllPreviews } from './preview'
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
  registerBoardRegistryHandler,
  subscribeBoardStatus
} from './boardRegistry'
import { sendMcpCommand } from './mcpCommand'
import { createAuditLog } from './auditLog'
import { registerAuditHandler, getAuditLog } from './auditIpc'
import { requestConfirm } from './mcpConfirm'
import { registerClipboardHandlers } from './clipboardIpc'
import { makeFlushChannel, makeFlushFinish } from './flushChannel'
// Terminal/agent-CLI session recap (Task 10 wiring) ────────────────────────────────
import {
  watchRecapMap,
  readRecapMap,
  installRecapHook,
  removeRecapHook,
  type RecapMapEntry
} from './agentRecapMap'
import { registerRecapHandlers, readConsent } from './recapConsent'
import { extractMilestones, isTrustedTranscriptPath, readTranscriptTail } from './agentTranscript'
import { createRecapWatcher, type RecapWatcher } from './agentRecapWatcher'

let mainWindow: BrowserWindow | null = null
let localServer: LocalServer | null = null
let mcp: RunningMcp | null = null
// Terminal recap (Task 10): the session-map fs.watch disposer; torn down in shutdown().
let stopRecapWatch: (() => void) | null = null
// Terminal recap (Task 11 — Slice B): hands-free mtime watcher; one per app lifetime.
let recapWatcher: RecapWatcher | null = null

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
    : process.env['CANVAS_DEV_TITLE'] || `${basename(process.cwd())} — Canvas ADE [dev]`
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0b',
    title: devTitle ?? 'Canvas ADE',
    webPreferences: buildMainWindowWebPreferences(join(__dirname, '../preload/index.js'))
  })
  // The renderer's <title> overwrites the window title on load — keep the dev stamp.
  if (devTitle) mainWindow.on('page-title-updated', (e) => e.preventDefault())

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // BUG-005: child WebContentsViews are NOT destroyed automatically with their
  // window (Electron docs mandate closing them in a 'closed' handler). Without
  // this, the preview module's stale views/owner/attached state survives a macOS
  // close -> activate reopen — attach() then skips addChildView on the NEW window
  // (blank Browser boards) — and the preview renderer processes leak while no
  // window exists. Close every preview view on window destruction; the recreated
  // window's renderer re-opens fresh views per persisted board.
  mainWindow.on('closed', () => disposeAllPreviews())

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
  electronApp.setAppUserModelId('com.canvasade.app')
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
  // BUG-003 (nodePath half): in a packaged build process.execPath is the app executable; running
  // it with a .js positional arg (without ELECTRON_RUN_AS_NODE=1) boots a second app instance
  // instead of executing the script. Bake ELECTRON_RUN_AS_NODE=1 into the hook env so Electron
  // acts as Node. In dev, process.execPath is already a real node binary — no env needed.
  const recapHookEnv: Record<string, string> | undefined = app.isPackaged
    ? { ELECTRON_RUN_AS_NODE: '1' }
    : undefined
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
    listSessions: listPtySessions,
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
    // The human-confirm gate (T4.2) — fail-closed; blocks until the user answers.
    confirm: (req) => requestConfirm(ipcMain, () => mainWindow, req),
    // Append to the append-only dispatch audit trail (T4.1). The log is wired just above
    // (registerAuditHandler — BUG-025); read lazily so the closure resolves it at dispatch time.
    audit: (e) =>
      getAuditLog()
        ?.append(e)
        .then(() => {}) ?? Promise.resolve(),
    // 🔒 MCP worker-tier write (T4.4 write_result): record a board's own structured
    // result → canvas://board/{id}/result. Bound to the caller's token board by the tool.
    recordResult: (id, result) => recordBoardResult(id, result)
  })
  registerPreviewHandlers(ipcMain, () => mainWindow, defaultPreviewUrl)
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
      const path =
        (board as { agentTranscriptPath?: string })?.agentTranscriptPath ??
        recapMap.get(boardId)?.transcriptPath
      if (!path || !isTrustedTranscriptPath(path) || !existsSync(path)) return undefined
      try {
        return extractMilestones(readTranscriptTail(path), { maxMilestones: 12, maxTextChars: 600 })
      } catch {
        return undefined
      }
    }
  })
  // Terminal recap (Task 11 — Slice B): create the ONE mtime watcher for this app lifetime.
  // Each learned transcript path (from the recap:learned flow below) is registered here so
  // any write to the transcript file debounce-fires summaryLoop.onIntent → auto-refreshed recap.
  recapWatcher = createRecapWatcher({
    debounceMs: 25_000,
    onIntent: (id) => void summaryLoop.onIntent({ boardId: id })
  })
  const memoryEngine = createMemoryEngine({
    onIntent: (intent) => void summaryLoop.onIntent(intent)
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
      if (readConsent(userData, dir) === 'enabled') {
        installRecapHook({
          projectDir: dir,
          nodePath: process.execPath,
          scriptPath: recordScript,
          mapPath: recapMapPath,
          env: recapHookEnv
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
        installRecapHook({
          projectDir: projectPath,
          nodePath: process.execPath,
          scriptPath: recordScript,
          mapPath: recapMapPath,
          env: recapHookEnv
        })
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
    const wc = mainWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.send('recap:learned', patches)
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
  if (mainWindow) installE2EMain(mainWindow, defaultPreviewUrl, mcp)

  if (SMOKE && mainWindow) {
    mainWindow.webContents.once('did-finish-load', async () => {
      // BUG-026: reuse defaultPreviewUrl (already '' when startLocalServer threw) instead
      // of the non-null assertion localServer!.url — if the bind failed (EACCES/firewall/
      // fd exhaustion) localServer is null, and the assertion would throw a TypeError into
      // the uncaughtException sink → crashShutdown(1), turning a graceful degraded boot into
      // an exit-1 smoke failure with no SELFTEST_DONE line. runSelfTest tolerates an empty URL.
      const ok = await runSelfTest(mainWindow!, defaultPreviewUrl)
      smokeLog(`SELFTEST_DONE ${JSON.stringify(ok)}`)
      if (SMOKE === 'exit') setTimeout(() => app.quit(), 400)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Idempotent teardown of every native resource (PTY trees, preview views, local
 * server). Returns a Promise that resolves once the PTY tree-kill is reaped (#49)
 * so the abrupt `app.exit` and guarded `before-quit` paths can await it; the crash
 * hooks fire it best-effort without awaiting (an uncaughtException handler can't).
 */
function shutdown(): Promise<void> {
  const drained = disposeAllPtys()
  disposeAllPreviews()
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
