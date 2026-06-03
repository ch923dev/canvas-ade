# E2E Harness Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the in-process `CANVAS_SMOKE=e2e` harness from a flat 24-probe load-bearing `PLAYLIST` + shared mutable `ids` bag into six typed per-group fixtures, and fold in the P0 gate-correctness fixes (real `sendInputEvent` input + a flaky soft-fail bucket).

**Architecture:** Each board-type theme becomes an `E2EGroup<F>` with a `setup` that seeds a typed fixture, a list of `GroupProbe<F>` that receive the fixture (no global bag), and a `teardown` that clears the canvas to empty. The runner iterates groups, asserts a fixture-count invariant between probes (reset model C), and tears down each group before the next so groups can't leak into each other.

**Tech Stack:** TypeScript, Electron 33 main process, Vitest (only `e2eReport` is unit-tested; the harness itself is verified by running it). Driven via `webContents.executeJavaScript` + `webContents.sendInputEvent`.

**Spec:** `docs/superpowers/specs/2026-06-03-e2e-restructure-design.md`

---

## Migration strategy (read first)

The old harness must keep running until the final flip, so CI never goes dark mid-migration.

- Tasks 1–4 are **additive** (new types, context helpers, hook primitive, report field). The old `PLAYLIST` keeps working — it still reads `ctx.ids` and `E2EProbe`.
- Tasks 5–10 **create** `src/main/e2e/groups/*.ts` as self-contained new code (migrated probe bodies live in the group files). The old `src/main/e2e/probes/*.ts` files stay untouched and wired, so the harness still runs the old playlist. The group files are dead code (typecheck-clean) until the flip.
- Task 11 **flips** `index.ts` to iterate the groups, then **deletes** `probes/*.ts` and the `ids` bag.

### Probe migration transform `T` (applied when copying a probe body into a group file)

When a task says "migrate probe `X` (transform `T`)", apply exactly this:

1. Type: `export const X: E2EProbe = {` → `export const X: GroupProbe<F> = {` where `F` is the group's fixture interface.
2. Signature: `async run(ctx) {` → `async run(ctx, fx) {`.
3. Fixture reads: replace every `ctx.ids.termId!` → `fx.termId`, `ctx.ids.browserId!` → `fx.browserId`, `ctx.ids.planId!` → `fx.planId`, `ctx.ids.browserOk` → `fx.browserOk`. (These appear both as bare JS and inside `JSON.stringify(...)` interpolations — the substitution is textual and identical in both.)
4. **Seeding moves to `setup`:** if the original probe began by calling `seedBoard(...)` and storing the id into `ctx.ids`, delete those lines from the probe body — the group `setup` now seeds and supplies the id via `fx`. The probe keeps only its assertions.
5. Everything else (the embedded `executeJavaScript` strings, `poll`/`delay` calls, the returned `E2EPart`) is **copied verbatim** unless the task lists an explicit input conversion.

The per-group tasks below list exactly which probes they contain, which need rule 4 (seed-moves-to-setup), and which need input conversions.

---

## File structure

**Modify:**
- `src/main/e2eReport.ts` — add `flaky?` to `E2EPart`; soft-fail in `summarizeE2E`.
- `src/main/e2eReport.test.ts` — cover the flaky bucket.
- `src/main/e2e/types.ts` — add `GroupProbe<F>` + `E2EGroup<F>` (keep `E2EProbe` until the flip).
- `src/main/e2e/context.ts` — add `realClickSelector` + `realKey` + `ensureFocus`; (flip) drop `ids`/`E2EIds`.
- `src/renderer/src/smoke/e2eHooks.ts` — add `clearAllBoards`.
- `src/main/e2e/index.ts` — (flip) iterate groups + invariant guard + `canvas-empty`.

**Create:**
- `src/main/e2e/groups/terminal.ts`
- `src/main/e2e/groups/browser.ts`
- `src/main/e2e/groups/crossBoard.ts`
- `src/main/e2e/groups/planning.ts`
- `src/main/e2e/groups/menu.ts`
- `src/main/e2e/groups/layout.ts`

**Delete (at flip):**
- `src/main/e2e/probes/*.ts` (all nine), including `probes/seed.ts`.

---

## Task 1: Flaky soft-fail bucket in the report summarizer

**Files:**
- Modify: `src/main/e2eReport.ts`
- Test: `src/main/e2eReport.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/e2eReport.test.ts` inside the `describe('summarizeE2E', …)` block:

```ts
  it('a flaky-tagged failing part does NOT flip the exit code', () => {
    const r = summarizeE2E([
      { name: 'terminal', ok: true },
      { name: 'browser', ok: false, flaky: true, detail: 'capturePage env flake' }
    ])
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
  })

  it('a hard (non-flaky) failing part still fails', () => {
    const r = summarizeE2E([
      { name: 'browser', ok: false, flaky: true },
      { name: 'terminal', ok: false }
    ])
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(1)
  })

  it('the flaky flag is serialized into the E2E_DONE line', () => {
    const r = summarizeE2E([{ name: 'browser', ok: false, flaky: true }])
    expect(r.line).toContain('"flaky":true')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- e2eReport`
Expected: FAIL — the two flaky cases fail (`ok` is `false`/`exitCode` is `1` because the current `every(p => p.ok)` does not consider `flaky`).

- [ ] **Step 3: Implement the soft-fail**

Replace the `E2EPart` interface and `summarizeE2E` in `src/main/e2eReport.ts`:

```ts
export interface E2EPart {
  /** Board/area name: 'terminal' | 'browser' | 'planning'. */
  name: string
  ok: boolean
  /** Human-readable evidence (echoed into the marker line). */
  detail?: string
  /**
   * A known-flaky check whose failure is reported but must NOT fail the run
   * (e.g. the browser/browser-gesture/focus-detach capturePage env flake). The
   * marker still prints with ok:false, flaky:true; the exit code is unaffected.
   */
  flaky?: boolean
}

export interface E2ESummary {
  ok: boolean
  /** 0 when ok, 1 otherwise — assigned to process.exitCode by the caller. */
  exitCode: number
  /** The `E2E_DONE …` stdout marker line. */
  line: string
}

export function summarizeE2E(parts: E2EPart[]): E2ESummary {
  const ok = parts.length > 0 && parts.every((p) => p.ok || p.flaky === true)
  return { ok, exitCode: ok ? 0 : 1, line: `E2E_DONE ${JSON.stringify({ ok, parts })}` }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- e2eReport`
Expected: PASS (all cases, including the four pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/main/e2eReport.ts src/main/e2eReport.test.ts
git commit -m "feat(e2e): flaky soft-fail bucket in summarizeE2E"
```

---

## Task 2: Group + fixture types

**Files:**
- Modify: `src/main/e2e/types.ts`

- [ ] **Step 1: Add the group/fixture contracts**

Append to `src/main/e2e/types.ts` (keep the existing `E2EProbe` export — the old runner still uses it until the flip):

```ts
import type { E2ECtx } from './context'

/**
 * A probe inside a fixture group. Unlike the legacy E2EProbe it receives the
 * group's TYPED fixture instead of reading the shared ctx.ids bag.
 */
export interface GroupProbe<F> {
  /** Playlist label (the part name(s) on the returned E2EPart). */
  readonly name: string
  run(ctx: E2ECtx, fixture: F): Promise<E2EPart | E2EPart[]>
}

/**
 * A themed group: seed a typed fixture once, run the group's probes against it
 * (each self-restoring; the runner guards the board-count invariant between
 * probes), then tear down to an empty canvas so groups cannot leak into one
 * another.
 */
export interface E2EGroup<F = unknown> {
  readonly name: string
  setup(ctx: E2ECtx): Promise<F>
  readonly probes: GroupProbe<F>[]
  teardown(ctx: E2ECtx, fixture: F): Promise<void>
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck:node`
Expected: PASS (no errors; `E2ECtx` already exports from `./context`).

- [ ] **Step 3: Commit**

```bash
git add src/main/e2e/types.ts
git commit -m "feat(e2e): add GroupProbe + E2EGroup fixture contracts"
```

---

## Task 3: Real-input helpers on the harness context

**Files:**
- Modify: `src/main/e2e/context.ts`

- [ ] **Step 1: Add the focus gate + input helpers to the `E2ECtx` interface**

In `src/main/e2e/context.ts`, add these members to the `E2ECtx` interface (after `delay(ms)`):

```ts
  /** Focus the window, then poll document.hasFocus() — required before sendInputEvent. */
  ensureFocus(): Promise<boolean>
  /**
   * Real OS click on the viewport-center of `selector` via webContents.sendInputEvent
   * (respects CSS-transform hit-testing, unlike synthetic dispatchEvent). Returns
   * false if the selector matches nothing. Focus-gated.
   */
  realClickSelector(selector: string): Promise<boolean>
  /** Real OS key press (keyDown/char/keyUp) via sendInputEvent, e.g. 'Escape'. Focus-gated. */
  realKey(key: string): Promise<void>
```

- [ ] **Step 2: Implement them in `makeContext`**

In `makeContext`, add these before the `return {` (they close over `win`, `evalIn`, `poll`):

```ts
  const ensureFocus = async (): Promise<boolean> => {
    win.focus()
    return poll(() => evalIn<boolean>('document.hasFocus()'), 2000)
  }

  const realClickSelector = async (selector: string): Promise<boolean> => {
    await ensureFocus()
    const at = await evalIn<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return null;
         const r = el.getBoundingClientRect();
         return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    )
    if (!at) return false
    const x = Math.round(at.x)
    const y = Math.round(at.y)
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    return true
  }

  const realKey = async (key: string): Promise<void> => {
    await ensureFocus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
    win.webContents.sendInputEvent({ type: 'char', keyCode: key })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
  }
```

Then add `ensureFocus,`, `realClickSelector,`, and `realKey,` to the returned object literal (alongside `evalIn,`/`poll,`/`delay,`).

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm typecheck:node`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/e2e/context.ts
git commit -m "feat(e2e): real sendInputEvent click/key helpers on E2ECtx"
```

---

## Task 4: `clearAllBoards` teardown primitive

**Files:**
- Modify: `src/renderer/src/smoke/e2eHooks.ts`

- [ ] **Step 1: Declare it on the `CanvasE2E` interface**

In `src/renderer/src/smoke/e2eHooks.ts`, add to the `CanvasE2E` interface (after `deleteBoard`):

```ts
  /** Remove every board (parking terminals first) and reset the seed cursor → empty canvas. */
  clearAllBoards: () => void
```

- [ ] **Step 2: Implement it in the `api` object**

In `installE2EHooks`, add this method to the `api` object (after `deleteBoard`):

```ts
    clearAllBoards() {
      const store = useCanvasStore.getState()
      for (const b of [...store.boards]) {
        if (b.type === 'terminal') void window.api.parkTerminal(b.id)
        store.removeBoard(b.id)
      }
      seedX = 0 // next group seeds from a clean origin
    },
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/smoke/e2eHooks.ts
git commit -m "feat(e2e): clearAllBoards hook for per-group teardown"
```

---

## Task 5: `terminal` group

**Files:**
- Create: `src/main/e2e/groups/terminal.ts`

**Probes (in run order):** `terminal` (rule 4: seed→setup), `config-nowheel`, `terminal-fullview` (from `probes/fullview.ts`), `fullview-close` (from `probes/fullview.ts`, **input conversion**), `terminal-lod`, `terminal-respawn`, `terminal-adopt`. Order preserved: `terminal` asserts SENTINEL1 before `terminal-respawn` overwrites the framebuffer with SENTINEL2.

- [ ] **Step 1: Write the group scaffold + fixture**

Create `src/main/e2e/groups/terminal.ts`:

```ts
/**
 * Terminal-board fixture group: one terminal seeded with a sentinel launchCommand.
 * Probes assert the PTY↔xterm data plane, the Configure nowheel guard, LOD survival,
 * config respawn, park/adopt-on-undo, and full-view PTY survival + chrome-less Esc close.
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface TerminalFixture {
  termId: string
}

const seedTerminal: E2EGroup<TerminalFixture>['setup'] = async (ctx) => {
  const termId = await ctx.evalIn<string>(
    `window.__canvasE2E.seedBoard('terminal', { launchCommand: 'echo ${ctx.TERM_SENTINEL}' })`
  )
  return { termId }
}
```

- [ ] **Step 2: Add the probes**

Append the seven probes. Copy each body from its source file applying transform `T`; `terminal` also applies rule 4 (drop the `seedBoard` + `ctx.ids.termId =` lines — `fx.termId` is already seeded). Sources: `terminal` / `config-nowheel` / `terminal-lod` / `terminal-respawn` / `terminal-adopt` from `probes/terminal.ts`; `terminal-fullview` / `fullview-close` from `probes/fullview.ts`.

The `terminal` probe after rule 4 is exactly:

```ts
export const terminal: GroupProbe<TerminalFixture> = {
  name: 'terminal',
  async run(ctx, fx) {
    const termOk = await ctx.poll(async () => {
      const text = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(fx.termId)})`
      )
      return typeof text === 'string' && text.includes(ctx.TERM_SENTINEL)
    }, 10000)
    return { name: 'terminal', ok: termOk, detail: termOk ? 'sentinel in framebuffer' : 'no sentinel' }
  }
}
```

`config-nowheel`, `terminal-lod`, `terminal-respawn`, `terminal-adopt`, `terminal-fullview` are transform `T` only (replace `const termId = ctx.ids.termId!` with using `fx.termId` directly — i.e. delete that line and substitute `fx.termId` at each use site).

**`fullview-close` input conversion:** in the embedded JS, the Escape is dispatched synthetically (`(ta || document).dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', …}))`). Split it so the textarea is focused in the renderer, then fire Escape via real input. Replace the single `evalIn` block with:

```ts
export const fullviewClose: GroupProbe<TerminalFixture> = {
  name: 'fullview-close',
  async run(ctx, fx) {
    await ctx.evalIn(`window.__canvasE2E.setFullView(${JSON.stringify(fx.termId)})`)
    await ctx.delay(400) // modal mounts + enter tween settles
    const pre = await ctx.evalIn<{ frame: boolean; bandGone: boolean; typed: boolean }>(
      `(() => {
         const ta = document.querySelector('.fullview-host .xterm-helper-textarea');
         if (ta) ta.focus();
         const typing = document.activeElement?.tagName === 'TEXTAREA';
         return {
           frame: !!document.querySelector('.fullview-scrim .fullview-frame .fullview-host'),
           bandGone: document.querySelector('.fullview-band') === null,
           typed: typing
         };
       })()`
    )
    await ctx.realKey('Escape') // real OS Escape from the focused xterm textarea (was synthetic)
    await ctx.delay(400) // exit tween (200ms) + onExited unmount
    const closed = await ctx.evalIn<boolean>(`document.querySelector('.fullview-scrim') === null`)
    const ok = pre.frame && pre.bandGone && pre.typed && closed
    return {
      name: 'fullview-close',
      ok,
      detail: ok
        ? 'chrome-less frame (no band); real Esc from focused terminal textarea closes + unmounts'
        : `frame=${pre.frame} bandGone=${pre.bandGone} typing=${pre.typed} closed=${closed}`
    }
  }
}
```

- [ ] **Step 3: Export the group**

At the bottom of the file:

```ts
export const terminalGroup: E2EGroup<TerminalFixture> = {
  name: 'terminal',
  setup: seedTerminal,
  probes: [terminal, configNowheel, terminalFullview, fullviewClose, terminalLod, terminalRespawn, terminalAdopt],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
```

- [ ] **Step 4: Verify typecheck + lint**

Run: `pnpm typecheck:node && pnpm lint`
Expected: PASS (the file is unused dead code, but must compile and lint clean).

- [ ] **Step 5: Commit**

```bash
git add src/main/e2e/groups/terminal.ts
git commit -m "feat(e2e): terminal fixture group (real Esc close)"
```

---

## Task 6: `browser` group

**Files:**
- Create: `src/main/e2e/groups/browser.ts`

**Probes:** `browser` (assertion only — capture verdict computed in setup, with retry+flaky), `browser-gesture` (flaky on fail), `browser-deadurl` (seeds + removes its own dead board), `fullview-preview` (seeds + removes an aux planning board), `fullview-self-preserve`, `fullview-emulator`.

- [ ] **Step 1: Write the group scaffold + fixture with retry capture**

Create `src/main/e2e/groups/browser.ts`:

```ts
/**
 * Browser-board / native-WebContentsView fixture group: one Browser at the in-process
 * localServer, brought to connected+live with a bounded retry capture verdict in setup.
 * The capturePage trio (browser / browser-gesture) is known-flaky on a contended host
 * (memory e2e-browser-trio-flake) → those parts emit flaky:true on failure, not a hard fail.
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface BrowserFixture {
  browserId: string
  /** setup's bounded-retry capturePage verdict — every browser probe reads this. */
  browserOk: boolean
}

const seedBrowser: E2EGroup<BrowserFixture>['setup'] = async (ctx) => {
  const browserId = await ctx.evalIn<string>(
    `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(ctx.localUrl)} })`
  )
  await ctx.delay(150) // let React Flow mount + measure before fitView
  await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
  const connected = await ctx.poll(async () => {
    const rt = await ctx.evalIn<{ status: string; live: boolean } | null>(
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.status === 'connected' && rt.live === true
  }, 10000)
  let browserOk = false
  if (connected) {
    // Bounded retry: a view needs ≥1 paint before capturePage is non-blank (P0-2).
    for (let attempt = 0; attempt < 3 && !browserOk; attempt++) {
      await ctx.delay(300)
      const cap = await ctx.dbg.captureView(browserId)
      browserOk = cap.attached && !cap.empty
    }
  }
  return { browserId, browserOk }
}
```

- [ ] **Step 2: Add the probes**

`browser` becomes a pure assertion on the setup verdict, tagged flaky on failure:

```ts
export const browser: GroupProbe<BrowserFixture> = {
  name: 'browser',
  async run(_ctx, fx) {
    return {
      name: 'browser',
      ok: fx.browserOk,
      flaky: !fx.browserOk, // capturePage env flake → reported, not a hard fail
      detail: fx.browserOk ? 'non-blank per-view capturePage' : 'capture blank/detached after 3 tries'
    }
  }
}
```

`browser-gesture`: migrate from `probes/browserPreview.ts` with transform `T` (`ctx.ids.browserId!` → `fx.browserId`, `ctx.ids.browserOk === true` → `fx.browserOk`). Tag the part flaky on failure — it depends on the flaky capture verdict. Change its return to exactly:

```ts
    return { name: 'browser-gesture', ok: gestureOk, flaky: !gestureOk, detail: gestureDetail }
```

`browser-deadurl`: migrate from `probes/browserPreview.ts` with transform `T`. It already seeds its own `deadId` locally — keep that, but **replace** `ctx.ids.deadId = deadId` with a local `const deadId` (the fixture has no `deadId`), and **append a cleanup** before `return` so the group count returns to baseline:

```ts
    await ctx.evalIn(`window.__canvasE2E.deleteBoard(${JSON.stringify(deadId)})`) // self-restore count
```

`fullview-preview`: migrate from `probes/fullview.ts` with transform `T`, but it needs a planning board to full-view + mutate. The fixture has no `planId`, so **seed and remove an aux planning board inside the probe**. Replace `const planId = ctx.ids.planId!` with:

```ts
    const planId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')")
```

and, just before the final `return [...]`, add cleanup:

```ts
    await ctx.evalIn(`window.__canvasE2E.deleteBoard(${JSON.stringify(planId)})`) // remove aux board → restore count
```

(The aux planning board is seeded and removed within the probe, so the group's count invariant holds across it.)

`fullview-self-preserve` and `fullview-emulator`: migrate from `probes/fullview.ts` with transform `T` only.

- [ ] **Step 3: Export the group**

```ts
export const browserGroup: E2EGroup<BrowserFixture> = {
  name: 'browser',
  setup: seedBrowser,
  probes: [browser, browserGesture, browserDeadUrl, fullviewPreview, fullviewSelfPreserve, fullviewEmulator],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
```

- [ ] **Step 4: Verify typecheck + lint**

Run: `pnpm typecheck:node && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/e2e/groups/browser.ts
git commit -m "feat(e2e): browser fixture group (retry capture + flaky tagging)"
```

---

## Task 7: `crossBoard` group

**Files:**
- Create: `src/main/e2e/groups/crossBoard.ts`

**Probes:** `focus-detach` (flaky), `preview-edge-stale`, `duplicate-keeps-link`, `preview-connect-gesture` (partial input conversion). Fixture = terminal + browser (browser brought live with the same retry-capture verdict as Task 6).

- [ ] **Step 1: Write the group scaffold + composite fixture**

Create `src/main/e2e/groups/crossBoard.ts`:

```ts
/**
 * Cross-board interaction fixture group: a terminal AND a live Browser together. Covers
 * the focus-detach ghost, the stale preview edge, duplicate-keeps-link, and the terminal
 * globe → connect-picker gesture routing — all of which need both boards present.
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface CrossFixture {
  termId: string
  browserId: string
  browserOk: boolean
}

const seedCross: E2EGroup<CrossFixture>['setup'] = async (ctx) => {
  const termId = await ctx.evalIn<string>(
    `window.__canvasE2E.seedBoard('terminal', { launchCommand: 'echo ${ctx.TERM_SENTINEL}' })`
  )
  const browserId = await ctx.evalIn<string>(
    `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(ctx.localUrl)} })`
  )
  await ctx.delay(150)
  await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
  const connected = await ctx.poll(async () => {
    const rt = await ctx.evalIn<{ status: string; live: boolean } | null>(
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.status === 'connected' && rt.live === true
  }, 10000)
  let browserOk = false
  if (connected) {
    for (let attempt = 0; attempt < 3 && !browserOk; attempt++) {
      await ctx.delay(300)
      const cap = await ctx.dbg.captureView(browserId)
      browserOk = cap.attached && !cap.empty
    }
  }
  return { termId, browserId, browserOk }
}
```

- [ ] **Step 2: Add the probes**

`focus-detach`: migrate from `probes/browserPreview.ts` with transform `T` (`ctx.ids.browserId!`→`fx.browserId`, `ctx.ids.termId!`→`fx.termId`, `ctx.ids.browserOk`→`fx.browserOk`). Tag flaky: change its return to `{ name: 'focus-detach', ok: focusOk, flaky: !focusOk, detail: … }` (it depends on the flaky capture).

`preview-edge-stale` and `duplicate-keeps-link`: migrate from `probes/previewLink.ts` with transform `T` only. Both already self-restore (they unlink / delete the clone before returning) — keep that.

`preview-connect-gesture`: migrate from `probes/previewLink.ts` with transform `T`. **Input conversion (partial, documented boundary):** the long-press timer and `contextmenu` gestures stay synthetic — `sendInputEvent` mouse `modifiers`/press-timing do not faithfully reproduce them (memory `e2e-modifier-keys-synthetic`). Convert only the two hit-test-sensitive clicks to real input: the **Connect button** click and the final **tap**. After the migrated `evalIn` gesture block returns, the original performs the tap *inside* the JS; instead, leave the hold/right-click/connect-candidate logic in the JS block but remove the trailing tap from it, and drive the tap via real input after the block:

In the embedded JS, delete the `// (3) TAP` section (the three `globe.dispatchEvent(... mousedown/mouseup/click ...)` lines and the `const tapOpened = !!picker();`), and change the block's return to not include `tapOpened`. Then after the `evalIn` call add:

```ts
    // (3) TAP via real OS input — a plain click refreshes the linked browser, opens NO picker.
    await ctx.realClickSelector(
      `.react-flow__node[data-id="${fx.termId}"] button[title*="choose browser"]`
    )
    await ctx.delay(700)
    const tapOpened = await ctx.evalIn<boolean>(
      `!!document.querySelector('.react-flow__node[data-id="${fx.termId}"] .ca-port-picker')`
    )
```

and adjust the final `connectGestureOk` expression to use this local `tapOpened` (drop `gesture.tapOpened`, keep `!tapOpened`). The Connect-candidate click inside the JS (`connect.click()`) is acceptable as-is (the picker is HTML, not transform-occluded), so only the tap is converted; note this in a one-line comment.

- [ ] **Step 3: Export the group**

```ts
export const crossBoardGroup: E2EGroup<CrossFixture> = {
  name: 'crossBoard',
  setup: seedCross,
  probes: [focusDetach, previewEdgeStale, duplicateKeepsLink, previewConnectGesture],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
```

- [ ] **Step 4: Verify typecheck + lint**

Run: `pnpm typecheck:node && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/e2e/groups/crossBoard.ts
git commit -m "feat(e2e): crossBoard fixture group (real tap input)"
```

---

## Task 8: `planning` group

**Files:**
- Create: `src/main/e2e/groups/planning.ts`

- [ ] **Step 1: Write the group**

Create `src/main/e2e/groups/planning.ts`. The `planning` probe migrates from `probes/planning.ts` with transform `T` + rule 4 (seeding moves to setup):

```ts
/**
 * Planning-board fixture group: one planning board. Asserts a checklist element persists
 * and the whole canvas round-trips through the schema (persistence-readiness).
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface PlanningFixture {
  planId: string
}

const seedPlanning: E2EGroup<PlanningFixture>['setup'] = async (ctx) => {
  const planId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')")
  return { planId }
}

export const planning: GroupProbe<PlanningFixture> = {
  name: 'planning',
  async run(ctx, fx) {
    await ctx.evalIn(`window.__canvasE2E.addChecklist(${JSON.stringify(fx.planId)})`)
    const planProbe = await ctx.evalIn<{ kinds: string[]; roundTrip: boolean }>(
      `(() => {
         const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(fx.planId)});
         const kinds = b && b.type === 'planning' ? b.elements.map((e) => e.kind) : [];
         return { kinds, roundTrip: window.__canvasE2E.roundTripOk() };
       })()`
    )
    const planOk = planProbe.kinds.includes('checklist') && planProbe.roundTrip
    return {
      name: 'planning',
      ok: planOk,
      detail: `elements=[${planProbe.kinds.join(',')}] roundTrip=${planProbe.roundTrip}`
    }
  }
}

export const planningGroup: E2EGroup<PlanningFixture> = {
  name: 'planning',
  setup: seedPlanning,
  probes: [planning],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `pnpm typecheck:node && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/e2e/groups/planning.ts
git commit -m "feat(e2e): planning fixture group"
```

---

## Task 9: `menu` group

**Files:**
- Create: `src/main/e2e/groups/menu.ts`

**Probes:** `board-menu` (input conversion: Duplicate/Delete → real clicks), `menu-chrome`. Fixture = terminal + planning (`board-menu` duplicates/deletes a planning clone; `menu-chrome` narrows the terminal).

- [ ] **Step 1: Write the group scaffold + fixture**

Create `src/main/e2e/groups/menu.ts`:

```ts
/**
 * Board ⋯-menu fixture group: a terminal + a planning board. Asserts the popover portals
 * to <body> and Duplicate/Delete fire through REAL OS clicks (was synthetic pointerdown),
 * and the ⋯ trigger stays within the title bar + clamps on-screen near the window edge.
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface MenuFixture {
  termId: string
  planId: string
}

const seedMenu: E2EGroup<MenuFixture>['setup'] = async (ctx) => {
  const termId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('terminal')")
  const planId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')")
  return { termId, planId }
}
```

- [ ] **Step 2: Add `board-menu` with real-click Duplicate/Delete**

The original opens the menu and clicks Duplicate/Delete via synthetic `dispatchEvent(PointerEvent)+click` inside one JS block. Restructure so the menu is opened in the renderer but the menu-item clicks go through real input. The menu items portal to `<body>` with class `.board-menu-item`; target them by text via a data attribute is unavailable, so click by resolving their rect. Add a small renderer helper inline that returns the item's center, then real-click it. Implementation:

```ts
export const boardMenu: GroupProbe<MenuFixture> = {
  name: 'board-menu',
  async run(ctx, fx) {
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(fx.planId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.delay(150)
    const base = await ctx.evalIn<number>('window.__canvasE2E.getBoards().length')

    // Open the planning board's ⋯ menu (opening is not transform-sensitive at zoom 1).
    const portaled = await ctx.evalIn<boolean>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(fx.planId)}) + ']');
         const more = node && node.querySelector('button[title="More"]');
         if (!more) return false;
         more.click(); await sleep(80);
         const menu = document.querySelector('.board-menu');
         return !!menu && menu.parentElement === document.body && !document.querySelector('.bb-frame .board-menu');
       })()`
    )
    // Real-click Duplicate (a body-portaled item — resolve by text, click its center via OS input).
    await realClickMenuItem(ctx, 'Duplicate')
    await ctx.delay(150)
    const afterDup = await ctx.evalIn<number>('window.__canvasE2E.getBoards().length')

    // Open the clone's ⋯ menu and real-click Delete.
    await ctx.evalIn(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const boards = window.__canvasE2E.getBoards();
         const dupId = boards.slice(-1)[0] && boards.slice(-1)[0].id;
         const dupNode = dupId && document.querySelector('.react-flow__node[data-id=' + JSON.stringify(dupId) + ']');
         const more = dupNode && dupNode.querySelector('button[title="More"]');
         if (more) { more.click(); await sleep(80); }
       })()`
    )
    await realClickMenuItem(ctx, 'Delete')
    await ctx.delay(150)
    const afterDel = await ctx.evalIn<number>('window.__canvasE2E.getBoards().length')

    const ok = portaled && afterDup === base + 1 && afterDel === base
    return {
      name: 'board-menu',
      ok,
      detail: ok
        ? 'portaled to body + real-click Duplicate/Delete fire'
        : JSON.stringify({ portaled, base, afterDup, afterDel })
    }
  }
}

/** Real OS click on a body-portaled .board-menu-item matched by trimmed text. */
async function realClickMenuItem(ctx: import('../context').E2ECtx, label: string): Promise<boolean> {
  const at = await ctx.evalIn<{ x: number; y: number } | null>(
    `(() => {
       const item = [...document.querySelectorAll('.board-menu .board-menu-item')]
         .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
       if (!item) return null;
       const r = item.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
     })()`
  )
  if (!at) return false
  ctx.win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 })
  ctx.win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 })
  return true
}
```

- [ ] **Step 3: Add `menu-chrome`**

Migrate `menu-chrome` from `probes/menu.ts` with transform `T` (`ctx.ids.termId!` → `fx.termId`). Its menu open/close `.click()` calls stay synthetic (geometry assertion at zoom 1, full screen — not transform-occluded). No other change.

- [ ] **Step 4: Export the group**

```ts
export const menuGroup: E2EGroup<MenuFixture> = {
  name: 'menu',
  setup: seedMenu,
  probes: [boardMenu, menuChrome],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
```

- [ ] **Step 5: Verify typecheck + lint**

Run: `pnpm typecheck:node && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/e2e/groups/menu.ts
git commit -m "feat(e2e): menu fixture group (real-click Duplicate/Delete)"
```

---

## Task 10: `layout` group

**Files:**
- Create: `src/main/e2e/groups/layout.ts`

- [ ] **Step 1: Write the group**

The `tidy`/`tile` probes migrate from `probes/layout.ts` unchanged (transform `T` is a no-op — they never read `ctx.ids`). Setup seeds a spread of boards so tidy's "browsers grouped on 1 row" check and tile's fill check have ≥2 boards including 2 browsers.

```ts
/**
 * Layout-preset fixture group: a spread of boards (2 browsers + terminal + planning) so
 * Smart tidy can prove type-grouping (browsers on one row) and Tile can prove fill. Both
 * probes use deterministic store paths — immune to the capturePage flake.
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface LayoutFixture {
  ids: string[]
}

const seedLayout: E2EGroup<LayoutFixture>['setup'] = async (ctx) => {
  const ids: string[] = []
  for (const type of ['browser', 'browser', 'terminal', 'planning'] as const) {
    ids.push(await ctx.evalIn<string>(`window.__canvasE2E.seedBoard(${JSON.stringify(type)})`))
  }
  return { ids }
}
```

Then append `tidy` and `tile` copied verbatim from `probes/layout.ts`, retyped `GroupProbe<LayoutFixture>` with `async run(ctx, _fx)` (the fixture is unused — the probes read `getBoards()` directly). Then:

```ts
export const layoutGroup: E2EGroup<LayoutFixture> = {
  name: 'layout',
  setup: seedLayout,
  probes: [tidy, tile],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `pnpm typecheck:node && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/e2e/groups/layout.ts
git commit -m "feat(e2e): layout fixture group"
```

---

## Task 11: Flip the runner + delete the old playlist

**Files:**
- Modify: `src/main/e2e/index.ts`
- Modify: `src/main/e2e/context.ts` (drop `ids`/`E2EIds`)
- Delete: `src/main/e2e/probes/` (all nine files)

- [ ] **Step 1: Rewrite the runner over groups**

Replace the whole body of `src/main/e2e/index.ts` with:

```ts
/**
 * In-process board harness (CANVAS_SMOKE=e2e). MAIN seeds a typed fixture per GROUP through
 * the renderer hook (window.__canvasE2E), runs that group's probes against the fixture, then
 * tears the group down to an empty canvas before the next — so groups never leak into one
 * another. Between probes the runner asserts the group's board-count invariant (reset model C)
 * and hard-fails the group on violation instead of cascading.
 *
 * Emits one E2E_<NAME> marker per part + a final E2E_DONE, and returns a summary whose exitCode
 * the caller assigns to process.exitCode. Verified by running the command; not a vitest target.
 *
 * Markers go to stdout via bare console.log — safe because index.ts installs a process.stdout
 * 'error' handler (EPIPE swallow) before this runs whenever SMOKE is set.
 */
import type { BrowserWindow } from 'electron'
import { summarizeE2E, type E2EPart } from '../e2eReport'
import { makeContext, type E2ECtx } from './context'
import type { E2EGroup } from './types'
import { terminalGroup } from './groups/terminal'
import { browserGroup } from './groups/browser'
import { crossBoardGroup } from './groups/crossBoard'
import { planningGroup } from './groups/planning'
import { menuGroup } from './groups/menu'
import { layoutGroup } from './groups/layout'

// Groups run in this order; each tears down to empty, so the order is NOT load-bearing for
// correctness (no shared state survives a teardown). Listed terminal→layout for readability.
const GROUPS: E2EGroup<unknown>[] = [
  terminalGroup as E2EGroup<unknown>,
  browserGroup as E2EGroup<unknown>,
  crossBoardGroup as E2EGroup<unknown>,
  planningGroup as E2EGroup<unknown>,
  menuGroup as E2EGroup<unknown>,
  layoutGroup as E2EGroup<unknown>
]

async function boardCount(ctx: E2ECtx): Promise<number> {
  return ctx.evalIn<number>('window.__canvasE2E.getBoards().length')
}

export async function runE2ESmoke(win: BrowserWindow, localUrl: string): Promise<number> {
  const ctx = makeContext(win, localUrl)

  const hookReady = await ctx.poll(() => ctx.evalIn<boolean>('!!window.__canvasE2E'), 8000)
  if (!hookReady) {
    const s = summarizeE2E([{ name: 'hook', ok: false, detail: 'window.__canvasE2E never appeared' }])
    console.log(s.line)
    return s.exitCode
  }

  const parts: E2EPart[] = []
  for (const group of GROUPS) {
    const fixture = await group.setup(ctx)
    const baseline = await boardCount(ctx)
    for (const probe of group.probes) {
      const r = await probe.run(ctx, fixture)
      if (Array.isArray(r)) parts.push(...r)
      else parts.push(r)
      const now = await boardCount(ctx)
      if (now !== baseline) {
        parts.push({
          name: `${group.name}-fixture-broken`,
          ok: false,
          detail: `board count ${now} != baseline ${baseline} after probe '${probe.name}'`
        })
        break // stop this group; teardown still runs below
      }
    }
    await group.teardown(ctx, fixture)
  }

  // Every group tore down to empty → the canvas must be empty now (replaces the old `seed`
  // final-count probe).
  const finalCount = await boardCount(ctx)
  parts.push({
    name: 'canvas-empty',
    ok: finalCount === 0,
    detail: `${finalCount} boards remain after teardown`
  })

  const summary = summarizeE2E(parts)
  for (const p of parts) console.log(`E2E_${p.name.toUpperCase()} ${JSON.stringify(p)}`)
  console.log(summary.line)
  return summary.exitCode
}
```

- [ ] **Step 2: Drop the dead `ids` bag from the context**

In `src/main/e2e/context.ts`: delete the `E2EIds` interface, delete the `readonly ids: E2EIds` member from the `E2ECtx` interface, and delete `ids: {},` from the returned object in `makeContext`. The sentinels and helpers stay.

- [ ] **Step 3: Delete the old probe files**

```bash
git rm src/main/e2e/probes/terminal.ts src/main/e2e/probes/browserPreview.ts \
  src/main/e2e/probes/fullview.ts src/main/e2e/probes/planning.ts \
  src/main/e2e/probes/menu.ts src/main/e2e/probes/previewLink.ts \
  src/main/e2e/probes/layout.ts src/main/e2e/probes/seed.ts
```

(If `src/main/e2e/probes/` retains only deleted files, the directory is removed automatically.)

- [ ] **Step 4: Verify the unit gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: PASS — no dangling references to `probes/*`, `E2EProbe`, or `ctx.ids`. (`E2EProbe` may still be exported from `types.ts`; that is fine, or delete it too if unused — `grep -r E2EProbe src` to confirm before removing.)

- [ ] **Step 5: Run the real harness**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: every group sets up, runs, and tears down; stdout shows the per-part `E2E_*` markers, a final `E2E_CANVAS_EMPTY {…ok:true…}`, and `E2E_DONE {"ok":true,…}`; the process exits 0 on a clean host. The `browser`/`browser-gesture`/`focus-detach` parts show `ok:true` on a clean run; if the env capturePage flake fires they show `ok:false, flaky:true` and the run **still exits 0**. Total `E2E_*` part markers = 25 (24 probe parts incl. `fullview-preview`'s two, plus `canvas-empty`; `seed` removed).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(e2e): flip runner to per-group fixtures; remove flat playlist + ids bag"
```

---

## Task 12: Update docs + baseline note

**Files:**
- Modify: `CLAUDE.md` (Status block — the e2e baseline sentence)
- Modify: memory `e2e-browser-trio-flake` (note the flaky soft-fail now downgrades it)

- [ ] **Step 1: Update the e2e baseline note in `CLAUDE.md`**

In the Status section, update the e2e sentence to reflect the new shape — six fixture groups, per-group teardown, the flaky soft-fail downgrade so the browser trio no longer red-lights CI, and `E2E_CANVAS_EMPTY` as the end-state assertion (replacing the `seed` count probe). Keep it to the existing one/two-sentence style.

- [ ] **Step 2: Update the flake memory**

Edit `C:\Users\De Asis PC\.claude\projects\Z--Canvas-ADE\memory\e2e-browser-trio-flake.md` to add: the trio now emits `flaky:true` on persistent capture failure, so a flaky run reports the failure but exits 0 — rerun is no longer required to green CI.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: e2e baseline note for per-group fixture harness"
```

(The memory file lives outside the repo and is saved separately, not committed.)

---

## Self-review notes (addressed)

- **Spec coverage:** group model (T2/11), reset-model-C invariant guard (T11 Step 1), six groups (T5–10), `clearAllBoards` (T4), real input on the three transform-sensitive probes (T5 `fullview-close` Esc, T9 `board-menu` Duplicate/Delete, T7 `preview-connect-gesture` tap), flaky quarantine (T1 + T6/T7 tagging), `seed` drop + `canvas-empty` (T11). All present.
- **Marker count:** 24 probe parts (incl. `fullview-preview` ×2) − `seed` + `canvas-empty` = 25, matching the spec.
- **Type consistency:** `GroupProbe<F>`/`E2EGroup<F>` (T2) used uniformly; fixtures `TerminalFixture`/`BrowserFixture`/`CrossFixture`/`PlanningFixture`/`MenuFixture`/`LayoutFixture`; `realClickSelector`/`realKey`/`ensureFocus`/`clearAllBoards` names match across tasks.
- **Out of scope (next pass):** coverage-matrix probes, Playwright Stage-2, `package needs: smoke`, macOS/Linux smoke leg — per spec §"Out of scope".
```
