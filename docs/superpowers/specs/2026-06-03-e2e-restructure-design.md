# E2E harness restructure — per-group fixtures + P0 gate-correctness

**Status:** design (approved 2026-06-03)
**Branch:** `feat/e2e-hardening`
**Builds on:** [`docs/research/electron-e2e-testing.md`](../../research/electron-e2e-testing.md) (deep-research landscape + gap analysis + P0/P1/P2 plan)

## Goal

Restructure the in-process `CANVAS_SMOKE=e2e` harness so it is **maintainable first** — kill
the load-bearing probe order and the shared mutable `ids` bag — and fold in the **P0
gate-correctness** fixes (real `sendInputEvent` input + capturePage flake quarantine) while the
probe bodies are already open. Coverage breadth (whiteboard tools, on-disk persistence,
responsive reflow, cap-4, error paths) is **out of scope for this pass** — but the new structure
makes each gap a drop-in, captured by the coverage matrix in §8.

Decision: **restructure first, then cover** (user, 2026-06-03). Playwright Stage-2 (`P1-4`) stays
deferred — this pass is in-process only.

## Problem (today)

`src/main/e2e/index.ts` runs a flat `PLAYLIST` of 24 probes in a **fixed, load-bearing order**.
Probes thread a single mutable `ctx.ids` bag (`termId`/`browserId`/`planId`/`deadId`/`browserOk`)
and **undo each other's mutations** — `menu-chrome` shrinks the terminal, `preview-connect-gesture`
widens it back, the final `seed` probe asserts the count returned to 4. A failure or reorder
mid-playlist leaves dirty state that cascades into false downstream failures. (Research gap #7.)

Two P0 correctness holes ride along:
- **Synthetic input (gap #1).** `webContents.sendInputEvent` is used nowhere; every simulated
  interaction is `dispatchEvent`/`click` via `executeJavaScript`, which bypasses CSS-transform
  hit-testing and can false-green on the scaled canvas (memory `e2e-sendinputevent-vs-dispatchevent`
  — a real full-view add-note bug three synthetic probes missed).
- **Flake has no quarantine (gap #2).** The `browser`/`browser-gesture`/`focus-detach`
  capturePage trio (memory `e2e-browser-trio-flake`) fails the whole run on a known env flake — no
  retry, no soft-fail; CI red-lights on a non-regression.

## Architecture

### Group model

Replace the flat `PLAYLIST` + mutable `ids` bag with **fixture-grouped probes**.

```ts
// src/main/e2e/types.ts (extended)
export interface GroupProbe<F> {
  readonly name: string
  run(ctx: E2ECtx, fixture: F): Promise<E2EPart | E2EPart[]>
}

export interface E2EGroup<F = unknown> {
  readonly name: string
  setup(ctx: E2ECtx): Promise<F>          // seed boards, return a TYPED fixture handle
  readonly probes: GroupProbe<F>[]         // each receives the fixture — no global bag
  teardown(ctx: E2ECtx, fixture: F): Promise<void> // clear to empty canvas
}
```

The typed fixture handle replaces the global `ids` bag. Each group seeds exactly the boards it
needs and hands probes a typed object (e.g. `{ termId }`, `{ browserId, termId }`).

### Runner

`runE2ESmoke` iterates **groups** instead of a flat list:

```
for each group:
  fixture = await group.setup(ctx)
  baseline = ctx.evalIn('getBoards().length')        // fixture invariant baseline
  for each probe in group.probes:
    parts.push(...await probe.run(ctx, fixture))
    assertFixtureIntact(ctx, baseline)               // reset model C — guard rail
  await group.teardown(ctx, fixture)                 // clearAllBoards → empty canvas
```

Groups are reorderable (each teardown returns the canvas to empty, so groups cannot leak into one
another). The hook-ready poll (`window.__canvasE2E`, 8 s) and the final `summarizeE2E` →
`process.exitCode` flow are unchanged.

### Reset model — C (self-restoring probes + runner invariant guard)

Within a group, probes **share** the fixture (that is the point). To make within-group order
**not** load-bearing for correctness:

- Probes must leave the fixture usable for the next probe. Most already do (zoom/fit/capture/
  open-popover are non-destructive). The few destructive ones (`terminal-adopt` = delete+undo)
  already self-heal by design.
- Between probes the runner asserts the **fixture invariant** — the fixture's board ids are still
  present and `getBoards().length === baseline`. A violation **hard-fails the group** with a clear
  marker (`E2E_<GROUP>_FIXTURE_BROKEN`) instead of silently cascading.

This turns the old *implicit* "order restores the count" magic into an *explicit* guard rail with
no snapshot/restore machinery. (Alternatives weighed: **A** probe-local try/finally cleanup —
discipline-only, no guard; **B** runner-enforced board-graph snapshot/restore — half the machinery,
but live PTY/view state can't be snapshot-restored so destructive probes still self-heal anyway.
**C** is the cheapest that still catches coupling regressions.)

### Groups (taxonomy)

Six groups. Fixtures are typed; no shared bag. Cross-board probes get a composite fixture rather
than being forced into a single-type box.

| Group | Fixture | Probes |
|---|---|---|
| `terminal` | 1 terminal (sentinel launchCommand) | `terminal` · `config-nowheel` · `terminal-lod` · `terminal-respawn` · `terminal-adopt` · `terminal-fullview` · `fullview-close` |
| `browser` | 1 browser @ localServer | `browser` (attach+capture) · `browser-gesture` · `browser-deadurl` (seeds its own dead board, removes it) · `fullview-preview` · `fullview-self-preserve` · `fullview-emulator` |
| `crossBoard` | terminal + browser | `focus-detach` · `preview-edge-stale` · `duplicate-keeps-link` · `preview-connect-gesture` · `menu-preview-detach` |
| `planning` | 1 planning | `planning` (checklist + round-trip) |
| `menu` | 1 board | `board-menu` · `menu-chrome` |
| `layout` | several boards | `tidy` · `tile` |

Probe→group assignment preserves every current assertion; only the wiring changes (fixture in,
global bag out). `duplicate-keeps-link` and `preview-connect-gesture` move from the `terminal`/
flat list into `crossBoard` because they need both boards live — making the dependency explicit
instead of relying on seed order.

### New renderer-hook primitives

`src/renderer/src/smoke/e2eHooks.ts` (`window.__canvasE2E`) gains:

- **`clearAllBoards(): void`** — remove every board (parking terminals first, same as
  `deleteBoard`) and **reset the `seedX` cursor to 0** so the next group seeds from a clean origin.
  Used by every `teardown`. This is the single missing teardown primitive today.

The fixture invariant read reuses the existing `getBoards()`. No other hook additions are needed
for the restructure.

## P0 fold-in

### Real input (`sendInputEvent`)

Add to `E2ECtx` (`context.ts`):

- **`realClickSelector(selector: string): Promise<boolean>`** — resolve the element's
  `getBoundingClientRect()` in the renderer, compute its viewport-center screen coords, and drive
  `win.webContents.sendInputEvent` `mouseDown`+`mouseUp` at those coords. Returns `false` if the
  selector misses. Gated behind a focus-readiness check (`win.focus()` + a `poll` on
  `document.hasFocus()`), **not** a sleep — `sendInputEvent` requires window focus.
- **`realKey(key: string): Promise<void>`** — `keyDown`/`char`/`keyUp` via `sendInputEvent` for
  the full-view Escape path.

Convert these transform-sensitive probes off synthetic `dispatchEvent`/`click`:
- `menu.ts` Duplicate/Delete clicks (~lines 36/46).
- `previewLink.ts` globe-gesture `MouseEvent`s (~121–149).
- `fullview.ts` Escape `KeyboardEvent` (~202).

Coordinate math reuses the well-rect × camera-scale technique (memory `e2e-whiteboard-probes`).
Caveat carried forward (memory `e2e-modifier-keys-synthetic`): `sendInputEvent` mouse `modifiers`
do **not** reach `e.altKey`/`e.shiftKey` — any modifier-gesture probe stays on synthetic
`PointerEvent` flags. None of the three converted probes use modifiers, so all three convert
cleanly; this is a documented boundary for future probes, not a blocker here.

### Flake quarantine

- `E2EPart` (`e2eReport.ts`) gains optional **`flaky?: boolean`**.
- `summarizeE2E` change: a failing part with `flaky === true` is reported (its marker still prints
  with `ok:false, flaky:true`) but **does not** flip `exitCode` to 1. `ok` for the run =
  `parts.length > 0 && every part (ok || flaky)`. Empty parts still = failure.
- The three capturePage probes (`browser`, `browser-gesture`, `focus-detach`) get a **bounded
  in-probe retry** (capture → readiness poll → re-capture, up to 3 attempts) before emitting; on
  persistent fail they emit `flaky: true`. (memory `e2e-browser-trio-flake` proves it is an env
  capturePage flake, not a regression.)

CI (`build.yml`) gate stays exit-code-driven; the flaky downgrade means a clean env still goes
green and the known trio can no longer red-light a non-regression. (P0-3 — making `package` depend
on `smoke` — is **not** in this pass; it is a one-line CI follow-up tracked in the research plan.)

## Drop

The `seed` final-count probe (`probes/seed.ts`) is removed — its job (assert the canvas returned
to a known board count) is subsumed by per-group `teardown` to empty plus one end-of-run assertion
that the canvas is empty after the last group's teardown (`E2E_CANVAS_EMPTY`).

## Output / CI compatibility

- Per-part markers stay `E2E_<NAME> {json}` + a final `E2E_DONE` summary, so CI grep and the
  documented baseline survive. Part **names are unchanged** (e.g. `terminal-adopt` stays
  `terminal-adopt`); only their grouping in source changes.
- New markers: `E2E_<GROUP>_FIXTURE_BROKEN` (invariant violation) and `E2E_CANVAS_EMPTY` (end
  state). Net `E2E_*` count: the 25 existing part markers minus `seed` (24) plus
  `E2E_CANVAS_EMPTY` (25), unchanged in total — update the "25/25" baseline note only if the
  flaky-soft-fail path changes the count on a flaky run.

## Testing

- `e2eReport.test.ts` extends to cover the new `flaky` soft-fail bucket: a flaky-failing part does
  not flip `exitCode`; a hard-failing part still does; empty parts still fail.
- The harness itself is verified by **running** it (`pnpm build; CANVAS_SMOKE=e2e pnpm start`),
  not a vitest target — the existing contract. Acceptance: every group sets up, runs its probes,
  and tears down to empty; the run exits 0 on a clean host; the capturePage trio soft-fails (not
  hard) when the env flake fires.
- No regression in unit gate (typecheck + lint + format + 502 tests).

## Risks

- **Per-group teardown cost.** Tearing down and re-seeding a terminal (real PTY) or browser
  (real `WebContentsView`) per group adds spawn/close cycles vs the current single-seed. Mitigated
  by grouping (seed once per group, not per probe) and by keeping the group count at 6. Watch total
  runtime; if it regresses badly, merge `terminal`+`crossBoard` fixtures (the crossBoard group can
  reuse the terminal rather than re-seed).
- **`clearAllBoards` + park races.** Terminals must be parked/killed before removal (mirror
  `deleteBoard`) or teardown leaks a PTY. Reuse the existing park path; assert no live terminals
  remain after teardown in the `terminal`/`crossBoard` groups.
- **Fixture invariant false-positives.** A legitimately board-count-changing probe (none today
  within a group after `duplicate-keeps-link` self-cleans) would trip the guard. The guard asserts
  against each group's own baseline, and any probe that intentionally adds/removes must restore
  before returning — documented in the probe contract.

## Coverage matrix (the "then cover" follow-up — NOT this pass)

Each remaining research gap maps to a target group; the new structure makes each a drop-in probe.

| Gap (research §5) | Target group | New probe(s) |
|---|---|---|
| #5 whiteboard breadth | `planning` | notes · text · arrows · freehand-pen · eraser · marquee-select · shortcuts (memory `e2e-whiteboard-probes`) |
| #3 responsive reflow | `browser` | assert `setBounds` width + `setZoomFactor` (incl. 0.25 floor) per `W∈{390,834,1280}` |
| #4 cap-4 / LOD lifecycle | new `previewLifecycle` | seed >4 browsers → assert over-cap close + recreate-on-demand |
| #6 on-disk persistence | new `persistence` | temp project dir → autosave → `canvas.json` parses → `.bak` fallback → migration → blur/quit flush |
| #9 negative/security | new `negative` | PTY spawn-fail · localServer bind-fail degrade · refused-then-recovered reconnect · deep-tree kill · `setWindowOpenHandler` deny-nav |
| #8 fixed-delay flake | all | audit `ctx.delay(...)` settles → `poll()` on readiness |

## Out of scope

- Playwright `_electron` Stage-2 (`P1-4`).
- CI `package needs: smoke` (`P0-3`) — one-line follow-up.
- macOS/Linux runtime smoke leg (`P2-4`).
- All coverage-matrix probes (next pass).
