# Testing T2 — IPC Integration Layer (design)

**Date:** 2026-06-03 · **Branch:** `testing-strategy` (single branch / PR #37) · **Status:** approved design, pre-plan
**Spec/roadmap:** `docs/superpowers/specs/2026-06-03-testing-strategy-design.md` (§T2)
**Predecessors:** T0 (Testing Foundation — tier split, shipped) · T1 (security-unit gap — shipped)

---

## Goal

Make Canvas ADE's MAIN-process IPC behavior testable **without booting the app**, on a **reusable
harness** rather than the three duplicated hand-rolled fakes T0/T1 left behind — and close the
**100%-untested preload** gap with a channel-mapping contract test. T2 establishes the MAIN-IPC
integration pattern (the template T3 copies) and is the last piece of foundation before the T3
push-down migration.

### Non-goals
- **No new dependency.** `electron-mock-ipc` is explicitly NOT adopted (decision below).
- No production behavior change. Touch production only if needed to make a unit testable (it is not —
  see §Preload).
- No app boot, no e2e change (the `CANVAS_SMOKE=e2e` harness stays frozen).
- No happy-path coverage for preview/pty handlers that needs module-state surgery — that is T3.

---

## Locked decisions (from brainstorming, 2026-06-03)

| Decision | Choice |
|---|---|
| IPC layer | **No-dep shared harness.** Not `electron-mock-ipc`. |
| Why no dep | 100% of channels are `ipcMain.handle` (invoke/handle); the hand-rolled capture-handler fake already exercises them fully; `electron-mock-ipc` does **not** cross the `contextBridge` boundary — the one genuinely boot-only piece — so it adds surface without closing the actual gap. |
| Scope | Harness + retrofit the 3 existing integration files + **preload channel-mapping contract** + doc. |
| Reference template for T3 | The retrofitted `projectIpc.integration.test.ts` (already has happy-path handler tests) + the harness, documented in `TESTING.md`. |
| Count invariant | Differs from T0: the **harness retrofit is count-neutral**; the **preload contract test ADDS tests** (≈ +28). New baseline confirmed empirically at T2.3. |
| Branch / PR | `testing-strategy` / PR #37 — no new branch. One commit per phase. |

### Approaches considered
- **A — No-dep shared harness (CHOSEN):** extract the duplicated `setup()`/`makeIpcMain` into one
  helper; add the preload contract. Minimal-dep, matches repo ethos, closes the real gap.
- **B — Adopt `electron-mock-ipc`:** the spec's stated lower-touch default. Rejected — re-tools tests
  that already pass, adds a dep, and still cannot test the `contextBridge` exposure (its `ipcRenderer`
  mock is not the bridge). No coverage win for the cost.
- **C — Spike both, then decide:** rejected — adds a throwaway step; the surface audit already
  answers the question (all `invoke`/`handle`).

---

## Current surface (measured 2026-06-03)

- **~28 `ipcMain.handle` channels**, all invoke/handle, across `preview.ts` (12), `projectIpc.ts` (9),
  `pty.ts` (7). Plus one `ipcMain.on`/`once` reply pair for `project:flush` (in `index.ts`).
- **The hand-rolled capture-handler fake is duplicated 3×** — `setup()` in
  `pty.integration.test.ts` / `preview.integration.test.ts` and `makeIpcMain()` +
  foreign-sender `setup()` in `projectIpc.integration.test.ts`.
- **`src/preload/index.ts` (190 lines) has zero tests.** Each `api.*` method is a pass-through to
  `ipcRenderer.invoke('channel', ...)`. A channel typo (`pty:kil`) surfaces only at runtime/e2e.
- **28 invoke-mapping `api` methods:** 7 terminal · 12 preview · 5 project · 2 asset · 1 dialog · 1
  export. Three carry an arg-transform (`navigatePreview`→`{id,url}`, `project.create`→
  `{dir,name,opts}`, `asset.write`→`{bytes,ext}`) — the shape-prone cases the contract most needs.
  Two listener methods (`onPreviewEvent`, `project.onFlush`) use `ipcRenderer.on` — **out of the
  invoke contract** (documented, not silently dropped).

---

## Architecture / components

### a. `src/main/ipcTestHarness.ts` (new — test-only helper)
A pure helper that captures `ipcMain.handle` registrations so a test invokes a handler directly with
a chosen sender. One responsibility: stand up a fake `ipcMain` + sender fixtures for MAIN-IPC
integration tests.

Exports (final names settled in the plan):
- `createIpcCapture()` → `{ ipcMain, handlers: Map<string, Handler>, invoke(channel, event, ...args) }`.
- Sender fixtures: `internalEvent` (no `senderFrame` → guard allows), `foreignEvent` (a non-main
  frame → guard rejects), `mainFrame`, `winWith(frame)` (a `getWin` returning a window whose
  `webContents.mainFrame` is `frame`).

**Not bundled into the app:** no production module imports it, so electron-vite tree-shakes it from
the build. It is typechecked under `tsconfig.node` and ignored by Vitest (no `*.test.` infix). The
plan's verify step greps to confirm no non-test `src/main/*.ts` imports it.

### b. Retrofit the 3 existing `*.integration.test.ts` onto the harness
Replace each file's local `setup()`/`makeIpcMain` with `createIpcCapture()` + the shared fixtures.
**Pure dedup: identical assertions, identical test count.** `projectIpc.integration.test.ts` retains
its `vi.mock` collaborator stubs (store/recents/dialog) — the harness only replaces the ipcMain
plumbing, not the mocks.

### c. `src/preload/preloadApi.integration.test.ts` (new — closes the preload gap)
Integration tier (mocks `electron`). Mechanism:
1. `vi.mock('electron')` → `contextBridge.exposeInMainWorld` captures the exposed `api`;
   `ipcRenderer.invoke` is a spy; `ipcRenderer.on` / `removeListener` are no-ops.
2. Set `process.contextIsolated = true` (forces the `if` leg — the `else` leg references `window`,
   undefined in node). `vi.resetModules()` then `await import('../preload/index')` (re-import per
   test for a clean capture).
3. Assert **each `api.*` method invokes the correct channel with the correct (possibly transformed)
   args** — a table-driven `it.each` over the 28 methods.

No production change: `api` is captured through the `exposeInMainWorld` mock (it need not be exported).

### d. Doc
Append a short "MAIN IPC integration — the harness" section to `docs/testing/TESTING.md`: how to use
`createIpcCapture`, the sender fixtures, and that `projectIpc.integration.test.ts` is the reference
template for T3.

---

## Data flow

**MAIN handler test (harness):**
```
createIpcCapture() → register*Handlers(ipcMain, getWin, …) → handlers Map filled
→ invoke('channel', internalEvent|foreignEvent, …args)
→ handler runs vs mocked collaborators → assert return + collaborator calls
```

**Preload contract test:**
```
vi.mock('electron'){ exposeInMainWorld→capture api ; invoke→spy ; on/removeListener→noop }
process.contextIsolated = true ; vi.resetModules() ; await import('../preload/index')
captured.api.killTerminal('b1') → expect(invokeSpy).toHaveBeenCalledWith('pty:kill','b1')
```

---

## Error handling / edge cases

- **Preload import side effects:** `ipcRenderer.on('pty:port', …)` must not throw at import → `on` is
  a `vi.fn()`. The `else` leg (`window.api = …`) is avoided by forcing `contextIsolated=true`.
  `vi.resetModules()` per test isolates the capture.
- **Harness must not enter the app bundle:** assert-by-convention; plan greps that no non-test
  `src/main/*.ts` imports `ipcTestHarness`.
- **Retrofit regression:** run each split file before+after retrofit; the combined count must match
  exactly. Drift → stop and fix before committing.
- **`.on`/`.send` channels** (`preview:event`, `project:flush` reply handshake) are out of the
  invoke contract — the flush reply genuinely needs a live `ipcMain.once`↔`send` roundtrip, which
  stays an e2e/manual concern. Documented as out-of-scope, not silently dropped.

---

## Testing (meta)
Pure-Vitest in the existing `check` job — no new CI lane. Harness proven by the unchanged retrofit
count; preload proven by the new contract assertions. `pnpm typecheck` + `pnpm lint` stay green. e2e
untouched. Single branch / PR #37, one commit per phase.

### Phases (one commit each)
- **T2.1** — `ipcTestHarness.ts` + retrofit `projectIpc.integration.test.ts` (the reference). Count-neutral.
- **T2.2** — retrofit `pty` + `preview` integration files onto the harness. Count-neutral.
- **T2.3** — `preloadApi.integration.test.ts` (≈ +28; confirm exact). New baseline.
- **T2.4** — `TESTING.md` "MAIN IPC integration" section + final verify gate + push.

---

## Open questions (resolve in the plan, not here)
- T2.1: final `createIpcCapture` return shape + fixture names against the 3 call sites' actual needs
  (projectIpc's `invoke(channel, …args)` convenience vs pty/preview's raw `handlers.get(c)!(e, …)`).
- T2.3: group the 28 assertions as one `it.each` table vs per-domain describes — pick for readability
  in the plan.
