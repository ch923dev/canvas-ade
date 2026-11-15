# Deep review + Electron → Rust migration plan

**Date:** 2026-11-15 · **Reviewed tree:** `main` @ `9d07af84` (v0.48.2; one commit behind `origin/main` — #452 WS-3 not included)
**Method:** three Opus reviewers (MAIN native surfaces · MAIN data/services · preload + renderer), read-only, plus coordinator spot-checks of the top findings against the code, a health-gate run, and web research on the Rust shell options.
**Owner decisions, 2026-11-15 (after the first draft):** Electron stays as the **legacy** project and takes **fixes only**; the Rust version is a **separate project**, not a conversion of this repo — recorded as [ADR 0015](../decisions/0015-legacy-line-fixes-only.md). Sections 0, 3.1, 4 and 6 were rewritten to match. The first draft recommended moving pieces into Rust inside the Electron app; that route is ruled out.
**Fixed since the review:** P1 #1 and #2 (asset GC) by #453, v0.48.4; a third sweep of the same kind (Browser-board screenshots) by #454, v0.48.5. Everything else in §2 was open when this file was committed.

---

## 0. Bottom line

**The code is in good shape.** Typecheck is clean, 7,901 of 7,910 unit/integration tests pass (the 2 failures are the known environment-only `pathSafe` 8.3-TEMP class), the security model is applied consistently, and the logic is unusually well dependency-injected. The review still found **5 P1 defects**, two of which silently lose user data on every project open (asset GC).

**On Rust: Electron stays as the legacy project and the Rust version is built as a separate project** (owner decision). Three facts decide what that project looks like:

1. **Chromium cannot be removed.** The Browser board is built on offscreen Chromium rendering plus CDP (`offscreen: true` → `paint` → BGRA frames → `<canvas>`, input/IME/dialogs/Network over `webContents.debugger`). No system webview (WebView2, WKWebView, WebKitGTK) offers that. So the realistic Rust shell is **Tauri 3 + the CEF runtime**, which is still **alpha** (`3.0.0-alpha.7`, 2026-11-06, no stable date), has **no offscreen rendering support** in the runtime yet, and currently runs **Windows renderers unsandboxed**. It also ships Chromium, so it does **not** make the app smaller or lighter than Electron.
2. **The renderer is already shell-agnostic.** 92K LOC with zero Electron/Node imports; everything goes through one typed `window.api` (391 call sites, 122 files). It survives any Chromium-based shell behind an adapter.
3. **MAIN already has clean seams.** The PTY host is a separate daemon speaking NDJSON over a named pipe (10 ops). 63% of the data/services layer (21.7K LOC) imports neither Node nor Electron. Only 2 of its 139 files import `electron` at runtime.

So the Rust version is: **a Tauri 3 + CEF shell, the legacy React renderer copied in unchanged and run on a `window.api` compatibility shim, and a Rust backend built as crates**, with the TypeScript orchestration layer (MCP, swarm, Jarvis) running as a Node sidecar at first. It is built in vertical slices (§4), with legacy as the reference implementation and three spikes up front that decide whether the terminal, Browser board and shell are feasible.

What the Rust version buys: no native Node addons (no `electron-rebuild`, no Spectre-libs prerequisite, no ABI rebuild per shell bump), a ~3 MB PTY daemon instead of a staged 245 MB Electron copy, memory-safe I/O hot paths, and an exit from Electron. What it does not buy: bundle size, RAM, or renderer performance — Chromium and the same React UI are still there.

What the separate-project route costs: nothing reaches users until the new app has working terminals, legacy has to be maintained in parallel, and the defects below stay in legacy until fixed there.

---

## 1. Snapshot

| | |
|---|---|
| Source (non-test) | MAIN ≈ 54K LOC / 232 files · renderer ≈ 92K / 488 · preload ≈ 2.2K / 14 · shared ≈ 3.8K / 15 |
| Tests | 551 vitest files / 7,910 cases (MAIN 212 files, renderer 319) · e2e 104 specs / ≈ 380 tests (Playwright `_electron`) |
| Health (this run) | `pnpm typecheck` exit 0 · `pnpm test`: 7,901 pass / 2 fail (`pathSafe.test.ts`, env-only) / 7 skipped |
| IPC surface | 211 methods on one `window.api`: 173 `invoke`, 31 push subscriptions, 5 MAIN→renderer request/reply, 4 `sendSync` (preload boot), 4 MessagePort streams (PTY, voice ×3) |
| Native addons | `node-pty` 1.2.0-beta.13, `sherpa-onnx-node` |
| Electron-only test harness | 57 of 104 e2e specs call MAIN through `__canvasE2EMain` (≈ 90 methods, `src/main/e2eMain.ts`) |

Not run: e2e, SCA audit, packaging.

---

## 2. Review findings

Verification column: **V** = coordinator re-read the cited code and the mechanism holds · **R** = reviewer-read only · nothing was executed, so every scenario is traced, not reproduced.

### P1

| # | Finding | Where | Failure | Ver. |
|---|---|---|---|---|
| 1 | **Asset GC sweeps every Kanban card attachment on project open.** `collectAssetIds` walks only `boards[].elements[]` (image / diagram `svgCache`) and the root `background`. Card attachments live at `boards[].cards[].attachments[].assetId` and are never collected. | `src/main/projectStore.ts:564-587`; callers `src/main/projectIpc.ts:311-315`, `:521-524`; shape `src/renderer/src/lib/kanbanSchema.ts:39,76` | Attach a file to a card, reopen the project: the blob is moved to `.canvas/assets/.trash/`, `asset:read` returns null, the attachment is broken. Recoverable by hand from `.trash`, invisible to the user. No reopen e2e. | V |
| 2 | **Asset GC sweeps a newly chosen file wallpaper.** `background` is a session key, so a backdrop-only change writes `.canvas/session.json` and never rewrites `canvas.json`. GC unions `canvas.json` + `.bak` only. The renderer then sees a missing asset and persists `kind: 'none'`. | `src/renderer/src/store/useAutosave.ts:46-47`; `src/main/projectIpc.ts:311-315`; `src/renderer/src/canvas/backdrop/BackdropLayer.tsx:41-49` | Pick a wallpaper, quit without touching a board, relaunch: wallpaper gone, setting reverted. | V |
| 3 | **PTY daemon: a late `exit` from a killed session deletes its same-id replacement.** `kill` removes the session and tree-kills asynchronously; the old process's `onExit` closure later runs `sessions.delete(msg.id)` and sends `exit` by id with no identity check. Restart respawns immediately under the same board id. | `src/main/ptyHost/daemonMain.ts:227-237`, `:294-314`; `src/main/ptyHost/client.ts:134-139,463`; `src/renderer/src/canvas/boards/terminal/useTerminalSpawn.ts:1326` | Restart a terminal under the daemon: the fresh session can show "exited", fire a spurious notification, and the new agent keeps running untracked (quit no longer kills it). MAIN's in-proc path has an `isStaleExit` guard; the daemon has none. | V (daemon side) |
| 4 | **Daemon sessions that are not re-adopted survive "Stop all & close".** Keep-drain detaches daemon proxies, including background and undo parks. After relaunch they exist only in `daemonSurvivors`, which is consumed by owner-scoped reattach or a same-id spawn. `disposeAllPtys` walks MAIN's maps only; `shutdownPtyHostDaemon` has exactly one caller, the tray's stop-all. | `src/main/ptyHost/quitDrain.ts:51-54`; `src/main/ptyHost/bridge.ts:136-170,242-248`; `src/main/pty.ts:1062-1067`; `src/main/trayResidency.ts:121-129` | Background project B with agents running → "Keep running" → reopen into A → quit with "Stop all & close": B's agents keep running headless and were never listed in the close modal. Contradicts ADR 0011. | V (structure) |
| 5 | **MCP `spawn_board.prompt` / `spawn_group.launchCommand` run a shell line with no human confirm and no audit row.** The lifecycle factory is built without `confirm` or `audit`; the prompt is sanitized to one line and becomes the first PTY line. The same field through `configure_board` is treated as an exec vector (confirm + audit). CLAUDE.md states "nothing the MCP draws ever runs code". | `src/main/mcpOrchestrator.ts:372-378,522-528`; `src/main/mcpLifecycle.ts:288-333`; `src/renderer/src/store/useMcpCommands.ts:69-175` (validates, does not confirm) | A prompt-injected but consented agent calls `spawn_board({type:'terminal', prompt:'…'})`: the command runs outside that CLI's own permission prompts and leaves no trace in the MCP audit log. Severity depends on whether each CLI auto-approves MCP tool calls. If spawn-without-confirm is intended (it is how leads launch workers), it needs at least an audit row and a doc fix. | V |

### P2

| # | Finding | Where | Ver. |
|---|---|---|---|
| 6 | **NDJSON pipe decodes each socket chunk separately** (`chunk.toString('utf8')`, no `StringDecoder`), on both ends. A multibyte character split across reads becomes U+FFFD, silently (JSON still parses). Every `replay` (up to 256 KB) spans several reads, so box-drawing/emoji-heavy TUIs are the likely victims. | `src/main/ptyHost/daemonMain.ts:379`; `src/main/ptyHost/client.ts:262` | V |
| 7 | **Codex/Gemini MCP configs are home-scoped, so a board-bound token is usable machine-wide.** Connected tier may read every board's PTY output (`canReadBoard` restricts only workers) and may call finding 5's spawn. `removeSync` ignores the project, so revoking consent in one project strips another's config. | `src/main/cliProvisioners/codex.ts`; `src/main/cliProvisioners/index.ts:322-324`; mcp package `scope.ts:32` | R |
| 8 | **External MCP server secrets are written decrypted into repo-root `.mcp.json` / `opencode.json`** with no ignore handling. `git add -A` commits a long-lived third-party token. (#451 covers only Expanse's own worktree commits.) | `src/main/mcpServers/external.ts:73-92` | R |
| 9 | **Auto-update compile gate is not tied to signing.** `release.mjs` sets `ENABLE_AUTO_UPDATE=1` unconditionally and CI signing degrades to unsigned per OS, so an unsigned build can ship with the updater compiled in — the window ADR 0008 says must not exist. | `scripts/release.mjs:56-57`; `.github/workflows/production.yml` | R |
| 10 | **Swarm write-role cap under-counts after a denied re-dispatch.** The cap check skips when the worker is already in `writeInFlight`, but the catch path deletes it unconditionally, so a busy writer leaves the set and a second writer is admitted into the same tree. | `src/main/swarmTools.ts:658,711,796,863` | R |
| 11 | **Model-chosen swarm `cwd` is not shown in the confirm**, and the provisioner then writes token config (`.mcp.json`, `.claude/settings.local.json` with `enabledMcpjsonServers`) there; an invalid cwd falls back to HOME. | `src/main/swarmTools.ts:532,600`; `src/main/cliProvisioners/index.ts:323`; `src/main/ptyShells.ts:69-75` | R |
| 12 | **An unused undo checkpoint splits the next gesture into two undo steps.** `beginChange()` always pushes; only a real mutation pops. A press-without-move on a resize handle, a no-op `configure_board`, or a keyboard resize at min size leaves a checkpoint that the next multi-write gesture (board drag, nudge, cross-board planning move) consumes. | `src/renderer/src/store/canvasStore.ts:392-403,1104-1106` | R (push/pop shape V) |
| 13 | **Undoing a terminal's creation kills its process; redo re-runs `launchCommand`.** Unmount teardown calls `killTerminal`; delete parks, undo does not. Conflicts with the "never silently fire launchCommand" rule. | `src/renderer/src/canvas/boards/terminal/useTerminalSpawn.ts:1246`; `canvasStore.ts:1108-1150` | R (kill-on-unmount V) |
| 14 | **POSIX tree-kill reaches only the shell's process group.** Interactive shells give each job its own group, so backgrounded/`setsid` children (e.g. `pnpm dev &`) survive board delete and quit on macOS/Linux and keep ports. | `src/main/pty.ts:1043-1053` | R |

### P3 (short)

- **No Electron fuses; the daemon requires `ELECTRON_RUN_AS_NODE`.** The signed exe is a general Node interpreter, and the staged runtime in user-writable `%LOCALAPPDATA%` is never re-verified after its marker exists. `ptyHost/client.ts:353`, `ptyHost/runtimeStage.ts:103`. A Rust daemon removes the need.
- **Synchronous ≈ 245 MB stage copy on MAIN's event loop** on the first spawn after every update. `ptyHost/runtimeStage.ts:104-107`.
- **Daemon idle-exit can drop an in-flight spawn**; the documented drain-and-respawn on protocol mismatch is not implemented (`ptyHost/protocol.ts:13` vs `client.ts:397`) — the main risk when the daemon's protocol next changes.
- **`orchestration:getProvisionStatus` revokes the token "Sync" just wrote** (mint for a pseudo-board revokes the prior). `orchestrationProvision.ts:57-60`.
- **A denied swarm spawn leaves its branch**, and the worktree is created before the confirm; after 20 suffixes the worker name is refused. `swarmTools.ts:544`, `swarmWorktree.ts:59,446-457`. (Safety rules are honoured; the comment is wrong.)
- **`ESCHEMAFLOOR` guard is skipped when the prior primary is unparseable** → a dev build can raise the floor through the `.bak` fallback path. `projectStore.ts:261`.
- **LLM budget edges:** catalog GET outside `tryConsume`; corrupt counter resets to 0. `llmModelsCatalog.ts:325`, `llmBudget.ts:94-97`.
- **Linux `safeStorage` may fall back to `basic_text`**; `getSelectedStorageBackend()` is never checked. `index.ts:533`.
- **CSP has no `media-src`**, so `blob:` `<video>`/`<audio>` should be refused under `default-src 'self'`. Kanban attachments use that path (`KanbanAttachments.tsx:116,227`) and so does the video wallpaper (`useBackdropMedia.ts:45`). **Unverified — needs a two-minute look in a packaged build**; no e2e touches video.
- **Perf:** File boards re-render and re-size the editor font on every zoom frame (`FileBoard.tsx:101,504,775`); pen strokes copy the whole point array per pointermove (`lib/pen.ts:70-71`).
- **Per-board preview sessions are never released** (`previewOsr.ts:563`); **frame guard returns "not foreign" on a null `senderFrame`** (`ipcGuard.ts:21`) — not exploitable today, do not copy into a port.
- **Switch-back terminal stays flagged idle** after re-adopt. `canvasStore.ts:541-545`.

Checked and fine: XSS sinks (two `dangerouslySetInnerHTML`, both escape by construction), Mermaid via inert `<img>` blob, terminal link allowlist, prod `script-src 'self'`, worktree rules (no `--force`, no recursive delete), #441 and #442 fixes present.

**Suggested fix order:** 1 + 2 (one small change in `collectAssetIds` + union `readSession`) → 5 (decide + audit) → 6 (two-line `StringDecoder`) → 3 + 4 → 7/8/9. Findings 3, 4 and 6 live in the legacy Node daemon, which the Rust version does not replace, so they need legacy fixes of their own.

---

## 3. Electron → Rust: the facts

### 3.1 What "Rust" can mean

| Path | Keeps | Result | Verdict |
|---|---|---|---|
| **A. Tauri 2 + system webview (wry)** | Renderer, mostly | Small installer. But no pixel-buffer paint callback, no frame-rate/paint control, no hidden-view input injection, and no CDP at all on WKWebView/WebKitGTK → the Browser board (8.3K renderer LOC + 6.8K MAIN LOC) has no producer. Three engines to test instead of one. | **No**, unless the Browser board is dropped or made Windows-only. |
| **B. Tauri 3 + CEF runtime** | Renderer unchanged (same Chromium everywhere), CDP from Rust | Rust backend. Alpha; runtime creates child windows only (OSR must be driven through the raw `cef` crate, which has "no API stability"); Windows renderers unsandboxed; bundle "hundreds of megabytes"; Linux forced to X11. | **Chosen shell for the separate Rust project** (§4). Alpha is tolerable while nothing ships. |
| **C. Native Rust UI (gpui / egui / iced)** | Nothing of the renderer | No mature Rust equivalent for React Flow's widget-hosting canvas, Mermaid, ELK layout, or CodeMirror; Browser board still needs CEF. 92K LOC and 319 test files rewritten. | **No.** |
| **D. Rust core inside the Electron app** | Everything user-visible, the e2e harness, the updater, the sandbox | MAIN's native subsystems move into Rust binaries/crates one seam at a time. Each step ships. | **Ruled out by the owner's decision**: legacy stays untouched. It was the lower-risk route; §4.4 says what replaces its safety net. |

The 2026-06-14 Flutter assessment reached "fix in Electron, do not migrate". Its core reasoning still holds (the Node backend does not port for free; e2e weakens; the canvas cannot be separated from board content), but its inventory is stale: the code has doubled, OSR shipped, the native `WebContentsView` path is gone, terminals use the DOM renderer.

### 3.2 Ecosystem state (checked 2026-11-15)

- **Tauri 3** is alpha: `tauri-runtime-cef` `3.0.0-alpha.7` (2026-11-06); the 3.0 milestone has no due date. Tauri 2 line is 2.12.x. APIs "may still change before the stable release".
- **CEF runtime capabilities:** CDP from Rust (`send_dev_tools_message`, `on_dev_tools_protocol`), raw `cef::Browser` access (`with_cef_webview`), `remote_debugging(Port | Pipe)`, per-request permission handler, deep links, bundling + macOS signing entitlements.
- **CEF runtime gaps:** "Windows currently runs unsandboxed regardless of the policy" (Chromium M138+ needs Chromium's own toolchain for the sandbox broker). Webviews are created `set_as_child`; `windowless_rendering_enabled` can be set through `Cef::with_settings`, but there is no render handler in the runtime — the OSR feature request (tauri#16223) was closed by its author with only an invitation to send a PR. The `cef` crate itself has a windowless OSR example with shared-texture import.
- **Mature Rust pieces:** `portable-pty` (ConPTY + openpty); official `sherpa-onnx` crate 1.13.x (streaming ASR, TTS; static link by default) — same version line as today's `sherpa-onnx-node`; `rmcp` 3.x (official MCP SDK, Streamable HTTP server, targets the 2026-07-28 spec); `notify`; `tauri-plugin-updater`.
- **E2E:** Playwright documents `connectOverCDP` for WebView2. Against CEF it has been unreliable historically; treat as unproven until spiked.

### 3.3 Port map

| Subsystem | LOC | Rust approach | Size | Notes |
|---|---:|---|---|---|
| PTY host daemon | 2.4K | `portable-pty` + tokio named pipe; legacy NDJSON protocol v1 kept as a correctness oracle | **S–M** | First spike. No staged 245 MB runtime, no RunAsNode; must not copy findings 3, 4, 6. |
| Terminal core (park/adopt/splice/residue) | ≈ 5.5K | Job Objects (`KILL_ON_JOB_CLOSE`) instead of `taskkill`; `setsid` + `killpg`; `sysinfo` for the busy probe | **L** | The PTY calls are easy; the lifecycle semantics are the cost. The pure cores (`parkCore`, `adoptCore`, `cleanupCore`, `quitDrainCore`) and their tests are the spec. |
| Voice engine host | part of 9.1K | `sherpa-onnx` crate in a child process; MAIN relays port traffic over stdio | **M** | Second and last native addon. |
| File IPC, path safety, file watch, clipboard, notifications | ≈ 2.7K | `dunce`/`canonicalize`, `notify`, `arboard`, `notify-rust` | **S each** | Port `pathSafe`'s two-layer containment exactly. |
| Git / worktrees | ≈ 1K | `std::process::Command("git")` with the same argv arrays | **S** | Not `git2`: it skips hooks/LFS/filters and has no dirty-checked `worktree remove`. |
| Persistence | 3.6K | Rust as a byte-exact writer: renderer sends already-stringified JSON; Rust does atomic write, `.bak` rotation, floor guard, asset GC | **M** | Schema migration stays in the webview (it lives in `renderer/src/lib/boardSchema.ts` today). Do not re-serialize in Rust (§5). |
| Browser preview (OSR) | 6.8K | `cef` crate windowless browsers: `OnPaint`/`OnAcceleratedPaint`, `SendMouse/KeyEvent`, IME, one `RequestContext` per board, CDP for Network | **L** on CEF, impossible on wry | Milestone M4, gated by spike S2. Same Chromium OSR underneath as Electron's, so parity is plausible but unproven. |
| App shell, updater, deep link, single instance, tray | ≈ 3K | Tauri plugins; capability ACLs replace the frame guard | **M** + a bridge release | §5 lists what changes shape. |
| MCP host + package | ≈ 18K + 125 test files | Keep TypeScript as a Node sidecar; optional later port to `rmcp` + `axum` | **S** as sidecar, **XL** as port | The wire contract (Streamable HTTP on loopback, bearer token, 29 tools, 13 resources) can be spoken by a Rust server; tool input schemas would change shape for the model. The package's `test/live` suite is a ready conformance harness. |
| Swarm, dispatch, Jarvis, LLM, recap | ≈ 14K | Same: sidecar first | **L** each as a port | ≈ 95% pure logic with injected fetch/timers. |
| `src/shared` | 3.8K | Stays TS for the renderer; anything Rust needs is duplicated | **M** | Lock-step drift risk, like today's duplicated `SCHEMA_VERSION`. |

Once PTY and voice are in Rust the Node side has **no native addons**, which makes a bundled Node sidecar (or a single-executable build) practical — the June assessment's objection to that was `node-pty`.

---

## 4. Plan: Electron stays legacy, Rust is a separate version

Ballpark durations are rough estimates for one focused lane each; verification is the bottleneck, not typing.

### 4.1 Ground rules

- **Legacy is not touched by the migration.** `expanse-desktop` receives no Rust code and no migration scaffolding. Defects found while porting are reported and fixed through ordinary legacy PRs, never as part of Rust work.
- **Legacy is fixes-only from 2026-11-15** (owner decision). No new features start there; new feature work belongs in the Rust version. The commit legacy sits at once the in-flight feature lanes are settled (§6) is the **freeze point**: the renderer copy for the Rust version is taken from it, and after it only bug-fix commits need syncing.
- **New project:** `M:\expanse\expanse-rs` (working name) — its own repo, a Cargo workspace plus the frontend.
- **Legacy is the reference implementation.** Its pure cores and their unit tests, the `@expanse-ade/mcp` `test/live` suite, and the e2e specs are the parity checklist. Read them; do not import from them at build time.
- **Both versions must be installable side by side.** The Rust version needs its own app id / AUMID / bundle id, its own user-data directory (legacy is `%APPDATA%\canvas-ade`), its own PTY-host pipe and state-file names, its own update feed, and its own deep-link scheme (or an explicit rule for who owns `expanse://`).
- **Projects stay openable by legacy until cut-over.** The Rust version writes `.canvas/canvas.json` at the legacy `schemaVersion` / `minReaderVersion` (24 / 24 today) and must never raise the floor — the same hazard `ESCHEMAFLOOR` guards against in dev builds. Keep serialization in the copied renderer and have Rust write the bytes it is given (§5).
- **One live writer per project.** Both apps stamp a live port and token into a project's `.mcp.json` and both would run agents in it. Either forbid opening a project that the other version has open, or give the Rust version a distinct MCP server key.

### 4.2 Architecture of the Rust version

- **Shell:** Tauri 3 + `tauri-runtime-cef`, pinned to an exact alpha. Acceptable because nothing ships to users yet; revisit at M7. Same Chromium on every OS, CDP available from Rust.
- **Frontend:** the legacy renderer (`src/renderer`, `src/shared`, `src/vendor`) copied in **unmodified**. Instead of rewriting 391 call sites, the new project supplies a **`window.api` compatibility shim**: an object with the same 211-method surface, implemented over Tauri `invoke`, events and `ipc::Channel`, injected by an initialization script (which also supplies the four boot values that are `sendSync` today). A method that is not ported yet rejects with a clear "not ported" error, so the UI degrades visibly instead of silently. Syncing the renderer from legacy then stays a scripted copy that records the legacy commit it came from.
- **Backend crates:** `expanse-pty` (library) + `expanse-ptyhost` (keep-alive daemon binary) · `expanse-store` (atomic write, `.bak`, floor guard, asset GC) · `expanse-fs` (file IPC, path safety, watch) · `expanse-git` (git CLI with argv arrays) · `expanse-preview` (CEF windowless browsers) · `expanse-voice` (`sherpa-onnx`) · `expanse-app` (Tauri commands, window, lifecycle, updater).
- **Orchestration** (MCP host, swarm, dispatch, Jarvis, LLM, recap — about 32K LOC of TypeScript plus the MCP package): run a copy of the existing TypeScript as a **Node sidecar** first, with an RPC shim to Rust for PTY access and renderer confirms. Port to Rust (`rmcp`, `reqwest`, `axum`) later, or never.

### 4.3 Milestones — vertical slices, each ends runnable

| | Slice | Proves | Rough size |
|---|---|---|---|
| **M0** | Three spikes: **S1** PTY library + daemon, wire-compatible with legacy protocol v1 as a correctness oracle (in progress, in `expanse-rs`) · **S2** CEF offscreen: one windowless browser → BGRA dirty rects, mouse/keyboard/IME injection, per-board request context with independent zoom, CDP `Network` · **S3** shell boots the copied renderer on a stub shim; measure cold start, RSS, installer size; try Playwright `connectOverCDP` | Whether M2, M4 and M7 are feasible at all | 1–2 wk |
| **M1** | Walking skeleton: shell + renderer + shim core + project open / save / recents / assets | Canvas, Planning, Kanban and backdrop work (they are renderer-only). A legacy project opens and saves byte-compatibly. | 3–5 wk |
| **M2** | Terminal boards: PTY stream channel, park / adopt / undo semantics, tree-kill, snapshots; then the keep-alive daemon | The core product loop: an agent CLI running on the canvas | 4–6 wk |
| **M3** | File board, file watch, git diff, worktrees | | 3–4 wk |
| **M4** | Browser board on CEF offscreen rendering | The highest-risk slice. If S2 failed, decide the Browser board's fate here instead of building it. | 6–10 wk |
| **M5** | MCP + swarm + command boards through the Node sidecar; CLI provisioning | Agents can drive the canvas | 4–6 wk |
| **M6** | Voice, Jarvis, LLM | | 3–5 wk |
| **M7** | Packaging, signing, `tauri-plugin-updater`, e2e harness, parity checklist | Cut-over decision: Tauri 3 stable or pinned alpha accepted; Windows renderer sandbox gap closed or accepted | 6–10 wk |

**Order set by the owner (2026-11-15):** PTY spike (S1) first, then the Electron → Tauri shell work (S3, leading into M1), since S1 establishes the Rust workspace the shell lives in. S3 should run the same app on both Tauri runtimes — system webview (`wry`) and bundled Chromium (CEF) — so the runtime choice is made on measurements.

After M1 the slices M2, M3, M5 and M6 are largely independent and can run as parallel lanes. Single-lane total is on the order of 7–11 months; treat that as a range, not a forecast.

### 4.4 What this route costs compared with moving pieces inside Electron

- **Nothing reaches users until at least M2.** Legacy carries production the whole time.
- **Two codebases.** Every legacy change after the renderer copy is either re-synced (renderer: scripted) or re-implemented by hand (MAIN). Legacy being fixes-only keeps that small: the Rust version tracks a fixed target plus a trickle of bug fixes, and a fix to behaviour the Rust version has already ported must be applied in both.
- **Legacy's own defects stay in legacy.** The PTY-daemon findings (3, 4, 6) are no longer fixed "for free" by replacing the daemon — they need ordinary legacy fixes.
- **The safety net changes.** It is no longer "each step ships inside the old app"; it is "legacy keeps working and defines correct behaviour".

## 5. Semantics a port must not change

- **Port ordering.** Adopt replays preface → tail → `sync{written}` → `state` on one ordered port; input and resize share it (`pty.ts:465-473`). Splitting them across a channel and `invoke` loses that ordering.
- **Single-threaded atomicity.** `llmBudget.ts:121-124` (read → check → write is synchronous), `mcpLifecycle.ts:311-317` (reserve the cap slot before the await), the module-level current-project pin (`projectIpc.ts:414-415`). A multi-threaded runtime reopens these races unless state is actor-owned.
- **`canvas.json` bytes.** `JSON.stringify(doc, null, 2)` keeps insertion order; `serde_json` sorts keys unless `preserve_order` is on, and typed structs drop unknown fields that ADR 0007 forward-compat relies on. Number formatting differs (`1e+21` vs `1e21`, `-0`). Safest: Rust never re-serializes the document.
- **Lone surrogates.** Several clamps are UTF-16 `.slice()` (`mcpLifecycle.ts:69`, `mcpOrchestrator.ts:536`, audit `cap()`) and can persist half a surrogate pair; `serde_json` refuses that when reading into `String`, which would make a project fall back to `.bak`.
- **Unicode tables.** Sanitizers use `\p{Default_Ignorable_Code_Point}` and JS `\s`; Rust's regex tables differ.
- **Error strings the renderer matches:** Node errno names (`ENOSPC`, `EPERM`, `EACCES`, `EBUSY`, `EROFS`), `ESCHEMAFLOOR`, `"newer than supported"`, `'forbidden'`, `'invalid path'` (`saveError.ts:20-32`).
- **Guarded quit.** `before-quit` → `preventDefault` → `project:flush` round trip (1.5 s) → shutdown → `app.exit(0)`; the update-install quit must detach sessions rather than kill them.
- **ConPTY quirks.** Drop same-size resizes (`ptyResize.ts:75-85`); skip `taskkill` on a natural exit to avoid PID reuse (`pty.ts:952-958`); pid arrives late.
- **Preview.** One session partition per board for zoom isolation; supersampling depends on zoom factor changing layout width; 30 fps (20 low-RAM), paint gating paired with `invalidate`; a global budget of 8 offscreen windows.
- **Updates and the daemon.** NSIS kills `Expanse.exe` by name; the daemon survives only because it runs as a renamed copy. Any new installer path needs the same discipline.
- **Recap hook.** Users' `.claude/settings.local.json` files reference `recordSession.js` run by a system `node`.

---

## 6. Decisions needed

Decided (owner, 2026-11-15): Electron is the legacy project; the Rust version is a separate project; legacy is fixes-only from now.

Still open:

1. **In-flight legacy feature lanes.** Feature worktrees existed when the freeze was called (`feat/ws7-confinement`, `feat/ws4-lifecycle`, `feat/ws8-context`, `feat/spatial-awareness`, `feat/swarm-mission-feed`). Finish and merge them, or park them? The answer fixes the freeze point the renderer copy is taken from.
2. **Why Rust?** If the goal is a smaller/lighter app, nothing here delivers it while the Browser board exists. If the goal is robustness, build simplicity, and an exit from Electron, the Rust version delivers that.
3. **Is the Browser board (offscreen preview) negotiable?** If it could become Windows-only or a plain native overlay, Tauri 2 becomes viable and M4 shrinks.
4. **Windows sandbox.** Would you ship Windows with unsandboxed renderers if that were the only blocker left at M7?
5. **Orchestration layer.** Node sidecar indefinitely, or a full Rust port as a goal in itself?
6. **Name and location** of the new project (`M:\expanse\expanse-rs` is a working name) and whether it gets a GitHub remote.

---

## 7. Limits of this review

- Nothing was executed beyond typecheck and the vitest run; every failure scenario is traced from code.
- Read only partially: `voiceEngineHost` internals, `cloudStt/TtsEngine`, `previewOsrNetwork` handlers, `e2eMain` body, `mcpPlanning*` / `mcpKanban*` / `mcpVisualize*`, `swarmChatIpc`, `summaryLoop`, most board components (`TerminalBoard`, `BrowserBoard`, `PlanningBoard`, Kanban, Command/Swarm, Jarvis, settings), e2e spec bodies, `@expanse-ade/diagram`.
- Inferred, not verified: electron-updater's behaviour without `publisherName`; memory cost per preview session; all WebKit claims; whether Playwright can drive a CEF-runtime Tauri app.
- Previously tracked items (cloud-TTS readiness probe, Jarvis converse + cloud STT, OpenAI tool-fragment drop) were not re-checked.

## Sources

- Tauri 3 CEF runtime docs — https://v3.tauri.app/develop/cef/
- `tauri-runtime-cef` releases — https://github.com/tauri-apps/tauri/releases
- CEF OSR request — https://github.com/tauri-apps/tauri/issues/16223 · windowless setting — https://github.com/tauri-apps/tauri/issues/15868
- Tauri 3.0 milestone — https://github.com/tauri-apps/tauri/milestone/5
- Playwright WebView2 — https://playwright.dev/docs/webview2
- `rmcp` — https://docs.rs/crate/rmcp · `sherpa-onnx` — https://docs.rs/sherpa-onnx
