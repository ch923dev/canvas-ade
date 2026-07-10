# Performance & Persistence Audit — Canvas ADE (Expanse Desktop)

**Date:** 2026-07-08
**Scope:** Whole app, primary focus on persistence (save) mechanism, memory, disk I/O, and render/CPU cost.
**Method:** Manual trace of the save spine (`useAutosave` → `project:save` → `writeProject`) plus six parallel subsystem deep-dives (persistence, terminal, preview OSR, React render, memory/teardown, disk I/O). Every finding is quoted against `file:line`.
**Target:** Smooth on 8 GB RAM (Apple M3 / low-memory hosts). Reported symptom: noticeable lag with even a single terminal open; heavier-than-expected feel when switching contexts/projects; "disk space" errors with ample free storage.

---

## 1. Executive summary

The codebase is **not** sloppy — it is heavily perf-tuned and unusually disciplined about teardown (dozens of prior leak/perf fixes: PLAN-01, PERF-05, CANVAS-01, PTY-1, BUG-*). Pan/zoom already does not re-render boards; undo is capped; per-board stores clear on unmount; watchers/timers/observers are disposed. So the reported lag is **not** death-by-a-thousand-leaks. It concentrates in a small number of **always-on, uncapped, or main-thread-blocking** mechanisms.

Three root causes explain the three reported symptoms almost entirely:

| Reported symptom | Root cause | Where |
|---|---|---|
| Lag with a single terminal open (idle) | A braille spinner bumps **component state on the 823-line `TerminalBoard` node every 80 ms** while a shell is "running" (an idle prompt counts) → the whole node reconciles **12.5×/sec** | `TerminalBoard.tsx:402-407` |
| Heavier when switching projects; memory growth | **Background project sessions are uncapped and have no TTL**; a remembered "keep" policy backgrounds silently → each switch retains that project's entire agent PTY tree (shell + `claude`/`codex`, 150 MB–1 GB+ each) for the whole app run, plus up to 8 resident frozen Chromium preview renderers | `projectSessions.ts:122-130`, `pty.ts:977-979`, `previewOsr.ts:168` |
| "Disk space" errors with free disk | **There is no free-disk-space check anywhere in the codebase.** Every write failure (antivirus lock `EPERM`/`EBUSY`, read-only mount `EROFS`, a project-switch race returning `false`) is mapped to fixed UI copy "check disk space." The real errno is discarded at the IPC boundary | `projectIpc.ts:366-378`, `useAutosave.ts:180` |

The persistence layer is **correct and safe** (atomic writes, single-flight debounce, dirty-ref gating, `.bak` recovery, cross-project write guards) but pays for that safety on the **main thread every ~1 s of editing**: a full read+parse of the prior doc, a full pretty-printed rewrite, a **synchronous** `.bak` rewrite, and a per-board fingerprint pass — plus the file watcher watching the very directory being written.

Nothing here needs a rewrite. The high-impact fixes are localized and low-risk.

---

## 2. Prioritized findings

Severity is rated by real-world impact on the 8 GB responsiveness goal.

### CRITICAL

| ID | Finding | File |
|---|---|---|
| **C1** | Background project sessions: **no cap, no TTL**, silent-keep bypasses the dialog → agent PTY trees accumulate for the app lifetime | `projectSessions.ts:122-130,160-169`; `pty.ts:977-979`; `projectSwitch.ts:78-80` |
| **C2** | 12.5 Hz whole-node re-render of `TerminalBoard` while any shell is "running" (idle prompt included) | `TerminalBoard.tsx:402-407` |
| **C3** | No disk-space check exists; **all** write failures mislabeled "check disk space"; errno discarded at IPC boundary (the reported false-ENOSPC bug) | `projectIpc.ts:366-378`; `useAutosave.ts:180` |

### HIGH

| ID | Finding | File |
|---|---|---|
| **H1** | Every autosave: synchronous `.bak` rewrite blocks MAIN + 2× write amplification (primary + full backup) | `projectStore.ts:165-180` |
| **H2** | Every autosave reads + `JSON.parse`s the prior doc **twice** (synchronously) just to rotate the backup | `projectStore.ts:166-168` |
| **H3** | File watcher watches the app's own `.canvas/` write dir (no `.canvas`/build-dir ignores) → write→watch→IPC feedback loop every save + open-time stat storm; also raises the rename contention behind C3 | `fileWatch.ts:38-53,115-125` |
| **H4** | Up to **8 frozen Chromium OSR renderers** held resident; eviction fires only at new-window creation, never on switch | `previewOsr.ts:168,523,185-197`; `previewOsrBackground.ts:57-76` |
| **H5** | Full BGRA frames copied over IPC (~16 MB/frame at S=2), no transferable/shared buffer; the common case on HiDPI 8 GB laptops | `previewOsrOwner.ts:180`; `previewOsr.ts:630-632` |
| **H6** | CDP `Network.enable` capture always-on for **every** board incl. frozen/off-screen (only the emit is gated); per-board WS ring ceiling ~256 MB | `previewOsrNetwork.ts:16,462-476`; `previewOsr.ts:599` |
| **H7** | Off-screen paint-gated boards still run page JS/timers/`setInterval`/sockets **unthrottled** (throttle only re-enabled on project switch) | `previewOsr.ts:251,536`; `previewOsrBackground.ts:66` |
| **H8** | Chrome subtree (`AppChrome`, `ProjectLibraryPanel`, `DigestPanel`) re-renders every board-drag frame + planning keystroke — not `React.memo`'d | `Canvas.tsx:150,992-1001` |
| **H9** | Terminal uses xterm **DOM renderer** (no WebGL/canvas); re-rasterized on every pan/zoom + heavy DOM mutation on output; no low-end opt-out | `useTerminalSpawn.ts:731-734` |

### MEDIUM

| ID | Finding | File |
|---|---|---|
| **M1** | Whole board tree rewritten on **any** change including a camera pan; `viewport`/`background` coupled into the monolith | `Canvas.tsx:784-790`; `useAutosave.ts:39` |
| **M2** | `fsync`-by-default on every atomic write, incl. regenerable sidecars (thumbnails, terminal snapshots, memory summaries) | `write-file-atomic/lib/index.js:227`; `canvasMemory.ts`, `terminalSnapshot.ts:90`, `projectThumbs.ts` |
| **M3** | `memoryEngine.observe` fingerprints (`JSON.stringify`) **every board** on every save — a 3rd full-tree pass on the save critical section | `projectIpc.ts:369`; `memoryEngine.ts:163-177` |
| **M4** | Summary loop rewrites `MEMORY.md` + `project.md` wholesale (3–4 `fsync`'d files) per intent, on a 25 s cadence while agents run | `summaryLoop.ts:723-733`; `index.ts:687` |
| **M5** | Synchronous `writeFileSync` of the thumbnail PNG on MAIN inside the switch-critical `project:captureThumb` handler | `projectThumbs.ts:151` |
| **M6** | Blit worker allocates a fresh full-size RGBA buffer per frame (ignores the `out` reuse arg) → ~1 GB/s garbage under full motion | `osrBlitWorker.ts:41`; `bgraToRgba.ts:29-33` |
| **M7** | Per-board in-memory preview sessions never released (`clearStorageData`/`clearCache` never called; board ids are non-reused UUIDs) | `previewOsr.ts:542,97-99` |
| **M8** | `buildDigest` (O(boards×elements), ~8 filter passes/planning board) recomputes every drag frame even when the digest panel is closed | `Canvas.tsx:280-283`; `digest.ts:96-121` |
| **M9** | Per-PTY-chunk `postMessage` over the MessagePort with no main-side batching | `pty.ts:655-674` |
| **M10** | `edges` array + `onDelete` closures rebuilt every drag frame; edge components not memoized | `Canvas.tsx:321-332`; `canvasEdges.ts:41-51` |
| **M11** | In-app MCP server (Express + MCP SDK + zod) boots **unconditionally at startup** and holds a constant low-MB heap even when Agent Orchestration is never used; a 2nd always-on loopback server (`localServer`) too. Lazy-start on first consent instead. See `MCP-SERVER-COST.md` | `mcp.ts:170`; `index.ts:478,445` |

### LOW

| ID | Finding | File |
|---|---|---|
| **L1** | Pretty-printed JSON (`null, 2`) inflates the double-written / re-parsed bytes ~1.3–2× | `projectStore.ts:173` |
| **L2** | No content diff at the writer — identical-content boards still hit disk | `projectStore.ts:149-181` |
| **L3** | `recents` file re-read uncached on every open/create/reopen | `projectIpc.ts:203-210` |
| **L4** | `BoardInspector` re-renders every zoom frame (subscribes to raw `zoom`) | `BoardInspector.tsx:59` |
| **L5** | `JSON.stringify` inside a Zustand selector runs on every store notification while a DataFlow board is mounted | `DataFlowBoard.tsx:91-93` |
| **L6** | `cursorBlink: true` + `preview:event` one-listener-per-board — minor, consistency nits | `useTerminalSpawn.ts:657`; `preload/index.ts:516-520` |
| **L7** | MAIN OSR supersample cap (`S≤4`, logical ≤4096) mismatches the renderer's real ceiling (`S≤2`, logical ≤1280) — defense-in-depth gap | `previewOsrSizing.ts:45-52` vs `osrSizing.ts:35` |

---

## 3. Detailed findings

### C1 — Uncapped, no-TTL background project sessions *(memory, switch-lag headline)*

**Root cause.** The Phase-4 "keep running" feature parks a switched-away project's PTYs and freezes its preview windows rather than killing them — by design — but there is **no cap on how many projects may be backgrounded**, background parks have **no TTL**, and a remembered keep policy backgrounds **silently**.

Background PTYs are explicitly TTL-exempt (`pty.ts:977-979`): *"park every LIVE session owned by `dir` as a `'background'` park — NO TTL (reaped only by disposeProjectPtys or quit)."* Undo-parks, by contrast, expire at `PARK_TTL_MS = 120_000` (`pty.ts:90`).

No cap is enforced. `backgroundProject()` parks + registers with no count check (`projectSessions.ts:122-130`); `backgroundCount()` exists (`:160`) but is referenced only in tests. The silent path: `projectSwitch.ts:78-80` returns `true` (background, no dialog) whenever `policy === 'keep'`, which includes the persisted `foreverKeeps`.

**What accumulates.** Every keep-alive switch retains that project's entire terminal agent process trees (node-pty → shell → agentic CLI, commonly 150 MB–1 GB+ resident each) for the whole app run. Switch through 3–4 projects with 2 agents each → 6–8 live agent trees + xterm buffers held simultaneously. On an 8 GB Mac this is exactly the reported "memory growth / lag when switching projects."

**Recommendation.**
1. Enforce `MAX_BACKGROUND` (2–3). On exceed, auto-close the **longest-backgrounded** project (mirror `pickOsrEvictions`), or force the ask-dialog and refuse silent keep past the cap.
2. Give background parks a generous **idle TTL** (auto-close after N minutes without switch-back), reaping PTYs like undo-parks.
3. Surface total backgrounded resource use in the switcher so silent-keep can't hide it.

**Estimated impact.** The single largest memory lever — each reclaimed background project frees hundreds of MB to multiple GB. Directly targets the reported scenario.

---

### C2 — 12.5 Hz whole-`TerminalBoard` re-render while running *(CPU, single-terminal-lag headline)*

**Root cause.** A braille spinner advances via component `setState` every 80 ms, and the state lives on the 823-line, 35-hook `TerminalBoard` node itself.

```ts
// TerminalBoard.tsx:402-407
const [spinnerFrame, setSpinnerFrame] = useState(0)
useEffect(() => {
  if (!running || prefersReducedMotion()) return
  const id = setInterval(() => setSpinnerFrame((f) => f + 1), 80)
  return () => clearInterval(id)
}, [running])
```

`running` is `state === 'running'` — true for **any live shell, including one idle at a prompt**. `spinnerFrame` feeds `displayStatus` (`:414-415`) which is used in the render, so the entire node's JSX subtree reconciles 12.5×/sec continuously with one terminal open. `useRunTimer(running)` (`:411`) adds a further ~1/sec re-render. Not gated on PTY activity — only on liveness.

**Recommendation.** Extract the glyph into a tiny isolated leaf (`<SpinnerGlyph running/>`) owning its own state so only ~1 line re-renders at 12.5 Hz — or drive it with a pure CSS `@keyframes` step-animation (zero JS, compositor-only, like the cursor blink already is). Consider 80 ms → 120–150 ms.

**Estimated impact.** Removes the only always-on, activity-independent main-thread cost for an open terminal; the best match for the reported idle lag. Scales linearly per running terminal. Low-risk change.

---

### C3 — No disk-space check; write failures mislabeled "disk space" *(correctness/UX, named user bug)*

**Root cause.** There is no free-space check anywhere in `src/` (no `statfs`/`checkDiskSpace`/`diskusage`/`freemem`). The write path throws on real filesystem errors, the errno is discarded at the IPC boundary, and the renderer hardcodes a "disk space" string.

The chain that makes a user with TB free see a "disk space" error:

1. **The write** — `projectStore.ts:173` + `:176`: `write-file-atomic` does temp-create → `fsync` → `rename()`. On Windows that `rename()` throws `EPERM`/`EBUSY`/`EACCES` while Windows Defender (or any AV) scans the fresh temp file, or `EROFS` on a read-only/synced mount — none disk-space conditions. `write-file-atomic` does not retry.
2. **Errno discarded** — `projectIpc.ts:366-378` catches *every* error and returns a bare `false`. The same handler also returns `false` for a project-switch race (`:358` `expectedDir !== dir`) and for an envelope-invalid doc (`projectStore.ts:155`) — both non-disk causes.
3. **Message hardcoded** — `useAutosave.ts:180`: `setSaveFailure('Auto-save failed — check disk space and permissions')`. Same fixed copy in `ProjectSwitcher.tsx:114,120`, `terminalSaveOutput.ts:88`, `runExport.ts:37`, `usePlanningImageIO.ts:60`.

**Hypothesis, stated plainly.** Users on Windows hit `EPERM`/`EBUSY` from antivirus locking the atomic-write temp file during the ~1 s autosave rename (amplified because the file watcher watches the very directory being written — H3), or `EROFS` on a synced/network folder. Free space is irrelevant to the actual failure.

**Recommendation.** Propagate `err.code` from `project:save` (return `{ ok: false, code }` instead of `false`) and map messages by code in the renderer: `ENOSPC` → disk space; `EPERM`/`EACCES`/`EBUSY` → "file is locked (antivirus/another program) or permission denied"; `EROFS` → "read-only location"; default → generic. Only say "disk space" for actual `ENOSPC`. Optionally add a genuine pre-flight free-space check.

**Estimated impact.** Eliminates the false ENOSPC reports; no I/O change, pure correctness/UX.

---

### H1 + H2 — Synchronous `.bak` write + double read, every autosave *(main-thread block, disk I/O)*

Both live in the same 30-line function (`writeProject`, `projectStore.ts:149-181`):

```js
let prior: Buffer | undefined
if (tryParse(primary) !== undefined) {          // :166  readFileSync + JSON.parse of the WHOLE prior doc
  try { prior = readFileSync(primary) }         // :168  reads the WHOLE prior file AGAIN
  ...
}
await writeFileAtomic(primary, JSON.stringify(doc, null, 2), 'utf8')  // :173 async primary
if (prior !== undefined) {
  writeFileAtomic.sync(bakPath(dir), prior)     // :176 SYNC .bak — blocks MAIN
}
```

Per successful save (each ~1 s during active editing): **2 full synchronous reads + 1 full `JSON.parse`** of the prior doc, **1 async full write** (primary), **1 synchronous full write** (`.bak`). The sync `.bak` write blocks Electron's single main thread — which also services PTY control IPC, preview frame relays, and the MCP/local HTTP servers. For a multi-MB whiteboard doc this is a recurring tens-of-ms main-thread stall.

**Recommendation.** (a) Make the `.bak` write `await writeFileAtomic(...)` (async) on the autosave path; reserve `.sync` for the quit path. (b) Better: rotate `.bak` on a coarser cadence (once per N saves or once per session-open) — it only needs to be "last known-good," not "one save ago." (c) Read the prior bytes once (drop the separate full `tryParse` parse). Together these roughly halve steady-state save I/O and remove the only recurring synchronous main-thread block in the autosave loop.

**Estimated impact.** ~50% less save I/O; eliminates a periodic main-thread stall during editing.

---

### H3 — File watcher watches `.canvas/` (the write dir) and build outputs *(disk I/O, feedback loop)*

```js
// fileWatch.ts:38-53
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules'])
const IGNORED_BASENAMES = new Set(['canvas.json.bak'])
```

The recursive chokidar watcher (`fileWatch.ts:115-125`, `awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }`) does **not** ignore `.canvas/`, `dist`, `build`, `out`, `.next`, `target`, `venv`, etc. Consequences:

- **Self-watch feedback loop.** `.canvas/` holds `canvas.json`, memory summaries, terminal snapshots, audit log — all written ~1×/sec. Each write fires change events that are stat-polled (`awaitWriteFinish`) and forwarded over IPC (`file:treeEvent`) to the renderer, even though the File Tree hides `.canvas/`. The watcher and the writer point at the same directory continuously.
- **Open-time stat storm.** Opening a large repo triggers a full recursive `readdir`+`stat` of every build-output/dependency dir not in the ignore set.
- **Rename contention.** Watching the atomic-write temp files raises the probability of the rename `EPERM`/`EBUSY` behind C3.

**Recommendation.** Add `.canvas` to `IGNORED_SEGMENTS` (the tree hides it anyway — zero functional loss) plus common heavy build dirs. The write→watch→IPC loop disappears and the open-time walk shrinks.

**Estimated impact.** Removes a continuous stat-poll + IPC stream proportional to save frequency; large open-time reduction on big projects; also reduces C3 false positives.

---

### H4 + H7 + M7 — Preview OSR resident cost across projects *(memory, CPU)*

- **H4 (resident renderers).** `GLOBAL_OSR_MAX = 8` (`previewOsr.ts:168`) bounds offscreen windows, but `pickOsrEvictions` only evicts **backgrounded** entries and only runs inside `ensureOsr` (new-window creation, `:523`). Switch A(browser)→B(browser)→…→ a browser-less project and up to 8 frozen Chromium renderers (~80–200 MB each, more with a large SPA heap) stay resident until you next open a Browser board somewhere. ~1–1.5 GB reclaimable. **Fix:** run the trim on project switch/foreground, coupled to C1's `MAX_BACKGROUND`.
- **H7 (unthrottled off-screen JS).** Freezing a board calls only `stopPainting()` (`previewOsr.ts:251`); the window is `backgroundThrottling: false` (`:536`) and throttling is re-enabled only on a project switch (`previewOsrBackground.ts:66`). So an off-screen board in the *active* project stops compositing but its `setInterval`/`fetch`/WebSocket keep running full-speed. **Fix:** call `setBackgroundThrottling(true)` inside `applyOsrPaint(false)` and restore on resume — a one-line change.
- **M7 (session accumulation).** Each board mints `session.fromPartition('preview-osr-<uuid>')` (`previewOsr.ts:542`); `disposeOsr` destroys the window but never `clearStorageData`/`clearCache`. In-memory only (no disk leak), but RAM grows over a long session of opening/closing Browser boards. **Fix:** best-effort `clearStorageData()` on dispose.

---

### H5 + M6 + L7 — Preview OSR frame pipeline cost *(CPU, memory bandwidth)*

- **H5.** Frames go main→renderer via `webContents.send('preview:osrFrame', payload)` (`previewOsrOwner.ts:180`) — standard structured-clone IPC: the BGRA `Buffer` is copied in main and again in the renderer (the zero-copy transfer only happens later, renderer→worker). At the Desktop preset (1280×800) supersampled S=2 that is `2560×1600×4 = 16.4 MB/frame`. A full-motion page (video/scroll → `dirty == full`) at 30 fps ⇒ ~491 MB/s per board, copied ≥2×. **DPR≥2 on a retina 8 GB laptop hits S=2 at rest**, so this is the *common* case on the target hardware, not the worst case. **Fix:** stream full repaints over a dedicated `MessageChannelMain` with a transferable buffer; expose a low-RAM setting capping `OSR_MAX_SUPERSAMPLE=1` and/or the frame rate.
- **M6.** The blit worker calls `bgraToRgba(new Uint8Array(buffer))` with no `out` reuse (`osrBlitWorker.ts:41`), allocating a fresh 16 MB `Uint8ClampedArray` per frame even though the function supports a reusable `out` (`bgraToRgba.ts:29-33`) → ~1 GB/s of worker garbage under full motion. **Fix:** a small pool of 2–3 reused scratch buffers.
- **L7.** MAIN's `sanitizeOsrSize` allows `S≤4` / logical ≤4096 (physical up to ~1 GB/frame) while the renderer only ever sends `S≤2` / logical ≤1280 — align the trust-boundary clamp with the real contract.

---

### H6 — Always-on CDP network capture *(CPU idle-time, memory)*

`wireOsrNetwork` → `armOsrNetwork` runs unconditionally in `ensureOsr` (`previewOsr.ts:599`), issuing `Network.enable` + `Target.setAutoAttach` (`previewOsrNetwork.ts:462-476`); the header confirms *"Capture is always-on for a live board"* — only the *emit* to the renderer is `subscribed`-gated. So every request/response/WS-frame for every live page streams over CDP to MAIN and is processed on the main thread even with **no inspector panel open and the board paint-frozen**. A chatty HMR/polling/WebSocket dev page burns MAIN CPU continuously and invisibly. Per-board ceilings are large: `MAX_RECORDS=1000`, WS buffers `500 × 16 KB × 32 sockets ≈ 256 MB` theoretical, plus CDP `maxTotalBufferSize:10 MB`.

**Fix.** Make capture lazy — `Network.enable` only when a panel subscribes, `Network.disable` on unsubscribe; shrink the no-subscriber ceilings. Pure win, no UX cost.

---

### H8 + M8 + M10 — Renderer re-render fan-out on drag/keystroke *(CPU)*

The app already insulates boards from pan/zoom (LOD-boolean subscriptions, per-id node cache, memoized planning cards). The remaining waste is the **chrome** and **derived data**, which are not insulated from `CanvasInner`'s own re-render:

- **H8.** `CanvasInner` subscribes to the whole `boards` array (`Canvas.tsx:150`); during a board drag `onNodesChange` → `updateBoard(id, {x,y})` fires ~60 fps, and every planning keystroke commits a new `boards` array. `AppChrome` (`:992`), `ProjectLibraryPanel` (`:1001`), and `DigestPanel` (`:993`) are plain functions rendered as children → the whole chrome fan-out (file tree, inspector, dock, camera cluster, switcher) reconciles every frame. The callbacks passed down are already stable (`tidyAndFit`/`focusGroup` are `useCallback`), so **`React.memo` on these three components would take effect immediately.** Biggest single responsiveness lever for drags/typing.
- **M8.** `buildDigest` (`Canvas.tsx:280`, O(boards×elements), ~8 filter passes per planning board) is derived unconditionally with dep `[boards, connectors]`, so a position-only drag recomputes it every frame despite identical output, and `DigestPanel` stays mounted-when-closed. **Fix:** gate on `digestOpen`; the digest ignores geometry so key it on a position-stripped projection.
- **M10.** `edges` (`Canvas.tsx:321`) rebuilds from `boards` every drag frame with fresh `onDelete` closures (`canvasEdges.ts:41-51`); edge components are plain functions. **Fix:** `React.memo` the three edge components + stabilize `onDelete`.

---

### H9 + M9 — Terminal render/transport cost *(CPU)*

- **H9.** The terminal deliberately uses xterm's **DOM renderer** (no WebGL/canvas addon — `useTerminalSpawn.ts:731-734`) so Chromium re-rasterizes glyphs crisply at the live camera scale. That is xterm's most CPU/layout-expensive path: (a) pan/zoom re-rasters the whole text DOM layer at each scale; (b) heavy output mutates row DOM + forces style recalc. No opt-out for weak hardware. **Fix (deferred P2 in the research doc):** offer an opt-in `@xterm/addon-canvas` low-power renderer, and/or freeze the terminal host to a static layer during an active pan/zoom gesture (the OSR "frozen frame" trick).
- **M9.** `proc.onData` posts each node-pty chunk individually over the MessagePort (`pty.ts:655-674`); the renderer coalesces *rendering* into one rAF flush (good) but the cross-process message volume and per-chunk handler cost (incl. the `pasteMode.observe` regex scan, L6) are not batched. **Fix:** micro-batch `onData` chunks on `setImmediate`/a ~4–8 ms timer before `postMessage`.

---

### M1 — Whole-document rewrite on any change, viewport coupled into the monolith *(disk I/O, CPU)*

`viewport` ∈ `SAVED_KEYS` (`useAutosave.ts:39`), and the RF transform is mirrored into `setViewport` every rAF frame during pan/zoom (`Canvas.tsx:784-790`). The debounce correctly coalesces a pan to a single write, and `setViewport` L2-guards identical transforms — but that single post-pan write still serializes + double-writes the **entire board tree** just because the camera moved. There is no per-board/per-region dirty set anywhere.

**Fix.** Persist `viewport` (and `background`, also settings-class) in a small sidecar so a camera/backdrop change writes a few hundred bytes instead of the whole tree. This is the high-leverage architectural move short of full incremental persistence.

---

### M2 + M3 + M4 + M5 — Other save-path CPU / disk cost

- **M2.** `write-file-atomic` `fsync`s by default (`lib/index.js:227`); no caller passes `fsync:false`. `fsync` is the expensive part on Windows. For regenerable sidecars (thumbnails, terminal snapshots, memory summaries) durability-on-power-loss is not required → pass `fsync:false`.
- **M3.** `memoryEngine.observe(doc)` runs `boardFingerprint` = `JSON.stringify(...)` per board on **every** save (`projectIpc.ts:369`, `memoryEngine.ts:163-177`) — a 3rd full-tree pass on the critical section, even though the engine's own downstream debounce is 45 s. Defer/sample it (`setImmediate`, off the write path).
- **M4.** Each summarize rewrites `board-<id>.md` + `MEMORY.md` + `project.md` wholesale via `writeFileAtomic.sync` (3 fsyncs; +1 recap sidecar), driven by a 25 s recap watcher while an agent is active (`summaryLoop.ts:723-733`). Skip `writeIndex`/`writeProject` when the rendered content is byte-identical (cheap read-compare), or write them only on project-open + board add/remove.
- **M5.** `projectThumbs.ts:151` `writeFileSync(...PNG)` runs synchronously inside the `project:captureThumb` handler on every switch-away + dock-open (already `async` — just use `fs.promises.writeFile`; cosmetic PNG needs no atomicity/fsync).

---

## 4. Recommended remediation sequence

Ordered by impact-to-effort. Items 1–6 are localized, low-risk, and cover the three reported symptoms.

**Quick wins (hours each, high impact):**
1. **C2** — isolate the terminal spinner to a CSS keyframe or leaf component. *(idle single-terminal lag)*
2. **H3** — add `.canvas` + build dirs to the watcher ignore set. *(disk churn + C3 contention)*
3. **C3** — propagate `err.code` and map errno→message; stop saying "disk space" for non-`ENOSPC`. *(false disk errors)*
4. **H1/H2** — make the `.bak` write async / coarser-cadence; read the prior once. *(save-time main-thread stall)*
5. **H7** — `setBackgroundThrottling(true)` in `applyOsrPaint(false)`. *(off-screen board CPU)*
6. **H6** — make CDP network capture lazy (subscribe-gated). *(idle preview CPU/memory)*
7. **H8** — `React.memo` `AppChrome`/`ProjectLibraryPanel`/`DigestPanel`. *(drag/keystroke fan-out)*

**Structural (days, largest ceilings):**
8. **C1** — `MAX_BACKGROUND` cap + idle TTL for background project sessions; block silent-keep past the cap. *(switch memory growth)*
9. **H4** — trim OSR renderers on switch/foreground, coupled to C1.
10. **H5/M6** — transferable-buffer frame stream + a low-RAM setting (`OSR_MAX_SUPERSAMPLE=1`, lower fps).
11. **M1** — split `viewport`/`background` into a sidecar so camera/backdrop changes don't rewrite the board tree.
12. **M11** — lazy-start the MCP server (`ensureMcp()` memoized singleton, triggered on first orchestration-enable; optional stop-on-disable) + a `process.memoryUsage()` heap-delta to size it first. Same treatment for `localServer`. Full rationale in `MCP-SERVER-COST.md`. *(Do NOT extract to a separate process — that raises total RAM; see the addendum.)*

**Polish:** M2–M5, M8–M10, all Low items.

---

## 5. Architecture notes

- **UI state vs persisted state.** The scene/session split is already disciplined (ephemeral selection/tool/hover never reaches `canvas.json`). The remaining coupling is **`viewport`/`background` in the persisted monolith** (M1) — settings-class data that forces a full board-tree rewrite on a pan. A small sidecar (`.canvas/session.json` or similar) cleanly separates "where the camera is" from "what the boards are."
- **Persistence unit.** The single monolithic `canvas.json` is simple and git-friendly but means every write is O(whole document). Given the safety machinery already in place, the highest-leverage move is not incremental persistence (large change) but making the whole-doc write **cheap** (async `.bak`, single prior read, `fsync:false` on sidecars, compact `.bak`) and **rarer for trivial changes** (viewport sidecar).
- **Always-on subsystems at boot.** `app.whenReady` eagerly starts the MCP HTTP server, the local preview HTTP server, the voice engine wiring, the recursive file watcher, auth/sign-in, and recap (`index.ts:368-520`). This is baseline weight on a low-RAM host even when the user only wants one terminal. Consider lazy-starting the MCP server and voice engine on first use, and only arming the file watcher when a File board (or the tree) is actually shown.
- **Low-RAM mode.** Several fixes converge on one setting: cap `OSR_MAX_SUPERSAMPLE=1`, lower OSR fps, opt into the xterm canvas renderer, and lower `MAX_BACKGROUND`. A single "low-memory mode" toggle (auto-enabled under a RAM threshold via `os.totalmem()`) would package H5/H9/C1/H4 for exactly the 8 GB target.

---

## 6. What is already good (do not "fix" these)

Verified during the audit; documented so effort isn't wasted:

- **Autosave engine** — 1 s debounce with correct coalescing, single-flight latch + trailing-coalesce, and a cheap ref-diff dirty gate (`SAVED_KEYS`); no overlapping writers; snapshots/thumbs/memory are off the hot path (`useAutosave.ts:45-118`).
- **Atomic writes + recovery** — temp+rename, `.bak` rotation *after* the primary is durable, envelope guards on both read and write, `expectedDir` cross-project write rejection (`projectStore.ts:149-181`, `projectIpc.ts:358-361`).
- **Assets** — content-addressed sha1, deduped (write skipped when the file exists), GC'd to `.trash` at open only (`projectStore.ts:366-459`).
- **Undo/redo** — capped at 50 with structural sharing (`history.ts:6`); no unbounded growth.
- **Teardown** — per-board stores clear on unmount; terminal disposes ports/observers/addons/PTYs; `disposeAllPtys`/`disposeOsr` drain their maps; watchers close before re-point; `memoryEngine`/`agentRecapWatcher` prune removed boards. No scattered leaks found.
- **Render** — `nodeTypes`/`edgeTypes` are module constants; boards subscribe to a derived `isLod` boolean so pan/zoom does not re-render them; perfect-freehand outlines cached in a `WeakMap`; planning cards memoized with ref-latest callbacks; file tree virtualized (react-arborist).
- **Terminal buffers** — main ring 256 KB/terminal, renderer scrollback default 2000 / cap 50k lines, hidden terminals render 0 (fully held); snapshots written only at going-away moments, capped 64 MB, async off the quit path.
- **OSR** — zero per-frame camera IPC, 30 fps cap, dirty-rect cropping, swizzle off the main thread, frozen boards send no frames, in-memory sessions (no disk cache), thorough disposal.
- **Backdrop** — never reads the viewport; scene rAF stops on `document.hidden`/unmount and respects reduced-motion; returns null for the default 'none'.

---

*Findings verified against source at the cited `file:line`. Line numbers reflect the tree as of 2026-07-08.*
