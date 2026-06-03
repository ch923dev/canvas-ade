# Testing — Canvas ADE

How we test. This is the source of truth for **which tier a test belongs to** and **where it lives**.
Backed by `docs/research/2026-06-03-testing-strategy.md` and the roadmap in
`docs/superpowers/specs/2026-06-03-testing-strategy-design.md`.

## Model — the Testing Trophy

We follow Kent C. Dodds' Testing Trophy: **mostly integration**, a solid unit base, a **thin** e2e
top, on a static base (TypeScript strict + ESLint). Not the unit-heavy pyramid. Ratios are
directional (~integration-heavy), never a quota.

## The three tiers (+ static)

| Tier | What it is | Runs in | Naming |
|---|---|---|---|
| **Static** | `tsc --noEmit` + ESLint | CI `check` | — |
| **Unit** | One pure function / module in isolation; collaborators mocked. No DOM render, no app, no real IPC. | Vitest `unit` project | `*.test.ts` / `*.test.tsx` |
| **Integration** | Multiple real units together: a rendered component tree (jsdom), a registered IPC handler, or logic that mocks `electron`. No real app boot. | Vitest `integration` project | `*.integration.test.ts` / `*.integration.test.tsx` |
| **E2E** | The real, booted app. The ONLY tier allowed to touch the native layer. | The e2e harness (today `CANVAS_SMOKE`; Playwright `_electron` after roadmap T4) | separate harness |

## The decision rule — which tier do I write?

Ask, in order:

1. **Can I prove it by calling a function with inputs and asserting outputs, with collaborators
   mocked?** → **unit** (`*.test.ts`). Most logic lives here: pure helpers, store reducers, layout
   math, parsers, schema (de)serialize.
2. **Does it render a component tree (jsdom), wire several real units together, register an IPC
   handler, or need `electron` mocked?** → **integration** (`*.integration.test.ts(x)`). Component
   render tests count as integration (they exercise a real tree).
3. **Does it only reproduce in the real, booted app** — native `WebContentsView`, a node-pty
   spawn→echo roundtrip, OS process-tree kill, auto-update, or genuine cross-platform/OS behavior?
   → **e2e**. Keep this tier thin (see below).

If a behavior is provable at a lower tier, write it there — duplicating it as e2e is redundant
(slower, flakier) and is not allowed.

## What each tier MAY touch

- **Unit:** pure code + mocked collaborators. No `electron`, no DOM render, no fs (use temp/mocks).
- **Integration:** real units + jsdom render + `electron`/IPC mocked (`electron-mock-ipc` or a fake
  `ipcMain` that captures handlers). **Never boots the app.**
- **E2E:** the real instance. **MAIN-process helpers only** — Playwright's renderer-side IPC helpers
  require `contextIsolation:false` + `nodeIntegration:true`, which **violates our locked sandbox**.
  Never weaken the security model to make a test pass.

## E2E keep-set (thin top)

E2E is reserved for surfaces that ONLY reproduce in the real app:
**core happy-path boot · node-pty/terminal · native `WebContentsView` (browser preview, full view) ·
auto-update · OS process-tree kill / cross-platform.** Everything else pushes down to
integration/unit. (Roadmap T3 migrates the redundant probes down; T4 moves the keep-set onto
Playwright; T5 re-enables it as a gate.)

## Security boundaries → tier map

Electron's security checklist is asserted at the **unit/integration** tier, not via broad e2e:

| Checklist item | Where asserted |
|---|---|
| #3 context isolation / #4 sandbox | unit — `src/main/windowSecurity.test.ts` (`buildMainWindowWebPreferences`) |
| #13 navigation limits / #14 new-window | unit — `windowSecurity.test.ts` (`navDecision` / `windowOpenDecision`) |
| #17 validate IPC sender / #20 no Electron APIs to untrusted content (Browser↛PTY) | integration — `pty.integration.test.ts`, `preview.integration.test.ts`, `projectIpc.integration.test.ts` |

## Running

- `pnpm test` — both projects (the CI `check` gate).
- `pnpm test:unit` — fast unit project only (use while iterating).
- `pnpm test:integration` — integration project only.
- `pnpm typecheck` · `pnpm lint` — the static tier.

## Adding a test

1. Apply the decision rule → pick the tier.
2. Name the file for its tier (`*.test.ts` vs `*.integration.test.ts`) and colocate it with the code.
3. `.ts` runs in node, `.tsx` in jsdom (handled by `environmentMatchGlobs`) — pick the extension to
   match what the test needs.

## MAIN IPC integration — the harness

MAIN-process IPC handlers are integration-tested **without booting Electron** via
`src/main/ipcTestHarness.ts`. It captures the channels a `register*Handlers(ipcMain, …)` call
registers, so a test invokes a handler directly with a chosen sender:

- `createIpcCapture()` → `{ ipcMain, handlers, invoke, invokeAs }`. Pass `cap.ipcMain` to the
  production `register*Handlers`; then `cap.invoke('channel', …args)` calls the handler as a trusted
  internal caller, and `cap.invokeAs(foreignEvent, 'channel', …args)` calls it as a given sender.
- Sender fixtures: `internalEvent` (no `senderFrame` → trusted), `foreignEvent` (a non-main frame →
  must be rejected, checklist #17/#20), `mainWin` (a `getWin` resolving to the trusted main frame).

Reference template: `src/main/projectIpc.integration.test.ts` (happy-path handlers with `vi.mock`
collaborators + foreign-sender rejection). Copy its shape for new MAIN-IPC integration tests.

The renderer-facing preload bridge is contract-tested in `src/preload/preloadApi.integration.test.ts`:
every `api.*` method is asserted to invoke the right `ipcRenderer.invoke` channel with the right args.

## E2E push-down (T3) — what migrated, what stayed

T3 moved redundant `CANVAS_SMOKE=e2e` probe coverage down to Vitest and deleted the migrated
probes. The homegrown harness now holds only the irreducible native/real-instance **slivers**
(deferred to the T4 Playwright keep-set):

- **Migrated to Vitest:** whiteboard interactions (erase/shortcut/marquee/multidrag/shift-add/snap/
  alt-dup/lock/group/align/group-align → `PlanningBoard.interaction.test.tsx`); board-menu contracts
  (items/dup+delete/stroke-width → `BoardMenu.integration.test.tsx`); tidy span + planning checklist/
  round-trip (→ `canvasStore.test.ts`); preview-edge stale styling (→ `PreviewEdge.test.tsx`). The
  paste reload/dedup/gc + SVG/image-embed parts were already covered by `projectStore.test.ts` +
  `whiteboardExport.test.ts`, and `duplicate-keeps-link` by `canvasStore.test.ts`.
- **Kept as slivers (T4):** `whiteboardFullviewAdd` (real OS click through the live camera
  transform), `whiteboardPasteImage` (real Ctrl+V clipboard), `whiteboardExport` (PNG raster),
  `menuChrome` (real title-bar layout + viewport clamp + CSS-var rest colour), `menuPreviewDetach`
  (native `WebContentsView` detach), `previewConnectGesture` (live port-detect IPC + long-press).
  These need real OS input, a native view, or the renderer's raster pipeline — jsdom can't reproduce
  them. The `planning`/`layout` probes were deleted outright; `whiteboardFullviewAdd` now seeds the
  shared `ctx.ids.planId` the slivers read (the deleted `planning` probe used to).
