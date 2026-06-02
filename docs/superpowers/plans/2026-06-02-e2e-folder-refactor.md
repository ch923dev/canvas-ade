# Plan — split the e2e smoke into an `e2e/` folder (themed probe modules)

**Date:** 2026-06-02 · **Branch:** `refactor/e2e-folder` · **Type:** test-harness refactor (no behavior change)

## Problem

`src/main/e2eSmoke.ts` is a single **950-line** `runE2ESmoke()` function holding ~25 sequential
probes that each push an `E2EPart` onto one `parts[]` array. It's unreadable and unnavigable — the
opposite of how unit tests sit one-per-module. Goal: break it into an `e2e/` folder of small,
themed files, "like unit testing."

## Hard constraint (why this is NOT pure per-test isolation)

The probes are **not independent**. They share seeded board ids and **execution order is
load-bearing**:

- `termId` (seeded by the first terminal probe), `browserId`, `planId`, `deadId` are created once
  and reused by many later probes.
- State mutates across probes and is restored later: `menu-chrome` shrinks the terminal to `w:150`;
  `preview-connect-gesture` restores `w:360`. `board-menu` / `duplicate-keeps-link` create then
  delete a clone to keep the final `seed` count at **4**. Full view is toggled on/off; zoom is
  set/restored.
- It's not a vitest target by design — it needs the live Electron runtime (`webContents.executeJavaScript`
  + MAIN-side `capturePage`/PTY debug accessors).

**Decision (confirmed with user):** keep a **single shared harness** that runs all probes in one
Electron session in a **fixed order**, threading a shared context. This is a pure structural
refactor — zero behavior change, identical runtime cost, identical gate. (True per-test isolation
was considered and rejected: it would force a re-seed per test, much longer Electron time, and the
cross-probe interactions are themselves the thing under test for several bugs.)

**Granularity (confirmed):** ~7 **themed** files (mirrors one-test-file-per-module), not ~25 tiny
files.

## Target structure

```
src/main/e2e/
  index.ts          # runE2ESmoke() entry (the only external export) + the ORDERED playlist + the hook-ready preamble
  context.ts        # E2ECtx type + makeContext(): helpers (evalIn/poll/delay), debug accessors, mutable ids bag, constants
  types.ts          # E2EProbe interface (re-exports E2EPart/E2ESummary from ../e2eReport)
  probes/
    terminal.ts       # terminal, config-nowheel, terminal-lod, terminal-respawn, terminal-adopt
    browserPreview.ts # browser, browser-gesture, focus-detach, browser-deadurl
    fullview.ts       # terminal-fullview, fullview-preview, fullview-preserve, fullview-self-preserve, fullview-emulator, fullview-close
    planning.ts       # planning
    menu.ts           # board-menu, menu-chrome, menu-preview-detach
    previewLink.ts    # preview-edge-stale, duplicate-keeps-link, preview-connect-gesture
    layout.ts         # tidy, tile
    seed.ts           # final seed/count assertion (count === 4)
```

`src/main/e2eSmoke.ts` is **deleted**; `src/main/index.ts:13` import switches from `./e2eSmoke` to
`./e2e`. `e2eReport.ts` (already extracted + unit-tested) is untouched. The renderer hook
(`smoke/e2eHooks.ts`, `smoke/e2eRegistry.ts`) is untouched — it's already the right shape.

> **Theme files group probe *functions*; the playlist in `index.ts` defines the *order*.** A theme
> file exports several named probes; `index.ts` imports them and lists them in the **exact current
> sequence** (which interleaves themes — e.g. `terminal` → `terminal-fullview` → `browser` → … ).
> Grouping ≠ reordering. This separation is the whole trick that keeps the load-bearing order intact
> while still giving readable per-theme files.

## The shared context

```ts
// context.ts
export interface E2EIds {
  termId?: string
  browserId?: string
  planId?: string
  deadId?: string
}

export interface E2ECtx {
  readonly win: BrowserWindow
  readonly localUrl: string
  // helpers (moved verbatim from e2eSmoke.ts)
  evalIn<T>(expr: string): Promise<T>
  poll(fn: () => Promise<boolean>, timeoutMs: number, stepMs?: number): Promise<boolean>
  delay(ms: number): Promise<void>
  // MAIN-side debug accessors (re-exported from ../preview + ../pty)
  readonly dbg: {
    terminalPid: typeof debugTerminalPid
    writeTerminal: typeof debugWriteTerminal
    captureView: typeof debugCaptureView
    viewIds: typeof debugViewIds
    viewWebContentsId: typeof debugViewWebContentsId
  }
  // shared sequential state — seed probes WRITE, later probes READ
  readonly ids: E2EIds
  // constants
  readonly TERM_SENTINEL: string
  readonly TERM_SENTINEL2: string
  readonly ADOPT_MARKER: string
  readonly DETECTED_URL: string
}
```

`makeContext(win, localUrl)` builds it once; `ids` is a mutable object the seed probes populate
(`ctx.ids.termId = await ctx.evalIn(...)`). Order guarantees a consumer's id is set before it runs.

## The probe contract

```ts
// types.ts
import type { E2EPart } from '../e2eReport'
export type { E2EPart }
export interface E2EProbe {
  /** stable name — used as the part name + the E2E_<NAME> log marker + playlist key */
  readonly name: string
  /** returns one part, or several when a block asserts multiple invariants
   *  (e.g. fullview-preview + fullview-preserve come from one block) */
  run(ctx: E2ECtx): Promise<E2EPart | E2EPart[]>
}
```

Each probe is a near-verbatim lift of its current block — same `evalIn`/`poll` calls, same timings,
same assertions, same `detail` strings — just (a) reading shared ids from `ctx.ids` instead of
closure locals, and (b) `return`ing its part(s) instead of `parts.push(...)`.

## The runner (`index.ts`)

```ts
const PLAYLIST: E2EProbe[] = [
  terminal, terminalFullview, browser, browserGesture, focusDetach, configNowheel,
  planning, fullviewPreview /* returns 2 parts */, fullviewSelfPreserve, fullviewEmulator,
  fullviewClose, terminalLod, terminalRespawn, terminalAdopt, browserDeadUrl,
  previewEdgeStale, duplicateKeepsLink, boardMenu, menuChrome, menuPreviewDetach,
  previewConnectGesture, tidy, tile, seed,
]  // EXACT current order — do not reorder

export async function runE2ESmoke(win, localUrl): Promise<number> {
  const ctx = makeContext(win, localUrl)
  const hookReady = await ctx.poll(() => ctx.evalIn('!!window.__canvasE2E'), 8000)
  if (!hookReady) {
    const s = summarizeE2E([{ name: 'hook', ok: false, detail: 'window.__canvasE2E never appeared' }])
    console.log(s.line); return s.exitCode
  }
  const parts: E2EPart[] = []
  for (const probe of PLAYLIST) {
    const r = await probe.run(ctx)
    parts.push(...(Array.isArray(r) ? r : [r]))
  }
  const summary = summarizeE2E(parts)
  for (const p of parts) console.log(`E2E_${p.name.toUpperCase()} ${JSON.stringify(p)}`)
  console.log(summary.line)
  return summary.exitCode
}
```

## Steps

1. **Branch** (done): `refactor/e2e-folder`. (Implementation should run on its own worktree per
   CLAUDE.md parallel-session rules; this branch currently holds the plan only.)
2. Create `e2e/types.ts` + `e2e/context.ts` (helpers + debug-accessor wiring + constants + ids bag).
3. Create the 8 `e2e/probes/*.ts`, lifting each block **verbatim** (only the two mechanical changes:
   read `ctx.ids`, `return` parts). One commit per theme file keeps the diff reviewable.
4. Create `e2e/index.ts` with the PLAYLIST (exact order) + `runE2ESmoke` + the hook preamble.
5. Update `src/main/index.ts:13` import `./e2eSmoke` → `./e2e`. Delete `src/main/e2eSmoke.ts`.
6. **Verify** (below). Commit.

## Verification (this is the gate — `e2e` is the real test)

- `pnpm typecheck` → clean (strict; no unused).
- `pnpm test` → **495** still green (unit suite is unaffected; `e2eReport.test.ts` unchanged).
- `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start` → **diff the `E2E_DONE` parts list against a
  pre-refactor capture** — same probe names, same order, same `ok`/`detail`. This is the
  acceptance criterion: identical markers in, identical markers out. (Per memory `e2e-before-handoff`:
  unit/typecheck green ≠ working — the e2e harness must pass before handoff.)
- Known env flake: the `browser` / `browser-gesture` / `focus-detach` / `preview-connect-gesture`
  trio can flake on a contended host (memory `e2e-browser-trio-flake`) — rerun for a clean pass; not
  a regression.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Order regression** — a probe runs before its id/state is ready | PLAYLIST preserves the exact current sequence; diff `E2E_DONE` parts order pre/post. |
| **Shared-state leak** — a mutation not restored (e.g. terminal width, link, count) | Lift blocks verbatim incl. their restore tails; the final `seed` (count===4) + `preview-connect-gesture`/`menu-chrome` width restores are unchanged. |
| **Lost constant** — `TERM_SENTINEL`/`2` go missing | Move to `context.ts`; only internal consumers (no external imports — verified). |
| **Import-path break** | Only external contract is `runE2ESmoke` (index.ts); keep the name + signature identical. |

## Out of scope (explicitly not doing now)

- True per-test isolation / re-seed-per-test.
- Converting any e2e probe to a vitest target (still needs the Electron runtime).
- Adding new probes or changing any assertion/timing.
- Touching the renderer hook surface (`__canvasE2E`) or `e2eReport.ts`.
```
