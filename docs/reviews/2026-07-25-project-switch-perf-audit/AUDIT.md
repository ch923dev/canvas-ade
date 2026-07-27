# Project Audit — Project Switching & Performance

**Date:** 2026-07-25 · **Version audited:** `0.31.0` (schema v22, HEAD `407d057b`, branch `main`)
**Method:** 3 read-only recon agents (switch pipeline · perf surface · architecture) + 1 web-research agent (prior art) + 1 measurement agent (numbers from this machine). No code changed, no builds run.

---

## 1. Executive summary

Expanse switches projects **in place inside one BrowserWindow**, keeping up to 3 previous projects resident in the background with their PTYs parked alive and their offscreen previews frozen. That design is sound and is validated by prior art — VS Code's window-per-workspace model is a *documented pain point* (microsoft/vscode#322745, #43188), and Figma/Linear both do in-place swaps. The subsystem is also well-tested by volume: **253 `it()` cases across 22 switch-path test files**, plus 8 e2e specs.

> **⚠️ UPDATE 2026-07-25, after Phase 0 shipped.** Point 1 below was an *estimate*, and measuring it
> did not confirm it: the dead air measures **33–44 ms median**, not ~800 ms, in a canvas of 0–24
> planning boards with no live terminals or previews. The 800 ms was arrived at by summing two 400 ms
> **timeouts**, which only elapse when the work behind them is slow. Point 2 is now fixed — the switch
> is instrumented and a baseline is committed. See §9 › *Phase 0 — BUILT*, and
> [`../2026-07-25-bench/BASELINE.md`](../2026-07-25-bench/BASELINE.md). Point 1's text is left intact
> below because it is what motivated Phase 0, and because R3 is not refuted — only unproven in the
> configuration measured so far.
>
> **⚠️ FURTHER UPDATE 2026-07-27 — point 1 is now REFUTED, and R3 with it.** The re-measurement that
> box asked for was taken with 3 live PTYs, the offscreen-window cap saturated (8 open / 4 painting)
> and 44 assets on disk: **`arm` = 86.6 ms median, worst sample 213.1 ms.** Neither 400 ms budget
> fires in any sample. Point 1 is off by roughly 9×, and R3 is dropped —
> [`../2026-07-25-bench/BASELINE.md` §6](../2026-07-25-bench/BASELINE.md#6-resource-bearing-re-measurement--r3-refuted-r11-revived).

Three things are nevertheless true:

1. **The switch has ~800 ms of dead time before any visual feedback appears.** Two serial 400 ms budgets (thumbnail capture, then snapshot fetch) run *before* the transition overlay arms. NN/g's response-time limits put 1.0 s as the boundary where a user's flow of thought breaks. A second click inside that window does nothing but raise a "locked" toast. This is the single most user-visible defect found. *(Superseded — see the update box above.)*
2. **There is no measurement.** `performance.mark` / `performance.measure` appear **zero times** in `src/`. There is no duration logging in main or renderer. The one bench harness (`e2e/terminalLoad.bench.ts`) has **no `package.json` script** and **no committed baseline artifact**. Nobody can currently say how long a switch takes — including this audit. *(Fixed by Phase 0.)*
3. **The remaining perf costs have moved up-stack.** Three prior measurement-grounded perf waves (#219, #315/#327/#330) already took the classic wins — the `.bak` sync write, the OSR paint storm, the network table, the pen tessellation. What is left is (a) a root-level React re-render fan-out, (b) two forced layouts per drag frame, and (c) an unbatched, unthrottled PTY wire protocol that post-dates the last audit.

**Headline recommendation: instrument before optimizing.** Phase 0 (2–3 days) buys a switch-latency number and a committed bench baseline; every later phase is then falsifiable. Three findings below (P-6 full-document rewrite, DL-4 thumbnail base64) were **de-prioritized by measurement** in this audit — real docs on this machine max out at 24 KB / 5 boards, so the "full-document rewrite" that reads alarming in code is not currently hot. That is exactly the value Phase 0 buys repeatedly.

**Effort to close everything below: ~19.5 dev-days across 5 phases** — of which **Phase 0 (3 d) is
built** and **R3 (1.5 d) is refuted and dropped** (2026-07-27), leaving ~15 d. Phases are
independently shippable and ordered so each one's result informs the next. Two open design questions
were decided by the user on 2026-07-25 and are folded in — see §9.

---

## 2. Current state assessment

### 2.1 What the switch actually does

Every real switch funnels through **`performProjectSwitch`** (`src/renderer/src/store/projectSwitch.ts:103-253`) — 253 LOC, **15 sequential `await`s**, essentially zero parallelism. Order in the file is load-bearing and documented at `:1-15`.

| # | Step | Anchor | Notes |
|---|---|---|---|
| 1 | Acquire module-scoped switch lock | `projectSwitch.ts:117` | shared across surfaces (`canvasStore.ts:590-598`) |
| 2 | Decide keep-vs-stop | `:119-127` → `decideKeep:69-101` | may **block on a modal promise** |
| 3 | Cancel pending autosave debounce | `:132` | prevents a post-switch save under the new dir |
| 4 | Flush-save canvas doc (dir-pinned) | `:138-141` | failure **aborts the switch** |
| 5 | Flush session sidecar | `:164-171` | advisory; failure logs only |
| 6 | `markSaved()` | `:181` | |
| 7 | **Capture thumbnail — 400 ms budget** | `:186`, `projectThumbCapture.ts:19` | must precede unmount |
| 8 | **Fetch outgoing snapshot — 400 ms budget**, then arm overlay | `:192-198`, `:41` | ← *first pixel of feedback* |
| 9 | Hand over live resources (park / kill / dispose) | `:200-227` | keep parks *before* unmount; stop unmounts first |
| 10 | `await applyOpenResult(await load())` | `:236-242` | |
| 11 | Settle or clear overlay | `:247-248` | 4 s watchdog force-clear (`switchTransitionStore.ts:33`) |
| 12 | Release lock | `:250-252` | |

A silent remembered-keep switch makes **4 IPC round-trips from this file alone** (`askOnSwitchInfo`, `save`, `saveSession`, `thumb`) plus whatever `backgroundLiveResources` issues.

MAIN's side of `project:open` (`projectIpc.ts:267-316`) is **all synchronous fs on the IPC thread**: a measured **floor of 14 sync fs calls + 2 per board**. On the real 5-board canvas found on this machine that is **24 sync fs calls per open**.

### 2.2 Entry points

Six production initiators, all reaching `performProjectSwitch`: the ProjectSwitcher pill (`ProjectSwitcher.tsx:144-179`), the bottom-edge ProjectDock (`ProjectDock.tsx:199-206`), the Alt-Tab RunningProjectSwitcher (`RunningProjectSwitcher.tsx:31-39`), and the window-scoped hotkey (`src/main/globalHotkey.ts:135-148` → `useProjectSwitchHotkey.ts:15-30`). Plus **two bypasses** that never run the pipeline: `WelcomeScreen.tsx:32-52,59-84` and boot auto-reopen `App.tsx:114-122`.

No deep-link, CLI, menu, command-palette, or MCP switch path exists (verified). `src/main/mcpBoardProjects.ts` is board→project *routing*, not switching.

### 2.3 Process & window model

One `BrowserWindow` for the whole app (`src/main/index.ts:222`). The PTY host is a **detached `child_process`**, app-run-scoped, surviving every switch (`src/main/ptyHost/client.ts:15`). Background residency policy (`backgroundSessions.ts:48-61`): `MAX_BACKGROUND=3` (low-RAM 1), `BG_IDLE_TTL_MS=30 min`, 60 s sweep, two-strike warn→grace→close, and a **CPU-delta busy probe** (`bgBusyProbe.ts`, ≥100 ms CPU delta ⇒ busy) so a working agent is never reaped. Both fail-safe biases point at *keeping the resident alive*. This machinery is genuinely good and is not a finding.

### 2.4 Scale

| Area | Files | LOC | Test files |
|---|---|---|---|
| `src/main/` | 371 | 80,903 | 168 |
| `src/preload/` | 14 | 2,226 | 1 |
| `src/renderer/` | 741 | 134,064 | 265 |
| **total** | **1,146** | **~209.5k** | **435** (~5,687 cases) |

IPC surface: **183 channel literals**, **121 `ipcMain` registrations**, one typed contract (`export type CanvasApi = typeof api`, `src/preload/index.ts:1017`) — **zero `ipcRenderer` calls in `src/renderer/`**. This is a well-kept boundary.

---

## 3. Findings — project switching

### 3.1 UX

**PS-1 · HIGH · ~800 ms of dead air before the switch overlay appears.**
Steps 7 and 8 are serial and each carries a 400 ms budget (`projectThumbCapture.ts:19` `CAPTURE_BUDGET_MS = 400`; `projectSwitch.ts:41` `SNAPSHOT_FETCH_BUDGET_MS = 400`). Only after both does `armSwitchTransition` paint anything. The code already knows: `ProjectDock.tsx:196-198` documents that a second click in this window "silently did nothing", patched only with a toast (`toastLockedSwitch`).
*Root cause:* the capture must precede unmount (correct), but the **overlay does not depend on the fresh capture** — it needs *a* snapshot, and `project:thumb` already has a cached PNG on disk from the previous visit (measured: 11 files, 3.0 MB, median 293 KB).
*Against the benchmark:* NN/g — 0.1 s reads as instantaneous, 1.0 s is the limit for uninterrupted flow; 1–10 s requires a skeleton or spinner. 800 ms of *nothing* is the worst cell of that table.

**PS-2 · HIGH · Four divergent open paths.**
Pipeline · `WelcomeScreen.tsx:32-52,59-84` · boot `App.tsx:114-122` · `e2eHooks.openProjectFromDisk:653`. WelcomeScreen takes the lock but skips flush-save, handover, thumb, and overlay (defensible — no outgoing project). **Boot does not take the lock at all.** Divergence means a fix to the pipeline silently does not apply to three other doors.

**PS-3 · MEDIUM · The hotkey→overlay→commit path has zero end-to-end coverage.**
`e2e/projectSwitcher.e2e.ts:10` states outright that it "never commits the switch". Overlay membership, ordering, Tab/Esc are covered; the actual commit is not. Related race: a press that lands while the card snapshot is still fetching is **silently dropped** (`runningSwitcherStore.ts:63`). Research found *no* prior-art rule for this case in VS Code or Windows Alt-Tab — it is an open design decision, not a solved one.
*Prior art that does apply:* Windows Alt-Tab and VS Code Ctrl+Tab are both **commit-on-release** with MRU ordering frozen for the duration of one invocation. Expanse already satisfies the frozen-MRU half (`runningSwitcherStore.ts:61` takes a frozen snapshot per interaction) but commits on Enter/click.
**DECIDED 2026-07-25 → move to commit-on-release** (R16). Implementation note: main `preventDefault`s only *exact chord* matches (`globalHotkey.ts:114-125,145`), so a bare `keyup` of `Control`/`Meta` does not match and still reaches the renderer — `RunningProjectSwitcher` already runs window-capture keyboard nav at `:43-77` and can commit from there with no new IPC. Fallback if that proves unreliable across platforms: have main push a `project:cycleCommit` on modifier keyup. Note the racing-press drop gets *more* load-bearing under commit-on-release (hold modifier, tap `]` twice fast) — R16 requires queueing it, not dropping it.

**PS-4 · MEDIUM · Three independent copies of the resident-project list go stale.**
`ProjectSwitcher.bgList` (refetched only on menu open), `ProjectDock.bgList` (only on dock open), and `runningSwitcherStore.cards` (frozen for the whole interaction). MAIN pushes `project:bgLifecycle` on every warn/close/evict — but the only subscriber is `useNotifications.ts:63-64`, which **only toasts**. Nothing invalidates the three lists. `ProjectSwitcher.recents` is likewise never refreshed after a switch.

**PS-5 · LOW · Dead code and stale docs left by the `globalShortcut` → `before-input-event` move (PR #342).**
`hotkey:failures` is permanently wired to `() => []` (`globalHotkey.ts:203`), so `ShortcutsPane`'s `failed` state (`:25,:55`) is unreachable UI. Four comment blocks still describe the removed mechanism: `preload/index.ts:753-756`, `hotkeyConfig.ts:7-10`, `hotkeyIpc.ts:1-6`, `ShortcutsPane.tsx:2-6`.

### 3.2 State management

**SM-1 · HIGH · Two independent "current project" values.**
Renderer `useCanvasStore.project.dir` vs main's module-level `currentDir` (`projectStore.ts:85-90`). They are reconciled by **ad-hoc `expectedDir` dir-pins bolted onto three handlers** (`projectIpc.ts:371-374`, `:420`, and `terminal:writeSnapshot`) — the BUG-009 fix. It works, but every *new* handler that writes project-scoped data must remember to re-derive the same guard. There is no single enforced invariant.

**SM-2 · MEDIUM · Duplicated derived state.**
Four independent project-name derivations (`projectIpc.ts:486`, `projectSessions.ts:269`, `projectSessionsShared.ts:12`, renderer store). `foreverDirs` held separately in `ProjectSwitcher`, `ProjectDock`, and `ProjectSessionsPane`. `ShortcutsPane.tsx:15-19` re-declares `DEFAULT_HOTKEYS`.

**SM-3 · MEDIUM · The orchestrator itself is untested.**
`projectSwitch.ts` — 253 LOC, 5 distinct return codes (`ok`/`locked`/`cancelled`/`save-failed`/`background-failed`) — has **no dedicated test file**. Its only test contact is `SwitchTransitionOverlay.integration.test.tsx`. Also untested: `askOnSwitchStore.ts`, `projectThumbCapture.ts`, `useProjectSwitchHotkey.ts` (including the `__REQUIRE_ACCOUNT__` sign-in-gate bypass at `:19`), and **`backgroundSessions.ts` has no test file at all** despite being actively churned.
Context: the switch path is *not* stable code — 8 distinct commits in the last 60 days across `projectSwitch.ts` (6), `projectSessions.ts` (5), `backgroundSessions.ts` (2).

**SM-4 · LOW · Production code shaped by test mocks.**
~8 files carry `Promise.resolve().then(() => window.api…).catch(...)` wrappers whose stated reason is that "a partial `window.api` mock (integration tests stub only what they use) must degrade… not throw" — `projectSessionsShared.ts:99-104,132-136`, `projectSwitch.ts:53,75,92,97,164`, `ProjectDock.tsx:82-84,92-94,214-216,226-228,234-236`, `projectThumbCapture.ts:36-38`, `ProjectSessionsPane.tsx:31-33`. A shared `mockCanvasApi()` test helper would let production code call the API directly.

### 3.3 Data loading on switch

**DL-1 · MEDIUM · `canvas.json.bak` is read and parsed on *every* open** — solely to union asset ids for `gcAssets` (`projectIpc.ts:289-292`). Two full parses per switch even when the primary doc is fine. GC is not switch-critical work.

**DL-2 · MEDIUM · N+1 `existsSync` per board** in `rehydrateMissingSummaries` (`projectIpc.ts:134-151`), on the synchronous IPC thread. Measured cost formula: **14 + 2×boardCount** sync fs calls per `project:open`.

**DL-3 · MEDIUM · N+1 per terminal board on mount** — `terminal:readSnapshot` + `terminal:exitResidue` (`useTerminalSpawn.ts:1129-1133` → `terminalIpc.ts:118-123`); `readTerminalSnapshot` is synchronous. Measured: 30 snapshot files on this machine, median 7.3 KB, max 203 KB (cap is 64 MB, so the cap is not the issue — the round-trip count is).

**DL-4 · LOW (measurement-downgraded) · `project:thumbs` synchronously reads and base64s every resident PNG** (`projectThumbs.ts:169-175`). Measured: 11 files / 3.0 MB → ~4.2 MB of base64 on dock open. Real but bounded; the switch path already avoids it via the single-dir `project:thumb`.

**DL-5 · LOW · 13 components subscribe to `project.dir`** and each fires its own refetch on switch (`AppChrome` recap consent, `OrchestrationPane`, `ProjectAgentsPane`, `ProjectSessionsPane`, `TerminalPane`, `FileTree` root re-list, …). None are batched or deferred past first paint of the new canvas.

---

## 4. Findings — performance

Ranked by likely user-visible impact. Prior waves already closed the obvious wins; do not re-flag `.bak` sync writes (fixed, `projectStore.ts:236`), the OSR paint storm (fixed), the file-watcher feedback loop (fixed, `fileWatch.ts:42-53`), unvirtualized lists (none found), or planning-card memoization (all 7 are `memo`'d).

**P-1 · HIGH · `App` re-renders 14 unmemoized children on every board mutation.**
`useMcpPublish.ts:25-41` subscribes `boards`, `connectors`, `groups`, `running`, `previewById`, `attention` — and it is called from `App` (`App.tsx:43`). `App`'s render body (`:124-179`) then renders `Canvas`, `AuditLogViewer`, `ProjectDock`, `VoicePill`, `JarvisPanel`, `ConfirmModal`, `BatchConfirmModal`, `AskOnSwitchModal`, `CloseSessionsModal`, `SwitchTransitionOverlay`, `RunningProjectSwitcher`, `ToastIsland`, `UpdateSurfaces` — **all 12 verified `memo`-free**. A board drag mutates `boards` ~60×/s. `JarvisPanel` owns a rAF canvas painter (`neuralCore.ts:212-215`).
*Root cause:* a coarse store subscription placed at the tree root. The same class of bug was already fixed one level down (`AppChrome`, `DigestPanel`, `ProjectLibraryPanel` are all `memo(…Impl)`).
*Fix per Zustand/React docs:* move the MCP publish subscription into a leaf component that renders nothing, use `useShallow` for object-shaped picks, and add `memo` boundaries. React Compiler 1.0 is complementary and incrementally adoptable (directory-by-directory, `"use no memo"` opt-out) but does **not** solve selector granularity.

**P-2 · HIGH · Two forced layouts + two O(boards) loops per drag frame.**
`useTerminalLiveness.ts:54,116-117` and `useOffscreenLiveness.ts:55,125-126` each call `getBoundingClientRect()` then walk every board, re-running on **every `boards` reference change**. The existing diff-skip guards the store *write* only — the layout read and the loop run regardless.
*Fix:* `ResizeObserver` for the pane box + cached viewport, read-then-write discipline (Paul Irish's forced-reflow list is the canonical reference).

**P-3 · HIGH · The PTY wire has no batching and no flow control on its first hop.**
`daemonMain.ts:184-188` does one `JSON.stringify(msg) + '\n'` socket write **per PTY chunk** (`protocol.ts:91`), and main `JSON.parse`s per line (`:105-118`). JSON-escaping is worst-case expensive precisely for dense agent TUI output. Hops 2–4 are already good (main→renderer micro-batching `ptyDataBatch.ts:33-62`, renderer rAF coalescing `terminalWriteCoalescer.ts:73-151`).
*Prior art with numbers — VS Code's pty-host* (`src/vs/platform/terminal/common/terminal.ts`, `FlowControlConstants`): `HighWatermarkChars = 100000` unacked chars → `ptyProcess.pause()`; `LowWatermarkChars = 5000` → `resume()`; `CharCountAckSize = 5000` per ack event (must be ≤ low watermark or the pty never unpauses). VS Code moved the PTY out of the renderer for exactly the two reasons Expanse did, and added this layer on top. **The load-bearing mechanism is the ack/pause protocol, not the byte encoding** — adding flow control matters more than switching off JSON.

**P-4 · MEDIUM · Boot is fully sequential and gated on a loopback HTTP bind that production never uses.**
`await startLocalServer()` at `index.ts:492`; `createWindow()` at `index.ts:1081`; **17 `register*Handlers(` calls in between**, all inside one `app.whenReady().then(async …)` (`:378`).

**Verified 2026-07-25 — this is stronger than "should be lazy".** `localServer.ts` serves only hardcoded fixture HTML (`PAGE`, `STATIC_PAGE`, `/download`, `/json?big|find`). It is **not** the MCP transport — MCP has its own loopback server, already lazy via `createMcpBoot`/`ensureMcp()` (`index.ts:543-554`). Its URL lands in one local, `defaultPreviewUrl` (`:490-493`), which has exactly **two** consumers:
- `installE2EMain(...)` (`:1093`) — internally gated `__ENABLE_E2E_MAIN__ ∧ CANVAS_E2E`; the comment at `:1091` states outright *"Production never enters here (either half of the gate is false)."*
- `runSelfTest(defaultPreviewUrl)` (`:1117`) — gated by `SMOKE` (`CANVAS_SMOKE`).

`grep` over `src/` (excluding tests) confirms `defaultPreviewUrl` and `localServer` appear nowhere else. **In a distributed build the bound port is read by nothing** — every user pays an AV/firewall-inspected loopback bind, on the critical boot path, for a test fixture. The existing error handling (`:494-500`, BUG-026, BUG-027) is careful and correct; it is guarding a server production does not need.

*Electron's own perf doc* prescribes: allocate just-in-time, lazy-`require` expensive modules, don't create everything at boot, `show:false` + `ready-to-show`. No credible source gives a measured cost for blocking `whenReady` on a socket bind — which is another argument for Phase 0 measuring it locally.

**P-5 · MEDIUM · The entry chunk carries a whole subsystem it does not need.**
Entry `index-BwaXfWbt.js` = 1,948,714 B raw / **410 KB gzip**; eager CSS `index-Cba9tbXA.css` = 262,906 B / 57 KB gzip, unsplit. `main.tsx:10` side-effect-imports `diagramPackageBridge`, which pulls **`@expanse-ade/diagram`'s package root + its CSS** (`diagramPackageBridge.tsx:11-13`) for two seam registrations. Verified by string-grep of the built chunk: `DiagramSpecView`, `assertDiagramSpec`, `pl-spec-*`, `configureSpecElkWorker` all present in the entry, **zero in any lazy chunk**. Separately, `@xterm/addon-webgl` (139,518 B) is bundled but **never loaded** — the DOM renderer is a locked decision. No bundle budget exists in CI.

**P-6 · LOW (measurement-downgraded) · Full-document rewrite per save.**
`useAutosave.ts:196` `toObject()` → structured clone across IPC → `JSON.stringify(doc, null, 2)` (`projectStore.ts:226`), with no per-board dirty set (finding L2, still open).
*Why LOW:* measured real docs on this machine are **558 B / 6.2 KB / 24.0 KB** for 1 / 2 / 5 boards. At those sizes the 1 s debounce plus ref-identity dirty gate (`useAutosave.ts:52-58`) is entirely adequate. **tldraw does the same thing** — `getSnapshot`/`loadSnapshot` of the whole store is its production persistence model, not a shortcut. Revisit only if a real canvas crosses ~1 MB.

**P-7 · LOW · Always-on timers.**
`useBrowserAutoConnect.ts:38,60` — 1 s interval iterating **all** boards even with zero Browser boards. `useRunTimer.ts:20` — 1 s `setState` re-rendering the whole 828-line `TerminalBoard` per running terminal (`TerminalBoard.tsx:404,412`). `ptyLifecycleMonitor.ts:17,128` — 2 s scan reading a ring tail per session.

**P-8 · LOW · Unbounded map.** `ensuredDirs` in `claudeBootDetect.ts:71` is keyed by board id and never deleted on board removal or session teardown. Bounded by boards × dirs, but grows for the app lifetime.

**P-9 · CROSS-CUTTING · There is no instrumentation.**
Zero `performance.mark` / `performance.measure` in `src/`. Zero `console.time` / `process.hrtime` / duration logging. The perf HUD (`DiagOverlay.tsx`) is dev-only with no production toggle (`Canvas.tsx:299`). The bench (`e2e/terminalLoad.bench.ts` + `playwright.bench.config.ts`) has **no `package.json` script** and its assertions are soft (`expect(p.frames).toBeGreaterThan(10)`); the only recorded numbers live in a prose table in `docs/research/2026-06-25-terminal-dom-renderer/REPORT.md:110-138`. The 2026-07-08 audit's own `MCP-SERVER-COST.md:39-44` says "Measure it precisely before acting" — that instrumentation was never added.

**Existing baselines (2026-06-25, ~165 Hz dev display), for regression comparison:**

| N terminals | phase | fps | p50 | p95 | jank >33 ms |
|---|---|---|---|---|---|
| 1 | all | ~163 | 6.1 ms | 6.2 ms | ~0% |
| 4 | static | 116–133 | 6.1 ms | 12.2 ms | 0% |
| 8 | static | **45** | **24 ms** | 30 ms | 0.6–2.2% |
| 8 | zoom | 65 | 12 ms | 18 ms | 0% |

Decisive recorded finding: `zoom ≥ pan ≥ static` at every N ⇒ **camera motion is never the bottleneck**; the cost is the write/DOM-mutation path. Liveness gating measured **133.9 vs 43.5 fps** (N=8, 6 gated).

---

## 5. Findings — repo hygiene (non-blocking, cheap)

| # | Finding | Evidence |
|---|---|---|
| H-1 | **35 orphaned worktree dirs** — 44 dirs on disk vs 9 registered (`git worktree list`); CLAUDE.md caps live worktrees at ~4. Unscoped `src/**` globs return 8–9× inflated counts. | `.worktrees/` |
| H-2 | **Zero release tags** at v0.31.0. Only tag is `backup/cmd-board-pre-rebase`; `production.yml` triggers on `release: published`. | `git tag` |
| H-3 | **4 stray root `.md` files** violating the repo's own "never at the repo root" doc rule | `KANBAN-MCP-CARD-DETAIL-REPORT.md`, `KICKOFF-CODEQL-TRIAGE.md`, `PHASE3-KICKOFF.md`, `CLAUDE.md.bak-20260530` |
| H-4 | **MCP pin drift across three sources** — CLAUDE.md says `0.18.0-rc.7`, `package.json:58` says `0.21.0`, installed tree has `0.22.1` | 3-way mismatch |
| H-5 | **Stale mirror comments** — `projectStore.ts:52` says "(18)" and `:367` says "(10)" against a `SCHEMA_VERSION = 22` value | drift-test passes; comments lie |
| H-6 | `next@^16.2.11` is a devDep of a desktop Electron app with no Next.js under `src/` | `package.json:104,134` |
| H-7 | Working tree dirty on `main` (modified `CLAUDE.md`, `.claude/settings.json`; untracked `.claude/commands/`) | `git status` |
| H-8 | `expanse-ui/canvas.json` sits at the project **root** — a live pre-ADR-0009 project, so `migrateProjectLayout`'s cold path is not dead code | `M:\expanse\expanse-ui\canvas.json` |

---

## 6. Prioritized recommendations

Effort is dev-days for one engineer including tests and the mandatory dev check.

| ID | Recommendation | Fixes | Effort | Impact |
|---|---|---|---|---|
| **R1** | **Instrument the switch.** `performance.mark` at `switch:start` / `switch:paintable` / `switch:interactive` in the renderer; `perf_hooks` marks around `project:open` in main; a dev-visible readout in `DiagOverlay` plus an opt-in production toggle. Bucket against 0.1 s / 1 s / 10 s. | P-9 | **2 d** | Enables everything else |
| **R2** | **Add `pnpm bench` + commit a baseline artifact.** Wire `playwright.bench.config.ts` into `package.json`; emit `docs/reviews/<date>-bench/BASELINE.json`; add a switch-latency bench beside the terminal one. | P-9 | **1 d** | Makes regressions detectable |
| **R3** | ❌ **REFUTED — DROP IT (re-measured 2026-07-27).** Was: arm the transition overlay first (reorder step 7↔8), on PS-1's claim of ~800 ms of dead air. That claim was arithmetic on two 400 ms *timeouts*, never a measurement. Phase 0 measured `arm` at 41–49 ms on a board-only canvas, which left R3 *unproven*; the resource-bearing re-measurement then took it with **3 live PTYs + the offscreen-window cap saturated (8 open, 4 painting) + 44 assets** and got **`arm` = 86.6 ms median, worst sample 213.1 ms**. Neither 400 ms budget fires in any sample; the premise is off ~9×, and `arm` stays under the NN/g 100 ms threshold even fully loaded. If the switch is re-attacked, `load` (34 → 158 ms under load) is the target, not `arm`. | PS-1 | **1.5 d → 0** | **Dropped.** Same death as R11's original premise |
| **R4** | **Unify the open paths.** Make WelcomeScreen and boot call a shared `openProject()` primitive with explicit "no outgoing project" semantics; lock-guard boot. | PS-2 | **2 d** | Removes 3 divergent doors |
| **R5** | ⭐ **PROMOTED (Phase 0 found supporting evidence the audit missed).** Memo boundary at `App`: move `useMcpPublish`'s subscription into a render-nothing leaf; `useShallow` for object picks; `memo()` the 12 root children. Verify with a React Profiler recording before/after. **`paint` — React mount plus first frame — is the steepest per-board cost in the switch (11 → 35 → 47 ms across 0 → 8 → 24 boards), the only Phase 2 item with a measured number behind it.** | P-1 | **1.5 d** | Now the best-evidenced perf item |
| **R6** | **Observer-based liveness.** Replace per-frame `getBoundingClientRect()` in both liveness managers with `ResizeObserver` + cached viewport; extend the diff-skip to the read side. | P-2 | **1.5 d** | 2 forced layouts/frame |
| **R7** | **PTY flow control on hop 1.** Port VS Code's watermark protocol into `ptyHost`: ack from main, `pause()` at 100k unacked chars, `resume()` at 5k, 5k ack size; coalesce same-tick daemon writes before `encodeLine`. | P-3 | **3 d** | Guards against runaway agent output |
| **R8** | **DECIDED 2026-07-25 — gate `startLocalServer` off in production entirely.** Not "lazy": its URL has zero production consumers (see P-4). Start it only under `CANVAS_E2E` / `CANVAS_SMOKE` / dev, eagerly in those modes so the 26 `@preview` specs and the smoke self-test are unchanged. Keep the BUG-026/027 error handling. Separately audit the 17 handler registrations for anything deferrable past `ready-to-show`. Measure boot before/after with R1's marks. | P-4 | **0.5 d** | Removes a loopback bind from every user's boot |
| **R9** | **Unit-test `projectSwitch.ts`** — all 5 return codes, `decideKeep` branches, the cancel-autosave→flush→sidecar ordering. Add a `backgroundSessions.ts` test file. Add an e2e that **commits** a hotkey switch. | PS-3, SM-3 | **2 d** | 253 LOC of untested orchestration |
| **R10** | **Invalidate resident lists on `project:bgLifecycle`.** One shared `useResidentProjects()` hook subscribing to the push channel; delete the three local copies and the three `foreverDirs` copies. | PS-4, SM-2 | **1.5 d** | Stale-UI class |
| **R11** | ⚠️ **DE-PRIORITIZED (Phase 0 measured it).** Move GC and summary rehydration off the open path: defer `readBak` + `gcAssets` to idle; batch `rehydrateMissingSummaries` into one `readdir` instead of N `existsSync`. **MAIN's whole `project:open` handler — which contains both costs — is flat at ~12 ms from 0 to 24 boards.** Caveat: the sweep varies *boards*, and `gcAssets` scales with *assets*, which the synthetic bench projects have none of (Appendix A found a real 44-file / 3.58 MB assets dir). Do not delete — re-measure asset-bearing before dismissing. | DL-1, DL-2 | **1 d** | Not hot at measured sizes |
| **R12** | **Lazy-load the diagram bridge; drop `addon-webgl`.** Register the seam on first Planning/Data-flow board mount instead of `main.tsx`. Remove the unused xterm WebGL addon. Add a gzip budget assertion to `pr.yml`. | P-5 | **1.5 d** | Entry chunk + CI guard |
| **R13** | **Kill the always-on timers.** Gate `useBrowserAutoConnect` on `browserBoards.length > 0`; hoist `useRunTimer`'s output into a leaf so it doesn't re-render `TerminalBoard`; make `ptyLifecycleMonitor` event-driven off `onData` quiescence. Delete `ensuredDirs` entries on board removal. | P-7, P-8 | **1.5 d** | Idle CPU |
| **R14** | **Enforce the dir invariant once.** A `withProjectDir(handler)` wrapper in `ipcGuard.ts` that pins `expectedDir` for every project-scoped write, replacing the three hand-rolled checks. | SM-1 | **1 d** | Prevents the next BUG-009 |
| **R16** | **DECIDED 2026-07-25 — switch the Alt-Tab overlay to commit-on-release.** Match Windows Alt-Tab / VS Code Ctrl+Tab: overlay stays open while the modifier is held, releasing `Ctrl`/`Cmd` commits the highlighted card. Enter and click stay as explicit commits; Esc still cancels. Also **queue** a press that races the async card fetch instead of dropping it (`runningSwitcherStore.ts:63`). | PS-3 | **1 d** | Matches OS muscle memory |
| **R15** | **Hygiene sweep.** Prune 35 orphaned worktrees; move/delete the 4 stray root `.md`s; reconcile the MCP pin across CLAUDE.md/package.json/lockfile; fix the stale schema-mirror comments; delete the dead `hotkey:failures` UI and 4 stale comment blocks; decide on release tags. | H-1…H-5, PS-5 | **1 d** | Removes measurement traps |

**Deliberately NOT recommended:** per-board dirty-set persistence (P-6) — measured docs are ≤24 KB and tldraw ships whole-snapshot persistence in production; revisit above ~1 MB. Window-per-project — prior art says the current in-place model is the better one. Replacing the xterm DOM renderer — already measured and rejected with numbers.

---

## 7. Phased implementation roadmap

**Phase 0 — Measure (3 d): R1, R2. ✅ BUILT 2026-07-25 (`feat/switch-instrumentation`, v0.33.0).**
Gate: a committed switch-latency number and a committed bench baseline exist — both now do
([`../2026-07-25-bench/`](../2026-07-25-bench/), 8/8 configs, machine state recorded). Nothing in
Phase 2/3 ships without a before/after against these. **Phase 0 changed the phases it was gating:
R3 lost its 800 ms premise, R11 lost its justification, R5 gained one.** See §9.

**Phase 1 — Switch UX & correctness (6.5 d, now **5 d**): R4, R16, R9, R10.**
✅ **The R3 TBD is resolved — as a drop (2026-07-27, PR #390).** R3's 1.5 d was bought entirely by
PS-1's ~800 ms; the resource-bearing re-measurement put `arm` at 86.6 ms median with 3 live PTYs +
8 offscreen windows (4 painting) + 44 assets, no budget ever firing, so it left the phase rather than
re-entering it. Phase 1 is now four unaffected items at 5 d with nothing pending. Suggested start:
**R9** — it is the only item whose hardest path already has a harness (`e2e/switchAskExclusion.e2e.ts`
is the first automated run to execute `decideKeep`'s non-explicit branch), and its gate subsumes R16's.
Gate: switch-to-first-paint under 100 ms measured by R1; commit-on-release working with a queued racing press; all 5 `performProjectSwitch` return codes unit-tested; one e2e that **commits** a hotkey switch (this now covers R16 as well); the three resident lists collapsed to one hook. Fits one coherent feature slice under the repo's plan-viz-first + worktree conventions.

**Phase 2 — Renderer perf (3 d): R5, R6.**
Gate: React Profiler shows the root children no longer re-render on a board drag; the bench's N=8 static number improves or holds at 45 fps / 24 ms p50.

**Phase 3 — Main-process & IO (4.5 d): R7, R8, R11, R14.**
Gate: boot-to-first-paint measured before/after (R8 should be visible here); a synthetic runaway-output PTY test shows pause/resume engaging at the watermarks; sync-fs count per `project:open` drops from 14+2N; full e2e matrix green — R8 touches the fixture server 26 `@preview` specs depend on, so the Linux leg is mandatory.

**Phase 4 — Bundle & hygiene (2.5 d): R12, R13, R15.**
Gate: entry chunk gzip below a budget asserted in `pr.yml`; idle CPU measured with zero boards open.

**Total: ~19.5 dev-days.** Phases 1–4 are independently shippable and independently revertable. Phase 0 is a hard prerequisite for 2 and 3.

---

## 8. Verification

For each phase:

1. **Unit / integration** — `pnpm test` (435 files, ~5,687 cases; this is the CI gate in `pr.yml`).
2. **e2e Windows leg** — `pnpm test:e2e` (93 specs, ~329 tests). Scoped subsets: `pnpm test:e2e:smoke` (`@core`), or the tag maps in `scripts/e2e-scope.mjs`. Switch-path specs: `projectSwitcher`, `projectSwitchMotion`, `projectDock`, `projectBackground*` (4 files), `projectSettings`.
3. **Full matrix, mandatory once per PR at the pre-merge gate** — `pnpm test:e2e:matrix` (Windows native + Linux Docker).
4. **Bench** — `pnpm build && pnpm exec playwright test --config playwright.bench.config.ts` (after R2: `pnpm bench`). Compare against the committed baseline; the 2026-06-25 table in §4 is the current reference.
5. **Manual dev check, title-stamped, BEFORE `git push`** — `$env:CANVAS_DEV_TITLE='PR#NNN <feature>'; pnpm dev`. For switch work specifically: open two real projects, switch A→B→A with a live agent running in A, confirm the PTY reattaches to the same pid with background output intact, and confirm the overlay appears with no dead air.
6. **Plan-viz first** — per CLAUDE.md this is a MUST: draw each phase's plan on the canvas via the `canvas-ade` MCP before implementation and keep it live as work lands.

**The bench WAS run on 2026-07-25 — and it was broken.** First attempt: **4 of 5 tests failed**, 9.2 min, no fps recorded for any of them. Root cause was a harness defect, not a perf regression: `assertStreaming` sampled buffer growth once over a fixed 1.5 s window immediately after `terminalMounted`, but mount is not streaming — the `pty:spawn` IPC, a ptyHost daemon cold start, shell boot, and `STREAM_CMD` being written as the first PTY line all sit in between. Failures were monotonic in warm-up (N=1: 0/1 streaming → N=8: 7/8 → last test: 1/1 pass), so the first tests in any run died at the precondition.

Fixed on `fix/bench-readiness-gate` (v0.32.1) by polling per terminal for real buffer growth instead of assuming it. Re-run: **5/5 passed in 1.6 min**, full baseline captured — see `docs/reviews/2026-07-25-bench-baseline/BASELINE.md` on that branch.

**This is why R2 is Phase 0 work and not a chore.** The harness could not produce a baseline at all; the gap in §4's "existing baselines" was not laziness, it was unmeasurable.

**And it immediately found a confirmed regression — whose cause is NOT in this audit's findings.** N=4 repeated 3× with N=1 as a control: N=1 static held at 160.4 / 160.0 / 159.9 fps (0.3% spread, matching the ~163 reference), while N=4 static landed at 74.8–81.5 across four runs against a 116–133 reference, p50 pinned at 12.1 ms where the reference was 6.1 ms. Comparing frame-time across all three N, only N=4 changed vsync bucket (1 frame → 2) — so the underlying change is a uniform per-terminal cost increase of ~5–15%, and the −35% fps headline is a quantization cliff.

**Root cause is dependencies, not app source.** Rebuilding the *reference commit's own source* (`78088bbc`) against current `node_modules` measures 75.6 fps / p50 12.1 ms — the same slow state as current main. The app source that produced the fast reference is slow on today's dependencies. Prime suspect: `@xterm/xterm` 5.5 → 6.x. This **exonerates P-1 / P-2 / P-3 as the cause of this particular regression** — they remain valid findings, but a planned bisect over 365 commits was abandoned as structurally incapable of finding a dependency-caused delta (worktree `node_modules` is a junction to MAIN's, pinning deps to current at every step). Full data, method, and the confirmation path: `docs/reviews/2026-07-25-bench-baseline/BASELINE.md`.

---

## 9. Next steps

### Decisions taken (2026-07-25)

| Question | Decision | Lands as |
|---|---|---|
| Alt-Tab switcher: commit-on-release vs commit-on-Enter? | **Commit-on-release**, matching Windows Alt-Tab / VS Code Ctrl+Tab. Enter and click remain explicit commits; Esc still cancels; racing presses queue rather than drop. | **R16**, Phase 1 |
| Local HTTP server: lazy or removed? | **Lazy — and, per the verification in P-4, gated off in production entirely.** Its URL has zero production consumers, so it starts only under `CANVAS_E2E` / `CANVAS_SMOKE` / dev. | **R8**, Phase 3 |

### Phase 0 — BUILT (2026-07-25, `feat/switch-instrumentation`)

R1 and R2 are implemented and the gate artifact exists: `docs/reviews/2026-07-25-bench/BASELINE.json`,
written with the machine state it was captured under. Full numbers and analysis:
[`../2026-07-25-bench/BASELINE.md`](../2026-07-25-bench/BASELINE.md).

**Phase 0 changed the shape of the roadmap it was gating.** Two recommendations are now measured
rather than estimated, and both need re-scoping before their effort is committed:

| Item | Audit said | Phase 0 measured | Consequence |
|---|---|---|---|
| **R3** (1.5 d) — arm the overlay first, "highest user-visible win" | PS-1: ~800 ms of dead air before the overlay arms | `arm` **33–44 ms median** (tail to 121 ms) across 0/8/24 boards | The 800 ms was inferred by summing two 400 ms *timeouts* (`SNAPSHOT_FETCH_BUDGET_MS` + the thumb capture), never measured. Timeouts only bite when the underlying work is slow — which the measured configuration (planning boards, no terminals, no previews, no assets) never triggers. **R3 was not refuted, only unproven.** ❌ **Now refuted (2026-07-27):** re-measured with 3 live PTYs + 8 offscreen windows (4 painting) + 44 assets, `arm` = **86.6 ms median**, no budget ever firing. R3 dropped. |
| **R11** (1 d) — move GC + summary rehydration off the open path | DL-1 `readBak` + `gcAssets`, DL-2's N × `existsSync` | MAIN's whole `project:open` handler is **flat at ~10 ms** from 0 to 24 boards | Neither cost is hot at these sizes, and neither scales in the measured range. **De-prioritize R11** until a measurement at realistic asset counts (Appendix A found a 44-file / 3.58 MB assets dir) says otherwise. 🔁 **That measurement landed 2026-07-27 and it moves:** `mainOpen` 9.8–13.0 ms → **65.4 ms** at 44 assets. R11 re-opens at a smaller scope — the seeded assets are unreferenced, so that is `gcAssets`’ worst path. |

Phase 0 also produced a finding the audit did not anticipate: **`paint` is the steepest per-board
cost** (15 → 29 → 48 ms across 0 → 8 → 24 boards), which is React mount plus first frame. That is
P-1/P-5 territory and is direct support for **R5** — the one Phase 2 item that now has a number
behind it.

### Remaining

1. Approve or re-order the phase list. Phase 0 is done; nothing else has started.
2. ✅ **DONE 2026-07-27 — `arm` re-measured with live resources; R3 is refuted and should be dropped.** 86.6 ms median fully loaded, no budget ever firing. Numbers, method and the two harness findings: [`../2026-07-25-bench/BASELINE.md` §6](../2026-07-25-bench/BASELINE.md#6-resource-bearing-re-measurement--r3-refuted-r11-revived) · artifact `RESOURCES.json` · bench `e2e/projectSwitchResources.bench.ts`.
3. ✅ **DONE 2026-07-27 — ask-time exclusion verified against the real dialog.** `e2e/switchAskExclusion.e2e.ts` drives `switchProjectAsk` (the default pipeline, so `decideKeep` does not early-return on an explicit keep), holds the real modal open 1.5 s, and asserts `ask` covers the hold while `arm` and `total` exclude it. The branch had never executed outside a unit test — every other automated switch passes an explicit keep, which returns before `recordAskTime`. Proven non-vacuous by disabling `minusAsk` and watching the spec fail.
4. Confirm the R8 gate condition covers every dev workflow that expects the fixture pages (`/static`, `/download`, `/json`) — `pnpm dev` must keep serving them.
5. ✅ **DONE 2026-07-27 — settled as "yes, in a second bench".** `e2e/projectSwitchResources.bench.ts` sweeps terminals / previews / assets / combined; the committed 0/8/24 planning sweep is deliberately left byte-identical so the baseline stays comparable.
6. 🔁 **NEW — re-open R11 at a smaller scope.** The same run found `mainOpen` is asset-sensitive after all (9.8–13.0 ms → **65.4 ms** at 44 assets), which is the measurement §3 of the baseline said R11 was pending. The seeded assets are unreferenced, so that figure is `gcAssets`' worst path; the next question is what the *referenced*-asset path costs, not a straight resurrection of the original 1 d estimate.

---

## Appendix A — Measurements taken (2026-07-25, this machine)

| What | Value |
|---|---|
| Real `canvas.json` docs found | 3 — 558 B (1 board) / 6,197 B (2) / 24,005 B (5) |
| `.canvas/assets/` totals | 138 KB (6 files) and 3.58 MB (44 files) |
| Thumbnail cache | 11 files, 3,160,374 B; min 94 KB / median 293 KB / max 582 KB |
| `recent-projects.json` | 1,049 B, 8 entries |
| Terminal snapshots | 30 files; min 246 B / median 7.3 KB / max 203 KB (cap 64 MB) |
| `out/` total | 16,571,262 B (40 files) |
| Entry chunk / eager CSS | 1,948,714 B (410 KB gz) / 262,906 B (57 KB gz) |
| `projectSwitch.ts` | 253 LOC, 15 code `await`s, 4 IPC round-trips on a silent keep-switch |
| `src/main/index.ts` | 1,218 LOC; `startLocalServer()` at :492, `createWindow()` at :1081, 17 `register*Handlers(` between |
| Sync fs in `src/main/` (excl. tests) | 138 call sites across 52 files |
| Sync fs per `project:open` | 14 floor + 2 per board (⇒ 18 for a 2-board canvas, 24 for a 5-board) |
| Switch-path test coverage | 253 `it()` across 22 files; **0** for `projectSwitch.ts` and `backgroundSessions.ts` |
| Switch-path churn (60 d) | 8 distinct commits across 3 files |

## Appendix B — Key external sources

- NN/g response-time limits (0.1 s / 1 s / 10 s) — https://www.nngroup.com/articles/response-times-3-important-limits/
- NN/g skeleton screens vs spinners vs progress bars — https://www.nngroup.com/articles/skeleton-screens/
- VS Code single-window multi-project pain point — https://github.com/microsoft/vscode/issues/322745 · https://github.com/microsoft/vscode/issues/43188
- VS Code pty-host flow control (`FlowControlConstants`) — https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/terminal.ts · https://github.com/microsoft/vscode/issues/74620
- VS Code hot exit (auto-flush over prompt) — https://code.visualstudio.com/blogs/2016/11/30/hot-exit-in-insiders
- Electron performance checklist — https://www.electronjs.org/docs/latest/tutorial/performance
- Electron `utilityProcess` (preferred over `child_process.fork`) — https://www.electronjs.org/docs/latest/api/utility-process
- Electron offscreen rendering cost profile — https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
- Zustand `useShallow` / selector granularity — https://zustand.docs.pmnd.rs/learn/guides/prevent-rerenders-with-use-shallow
- `useSyncExternalStore` semantics — https://react.dev/reference/react/useSyncExternalStore
- React Compiler incremental adoption — https://react.dev/learn/react-compiler/incremental-adoption
- Forced reflow / layout thrash reference list — https://gist.github.com/paulirish/5d52fb081b3570c81e3a
- tldraw whole-snapshot persistence — https://tldraw.dev/docs/persistence
- Electron multi-process tracing (`contentTracing`) — https://blog.scottlogic.com/2019/05/21/analysing-electron-performance-chromium-tracing.html

**Sourcing gaps flagged by the research pass:** no primary source exists for (a) switcher behavior when a keypress races an async fetch, (b) measured cost of blocking `app.whenReady()` on a socket bind, (c) extracting `performance.mark` telemetry from a *packaged* Electron build, or (d) a standard "time to interactive after switch" desktop metric. R1's marks are therefore a custom instrument judged against NN/g's thresholds, not an industry-standard metric.
