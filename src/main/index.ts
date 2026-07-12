import { app, shell, BrowserWindow, ipcMain, safeStorage, Menu } from 'electron'
import { basename, join } from 'path'
import { pathToFileURL } from 'url'
import { tmpdir, homedir } from 'os'
import { writeFileSync, mkdtempSync, existsSync, rmSync } from 'fs'
import writeFileAtomic from 'write-file-atomic'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  registerPtyHandlers,
  disposeAllPtys,
  getTerminalRuntime,
  getTerminalBootInfo,
  setRecapEnvProvider,
  setOrchestrationSyncProvider,
  getTerminalCwd,
  disposeProjectPtys,
  persistBackgroundRingTails,
  backgroundParkedBoardIds
} from './pty'
import { setRecapHookSyncProvider } from './ptySpawnEnv'
import { recordRecapHookDir, listRecapHookDirs, clearRecapHookDirs } from './recapHookDirs'
import { appendTerminalSnapshot } from './terminalSnapshot'
import { registerPreviewOsrHandlers, disposeAllOsr } from './previewOsr'
import { disposeProjectOsr } from './previewOsrBackground'
import {
  projectSessions,
  startBackgroundIdleSweep,
  stopBackgroundIdleSweep
} from './backgroundSessions'
import { registerProjectSessionsHandlers } from './projectSessionsIpc'
import { wireGlobalHotkey } from './globalHotkey'
import { registerProjectThumbHandlers } from './projectThumbs'
import { registerDiagramHandlers, disposeDiagramWorker } from './diagramWorker'
import { registerPreviewScreenshotHandler } from './previewScreenshot'
import { pruneBoardResults } from './boardResults'
import {
  buildMainWindowWebPreferences,
  windowOpenDecision,
  computeAppOrigin,
  createNavGuard
} from './windowSecurity'
import { registerMicPermissionPosture } from './micPermission'
import { disposeVoiceSession, registerVoiceHandlers } from './voiceIpc'
import { applyVoiceBootEnv, runVoiceSpikeGate } from './voiceBoot'
import { applyDevProfileIsolation } from './profileIsolation'
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
import { performGuardedQuit, makeCrashHandler, performWindowCloseCleanup } from './quit'
import { getCurrentDir, readProject } from './projectStore'
import type { RunningMcp } from './mcp'
import { createMcpBoot } from './mcpBoot'
import { registerSpawnCapHandlers } from './orchestrationConfig'
import {
  listBoardMirror,
  registerBoardRegistryHandler,
  subscribeBoardStatus
} from './boardRegistry'
import { registerOrchestratorIpc, forwardBoardStatus } from './mcpOrchestratorIpc'
import { createAuditLog } from './auditLog'
import { registerAuditHandler } from './auditIpc'
// #321 cross-project routing: armed eagerly here; its registry slice is passed into the lazy
// createMcpBoot (M11). sendMcpCommand / requestConfirm / appendAuditEntry moved into mcpBoot.ts.
import { startMcpCommandRouting } from './mcpRoutingBoot'
import { registerClipboardHandlers } from './clipboardIpc'
import { registerShellHandlers } from './shellIpc'
import { registerTerminalHandlers } from './terminalIpc'
import { registerPlatformIpc } from './platformIpc'
import { bindLowRamConfig } from './lowRamConfig'
import { flushRendererAutosave } from './flushChannel'
// Terminal/agent-CLI session recap (Task 10 wiring) ────────────────────────────────
import {
  watchRecapMap,
  readRecapMap,
  installRecapHook,
  removeRecapHook,
  findNodeExecutable,
  isRecapHookInstalled,
  type RecapMapEntry
} from './agentRecapMap'
import { registerRecapHealthIpc, createFocusReEnsure, selectTranscriptClocks } from './recapHealth'
import { registerRecapHandlers, readConsent } from './recapConsent'
import { registerOrchestrationHandlers } from './orchestrationConsent'
import { registerOrchestrationProvisionHandlers } from './orchestrationProvision'
import { mintTerminalToken, isOrchestrationEnabled } from './orchestration/seam'
import {
  bindProvisionedDirStore,
  loadPersistedProvisionedDirs,
  makeOrchestrationSyncProvider,
  revokeOrchestration,
  unsyncProvisioners
} from './cliProvisioners'
import { createMcpServersStore } from './mcpServers/mcpServersStore'
import { registerMcpServersHandlers } from './mcpServers/mcpServersIpc'
import { bindExternalSyncStore, makeExternalMcpSyncProvider } from './mcpServers/externalSync'
import { probeExternalServer } from './mcpServers/mcpClientProbe'
import {
  isTrustedTranscriptPath,
  readTranscriptTail,
  resolveLiveTranscriptPath
} from './agentTranscript'
import { createGetAgentMilestones, persistedTranscriptPath } from './agentMilestones'
import { createRecapWatcher, type RecapWatcher } from './agentRecapWatcher'
import { wireLifecycleNotifications } from './lifecycleNotifications'
import { registerRecapIpc } from './recapIpc'
import { registerTerminalResumeIpc } from './terminalResume'
import { computeRecapFacts } from './recapFacts'
import { createResultSynthesizer, type ResultSynthesizer } from './boardResultSynth'
import { startAutoUpdate } from './autoUpdateWiring'
import { readLocalFeedOverride } from './localUpdateFeed'
import { createDeepLinkRouter } from './deepLinkBoot'
import { createAuthTokenStore } from './authTokenStore'
import { readSession, writeSession, clearSession } from './authSession'
import { readEntitlement, writeEntitlement, clearEntitlement } from './entitlementCache'
import { createAuthService, type AuthService } from './authService'
import { registerAuthHandlers, pushAuthStatus } from './authIpc'
import { AUTH_CONFIG } from './authConfig'

// Build-time auto-update gate (electron.vite.config.ts `define`). True ONLY for signed
// production builds; fences initAutoUpdate so unsigned builds never touch the update feed.
declare const __ENABLE_AUTO_UPDATE__: boolean
// Build-time local-update-channel gate (electron.vite.config.ts `define`). True ONLY for the
// maintainer's personal builds (scripts/release-local.mjs); every distributed build strips the
// userData feed-override path entirely. See src/main/localUpdateFeed.ts for the full posture.
declare const __LOCAL_UPDATE_CHANNEL__: boolean
// Build-time e2e-seam gate (electron.vite.config.ts `define`), mirrored from e2eMain.ts. M11:
// installE2EMain captures the `mcp` VALUE, so under the e2e seam we must eager-start the lazy MCP
// server before that call — gated on the SAME (compile ∧ runtime) predicate e2eMain uses.
declare const __ENABLE_E2E_MAIN__: boolean

let mainWindow: BrowserWindow | null = null
// Phase 1 accounts: the sign-in service is constructed in whenReady (needs userData + the
// safeStorage encryptor). A deep-link that arrives before then buffers inside the router
// (deepLinkBoot.ts) until connect() hands it the live service callback.
let authService: AuthService | null = null
const deepLinks = createDeepLinkRouter(() => mainWindow)
// BUG-024: entitlementCache.isFresh() existed but no caller ever consulted it — the cache was
// written once at sign-in and trusted indefinitely, so a Stripe-side cancel/lapse would never
// reach the desktop. Re-check on startup (below), gated by this TTL so it costs at most one
// license GET per hour of app runtime.
const ENTITLEMENT_TTL_MS = 60 * 60 * 1000
let localServer: LocalServer | null = null
// M11: the resolved lazy MCP server (or null). Written by ensureMcp()'s publish callback (createMcpBoot
// owns the memoization latch); read by the () => mcp getters below. Eager boot-time start removed so the
// ESM @expanse-ade/mcp import + Express/SDK heap are paid only on first orchestration use.
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
// Background project sessions (Phase 1 + C1 cap/TTL): the backgrounded-project registry + its
// idle sweep live in backgroundSessions.ts (extracted for the max-lines ratchet; every dep is a
// module import). App-run lifetime only — quit's disposeAll* kills background resources too, so the
// registry is never persisted or drained at shutdown.

const SMOKE = process.env.CANVAS_SMOKE // "1"=self-test (keep open), "exit"=self-test+quit

// Dev profile isolation (profileIsolation.ts): every unpackaged instance gets a PER-CHECKOUT
// userData (main-checkout dev, worktree devs, the e2e/smoke harnesses), so concurrent instances
// never share a Chromium profile or the app's JSON stores — the "close all Expanse windows
// before a dev check" ritual dies here. Module scope: must precede the single-instance lock
// (keyed on userData) and every userData read. Packaged builds and the voice spike (which owns
// its own redirect, below) are left untouched. CANVAS_USERDATA overrides; CANVAS_FRESH=1 mints
// a throwaway profile, deleted on quit (best-effort — Windows may still hold a handle).
const devProfile = applyDevProfileIsolation(app, process.env, process.cwd())
if (devProfile.fresh && devProfile.dir) {
  const freshDir = devProfile.dir
  app.on('will-quit', () => {
    try {
      rmSync(freshDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })
}

// Voice boot env (voiceBoot.ts): the fake-mic switches (CANVAS_FAKE_MEDIA) + the spike
// run's userData isolation. Module scope: appendSwitch must run before app.ready, and the
// userData redirect must precede the single-instance lock below (it is keyed on userData).
applyVoiceBootEnv()

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
  // macOS PTY-orphan fix: on darwin, window-all-closed does NOT quit, so the before-quit
  // PTY drain never fires and live/parked agent PTYs are orphaned — performWindowCloseCleanup
  // reaps them here (darwin only; Win/Linux keep the awaited before-quit drain). See quit.ts.
  mainWindow.on('closed', () => {
    performWindowCloseCleanup({
      platform: process.platform,
      disposeOsr: disposeAllOsr, // close offscreen preview renderers
      disposeDiagramWorker, // close the hidden Mermaid render worker (S4)
      // darwin-only PTY-tree reap (guarded inside). Phase 5: persist background parks'
      // ring tails first — this darwin close is a quit-equivalent for PTYs (see quit.ts),
      // and the before-quit shutdown() that normally appends them never fires here.
      disposePtys: () => {
        persistBackgroundRingTails(appendTerminalSnapshot)
        return disposeAllPtys()
      }
    })
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
  // Voice V0: pin the DEFAULT session's permission posture (mic-only media + clipboard
  // write for the app page; everything else denied). Without a handler Electron
  // auto-grants every request and leaks enumerateDevices() labels pre-grant. The
  // preview/diagram sessions keep their own deny-alls (separate partitions).
  registerMicPermissionPosture(mainWindow.webContents.session, appOrigin)
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
  // BUG-056: the renderer's dependency-smoke probe (useRendererSmoke) must only run
  // under the CANVAS_SMOKE harness, so pass `?smoke=1` the same way — otherwise it
  // has no signal and either always/never runs regardless of the env var.
  const seedHarness = !!process.env.CANVAS_E2E
  const query: Record<string, string> = {}
  if (seedHarness) query.e2e = '1'
  if (SMOKE) query.smoke = '1'
  const qs = Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : ''
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const base = process.env['ELECTRON_RENDERER_URL']
    mainWindow.loadURL(`${base}${qs}`)
  } else {
    // Same path the nav guard pins to via appDocPath above (indexHtmlPath).
    mainWindow.loadFile(indexHtmlPath, qs ? { query } : undefined)
  }
}

// ── Phase 1 accounts: OAuth deep-link (expanse://) + single-instance lock ───────────────────────
// The OAuth callback from the system browser returns to the app via the custom scheme. On
// Windows/Linux the OS launches a SECOND instance carrying the URL in argv, which the running
// primary receives through 'second-instance' — that requires the single-instance lock, acquired
// BEFORE whenReady (calling it later is a silent no-op). macOS delivers it via 'open-url' instead.
//
// PACKAGED-ONLY: dev intentionally allows several concurrent instances (multiple worktrees /
// title-stamped PR checks — see CLAUDE.md "Manual dev check"), and the e2e harness runs UNPACKAGED
// against a shared persistent userData; the lock is keyed on userData, so taking it there would
// deny the second launch. app.isPackaged is false in both, so the lock is only ever taken in a real
// packaged build (where the deep-link actually matters). Verify via `pnpm pack:dir`.
//
const gotSingleInstanceLock = app.isPackaged ? app.requestSingleInstanceLock() : true
if (!gotSingleInstanceLock) {
  // A second instance (e.g. the OS opening an expanse:// link) — the primary handles it; exit now.
  app.quit()
}

// Deep-link routing (deepLinkBoot.ts): OS registration + open-url/second-instance handlers.
if (app.isPackaged && gotSingleInstanceLock) deepLinks.installPackagedHandlers()

app.whenReady().then(async () => {
  // A second packaged instance (no lock) is already quitting — don't build a window or wire IPC.
  if (!gotSingleInstanceLock) return
  // Voice V2/V5 spike gate (voiceBoot.ts): prove the sherpa addon loads in THIS layout
  // (host + decoder worker), print a marker, exit. Never part of a normal boot.
  if (await runVoiceSpikeGate(smokeLog)) return
  // Taskbar identity: packaged keeps the product AUMID; dev gets a PER-CHECKOUT one so several
  // dev instances group per checkout instead of with each other / the installed app. (The toolkit
  // helper pins dev to process.execPath — the SAME electron.exe for every checkout via the
  // node_modules junction — so the dev branch calls the raw API.)
  if (app.isPackaged) electronApp.setAppUserModelId('com.expanse.app')
  else if (process.platform === 'win32')
    app.setAppUserModelId(`com.expanse.dev.${devProfile.slug ?? 'dev'}`)
  // Cold start via the scheme (Windows/Linux first launch): the deep-link URL is in our argv.
  if (app.isPackaged) deepLinks.handleColdStart()
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
  // Low-RAM (AUDIT §5): bind the override file dir; the mode itself is decided lazily on first read
  // (os.totalmem, or the userData override). Must precede registerPlatformIpc so platform:lowRam
  // resolves the bound config.
  bindLowRamConfig(userData)
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

  // ── Cross-cwd recap hook install (spawn-time) ─────────────────────────────────────────
  // The env var above reaches EVERY consented spawn, but the recap hook itself only ever
  // landed in the OPEN project's .claude/settings.local.json (project open + window focus).
  // Claude Code reads hooks from the directory it launches in — so a board whose cwd points at
  // another repo (MCP spawn_board cwd, the Inspector's Edit… cwd) ran a claude that never fired
  // recordSession.js: no map entry, "Capture didn't record this session", no Resume. pty.ts
  // calls this synchronously just before the launch line (inside its own try/catch), mirroring
  // the orchestration config sync that already re-stamps .mcp.json into the spawn cwd.
  // Skip the user home dir: it's the safeCwd fallback for a missing/invalid cwd, and
  // ~/.claude/settings.local.json is Claude Code USER scope — a hook there would fire for every
  // claude session on the machine, not just this project's boards.
  setRecapHookSyncProvider(({ cwd }) => {
    if (!recapRunner) return
    const dir = getCurrentDir()
    if (!dir || readConsent(userData, dir) !== 'enabled') return
    if (cwd === homedir()) return
    installRecapHook({
      projectDir: cwd,
      command: recapRunner,
      scriptPath: recordScript,
      mapPath: recapMapPath
    })
    // Review [warning]: track every divergent install (keyed by the CONSENTING project) so a
    // consent decline can clean each cross-cwd repo too — mirrors provisionedDirStore (F8).
    recordRecapHookDir(userData, dir, cwd)
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
  registerVoiceHandlers(ipcMain, () => mainWindow) // voice V1: session control + port broker
  registerClipboardHandlers(ipcMain, () => mainWindow)
  // General external-open channel (scheme re-validated in MAIN) — Phase 4 terminal web-links.
  registerShellHandlers(ipcMain, () => mainWindow)
  // Phase 5 · S1: frame-guarded "save terminal output to file" (native dialog + atomic write).
  registerTerminalHandlers(ipcMain, () => mainWindow)
  // SYNC platform info (Windows build number) for the terminal's xterm windowsPty hint (A-Win).
  registerPlatformIpc(ipcMain, () => mainWindow)
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
  // Cross-project routing (#321): the pending-command store + foreground drainer are armed EAGERLY —
  // a queued command must deliver when its project is next foregrounded even before the lazy MCP
  // server boots (the drainer subscribes to board snapshots, independent of the loopback server). Its
  // registry slice is passed into createMcpBoot for the (lazy) startMcpServer registry.
  const mcpRouting = startMcpCommandRouting({ userData, bus: ipcMain, getWin: () => mainWindow })
  // M11: lazy-start the in-app MCP loopback server (registry assembly + memoized ensureMcp live in
  // mcpBoot.ts) — the ESM @expanse-ade/mcp import + Express/SDK heap + loopback bind are paid only on
  // the FIRST orchestration use, not at boot. `publish` writes the resolved server into `mcp` so the
  // () => mcp getters below observe it.
  const ensureMcp = createMcpBoot({
    getWin: () => mainWindow,
    userData,
    mcpRouting,
    publish: (m) => {
      mcp = m
    }
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

  // ── Phase 1 accounts: construct the sign-in service (reuses the safeStorage encryptor) + register
  //    its IPC, then flush any deep-link that arrived before the service existed (open-url pre-ready).
  authService = createAuthService({
    config: AUTH_CONFIG,
    tokenStore: createAuthTokenStore(userData, llmEncryptor),
    session: {
      read: () => readSession(userData),
      write: (s) => writeSession(userData, s),
      clear: () => clearSession(userData)
    },
    entitlement: {
      read: () => readEntitlement(userData),
      write: (e) => writeEntitlement(userData, e),
      clear: () => clearEntitlement(userData)
    },
    openExternal: (url) => void shell.openExternal(url),
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    onStatusChanged: (s) => pushAuthStatus(() => mainWindow, s)
  })
  registerAuthHandlers(ipcMain, () => mainWindow, authService)
  const auth = authService
  deepLinks.connect((url) => void auth.handleCallback(url))
  // BUG-024: re-verify a stale cached entitlement against the backend on every cold start (no-op
  // when signed out or still within the TTL) so a lapsed/canceled subscription doesn't stay
  // trusted indefinitely just because the app happened to stay signed in.
  void authService.syncEntitlementIfStale(ENTITLEMENT_TTL_MS)
  // Isolate the key/config/budget store under a throwaway temp dir for ANY e2e run so a test
  // key never lands in real userData. The current Playwright harness sets CANVAS_E2E (not the
  // retired CANVAS_SMOKE=e2e), so gate on both — the old SMOKE-only guard was dead (F-A).
  const llmIsolated = !!process.env.CANVAS_E2E || SMOKE === 'e2e'
  const llmDataDir = llmIsolated ? mkdtempSync(join(tmpdir(), 'canvas-e2e-llm-')) : userData
  if (llmIsolated) process.env.CANVAS_E2E_LLM_DIR = llmDataDir

  // Recap-refresh fix A4: the ONE transcript resolver every recap read path uses. Threads the
  // recap-map entry's clocks (recordedAt = the hook's ts; sessionId = the lineage anchor) and
  // the board's live PTY activity into resolveLiveTranscriptPath so it can (a) refuse to scan
  // onto an OLDER session during the eager-capture window and (b) adopt a lineage-proven
  // rotation successor while the old file still exists. Entry clocks apply only when the
  // recorded path IS the map entry's (a divergent persisted board path keeps legacy behavior).
  const resolveBoardTranscript = (
    boardId: string,
    recorded: string | undefined
  ): string | undefined => {
    let lastActive: number | undefined
    try {
      lastActive = getTerminalRuntime(boardId)?.lastActivityAt
    } catch {
      lastActive = undefined
    }
    // F4 (#295 carry-in): clock selection now also matches the entry's CONFIRMED capture path,
    // so a rotated confirmed session adopts its successor — see selectTranscriptClocks.
    return resolveLiveTranscriptPath(recorded, {
      ...selectTranscriptClocks(recapMap.get(boardId), recorded),
      agentActiveAt: lastActive
    })
  }

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
    // Terminal recap (Task 10 Step 4): distil a terminal board's transcript into milestones —
    // body + the BUG-002 consent gate + trusted-path guard live in agentMilestones.ts
    // (extracted under the max-lines ratchet; behavior unchanged).
    getAgentMilestones: createGetAgentMilestones({
      getCurrentDir,
      isConsented: (dir) => readConsent(userData, dir) === 'enabled',
      resolveTranscript: resolveBoardTranscript,
      getRecordedPath: (id) => recapMap.get(id)?.transcriptPath
    }),
    // Recap-refresh fix: the sidecar-regen push. Fired by the loop ONLY after writeBoardRecap
    // durably rewrote board-<id>.recap.json (watcher-driven OR manual refresh), so an open
    // RecapView re-reads instead of waiting for the next flip. Same destroyed-window guards as
    // the recap:learned sender below (this too can fire from a debounced timer at teardown).
    onRecapWritten: (boardId, asOf) => {
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      const wc = win.webContents
      if (!wc.isDestroyed()) wc.send('recap:updated', { boardId, asOf })
    }
  })
  // PR-4: derive a board's BoardResult from its recap transcript. getFacts resolves the SAME
  // trusted transcript tail the recap face reads (no egress, no consent — local read only) and
  // returns null when there is no transcript yet (nothing to verdict). The synthesizer records a
  // result only for a SETTLED agent and never clobbers an explicit `write_result` (see
  // boardResultSynth.ts). Driven below off the watcher's onIntent settle signal.
  resultSynth = createResultSynthesizer({
    getFacts: (boardId) => {
      const path = resolveBoardTranscript(boardId, recapMap.get(boardId)?.transcriptPath)
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
      const dir = getCurrentDir()
      const recorded =
        (dir ? persistedTranscriptPath(readProject, dir, boardId) : undefined) ??
        recapMap.get(boardId)?.transcriptPath
      return resolveBoardTranscript(boardId, recorded)
    },
    getTerminalRuntime
  })
  // Terminal-resume F1+F3 (see terminalResume.ts): validate canResume + build the Resume launch
  // line from the transcript's on-disk reality, through the SAME A4 resolver the recap reads use.
  registerTerminalResumeIpc(ipcMain, {
    getWin: () => mainWindow,
    resolveTranscript: resolveBoardTranscript,
    getMapEntries: () => recapMap
  })
  // F4 (terminal-resume): hook-health probe for the Inspector's fault-only status line, and the
  // focus-time self-heal — a clobbered .claude/settings.local.json re-ensures on the next window
  // focus instead of waiting for the next project open. Consent-off → null → renders nothing.
  const recapHealthDeps = {
    getCurrentDir,
    isConsented: (dir: string) => readConsent(userData, dir) === 'enabled',
    runnerOk: () => recapRunner !== null
  }
  registerRecapHealthIpc(ipcMain, {
    ...recapHealthDeps,
    getWin: () => mainWindow,
    hookInstalled: (dir) => isRecapHookInstalled(dir, recordScript),
    hasCapture: (id) => recapMap.has(id),
    sessionAgeMs: (id) => getTerminalBootInfo(id)?.ageMs ?? null,
    // Cross-cwd recap capture: probe the hook where the board's claude actually launched.
    // A homedir cwd is the safeCwd fallback (cwd-less/invalid board), not a project scope we
    // manage — the spawn-time install skips it, so probe the open project dir instead (the
    // pre-fix behavior for default boards).
    boardCwd: (id) => {
      const cwd = getTerminalCwd(id)
      return cwd === homedir() ? undefined : cwd
    }
  })
  const recapReEnsure = createFocusReEnsure({
    ...recapHealthDeps,
    // installRecapHook no-ops on an empty command; runnerOk gates before this runs anyway.
    install: (dir) =>
      installRecapHook({
        projectDir: dir,
        command: recapRunner ?? '',
        scriptPath: recordScript,
        mapPath: recapMapPath
      }),
    // Cross-cwd recap capture: heal every live board cwd too (spawn-time installs can be
    // clobbered mid-session as well). Derived from the board mirror through the pty cwd map
    // (non-terminals resolve undefined). Home-dir skip matches the spawn-time policy.
    extraDirs: () => [
      ...new Set(
        listBoardMirror()
          .map((b) => getTerminalCwd(b.id))
          .filter((d): d is string => !!d && d !== homedir())
      )
    ]
  })
  app.on('browser-window-focus', recapReEnsure)
  registerProjectHandlers(
    ipcMain,
    () => mainWindow,
    userData,
    undefined,
    memoryEngine,
    // T-F4: manual ⟳ refresh → the SAME budgeted/passive summarize the detector drives (awaited so
    // the renderer can flip its "updating…" state off once the prose is rewritten).
    // Recap-refresh fix: route the manual path through refresh() so the outcome (recap written /
    // skipped + reason / llm-unavailable / coalesced) reaches the renderer via memory:refresh.
    (boardId) => summaryLoop.refresh(boardId),
    // Terminal recap (Task 10 Step 5): on opening an already-consented project, re-ensure the recap
    // SessionStart hook so a project consented in a prior session keeps recording. Idempotent
    // (installRecapHook no-ops when present). Best-effort — projectIpc wraps this in try/catch.
    (dir) => {
      // BUG-035 (verify follow-up): board results are per-project — an id-colliding
      // board in the next project must not inherit the previous project's verdict.
      // Phase 5 (bg sessions): the open-clear now SPARES background residents' results —
      // a resident's verdict must survive until its switch-back (id-keyed, so the R1
      // clone-collision caveat applies; accepted + ADR'd for v1). onBoardsObserved's
      // prune handles deletions WITHIN a project.
      pruneBoardResults(backgroundParkedBoardIds())
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
      // M11: a project consented in a PRIOR session never fires the ENABLE onChange this run, so
      // warm the loopback MCP server when opening an already-orchestration-consented project —
      // before the user spawns a consented terminal (whose spawn-time provisioner mints against the
      // live server). Memoized ⇒ a no-op after the first open. Mirrors the recap re-ensure just above.
      if (isOrchestrationEnabled(dir)) {
        void ensureMcp().catch((err) =>
          console.error('[mcp] lazy start on project open failed', err)
        )
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
      // Phase 5 (bg sessions): prune to the UNION of the active project's live boards and
      // the background residents' parked ids — a switch must not destroy a resident's
      // verdict (it re-surfaces on switch-back).
      const residentIds = backgroundParkedBoardIds()
      pruneBoardResults(new Set([...liveBoardIds, ...residentIds]))
      // Re-arm watchers for live boards that the in-memory recapMap knows about but whose
      // fs.watch handle was disposed when we switched away from this project.
      // Phase 5 recap gating: SKIP ids that are also background-parked — an id that is both
      // live here and parked for a resident is the R1 clone collision, and tracking the
      // RESIDENT's transcript for the active clone's board would cross-wire the projects.
      for (const [boardId, entry] of recapMap.entries()) {
        if (liveBoardIds.has(boardId) && !residentIds.has(boardId)) {
          recapWatcher?.track(boardId, entry.transcriptPath)
        }
      }
    },
    // Background sessions (Phase 1): a successful open/reopen forgets any backgrounded state
    // for the now-active dir (idempotent for a never-backgrounded one) — see projectSessions.
    (dir) => projectSessions.foregroundProject(dir)
  )
  // Background project sessions: the switch-pipeline control plane (Phase 2) + the Phase-4
  // keep-policy plane (ask-on-switch info · set/forget keep · ∞ badges). Flag-free since
  // Phase 4 — keep-running is the shipped behavior, mediated by the dialog.
  registerProjectSessionsHandlers(ipcMain, () => mainWindow, {
    sessions: projectSessions,
    getCurrentDir,
    disposeProjectPtys,
    disposeProjectOsr
  })
  // Global project-switch hotkey (OS-wide accelerators → foreground + cycle). All wiring +
  // Settings IPC lives in globalHotkey.ts; register-fail is surfaced, never swallowed. Electron
  // auto-unregisters global shortcuts on quit, so there is no shutdown() teardown to thread here.
  wireGlobalHotkey(ipcMain, () => mainWindow, userData)
  // Phase 4b: project-dock thumbnails — capture keyed to the MAIN-resolved active dir, cached
  // in userData/project-thumbs (app cache, never the project folder), served only for the
  // session set (active + registry residents).
  registerProjectThumbHandlers(ipcMain, () => mainWindow, {
    getCurrentDir,
    sessionDirs: () => projectSessions.listBackgroundProjects().map((b) => b.dir),
    thumbsDir: () => join(app.getPath('userData'), 'project-thumbs')
  })
  registerLlmHandlers(ipcMain, () => mainWindow, llmDataDir, undefined, llmEncryptor)
  // Configurable MCP spawn cap (orchestration:getSpawnCap / setSpawnCap, frame-guarded). Stored in
  // the REAL userData (app-wide config — the MCP server is a process singleton), never the isolated
  // llmDataDir; the orchestrator reads the same file via the `cap` getter passed to startMcpServer.
  registerSpawnCapHandlers(ipcMain, () => mainWindow, userData)
  // Project Library (list/reveal/open files saved under <project>/.canvas/{downloads,assets}).
  registerProjectLibraryIpc(ipcMain, () => mainWindow)

  // ── Recap consent IPC + hook-install policy (Task 10 Step 5) ────────────────────────
  // recap:getConsent / recap:setConsent (frame-guarded inside recapConsent.ts). The decision
  // callback owns the consent-driven install/remove of the project's .claude/settings.local.json
  // hook ('enabled' → install idempotently, anything else → remove only OUR entry) — the
  // spawn-time / boot-detect providers above may ALSO install into a board's divergent cwd, and
  // every such install is tracked in recapHookDirs so the decline below cleans those too. The
  // map path is baked into the hook args so the external Claude process appends to the app map.
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
        // Review [warning]: also remove OUR hook entry from every divergent cwd this project's
        // consent ever installed into (tracked by the providers above; persisted across
        // restarts). Per-dir try/catch — one unwritable repo must not strand the others.
        for (const divergent of listRecapHookDirs(userData, projectPath)) {
          try {
            removeRecapHook(divergent, recordScript)
          } catch {
            /* best-effort cleanup */
          }
        }
        clearRecapHookDirs(userData, projectPath)
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
      } else {
        // M11: first ENABLE this session → lazy-start the loopback MCP server NOW, before the user's
        // next terminal spawn (a separate, seconds-later gesture), so the spawn-time provisioner's
        // mintTerminalToken finds a live minter instead of throwing (its throw is swallowed → the
        // agent's .mcp.json would silently miss until a later spawn). Memoized ⇒ no-op if already up.
        void ensureMcp().catch((err) => console.error('[mcp] lazy start on enable failed', err))
      }
    }
  )

  // Spawn-time auto-sync (WT-provision P3 hook): on each terminal start, if the project has
  // orchestration consent and the launch command starts a known CLI, write that CLI's MCP config
  // with a freshly-minted connected-tier token BEFORE the launch line runs — the live loopback
  // endpoint + bearer rotate each app restart, so re-syncing here is what fixes the
  // stale-config-after-restart failure ("tool doesn't exist"). Errors are swallowed by pty.ts's
  // spawn-time try/catch, so a provisioning failure can never break a spawn. 🔒 token never logged.
  //
  // External MCP servers (feature: add external MCP servers): a PARALLEL spawn-time writer composed
  // into the same pty slot. It writes the user's OWN enabled external servers into the launching
  // CLI's config — gated ONLY on enabled+targets, NOT orchestration consent (they are the user's
  // servers, not Expanse authority). Each provider is wrapped so one failing never blocks the other,
  // and both sit inside pty.ts's spawn try/catch. The store + dir-tracking live under `llmDataDir`
  // (the same e2e-isolated sensitive-data dir), so a test key/config never lands in real userData.
  const mcpServersStore = createMcpServersStore(llmDataDir, llmEncryptor)
  bindExternalSyncStore(llmDataDir)
  registerMcpServersHandlers(ipcMain, () => mainWindow, {
    store: mcpServersStore,
    probe: probeExternalServer
  })
  const orchestrationSync = makeOrchestrationSyncProvider({
    getProjectDir: getCurrentDir,
    mintToken: mintTerminalToken
  })
  const externalMcpSync = makeExternalMcpSyncProvider({
    getProjectDir: getCurrentDir,
    store: mcpServersStore
  })
  setOrchestrationSyncProvider((opts) => {
    try {
      orchestrationSync(opts)
    } catch {
      /* canvas-ade sync failure must never block the external write (or the spawn) */
    }
    try {
      externalMcpSync(opts)
    } catch {
      /* external sync failure must never block the spawn */
    }
  })

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
    for (const [boardId, entry] of m.entries()) recapWatcher?.track(boardId, entry.transcriptPath)
    // BUG-001: this onChange runs inside agentRecapMap's bare debounce setTimeout, so a
    // throw escapes to uncaughtException -> crashShutdown(1). Optional chaining does NOT
    // stop the .webContents getter from THROWING on a destroyed-but-non-null window, so
    // guard isDestroyed() BEFORE dereferencing .webContents (mirrors flushRenderer).
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (!win.webContents.isDestroyed()) win.webContents.send('recap:learned', patches)
  })

  // C1: arm the background-session idle-TTL sweep (skipped under the headless self-test); it reaps
  // idle residents via the scoped ring-flush-then-dispose close. Torn down in shutdown().
  if (!SMOKE) startBackgroundIdleSweep()

  // ── Desktop notifications: agent lifecycle → OS notification + in-app toast + on-canvas ────
  // The recap hook fires on Stop / Notification (RECAP_HOOK_EVENTS), each appended to
  // the SAME session map. wireLifecycleNotifications registers the notifications:* IPC, watches that
  // map for NEW lines (skips history at init — no boot replay), gates + delivers each event, and
  // routes the generic-PTY path into the same delivery site. Self-disposes on before-quit.
  wireLifecycleNotifications(() => mainWindow, recapMapPath, userData)

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
  // F4: recapReEnsure rides along so a spec can drive the heal without a real OS focus event.
  if (mainWindow) {
    // M11: installE2EMain captures the `mcp` VALUE (not the () => mcp getter), so under the e2e seam
    // a lazily-null mcp would strand the mcp.e2e.ts tier smoke (mcpInfo/gitDiff/spawnGroupNow/…).
    // Match e2eMain's exact gate (__ENABLE_E2E_MAIN__ ∧ CANVAS_E2E) and eager-start so the seam
    // captures the live server. Production never enters here (either half of the gate is false).
    if (__ENABLE_E2E_MAIN__ && process.env.CANVAS_E2E) await ensureMcp()
    installE2EMain(mainWindow, defaultPreviewUrl, mcp, () => resultSynth, recapReEnsure)
  }

  // Phase 5 auto-update (gated · tiered) — full wiring in autoUpdateWiring.ts › startAutoUpdate
  // (this file stays a thin caller). A NO-OP in dev/unsigned builds. The localFeedUrl ternary is
  // the dev-only local update channel: compile-gated, so distributed builds fold it to null and
  // tree-shake localUpdateFeed out entirely (posture: src/main/localUpdateFeed.ts). A rejection
  // here means the gate was open but init failed — log it, never an unhandled rejection.
  startAutoUpdate({
    enabled: __ENABLE_AUTO_UPDATE__,
    isPackaged: app.isPackaged,
    ipc: ipcMain,
    getWin: () => mainWindow,
    currentVersion: app.getVersion(),
    localFeedUrl: __LOCAL_UPDATE_CHANNEL__ ? readLocalFeedOverride(app.getPath('userData')) : null
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
  // Phase 5 (bg sessions): background parks' post-park output lives ONLY in their rings
  // (the renderer flush serializes just the ACTIVE project's mounted xterms) — append each
  // tail to its owning project's sidecar BEFORE the rings die in the PTY drain. Sync +
  // best-effort, so the crash sinks that share this teardown can run it too.
  persistBackgroundRingTails(appendTerminalSnapshot)
  const drained = disposeAllPtys()
  disposeAllOsr() // close offscreen preview renderers
  disposeDiagramWorker() // close the hidden Mermaid render worker (S4)
  disposeVoiceSession() // kill the sherpa-onnx utilityProcess engine host (voice V2)
  const mcpClosed = mcp?.close() ?? Promise.resolve()
  mcp = null
  localServer?.close()
  localServer = null
  // Terminal recap (Task 10): stop the session-map fs.watch so it can't fire after teardown.
  // Idempotent — watchRecapMap's disposer is safe to call once; null it so a second shutdown()
  // (this fn is shared by before-quit + the crash sinks) is a no-op.
  stopRecapWatch?.()
  stopRecapWatch = null
  // C1: stop the background-session idle sweep so it can't fire after teardown.
  stopBackgroundIdleSweep()
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

/** BUG-M2 renderer autosave flush before a hard exit — body lives in flushChannel.ts
 *  (`flushRendererAutosave`, moved beside its channel/finish primitives by the max-lines
 *  ratchet); this wrapper just binds the module's ipcMain + live window. */
function flushRenderer(timeoutMs = 1500): Promise<void> {
  return flushRendererAutosave(ipcMain, () => mainWindow, timeoutMs)
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
  // It also catches a shutdown() rejection (quit-reject-catch) so the fire-and-forget `void` call
  // here can never surface as an unhandled rejection.
  void performGuardedQuit({
    flush: flushRenderer,
    shutdown,
    exit: (code) => app.exit(code),
    onFlushError: (err) =>
      console.error('[before-quit] renderer flush failed; proceeding to shutdown', err),
    onShutdownError: (err) => console.error('[before-quit] shutdown failed; exiting anyway', err)
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
