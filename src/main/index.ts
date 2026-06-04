import { app, shell, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeFileSync, mkdtempSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  registerPtyHandlers,
  disposeAllPtys,
  listPtySessions,
  readPtyOutput,
  drainPty,
  writeToPty,
  getTerminalRuntime
} from './pty'
import { registerPreviewHandlers, disposeAll as disposeAllPreviews } from './preview'
import { readBoardResult, recordBoardResult } from './boardResults'
import { readProjectMemory, readBoardSummary } from './boardMemory'
import {
  buildMainWindowWebPreferences,
  windowOpenDecision,
  computeAppOrigin,
  navDecision
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
import { getCurrentDir, readProject } from './projectStore'
import { startMcpServer, type RunningMcp } from './mcp'
import { runMcpSmoke } from './mcpSmoke'
import { listBoardMirror, listConnectors, registerBoardRegistryHandler } from './boardRegistry'
import { sendMcpCommand } from './mcpCommand'
import { createAuditLog } from './auditLog'
import { registerAuditHandler, getAuditLog } from './auditIpc'
import { requestConfirm } from './mcpConfirm'

let mainWindow: BrowserWindow | null = null
let localServer: LocalServer | null = null
let mcp: RunningMcp | null = null

const SMOKE = process.env.CANVAS_SMOKE // "1"=self-test, "exit"=self-test+quit, "mcp"=MCP tier smoke+quit

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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0b',
    title: 'Canvas ADE',
    webPreferences: buildMainWindowWebPreferences(join(__dirname, '../preload/index.js'))
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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
  const appOrigin = computeAppOrigin(process.env['ELECTRON_RENDERER_URL'])
  const guardNav = (event: { preventDefault: () => void }, url: string): void => {
    const d = navDecision(url, appOrigin)
    if (d.allow) return
    event.preventDefault()
    if (d.openExternal) shell.openExternal(d.openExternal)
  }
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

  // The Playwright e2e boot (CANVAS_E2E) and the MCP tier smoke (CANVAS_SMOKE='mcp')
  // both need the renderer's seeding hook (window.__canvasE2E) to populate the board
  // mirror, so load with ?e2e=1 for either.
  const seedHarness = !!process.env.CANVAS_E2E || SMOKE === 'mcp'
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    mainWindow.loadURL(seedHarness ? `${base}?e2e=1` : base)
  } else {
    mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      seedHarness ? { query: { e2e: '1' } } : undefined
    )
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.canvasade.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

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
  registerBoardRegistryHandler(ipcMain, () => mainWindow)
  // 🔒 MCP dispatch audit trail (T4.1) — wired BEFORE startMcpServer (BUG-025) so the
  // getAuditLog() seam the dispatch tools append through is already non-null the instant
  // the HTTP server is live. Previously this ran ~85 lines later, so any dispatch arriving
  // in that boot window had its audit entry silently dropped (getAuditLog() → null → the
  // `?? Promise.resolve()` short-circuit), leaving an invisible gap in the forensic trail.
  // Append-only JSONL under userData (NEVER the project folder — must outlive any project).
  registerAuditHandler(ipcMain, () => mainWindow, createAuditLog({ dir: app.getPath('userData') }))
  mcp = await startMcpServer({
    listBoards: listBoardMirror,
    // The orchestration connector graph (T4.6 relay_prompt) — mirrored from the renderer.
    listConnectors,
    listSessions: listPtySessions,
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
  const llmDataDir = llmIsolated
    ? mkdtempSync(join(tmpdir(), 'canvas-e2e-llm-'))
    : app.getPath('userData')
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
    getTerminalRuntime
  })
  const memoryEngine = createMemoryEngine({
    onIntent: (intent) => void summaryLoop.onIntent(intent)
  })
  registerProjectHandlers(
    ipcMain,
    () => mainWindow,
    app.getPath('userData'),
    undefined,
    memoryEngine,
    // T-F4: manual ⟳ refresh → the SAME budgeted/passive summarize the detector drives (awaited so
    // the renderer can flip its "updating…" state off once the prose is rewritten).
    (boardId) => summaryLoop.onIntent({ boardId })
  )
  registerLlmHandlers(ipcMain, () => mainWindow, llmDataDir, undefined, llmEncryptor)

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
  if (mainWindow) installE2EMain(mainWindow, defaultPreviewUrl)

  if (SMOKE && mainWindow) {
    mainWindow.webContents.once('did-finish-load', async () => {
      if (SMOKE === 'mcp') {
        const code = await runMcpSmoke(mcp, mainWindow!)
        process.exitCode = code
        // Drain the renderer's debounced autosave before teardown (the mcp smoke
        // seeds boards under ?e2e=1, arming useAutosave) so a late `project:save`
        // invoke can't race the window destruction.
        await flushRenderer()
        await shutdown()
        app.exit(code)
      } else {
        const ok = await runSelfTest(mainWindow!, localServer!.url)
        smokeLog(`SELFTEST_DONE ${JSON.stringify(ok)}`)
        if (SMOKE === 'exit') setTimeout(() => app.quit(), 400)
      }
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
  const wc = win?.webContents
  if (!win || !wc || wc.isDestroyed()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const replyChannel = `project:flush:done:${Date.now()}:${Math.random().toString(36).slice(2)}`
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      ipcMain.removeAllListeners(replyChannel)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    ipcMain.once(replyChannel, finish)
    try {
      wc.send('project:flush', replyChannel)
    } catch {
      finish() // renderer gone — nothing to flush
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
  void flushRenderer()
    .then(() => shutdown())
    .finally(() => app.exit(0))
})

// Crash-path / signal cleanup (#50): before-quit/window-all-closed don't fire on an
// uncaught error or an external SIGINT/SIGTERM, which would orphan the node-pty child
// trees. shutdown() is idempotent, so firing it here (in addition to the normal paths)
// is safe. An uncaughtException handler can't await the async taskkill before exit, so
// this is best-effort — but firing the tree-kill at all beats the zero-cleanup path.
let crashing = false
function crashShutdown(exitCode: number, err?: unknown): void {
  if (crashing) return
  crashing = true
  if (err) console.error(err)
  void shutdown()
  app.exit(exitCode)
}
process.on('uncaughtException', (err) => crashShutdown(1, err))
process.on('unhandledRejection', (reason) => crashShutdown(1, reason))
process.on('SIGINT', () => crashShutdown(0))
process.on('SIGTERM', () => crashShutdown(0))
