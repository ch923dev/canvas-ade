# Handoff — Phase 1-A (dev tooling + diagnostics harness + tested transform math)

> For a fresh session. Self-contained. Read this, then execute the checklist. Phase 1-A is the
> first rung of the Phase 1 GATE ladder (see `docs/roadmap.md` → Phase 1, steps 1-A…1-E).

## First 10 minutes (orientation)

1. Read `CLAUDE.md` (architecture, locked decisions, security model, env notes).
2. Read `docs/roadmap.md` → **Phase 1** (the 1-A…1-E ladder) and `docs/decisions/0001-stack.md`.
3. Skim `design-reference/project/DESIGN.md` **§5 Canvas**, **§7.2 Browser board**, **§10 Implementation**.
4. Look at the working scaffold: `src/main/{index,pty,preview,localServer,selfTest}.ts`,
   `src/preload/index.ts`, `src/renderer/src/{App,smoke/*}.tsx`. The smoke tabs already render a React
   Flow canvas (`smoke/FlowSmoke.tsx`) and a WebContentsView (`smoke/PreviewSmoke.tsx`) — reuse these
   as the starting point for the spike; don't rip them out yet (Phase 2.0 builds the real foundation).

State: **Phase 0 is DONE and green** (commits `4d057e0` scaffold, `41f8046` roadmap). App runs:
`pnpm dev`. Headless smoke: `$env:CANVAS_SMOKE='exit'; pnpm start`.

## Goal of 1-A

Stand up the **testing/measurement capability** the whole gate depends on, and the **one pure module**
the live-sync steps (1-B…1-E) will build on. No native-overlay motion work yet — that's 1-C+.

Deliverables:
- ESLint + Prettier + Vitest wired; CI `check` job runs **lint + test** (today it only typechecks+builds).
- A **diagnostics overlay** (frame-time, live-view count, memory sample) to *measure* smoothness in 1-C+.
- The pure **camera→bounds** math module, fully unit-tested — the heart of native-overlay positioning.

## Checklist

### 1. Tooling
- [ ] **ESLint 9 flat config** (`eslint.config.js`) + `typescript-eslint` v8, `eslint-plugin-react-hooks`,
      `eslint-plugin-react-refresh`, `eslint-config-prettier` (last, to disable style rules).
- [ ] **Prettier 3** (`.prettierrc` — match existing style: no semicolons, single quotes, width ~100, no trailing-comma drama; `.prettierignore` for `out/ release/ node_modules/ design-reference/`).
- [ ] **Vitest 2** (`vitest.config.ts`, `environment: 'node'` for pure tests; jsdom + @testing-library can wait for Phase 2 component tests).
- [ ] Scripts: `lint`, `lint:fix`, `format`, `format:check`, `test`, `test:watch`.
- [ ] `eslint.config.js` ignores `out/`, `release/`, `design-reference/`, `node_modules/`.

### 2. CI
- [ ] In `.github/workflows/build.yml`, extend the **`check`** job to run `pnpm lint` and `pnpm test`
      (after `pnpm typecheck`, before/after `pnpm build`). Keep the `package` matrix as-is.

### 3. Camera→bounds math (the load-bearing pure module)
- [ ] Create `src/renderer/src/lib/cameraBounds.ts` + `cameraBounds.test.ts` (colocated).
- [ ] Implement and test:

```ts
export interface Viewport { x: number; y: number; zoom: number }
export interface Rect { x: number; y: number; width: number; height: number }

/**
 * World-space node rect → screen-space rect under a React Flow viewport.
 * React Flow viewport = translate(x,y) scale(zoom) on `.react-flow__viewport`, origin 0 0.
 * paneOffset = the canvas container's top-left in window CSS px. NOT (0,0) in this app:
 * the topbar (44px) + tabs sit above `.panel`, so paneOffset = panel.getBoundingClientRect().
 */
export function worldRectToScreen(node: Rect, vp: Viewport, paneOffset = { x: 0, y: 0 }): Rect {
  return {
    x: paneOffset.x + vp.x + node.x * vp.zoom,
    y: paneOffset.y + vp.y + node.y * vp.zoom,
    width: node.width * vp.zoom,
    height: node.height * vp.zoom
  }
}

/** WebContentsView.setBounds wants integers. */
export function roundRect(r: Rect): Rect { /* Math.round each field */ }

/** Skip a setBounds IPC when nothing moved (diff-skip for the rAF loop). */
export function rectsEqual(a: Rect, b: Rect): boolean { /* field compare */ }
```

- [ ] Test cases: identity (zoom 1, vp 0/0, no offset) → unchanged; zoom 2 doubles size + scales origin;
      paneOffset adds; negative world coords; rounding; `rectsEqual` true/false. Aim ~8 assertions.

### 4. Diagnostics overlay
- [ ] `src/renderer/src/spike/DiagOverlay.tsx`: a fixed corner panel showing rolling **frame time / FPS**
      (rAF delta), a **live-view counter** (prop), and **JS heap** (`performance.memory?.usedJSHeapSize`,
      guarded — Chromium-only). Monospace, dark tokens, `pointer-events:none`.
- [ ] Wire it behind a dev toggle into the canvas/spike view so 1-C can read the numbers.

## Acceptance (Definition of Done) 📏

- `pnpm typecheck` · `pnpm lint` · `pnpm format:check` · `pnpm test` · `pnpm build` all green.
- CI `check` job runs lint + test (verify the workflow file).
- `cameraBounds.test.ts` passes; covers identity/zoom/offset/negative/round/equal.
- Overlay renders live frame-time + view-count + heap in `pnpm dev`.
- App still launchable; smoke still green.
- Commit: `Phase 1-A: dev tooling + diagnostics harness + camera→bounds math (tested)`.

## Gotchas / carry-forward (don't relearn these)

- **node-pty stays `1.2.0-beta.13`** (winpty-free). Repo path `Z:\Canvas ADE` has a space → don't
  downgrade or native build breaks. (Full reasoning in CLAUDE.md.)
- **React Flow:** set `proOptions={{ hideAttribution: true }}`, `minZoom={0.1}`, `maxZoom={2.5}`
  (defaults 0.5/2 are wrong for us).
- **Security:** never weaken `contextIsolation:true` / `sandbox:true` / `nodeIntegration:false` / thin preload.
- **WebContentsView** (for 1-B+): paints above all HTML, can't be clipped/rounded, **no `destroy()`**
  → `webContents.close()` to avoid leaking a renderer. Bounds are DIP relative to the window content area
  → use `worldRectToScreen` (cheap, no layout) in the rAF loop, not `getBoundingClientRect` per frame.
- **paneOffset is real here:** the `.panel` sits below the 44px topbar + tabs. Compute it once per
  layout (ResizeObserver on the pane), not per frame.
- pnpm `.npmrc` already sets `node-linker=hoisted`. Vitest/ESLint installs are fine.

## What 1-B picks up next

Static `WebContentsView` pinned to one React Flow node's bounds (camera still) using
`worldRectToScreen` + `roundRect`; verify pixel alignment over the cutout; transform tests still green.
Then 1-C adds live pan/zoom and the **measurement** of Windows trailing/lag using the overlay.
