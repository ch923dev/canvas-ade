# Structural Fixes — Implementation Plan (PLAN ONLY)

**Date:** 2026-07-09 · Branch: `perf/structural-plan` · Base: `perf/audit-umbrella`
**Companion to:** [`AUDIT.md`](./AUDIT.md) (§4 "Structural" items 8–12) and [`MCP-SERVER-COST.md`](./MCP-SERVER-COST.md).
**Status:** design only — **no `src/` changes, no `package.json` bump.** Another pass implements from this.
**Live plan board:** canvas planning board `Perf Structural — perf/structural-plan` (`36c7a868…`), kept in lock-step with this doc.

This plan covers the five **structural** audit items — **C1, H4, H5/M6, M1, M11** — plus the umbrella **Low-RAM mode** (AUDIT §5) that packages their knobs for the 8 GB target. Every design decision was verified against primary sources (Electron/Node/Chromium docs); citations are inline. One audit premise (H5's zero-copy claim) **did not survive research** and is corrected below.

---

## 0. Executive summary + the one correction

| Item | Sev | Core move | Migration risk | Web-research verdict |
|---|---|---|---|---|
| **C1** | CRIT | `MAX_BACKGROUND` cap + idle TTL for background project sessions | none (runtime state) | confirmed: destroy is the only reclaim |
| **H4** | HIGH | Run OSR eviction on switch/foreground, coupled to C1 | none | confirmed: `win.destroy()` is the only renderer-RAM reclaim |
| **H5/M6** | HIGH | **PIVOT** → low-RAM supersample/fps caps + in-worker buffer pool | none | ⚠️ **audit's transferable-buffer plan rejected** (not zero-copy across processes) |
| **M1** | MED | `.canvas/session.json` sidecar for `viewport`/`background` | additive, **no floor bump** | confirmed: dual-write forward-compat pattern |
| **M11** | MED | `ensureMcp()` lazy singleton on first orchestration-enable | none | confirmed: memoize the promise, catch-evict; **do not** extract to a process |

**The correction (H5).** The audit recommends "stream full repaints over a dedicated `MessageChannelMain` with a transferable buffer (zero-copy)." Research shows this **cannot** be zero-copy: Electron's transfer lists on the main↔renderer boundary accept `MessagePortMain[]` **only** — an `ArrayBuffer` in the transfer list is unsupported (historically crashed, now rejected — [electron#37585](https://github.com/electron/electron/pull/37585)), and `ArrayBuffer` transfer is a *same-process, thread-to-thread* ownership handoff, so across the main/renderer **process** boundary the 16 MB still crosses Chromium's mojo IPC exactly once ([electron#45034](https://github.com/electron/electron/issues/45034); [MDN Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)). A `MessageChannelMain` rewrite would be **equal cost** to today's `webContents.send(buffer)` — pure churn. The real, code-only levers for H5 are **sending fewer bytes** (supersample=1, lower fps) and the **in-worker buffer pool** (M6, which *is* genuinely zero-copy because it lives inside one renderer). The proper long-term zero-copy path is **GPU shared-texture OSR** (`offscreen.useSharedTexture`), which needs a native GPU-import addon — scoped as a spike, not this pass.

---

## 1. Dependency ordering & rollout

```
        ┌─────────────── measure ───────────────┐
M11 ────┤ (heap delta first, then lazy-start)    │  independent, ship anytime
        └────────────────────────────────────────┘
C1 ───────────────► H4            (H4 reads C1's MAX_BACKGROUND budget; land C1 first,
   cap + TTL         couple trim   then couple H4's OSR trim to the same number)

M1 ─── standalone sidecar migration (touches persistence; land in its own PR, big test surface)

H5/M6 ─── supersample/fps caps + worker pool (independent; caps feed Low-RAM mode)

Low-RAM mode ─── LANDS LAST: the single toggle that flips C1/H4/H5 knobs together.
                 Build the config + os.totalmem() gate first as a no-op scaffold,
                 wire each item's knob to it as that item lands.
```

**Recommended PR sequence** (each self-contained, each ends runnable + committed + manual-dev-checked):

1. **M11 measure** (temporary instrumentation) → real heap/rss number on target hardware.
2. **M11 lazy-start** (remove instrumentation, ship `ensureMcp()`).
3. **C1** (cap + TTL + switcher surfacing).
4. **H4** (OSR trim on switch, coupled to C1's constant).
5. **H5/M6** (worker pool + supersample/fps caps + L7 clamp alignment).
6. **M1** (session sidecar — largest test surface, isolated PR).
7. **Low-RAM mode** (config + `os.totalmem()` gate + wire all knobs; auto-enable ≤ 8 GiB).

Rationale: M11 is a clean isolated reclaim (ship first, it de-risks the boot path). C1 must precede H4 (H4 consumes C1's budget constant). M1 is persistence-critical and gets its own PR so a regression is bisectable. Low-RAM mode is last because it only *flips* knobs the earlier items expose — it has nothing to configure until they exist.

---

## 2. C1 — Cap + TTL for background project sessions

### 2.1 Current design (verified)

- **Registry.** `createProjectSessions()` (`src/main/projectSessions.ts:89-188`) holds `registry = Map<dir, {name, backgroundedAt}>`. `backgroundProject(dir)` (`:122-130`) reaps undo-parks, parks PTYs, freezes OSR, and `registry.set(...)` — **no count check**. `backgroundCount()` exists (`:160`) but is referenced only in tests.
- **PTY park has no TTL.** `parkProjectSessionsCore` (`src/main/pty.ts:982-994`) calls `parkCore(id, …, undefined, 'background')`; `parkCore` (`:323-359`) arms a `setTimeout` reaper **only** when `parkTtlMs !== undefined`. A `'background'` park arms none — "reaped only by `disposeProjectPtys` or quit's `disposeAllPtys`" (`:978-980`). Undo-parks, by contrast, expire at `PARK_TTL_MS = 120_000` (`pty.ts:90`).
- **Silent-keep.** `decideKeep()` (`src/renderer/src/store/projectSwitch.ts:69-101`) returns `true` with **no dialog** when `info.policy === 'keep'` (`:80`), which includes persisted `foreverKeeps` (`projectSessions.ts:168-169`, `getSwitchPolicy` = `sessionKeeps ∪ foreverKeeps`).
- **The scoped-close safety already exists** and must be preserved: `projectSwitch.ts:190-194` uses `closeActiveLiveResources` (scoped) on STOP, never the dispose-all; `closeBackgroundProject` (`projectSessions.ts:137-144`) is registry-guarded so a renderer path can never dispose an arbitrary dir. **New C1 auto-close code MUST route through these scoped paths.**

### 2.2 Proposed approach

Enforce a hard cap and an idle TTL **in the MAIN-side registry** (`projectSessions.ts`), the single source of truth, so no renderer path can bypass it:

1. **`MAX_BACKGROUND` cap (default 3; Low-RAM 1).** In `backgroundProject(dir)`, *after* registering, if `registry.size > cap`, pick the **longest-backgrounded** resident (smallest `backgroundedAt`, excluding `dir` itself) and auto-close it via the existing `closeBackgroundProject(victim)` — which is already the scoped, registry-guarded kill (`disposeOsr` + `disposeProjectPtys`, both dir-scoped). Mirror `pickOsrEvictions`'s ordering exactly (`previewOsr.ts:185-197`).
2. **Idle TTL (default e.g. 10 min; Low-RAM shorter).** Give each background park a generous idle reaper. Two options — **recommend option (b)**:
   - (a) Arm a per-entry `setTimeout` in the registry that calls `closeBackgroundProject(dir)` on expiry, cleared/re-armed on switch-back (`foregroundProject`).
   - (b) **A single sweep timer** on the registry (`setInterval` ~60 s, `.unref()`), closing any entry whose `backgroundedAt` is older than the TTL. One timer, no per-entry bookkeeping, trivially testable with an injected clock (`deps.now()` already exists). "Idle" = time since backgrounded with no switch-back (switch-back deletes the entry via `foregroundProject`, so `backgroundedAt` *is* the idle clock).
3. **Cap the silent-keep.** In `decideKeep()` (renderer), before honouring `policy === 'keep'`, consult a new `project:backgroundAtCap` IPC (or piggyback on `askOnSwitchInfo`): if backgrounding this project would exceed the cap, **force the dialog** (or auto-close-oldest silently but toast it) rather than silently accumulating. Persisted `foreverKeeps` still counts against the cap.
4. **Surface the totals.** Extend `listBackgroundProjects()` (already returns `terminalsRunning`/`previews` per dir) into the `ProjectSwitcher` UI as an aggregate ("3 projects kept running · 5 terminals · 2 previews") so silent-keep can't hide resource use.

### 2.3 Exact files to change

| File | Change |
|---|---|
| `src/main/projectSessions.ts` | `MAX_BACKGROUND` (via injected getter for Low-RAM live-read), cap-enforce in `backgroundProject`, TTL sweep (inject `now`, add `deps.closeIfIdle`/reuse `closeBackgroundProject`), a `wouldExceedCap()` predicate |
| `src/main/pty.ts` | **new dir-scoped `persistProjectRingTails(dir, append)`** (filter `persistBackgroundRingTailsCore` to one dir) — flush the victim's post-park ring tails **before** dispose (see §2.6 — the reviewer-caught data-loss fix) |
| `src/main/projectSessions.ts` (`closeBackgroundProject`) | call the dir-scoped tail flush before `disposePtys` |
| `src/main/projectSessionsIpc.ts` | new `project:backgroundAtCap` (or fold into `askOnSwitchInfo`'s payload); expose aggregate counts |
| `src/main/index.ts:170-185` | wire the cap getter (from Low-RAM config), start/stop the TTL sweep timer in the app lifecycle |
| `src/renderer/src/store/projectSwitch.ts:69-101` | `decideKeep` consults the cap → force dialog past cap |
| `src/renderer/src/canvas/ProjectSwitcher.tsx` (+ `projectSessionsShared.ts`) | render the aggregate backgrounded-resource line |
| `src/preload/projectSessionsApi.ts` | expose the new IPC |

### 2.4 Build sequence

Registry cap (pure, unit-testable) → TTL sweep (injected clock) → IPC surface → renderer dialog gate → switcher UI. Each step compiles green independently; the cap+TTL land before the UI so the safety net exists even if the UI slips.

### 2.5 Migration / back-compat

**None required** — background sessions are app-run-only runtime state, never persisted (`projectSessions.ts:13-15`). The one persisted artifact, `foreverKeeps` (userData `background-keep.json`), is **unchanged**; the cap simply means a persisted keep may be auto-closed this run (re-keeps on the next switch). Document that `foreverKeeps` is now "keep *when under cap*," not an absolute guarantee.

### 2.6 Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Dispose-all vs scoped-close** (reaping another resident's sessions) | Auto-close MUST use `closeBackgroundProject(victim)` (scoped, registry-guarded) — never `disposeAllPtys`/`disposeAllOsr`. Add a unit test asserting a cap-eviction of A leaves B's sessions live. |
| **TTL races an in-flight switch-back** | ⚠️ **Reviewer-corrected.** `acquireProjectSwitchLock()` is **renderer-side** (`projectSwitch.ts:16,117`), so a MAIN-side sweep **cannot** observe it — the original "no-op while the lock is held" was unimplementable. MAIN's only visible guard is `dir !== getCurrentDir()`, and there is a **residual window**: during the pre-load switch phase (dialog→save→background-outgoing, `projectSwitch.ts:122-179`) `currentDir` still points at the *outgoing* dir and the incoming project may still be a registry resident from a prior backgrounding; `currentDir` flips only when `project:open` runs (`:209-211`). A sweep firing then could reap a past-TTL incoming project just as the user switches back (degrades to a safe re-spawn, not a crash — but defeats the keep). **Mitigation:** add a MAIN-side "pending-incoming-dir" signal set at switch start / cleared on open, and have the sweep skip both `getCurrentDir()` and the pending dir. Do **not** rely on the renderer lock. |
| **Auto-close discards unsaved agent work** | ⚠️ **Reviewer-corrected — the original mitigation was false.** `persistBackgroundRingTails` is **NOT** part of `disposeProjectPtys`: `disposeProjectPtysCore` (`pty.ts:1029-1043`) only reaps parked + cleans up live sessions; the ring-tail flush runs **separately**, only from the quit-equivalent paths (`shutdown()` `index.ts:1071`, darwin close `:246`), each flushing all parked rings *before* `disposeAllPtys`. And `flushAllTerminalSnapshots` covers only the **active** project's mounted xterms — never a backgrounded project's unmounted terminals (which is exactly why `persistBackgroundRingTails` exists, `pty.ts:522-533`). So a C1 auto-close today would **kill the victim's background terminals and silently lose their post-park output.** **Fix (required, also closes a pre-existing gap in the manual "Close project" button):** run a **dir-scoped `persistProjectRingTails(dir)`** (filtered from `persistBackgroundRingTailsCore`) **before** `disposeProjectPtys`, mirroring `shutdown()`'s flush-then-dispose order. Toast the user which project was closed. |
| **Cap too low harms multi-project workflows** | Default 3 (not 1); Low-RAM lowers to 1. User-visible + configurable. |

### 2.7 Test strategy

- **Unit** (`projectSessions.test.ts`): cap eviction picks longest-backgrounded; eviction of A never touches B (dispose-all guard); TTL sweep closes an idle entry, skips the active dir, skips a fresh entry; injected clock drives the TTL deterministically; `foreverKeeps` still counts against cap.
- **e2e** (`@core`, Playwright `_electron`): background 4 projects (with the cap at 3) → assert the oldest's PTYs are gone (pid no longer alive) and the newest 3 survive; assert a switch-back within the window adopts, past the window re-spawns.
- **Manual dev check** (`CANVAS_DEV_TITLE='PR#NNN C1'`): open 3 projects each with a terminal, keep-switch through them, watch Task Manager — resident set should plateau, not climb; confirm the switcher shows the aggregate; confirm the "past cap" dialog fires.

---

## 3. H4 — Trim OSR renderers on switch/foreground (coupled to C1)

### 3.1 Current design (verified)

- `GLOBAL_OSR_MAX = 8` (`src/main/previewOsr.ts:168`). `pickOsrEvictions(entries, max)` (`:185-197`) is pure and correct — it evicts the longest-backgrounded (`backgroundedAt`), never a foreground entry.
- **But it only runs inside `ensureOsr`** (`:523`, `for (const victim of pickOsrEvictions(...)) disposeOsr(victim)`) — i.e. **only when a new offscreen window is created.** Switch A(browser)→B(browser)→…→ a browser-less project and up to 8 frozen renderers stay resident until the next Browser board opens somewhere.
- `foregroundProjectOsr(dir)` (`previewOsrBackground.ts:100-107`) un-throttles and clears `backgroundedAt` on switch-back but **does not trim**. `backgroundProjectOsr` (`:84-96`) freezes + throttles + stamps `backgroundedAt`.

**Research-confirmed constraint:** there is **no partial renderer-memory release** in Electron — `stopPainting()` frees *paint/CPU* work only, not the resident renderer process; the V8 heap/DOM/GPU stay resident until `win.destroy()` ([Offscreen Rendering tutorial](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering); [webContents API](https://www.electronjs.org/docs/latest/api/web-contents); the create/destroy-churn growth in [electron#7350](https://github.com/electron/electron/issues/7350)). So the reclaim **must** be `disposeOsr` (which `win.destroy()`s). There is also **no built-in renderer-process cap** — `--renderer-process-limit` is unreliable and was closed "not planned" ([electron#37437](https://github.com/electron/electron/issues/37437)) — so a manual LRU is the platform-blessed route.

### 3.2 Proposed approach

Add a standalone `trimOsrToBudget(max)` in `previewOsrBackground.ts` that runs `pickOsrEvictions` + `disposeOsr(victim)` **outside** `ensureOsr`, and call it:

> ⚠️ **Reviewer-caught off-by-one.** `pickOsrEvictions` computes `need = all.length - max + 1` (`previewOsr.ts:190`) — the `+1` is deliberate for its *only current* caller `ensureOsr`, which evicts to make room for **one window about to be created**. A standalone trim creates no window, so passing `max` would over-evict to **`max-1`** (and at Low-RAM `max=1`, `trimOsrToBudget(1)` would evict **every** background window). **Fix:** either call `pickOsrEvictions(getOsrEntries(), max + 1)`, or add a trim-specific variant with `need = len - max`. Add a unit test pinning the standalone-trim count (do **not** blindly "reuse `pickOsrEvictions` tests" — the create-time semantics differ).

1. **On project switch-back / foreground.** Right after `foregroundProjectOsr(dir)` completes (in the switch pipeline / `projectSessions.foregroundProject`), trim to the budget. Now switching *away* from browser projects into a browser-less one actively sheds their renderers instead of parking 8.
2. **Couple the budget to C1.** The effective budget = a function of `MAX_BACKGROUND`: only keep OSR windows for (active project + up to `MAX_BACKGROUND` residents). With Low-RAM `MAX_BACKGROUND=1`, that collapses the resident renderer set hard. Keep `GLOBAL_OSR_MAX` as the absolute existence ceiling; add a *tighter dynamic* trim target derived from the live cap.

An evicted board is not lost: the renderer keeps its frozen last frame + a "paused" badge (`useOffscreenPreview.ts:30-33`), the in-memory `preview-osr-<id>` partition keeps cookies, and re-open revives it (`ensureOsr` recreates). This is the **existing** evict-keeps-frozen-frame contract — H4 just triggers it at the right moment.

### 3.3 Exact files to change

| File | Change |
|---|---|
| `src/main/previewOsrBackground.ts` | add `trimOsrToBudget(max)`; call after `foregroundProjectOsr` |
| `src/main/previewOsr.ts` | export a `trimTarget` derived from the live cap; keep `GLOBAL_OSR_MAX` as the hard ceiling |
| `src/main/projectSessions.ts` / `index.ts` | invoke the trim on `foregroundProject`, passing the C1-coupled budget |

### 3.4 Coupling with C1 (explicit)

C1 caps **projects** backgrounded; H4 caps **renderers** resident. They must agree: closing a background *project* (C1 auto-close or TTL) already calls `disposeProjectOsr(dir)` (destroys that project's windows), so C1's eviction *is* an OSR trim for that project. H4 adds the complementary case C1 doesn't cover: an *active* project with many Browser boards, or residents kept under the cap whose OSR count still exceeds the renderer budget. **Land C1 first** so H4's budget can read `MAX_BACKGROUND`; a single Low-RAM config object feeds both.

### 3.5 Migration / risks / tests

- **Migration:** none (runtime).
- **Risks:** (a) Trimming a resident whose board a switch-back is about to remount → the remount's `ensureOsr` just recreates it (one reload, ~acceptable); mitigate by trimming *background* entries only (already enforced by `pickOsrEvictions`) and after the foreground transition settles. (b) Frozen-frame UX: verify the paused badge shows post-trim (existing e2e `osrReviveSizing`).
- **Unit:** `trimOsrToBudget` evicts oldest-backgrounded to the budget, never a foreground entry (reuse `pickOsrEvictions` tests); dynamic budget derives correctly from the cap.
- **e2e** (`@preview`): open Browser boards across 3 projects; switch to a browser-less project; assert offscreen window count drops to the budget; switch back → board revives.
- **Manual dev check:** open several Browser boards, switch to a terminal-only project, confirm in Task Manager the Chromium renderer count falls; switch back and confirm the preview repaints.

---

## 4. H5 / M6 — OSR frame-pipeline cost + low-RAM setting (PIVOTED)

### 4.1 Current design (verified)

- **Send side (MAIN).** `wc.on('paint', …)` (`previewOsr.ts:619-633`) crops the dirty rect and calls `emitFrame({id, full, dirty, buffer: patch.toBitmap()})` → `emitToOwner('preview:osrFrame', payload)` (`previewOsrOwner.ts:177-184`) → `owner.webContents.send('preview:osrFrame', payload)`. Standard structured-clone IPC: the BGRA `Buffer` is serialized (copy) in MAIN and deserialized (copy) in the renderer. At Desktop 1280×800 @ S=2 a full frame is `2560×1600×4 ≈ 16.4 MB`; **DPR≥2 retina at rest already hits S=2** (`osrSizing.ts:35`, `computeOsrSize` = `fit·zoom·dpr`), so this is the common case on the 8 GB target.
- **Worker (renderer).** `useOffscreenPreview.ts:169-181` transfers the BGRA `ArrayBuffer` to `osrBlitWorker` (zero-copy, *within* the renderer). The worker (`osrBlitWorker.ts:41`) calls `bgraToRgba(new Uint8Array(buffer))` — **no `out` reuse** — allocating a fresh ~16 MB `Uint8ClampedArray` per frame, then transfers it back. `bgraToRgba` (`bgraToRgba.ts:29-33`) *supports* a reusable `out` param but nobody passes it → ~1 GB/s of worker garbage under full motion.
- **Clamp mismatch (L7).** MAIN's `sanitizeOsrSize` (`previewOsrSizing.ts:45-52`) allows `S≤4` / logical ≤4096; the renderer only ever sends `S≤2` / logical ≤1280 (`osrSizing.ts:35`). A trust-boundary gap.

### 4.2 What the research changed — the rejected approach

The audit's H5 fix ("transferable-buffer frame stream over a dedicated `MessageChannelMain`, zero-copy") is **rejected**. Primary sources:

- `MessagePortMain.postMessage(message, [transfer])`, `webContents.postMessage(channel, message, [transfer])`, and `ipcRenderer.postMessage` all type the transfer list as **`MessagePortMain[]` / `MessagePort[]`** — an `ArrayBuffer` is not accepted ([message-port-main](https://www.electronjs.org/docs/latest/api/message-port-main); [web-contents](https://www.electronjs.org/docs/latest/api/web-contents); [ipc-renderer](https://www.electronjs.org/docs/latest/api/ipc-renderer)). Putting a non-port there historically **crashed** and is now hard-rejected ([electron#37585](https://github.com/electron/electron/pull/37585)); renderer→main transferables are silently dropped ([electron#34905](https://github.com/electron/electron/issues/34905)).
- Even where transfer *is* legal, it is a **same-process, thread-to-thread** memory-ownership handoff (detaches/neuters the sender's handle) — it does not remove a cross-process copy. Main and renderer are separate OS processes, so the bytes cross mojo IPC regardless ([electron#45034](https://github.com/electron/electron/issues/45034); [MDN Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)).
- **`SharedArrayBuffer` is not a main↔renderer bridge** either — it shares memory only between agents/threads in the *same* process, and enabling it cross-process would require COOP/COEP cross-origin isolation ([web.dev COOP/COEP](https://web.dev/articles/coop-coep)), which would break arbitrary cross-origin Browser-board subresources and re-open Spectre surface ([cross-origin isolation guide](https://web.dev/articles/cross-origin-isolation-guide)).

**Conclusion:** replacing `webContents.send(buffer)` with `MessageChannelMain` is equal-cost churn. Do **not** do it.

### 4.3 Proposed approach (code-only levers)

**(A) M6 — in-worker buffer pool (VALID, genuinely zero-copy within the renderer).**
The main↔worker path *is* real transfer within one process, so pooling there removes allocation without adding a copy. Pattern (ping-pong / double-buffer, the canonical fix — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)):

- The worker keeps a small free-list (2–3) of RGBA `out` buffers, passing one to `bgraToRgba(src, out)` instead of allocating; **allocate-on-empty** (never block) so a drained pool degrades to today's behaviour, never a stall.
- Because the worker **transfers** the RGBA out to the main thread (neutering it), the main thread must **return** the buffer to the worker after `putImageData` (which copies pixels into the canvas backing store, so the buffer is free the instant it returns). Add a `worker.postMessage({returnBuffer}, [returnBuffer])`; the worker pushes it back on the free-list. **Key the pool by the buffer's byte length (= the dirty-rect size, which varies per frame — `patch.toBitmap()` in MAIN crops to the dirty rect), not the full-frame size;** it recycles only when successive frames share a size (`dirty == full` — the video/continuous-motion case this targets).
- ⚠️ **Reviewer-caught pool bleed.** The `onmessage` handler (`useOffscreenPreview.ts:61-86`) has **three early returns before `putImageData`**: gen-mismatch drop (`:63`), no canvas/ctx (`:65`), and non-full frame on a size change (`:75`). Returning the buffer *only* after `putImageData` leaks a buffer on every one of those — and gen bumps fire on exactly the churn the pool must survive (url change/fail/crash/unmount/evict, `:99,111,158,163,185`), draining the free-list. **Fix: return the buffer to the worker on ALL exit paths of the handler (including the gen-drop),** paired with allocate-on-empty in the worker so a lost buffer is self-healing.
- Net: eliminates ~1 GB/s of `Uint8ClampedArray` churn under full motion; no behavioural change on the frame contract.

**(B) Low-RAM byte-reduction (the only lever that shrinks the IPC copy).**
- **Cap `OSR_MAX_SUPERSAMPLE = 1`** in Low-RAM mode (`osrSizing.ts:35` + `computeOsrSize`): 16 MB → 4 MB/frame, a 4× cut on the exact retina-8 GB common case. `quantizeSupersample` already clamps to `[MIN, MAX]`; make `MAX` read the Low-RAM flag.
- **Lower the frame rate** in Low-RAM mode: `wc.setFrameRate(OSR_FRAME_RATE)` (`previewOsr.ts:618`) — `setFrameRate` is the documented OSR throughput knob (1–240, [webContents](https://www.electronjs.org/docs/latest/api/web-contents)). Drop e.g. 30 → 15–20 for browser boards on low RAM.

**(C) L7 — align the MAIN clamp to the real contract.** Tighten `sanitizeOsrSize` to `S≤2` / logical ≤1280 (the renderer's actual ceiling), closing the trust-boundary gap and bounding a directly-driven channel to the real max frame.

**(D) Future spike (not this pass): GPU shared-texture OSR.** `webPreferences.offscreen.useSharedTexture:true` makes the `paint` event carry an `OffscreenSharedTexture` (`event.texture`) whose pixels stay on the GPU — genuinely zero-copy, never entering JS as a CPU buffer ([offscreen-shared-texture](https://www.electronjs.org/docs/latest/api/structures/offscreen-shared-texture); [web-preferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences); PRs [#42001](https://github.com/electron/electron/pull/42001)/[#42953](https://github.com/electron/electron/pull/42953)). But it "requires a native node module" to import the shared handle into a GPU stack (D3D11/IOSurface → WebGL/WebGPU) and blit it — a large, native-dependency change incompatible with the current `putImageData`-into-2D-canvas design and this plan's low-risk posture. **Recommend a separate spike** to prototype and measure before committing.

### 4.4 Exact files to change

| File | Change |
|---|---|
| `src/renderer/src/canvas/boards/osrBlitWorker.ts` | free-list of RGBA `out` buffers; pass `out` to `bgraToRgba`; accept `{returnBuffer}` back |
| `src/renderer/src/canvas/boards/useOffscreenPreview.ts:81-85` | after `putImageData`, return-transfer the buffer to the worker |
| `src/renderer/src/lib/osrSizing.ts:32-61` | `OSR_MAX_SUPERSAMPLE` reads Low-RAM flag (cap to 1) |
| `src/main/previewOsr.ts:618` | Low-RAM `setFrameRate` reduction |
| `src/main/previewOsrSizing.ts:45-52` | L7: tighten clamp to S≤2 / ≤1280 |

### 4.5 Migration / risks / tests

- **Migration:** none.
- **Risks:** (a) **Return-transfer correctness + pool bleed** — reuse-before-return corrupts; the early-return paths leak buffers (see the fix above: return on **all** handler exits + allocate-on-empty). `putImageData` copies into the canvas, so the buffer is provably free on return. (b) Supersample=1 is slightly softer on retina — acceptable and *only* in Low-RAM mode. (c) The L7 clamp tighten must not reject the legitimate full-view S=2 path (`computeFullViewOsrSize` also caps at 2 — safe).
- **Unit:** `bgraToRgba` with `out` reuse already covered (`bgraToRgba.test.ts`) — add a pool round-trip test; `quantizeSupersample` respects the Low-RAM cap; `sanitizeOsrSize` new bounds.
- **e2e** (`@preview`, existing `osrCropSupersample`): frames still render correctly at S=1 and S=2; a resize mid-stream doesn't blit a stale-size buffer.
- **Manual dev check:** open a video/animated page in a Browser board; confirm smooth repaint; toggle Low-RAM and confirm the frame size drops (log the buffer bytes) and CPU/GC falls in DevTools.

---

## 5. M1 — Split viewport/background into a session sidecar

### 5.1 Current design (verified)

- `SAVED_KEYS = ['boards','connectors','viewport','groups','background']` (`useAutosave.ts:39`). Any change to `viewport` (mirrored every rAF via the RF `transform` subscription, `Canvas.tsx:784-792`, `setViewport`) or `background` arms the debounced autosave.
- The autosave writes the **whole doc**: `save()` (`useAutosave.ts:146-153`) → `window.api.project.save(s.toObject(), dir)`. `toObject()` (`boardSchema.ts:622-641`) serializes `{schemaVersion, minReaderVersion, viewport, boards, connectors, groups, background?}`. `writeProject` (`projectStore.ts:149-181`) then pretty-prints + atomically writes `canvas.json` **and** rotates `.bak`. So a bare camera pan rewrites (and `.bak`-rotates) the entire board tree.
- On load, `applyOpenResult` → `fromObject(doc)` → the store hydrates `viewport: d.viewport`, `background: d.background ?? null` (`canvasStore.ts:538-539`).
- `viewport`/`background` are already **settings-class** (never on the undo rail — `canvasStore.ts:311-317`, `setViewport`/`setBackground` untracked).

### 5.2 Proposed approach — forward-compatible dual-write

Add `.canvas/session.json` = `{version:1, viewport, background}` and split the save path:

- **`hasDocChange`** (boards/connectors/groups) → **full `canvas.json` save** (unchanged path; it *also* writes the current `viewport`/`background` inline, keeping the inline copy fresh whenever the doc is written anyway — near-free).
- **`hasSessionChange`** (viewport/background *only*) → **sidecar-only write** via a new `project:saveSession` IPC → `writeSession(dir, {viewport, background})` atomically with **`fsync:false`** (disposable settings-class data; skipping fsync is the documented perf trade — [write-file-atomic](https://github.com/npm/write-file-atomic)). A few hundred bytes instead of the whole tree.
- **On load:** `readProject` also reads `session.json`; the load path prefers the sidecar's `viewport`/`background`, **falling back to the doc's inline value** when the sidecar is absent/unparseable **or parseable-but-invalid**. Sidecar loss ⇒ `fitView` / no backdrop — never blocks load (the doc is the source of truth for correctness; the sidecar is advisory).
- ⚠️ **Reviewer-caught validation bypass.** `fromObject` deep-validates both fields — viewport via `isValidViewport` → `null` on non-finite/`zoom≤0` (`boardSchema.ts:792-799,1247`), background via `reconcileBackground` (degrade unknown `kind`, drop `kind:'file'` without `assetId`, clamp `dim`/`saturation`, `:1243`). Merging the **sidecar** value *after* `fromObject` would **bypass** those guards for a semantically-invalid-but-parseable sidecar (e.g. `{viewport:{x:0,y:0,zoom:0}}`, `{background:{kind:'file'}}` with no asset). **Fix: run the sidecar's viewport through `isValidViewport` and its background through `reconcileBackground` before it overrides the inline value** (reuse the exact validators `fromObject` uses — export them if needed).

This is exactly the schema-evolution "field moved to a sidecar" pattern: keep writing the field inline (its old home) **and** the sidecar; the new reader prefers the sidecar; the old reader never learns of the sidecar and reads the inline value ([Confluent schema evolution](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html); Excalidraw already treats viewport as *ephemeral* and strips it — [`appState.ts` `cleanAppStateForExport`](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/appState.ts) — we go one step further and persist it out-of-band).

### 5.3 Migration / back-compat (the careful part)

- **No `schemaVersion` bump, no `minReaderVersion` bump.** The `canvas.json` shape is **unchanged** — `viewport`/`background` stay inline. The sidecar is a *new file*, not a doc field (like ADR 0009's location migration, which also bumped nothing). ADR 0007's rule: bump the writer only for additive doc-field changes, the floor only for breaking ones — neither applies here because the doc shape is byte-compatible.
- **Old app opens a new project:** ignores `session.json` (doesn't know it), reads inline `viewport`/`background` from `canvas.json` → works. The inline copy may be slightly *stale* (last refreshed on the last full save) — worst case an older camera position / backdrop, never data loss. **Forward-compatible.** ✔
- **New app opens an old project (no sidecar):** reads inline values, writes the sidecar on the first session change. **Backward-compatible.** ✔
- **`.gitignore`:** add `session.json` to the `.canvas/.gitignore` (settings-class, like `assets/` — per ADR 0009 the canvas is git-trackable but settings/blobs are ignored by default). `session.json` is machine-local camera state; ignore it.
- **The two files are independently atomic but not transactional** — a crash between the doc write and the sidecar write can leave them momentarily disagreeing. Design makes this safe: the sidecar is advisory (stale/missing/ahead are all fine), and the inline copy is the fallback. Never share one temp file across the two writes.

### 5.4 Exact files to change

| File | Change |
|---|---|
| `src/main/projectStore.ts` | `writeSession(dir, session)` (atomic, `fsync:false`), `readSession(dir)` (returns `{viewport,background}` or null); `readProject`/a new read returns the sidecar alongside the doc |
| `src/main/projectIpc.ts` | `project:saveSession` handler; include the sidecar in the open payload |
| `src/preload/*` | expose `project.saveSession` |
| `src/renderer/src/store/useAutosave.ts:39-50,146-153` | split `hasSavableChange` → `hasDocChange` / `hasSessionChange`; add a session-save path (its own light debounce is fine) |
| `src/renderer/src/store/canvasStore.ts:529-540` | thread the sidecar into **`applyLoadedDoc`** (the single choke point at `:522-555`, sets viewport/background at `:538-539`) — validated sidecar wins over inline. This covers **all three** apply sites: the primary `applyOpenResult` (`:1222`), the **`.bak` recovery** (`:1199-1208`, `fromObject(bak.doc)`→`applyLoadedDoc`), and `loadObject` (`:1175`, which has no dir/sidecar → passes `undefined`, falls back to inline). `readBak`/reopen-from-bak must also return the sidecar. |
| `.canvas/.gitignore` template (`canvasMemory.ts`) | ignore `session.json` |

### 5.5 Build sequence

`writeSession`/`readSession` (pure I/O, unit-tested) → IPC + preload → autosave split → load-merge → `.gitignore`. Land the read-fallback **before** the write-split so a half-migrated project (sidecar exists but writer not yet split, or vice-versa) always resolves a valid camera.

### 5.6 Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Old app reads stale inline camera** | Acceptable (camera is disposable); the full-save path keeps inline reasonably fresh. Document it. |
| **Sidecar/doc disagree after a crash** | Advisory sidecar + inline fallback; never share a temp file; doc is correctness source. |
| **A settings-only edit no longer arms the full save** — regression class the `SAVED_KEYS` comment warns about | The drift-guard unit test (`useAutosave` pins `SAVED_KEYS` to `toObject`) must be updated to pin *both* the doc set and the session set; a new persisted field must land in one or the other, never neither. |
| **Blur/quit flush must flush BOTH** | `onBlur`/`onUnload`/`onFlush` (`useAutosave.ts:194-232`) must flush the session sidecar too (or the full path, which includes inline). Ensure the session debounce is flushed on the same lifecycle moments. |

### 5.7 Test strategy

- **Unit:** `writeSession`/`readSession` round-trip; `fsync:false` passed; autosave split routes viewport-only → session save, board change → full save; drift-guard pins both key sets; load-merge prefers sidecar, falls back to inline, tolerates a corrupt sidecar.
- **e2e** (`@core`): pan the camera, quit, reopen → camera restored from sidecar; delete the sidecar, reopen → camera falls back to inline (or fitView); assert a pan does **not** change `canvas.json`'s mtime/bytes (only `session.json` moves).
- **Manual dev check:** pan/zoom repeatedly, watch `.canvas/` — only `session.json` should be rewritten; edit a board → `canvas.json` rewrites; open the same project in a build *without* M1 (or simulate an old reader) → camera still loads from inline.

---

## 6. M11 — Lazy-start the in-app MCP server

### 6.1 Current design (verified)

- `startMcpServer(registry, opts)` (`src/main/mcp.ts:170-258`) dynamic-`import()`s the ESM `@expanse-ade/mcp`, builds the orchestrator + `TokenStore`, `createMcpHttpServer(...)`, registers the seam minter via `__setTerminalTokenMinter(mintConnectedToken)`, and returns a `RunningMcp` (with `close()` that calls `__setTerminalTokenMinter(null)` + `server.close()`, `:239-244`).
- It is **`await`ed unconditionally in `whenReady`** (`index.ts:478`) regardless of orchestration consent, holding Express 5 + MCP SDK + zod (+ ajv) in MAIN's heap for the whole run — pure waste for the common case (orchestration never enabled). Idle CPU ≈ 0 (the T3.4 idle-reap was removed, `mcp.ts:222`).
- **Everything already tolerates a null server:** `registerOrchestratorIpc(ipcMain, …, () => mcp)` (`index.ts:546-550`, "null until the loopback server is up → handlers reject cleanly"); the provision IPC handlers `try/catch` `mintTerminalToken` and degrade (`orchestrationProvision.ts:56-63, 89-97`); the seam's `mintTerminalToken` **throws** when the minter is null (`seam.ts:60-65`) — the correct fail-loud, already caught by all callers.
- **The one race point:** the spawn-time provisioner `makeOrchestrationSyncProvider` is **synchronous** (`cliProvisioners/index.ts:8`, invoked at `pty.ts:752` as `orchestrationSyncProvider?.({...})`), minting via the throwing `mintTerminalToken`; the throw is swallowed by both the `setOrchestrationSyncProvider` wrapper (`index.ts:966-977`) and pty's spawn `try/catch`. So if the server isn't up when the *first* consented terminal spawns, that terminal's MCP config isn't written → "tool doesn't exist" until a later spawn. **The lazy-start trigger must therefore fire on orchestration-ENABLE, before any spawn.**
- **`index.ts:926` ENABLE branch is currently a no-op** ("On ENABLE nothing proactive here"). This is the natural trigger site.

### 6.2 Measure first (do this before refactoring)

Wrap the `import()` + `createMcpHttpServer` in `mcp.ts:181-212` with `process.memoryUsage()` `heapUsed`/`rss` deltas, logged once. Sample under `--expose-gc` with a `global.gc()` before each read and a settle tick between (`rss` commits lazily) — `heapUsed` for "how much JS the module pulled in," `rss` for real footprint ([process.memoryUsage](https://nodejs.org/api/process.html#processmemoryusage); [Node memory tuning](https://nodejs.org/learn/diagnostics/memory/understanding-and-tuning-memory)). This gives the real reclaim number on the 8 GB target before committing to the refactor. Remove the instrumentation in the shipping PR.

### 6.3 Proposed approach — `ensureMcp()` memoized singleton

```
let mcpPromise: Promise<RunningMcp | null> | null = null
function ensureMcp(): Promise<RunningMcp | null> {
  if (!mcpPromise) {
    mcpPromise = startMcpServer(registry, opts).catch(err => {
      mcpPromise = null   // evict on failure so a later enable retries
      throw err
    })
  }
  return mcpPromise
}
```

- **Memoize the promise, not the result**, assigned synchronously so concurrent callers share one in-flight start (single-flight — [singleton-promises](https://www.jonmellman.com/posts/singleton-promises/); [async lazy initializer](https://advancedweb.hu/the-async-lazy-initializer-pattern-in-javascript/); [p-memoize](https://github.com/sindresorhus/p-memoize)). **Catch-evict on failure** so a rejected start doesn't poison the cache. Caveat: `startMcpServer` already `try/catch`es internally and returns `null` on bind failure (non-fatal by design), so `ensureMcp` mostly memoizes a resolved-`null`; treat a truly thrown import-eval error as fatal (Node's loader caches ESM eval rejections — nulling our promise won't re-run the module body, so an import failure is not retryable at the module level; but a *bind* failure returns null and can be retried by re-calling if we choose).
- **Trigger** at the orchestration-ENABLE `onChange` (`index.ts:926`, the currently-empty ENABLE branch): `void ensureMcp()`. Since Enable is a user modal action and the first terminal spawn is a later user action (seconds apart), the tens-of-ms start completes well before any spawn. Also call `void ensureMcp()` from the manual Sync modal path for robustness.
- **`() => mcp` becomes `() => mcpFromPromise`** — but `registerOrchestratorIpc` reads a getter; give it a getter that returns the resolved value (null until resolved). Everything downstream already tolerates null.
- **Optional stop-on-disable:** when the *last* consented project revokes, `await mcp.close()` (`RunningMcp.close()` exists, `mcp.ts:239`) and null `mcpPromise`, reclaiming the whole heap. Use `server.close()` semantics: it stops accepting new connections and completes on drain; on Node ≥19 idle keep-alives are closed automatically, and a fresh `http.Server` can re-`listen()` after close ([net server.close/listen](https://nodejs.org/api/net.html); [http closeAll/IdleConnections](https://nodejs.org/api/http.html#serverclosealllconnections)). (The package owns its server; we only call its `close()`.)
- **`localServer` same treatment (lighter, secondary):** `startLocalServer()` (`localServer.ts:89`) provides the Browser-board fallback preview URL captured once at boot as `defaultPreviewUrl` (`index.ts:443-446`, consumed at `:1023`, `:1049`). Lazy-starting it means the first Browser board that needs the fallback triggers `ensureLocalServer()`; the `defaultPreviewUrl` handoff must become a getter/async lookup rather than a boot constant. Slightly more plumbing than MCP; do it as a follow-on once the MCP pattern is proven.

### 6.4 Exact files to change

| File | Change |
|---|---|
| `src/main/index.ts:478` | replace eager `mcp = await startMcpServer(...)` with `ensureMcp()` definition (registry/opts captured); `mcp` becomes the resolved-or-null value read by getters |
| `src/main/index.ts:926` | ENABLE branch: `void ensureMcp()` |
| `src/main/index.ts:546-550` | `registerOrchestratorIpc(…, () => resolvedMcp)` reads the memoized result |
| `src/main/index.ts` (revoke branch `:934`) | optional stop-on-last-disable → `mcp.close()` + null the promise |
| `src/main/index.ts:1022-1023` (`installE2EMain(…, mcp, …)`) | ⚠️ **captures `mcp` BY VALUE** (not a getter) — under lazy-start it captures `null`. Must eager-start before this line whenever the e2e seam is active (see §6.5b). The getter consumers (`() => mcp`, `:549/:934/:1076`) are unaffected. |
| `src/main/localServer.ts` + `index.ts:443` | (follow-on) `ensureLocalServer()`; `defaultPreviewUrl` via getter |
| temp: `src/main/mcp.ts:181` | (measure PR only) heap-delta instrumentation, removed before ship |

### 6.5 Migration / risks / tests

- **Migration:** none (boot-order change only).
- **Risks:** (a) **Enable→spawn race** — mitigated by triggering on Enable (before spawn) + memoized dedupe; residual gap is a user-paced seconds-long window vs a tens-of-ms start. Document + optionally have the manual Sync modal also warm it. (b) ⚠️ **CANVAS_E2E capture-by-value (reviewer-corrected — REQUIRED, not optional).** `installE2EMain` captures the `mcp` *value* at `:1023`; the seam body no-ops in prod (gated `e2eMain.ts:368` on `process.env.CANVAS_E2E` truthy), so prod is fine, but under E2E lazy-start captures `null` **permanently** → `mcpInfo`/`gitDiff`/`describeApp`/`spawnGroupNow`/`spawnBoardNow`/`mcpMintConnectedToken` return null forever even after the server later starts → the `mcp.e2e.ts` tier smoke breaks. **Fix: eager-start the server before `installE2EMain` whenever the seam is active, and match the gate exactly — `e2eMain.ts` gates on `process.env.CANVAS_E2E` being *truthy*, so use the SAME truthiness check (not `=== '1'`), or a truthy-but-not-`'1'` value installs the seam without warming the server.** (c) Stop-on-disable while a dispatch is mid-flight — only stop when no consented project remains AND no active dispatch; keep it optional/conservative. (d) An import-eval failure is loader-cached (not retryable) — but that path already logged + returned null at boot, so behaviour is unchanged, just deferred.
- **Unit:** `ensureMcp` memoizes one start across concurrent calls; catch-evicts on throw; returns null on bind-failure without poisoning; the seam minter is registered only after the server is up.
- **e2e:** with orchestration **off**, the app boots and terminals/previews work with no MCP server (assert no loopback port bound); enable orchestration → server starts → a spawned consented terminal gets its config; (if implemented) disable-last → port released.
- **Manual dev check:** boot without touching orchestration → confirm (via the measure instrumentation or a temp log) the MCP heap is *not* paid; enable orchestration in a project → confirm the server starts and a terminal's `.mcp.json`/CLI config is written and `canvas-ade` tools resolve.

---

## 7. Low-RAM mode (AUDIT §5) — the umbrella toggle

### 7.1 Design

A single boolean, **auto-enabled** when `os.totalmem() <= 8 * 1024**3` bytes (8 GiB) with a manual override. Use `os.totalmem()` (Node, bytes, cross-platform, [os.totalmem](https://nodejs.org/api/os.html#ostotalmem)) — **not** `freemem()`/`getSystemMemoryInfo().free`, which fluctuate and read low on Linux (cache counted as used); decide the mode **once at startup from total RAM**. Note Electron's `process.getSystemMemoryInfo()` is in **KB, not bytes** ([Electron process](https://www.electronjs.org/docs/latest/api/process)) — don't mix units. Store in a userData JSON config with a getter read fresh per check, mirroring `orchestrationConfig.ts` (the existing spawn-cap config pattern); expose a Settings toggle.

### 7.2 Knobs each item exposes to it

| Item | Knob | Default | Low-RAM |
|---|---|---|---|
| C1 | `MAX_BACKGROUND` | 3 | 1 |
| C1 | background idle TTL | ~10 min | shorter (~3–5 min) |
| H4 | OSR resident budget (`GLOBAL_OSR_MAX` / dynamic) | 8 | 3–4 |
| H5 | `OSR_MAX_SUPERSAMPLE` | 2 | 1 |
| H5 | OSR `setFrameRate` | 30 | 15–20 |
| H9 (audit, out of scope here) | xterm renderer | DOM | opt-in canvas |
| M1, M11 | — | **always-on** (not gated) | same |

M1 (sidecar) and M11 (lazy MCP) are unconditional wins — they help every user, not just low-RAM, so they are **not** behind the toggle. The toggle only flips the C1/H4/H5 knobs together.

### 7.3 Build/rollout

Build the config + `os.totalmem()` gate first as an **inert scaffold** (a getter returning the flag, wired nowhere). As each item lands, replace its hardcoded constant with a `lowRam ? x : y` read of the getter. This keeps every intermediate PR runnable and lets Low-RAM mode "light up" incrementally. Land the Settings UI + auto-enable last.

### 7.4 Tests

- **Unit:** the threshold gate (`totalmem` mock ≤/> 8 GiB → flag), each knob reads the flag.
- **e2e:** force the flag on → assert `MAX_BACKGROUND` collapses, OSR frame bytes drop, resident renderer budget tightens.
- **Manual dev check:** on the 8 GB target, confirm auto-enable; toggle off/on and watch the knobs move in Task Manager.

---

## 8. Adversarial review

Two rounds: an initial self-review against the brief's failure modes, then an **independent adversarial pass** that re-verified every load-bearing claim against source. The independent pass found **five real defects the first draft asserted were safe** — all folded into §2–§6 above; recorded here honestly (finding → evidence → correction).

### 8.1 C1 — auto-close silently loses background terminal output *(defect, HIGH — folded)*
The draft claimed auto-close was durability-safe because "it routes through the same `disposeProjectPtys` … the snapshot/residue path is unchanged." **False.** `persistBackgroundRingTails` is **not** part of `disposeProjectPtys` — `disposeProjectPtysCore` (`pty.ts:1029-1043`) only reaps/cleans; the ring-tail flush runs only from the quit paths (`shutdown()` `:1071`, darwin close `:246`), and `flushAllTerminalSnapshots` covers only the *active* project's mounted xterms. So a cap/TTL auto-close would kill a resident's background terminals and lose their post-park output. **Fix folded (§2.3, §2.6):** a dir-scoped `persistProjectRingTails(dir)` before `disposeProjectPtys` (also closes a pre-existing gap in the manual Close-project button).

### 8.2 C1 — the TTL "switch lock" guard was unimplementable *(defect — folded)*
`acquireProjectSwitchLock` is **renderer-side**; a MAIN-side sweep can't observe it, so "no-op while the lock is held" was impossible. There is a residual pre-load window where `currentDir` still points at the outgoing project and a past-TTL incoming resident could be reaped. **Fix folded (§2.6):** a MAIN-side "pending-incoming-dir" signal the sweep also skips; never rely on the renderer lock.

### 8.3 H4 — `pickOsrEvictions` `+1` over-trims a standalone call *(defect — folded)*
`need = len - max + 1` is correct only for `ensureOsr` (making room for one new window). A standalone `trimOsrToBudget(max)` would evict to `max-1` — and at Low-RAM `max=1`, evict **everything**. **Fix folded (§3.2):** call with `max+1` or a `need = len - max` variant + a dedicated test. (The rest of H4 verified sound: just-foregrounded entries have `backgrounded=false`/`backgroundedAt=undefined`, so `pickOsrEvictions`'s `e.backgrounded` filter correctly excludes the incoming project — no reload flash.)

### 8.4 H5/M6 — the buffer pool bleeds on every dropped frame *(defect — folded)*
The `onmessage` handler has three early returns *before* `putImageData` (gen-mismatch, no-ctx, non-full-on-resize); returning the pooled buffer only after `putImageData` leaks one per drop, and gen-drops fire on exactly the churn the pool must survive. **Fix folded (§4.3, §4.5):** return the buffer on **all** handler exits + allocate-on-empty in the worker (self-healing). Also corrected: key the pool by dirty-rect byte length, not full-frame size. (The happy-path claim verified: `putImageData` copies synchronously and doesn't retain the `ImageData`, so post-blit return is safe.)

### 8.5 M1 — sidecar values bypass `fromObject`'s validators *(defect — folded)*
`fromObject` deep-validates viewport (`isValidViewport`) and background (`reconcileBackground`); merging the sidecar *after* `fromObject` bypasses them for a parseable-but-invalid sidecar. **Fix folded (§5.2, §5.4):** run the sidecar through the same validators before it overrides inline; thread it through the single `applyLoadedDoc` choke point so the primary, the `.bak`-recovery, and the `loadObject` apply sites are all covered.

### 8.6 M11 — `installE2EMain` captures `mcp` by value, not the getter *(defect — folded)*
The getter consumers (`() => mcp`) are genuinely null-safe, but `installE2EMain(…, mcp, …)` (`:1023`) captures the *value* — under E2E lazy-start it captures `null` permanently, breaking the `mcp.e2e.ts` tier smoke. **Fix folded (§6.4, §6.5b):** eager-start before that line whenever the seam is active, and **match the gate** to `e2eMain.ts`'s `process.env.CANVAS_E2E`-truthy check (not `=== '1'`). This upgraded the e2e mitigation from "optional" to "required."

### 8.7 Claims that survived review (verified sound)
- **M1 schema safety** — dual-write keeps `canvas.json` byte-compatible; no floor bump is correct (ADR 0007's breaking trigger doesn't fire); old reader reads inline, new reader prefers sidecar. The `SAVED_KEYS` drift-guard must pin *both* key sets (§5.6/§5.7).
- **C1 scoped-close** — auto-close uses the registry-guarded, dir-scoped `closeBackgroundProject`, never `disposeAll*`; unit test (evict A, assert B lives) added (§2.7).
- **H5 zero-copy correction** — the rejected `MessageChannelMain` approach touches no `preview:osrFrame` consumer (it isn't built); the byte-reduction + worker pool leave the IPC channel/payload untouched.
- **M11 no-separate-process** — extraction *raises* total RAM (`MCP-SERVER-COST.md` §3); lazy-start is the correct win; `readOrchestrationConfig`/spawn-cap handlers confirmed to not read the `mcp` variable at boot.
- **H4/C1 coupling** — complementary (projects vs renderers), single Low-RAM config, C1 lands first.

### 8.8 Residual open questions (for the implementer)
1. **C1 TTL default** — 10 min is a guess; measure real switch-back cadence before fixing it. Too short annoys, too long defeats the reclaim.
2. **M11 stop-on-disable** — worth it only if the measured heap (§6.2) is non-trivial; otherwise ship lazy-start alone and skip the teardown complexity.
3. **H5 shared-texture spike** — the only path to true zero-copy; size it separately (native addon, GPU interop, `putImageData`→WebGL rewrite).
4. **M1 session debounce cadence** — the sidecar can debounce faster than 1 s (it's cheap); decide whether to keep the shared 1 s or give it its own.

---

## 9. Web sources (consolidated)

**Electron OSR / renderer memory / throttling**
- Offscreen Rendering — https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering
- webContents (`setFrameRate`/`start`/`stopPainting`/`setBackgroundThrottling`) — https://www.electronjs.org/docs/latest/api/web-contents
- web-preferences (`backgroundThrottling`, `offscreen.useSharedTexture`) — https://www.electronjs.org/docs/latest/api/structures/web-preferences
- OffscreenSharedTexture — https://www.electronjs.org/docs/latest/api/structures/offscreen-shared-texture ; PRs https://github.com/electron/electron/pull/42001 , https://github.com/electron/electron/pull/42953
- No partial renderer-memory release / churn growth — https://github.com/electron/electron/issues/7350
- No first-class renderer-process cap ("not planned") — https://github.com/electron/electron/issues/37437
- `setBackgroundThrottling(false)`+minimized video bug (N/A to never-minimized OSR, noted) — https://github.com/electron/electron/issues/50250

**Electron IPC / transfer / shared memory**
- MessageChannelMain / MessagePortMain (transfer list = `MessagePortMain[]` only) — https://www.electronjs.org/docs/latest/api/message-channel-main , https://www.electronjs.org/docs/latest/api/message-port-main , https://www.electronjs.org/docs/latest/tutorial/message-ports
- ipcRenderer.postMessage (only postMessage can transfer ports) — https://www.electronjs.org/docs/latest/api/ipc-renderer
- Non-port in transfer list rejected — https://github.com/electron/electron/pull/37585 ; renderer→main transferables dropped — https://github.com/electron/electron/issues/34905
- Transfer is thread-to-thread same-process (not cross-process zero-copy) — https://github.com/electron/electron/issues/45034 ; https://github.com/electron/electron/issues/10409
- MDN Transferable objects (detach/neuter; ping-pong pool) — https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- SharedArrayBuffer cross-origin isolation (COOP/COEP) — https://web.dev/articles/coop-coep , https://web.dev/articles/cross-origin-isolation-guide

**Session / persistence**
- Electron session (`clearStorageData` async, `clearCache`, `fromPartition`, `getStoragePath`) — https://www.electronjs.org/docs/latest/api/session
- Electron 42 breaking change — `clearStorageData` `quotas` removed — https://www.electronjs.org/blog/electron-42-0
- write-file-atomic (fsync default, temp+rename) — https://github.com/npm/write-file-atomic
- Schema evolution / forward compatibility — https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html , https://www.creekservice.org/articles/2024/01/08/json-schema-evolution-part-1.html
- Excalidraw `cleanAppStateForExport` (ephemeral/session split; viewport is ephemeral) — https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/appState.ts

**Lazy-start / memory measurement / low-RAM detection**
- Singleton-promise / async lazy init (memoize promise, catch-evict) — https://www.jonmellman.com/posts/singleton-promises/ , https://advancedweb.hu/the-async-lazy-initializer-pattern-in-javascript/ , https://github.com/sindresorhus/p-memoize
- process.memoryUsage (heapUsed/rss/external/arrayBuffers) — https://nodejs.org/api/process.html#processmemoryusage ; tuning — https://nodejs.org/learn/diagnostics/memory/understanding-and-tuning-memory
- os.totalmem/freemem (bytes) — https://nodejs.org/api/os.html#ostotalmem ; Electron `getSystemMemoryInfo` (KB) — https://www.electronjs.org/docs/latest/api/process
- http server.close / closeIdleConnections / closeAllConnections ; net re-listen after close — https://nodejs.org/api/http.html#serverclosealllconnections , https://nodejs.org/api/net.html

---

*Plan verified against source at the cited `file:line` (tree as of 2026-07-09) and against the primary sources above. No `src/` changes were made producing this document.*
