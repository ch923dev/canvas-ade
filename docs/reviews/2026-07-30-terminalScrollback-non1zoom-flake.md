# terminalScrollback NON-1-zoom flake — root cause (2026-07-30)

**Status: ROOT-CAUSED. Verdict: TEST-SIDE, disjoint from the terminal-clip defect. No production
change required — the product behaved exactly as designed at every step.**

Diagnosis lane: worktree `scrollback-flake` (`feat/scrollback-flake`, base `9cc12ee5` v0.42.1).
Kickoff: `KICKOFF-SCROLLBACK-FLAKE.md` (deleted in this PR per doc lifecycle). Production edits
were gated on the `terminal-clip` sibling landing; the verdict makes that gate moot for `src/**` —
this lane ships no production change at all.

---

## Symptom

`e2e/terminalScrollback.e2e.ts` › *every line survives a full-view round-trip at a NON-1 zoom*
fails when the spec runs after `dataFlow.e2e.ts`. Pre-existing on clean `main` (proven in the
PR #401 session: `e2e/` reverted to base, rebuilt, identical targeted run → base fails the same
test at its own `:244` — which is the **test declaration line**, not an assertion; Playwright's
line reporter cites the declaration).

## Failure rate — measured (this box, Windows, workers:1, retries:0)

| configuration | runs | failures |
|---|---|---|
| `terminalScrollback.e2e.ts` alone | 6 | **0** |
| paired: `playwright test dataFlow terminalScrollback` | 9 | **9** — same test, same assert, every run |

Not probabilistic in the paired configuration — **deterministic adjacency**. The full suite hides
it because alphabetical ordering rarely puts an ill-behaved camera predecessor directly before
this spec, and `retries:2` under the push gate absorbs the residue. (One paired run also dropped
`dataFlow.e2e.ts:11` — that is dataFlow's own documented ambient flake, unrelated.)

## The failing assertion

Not the markers assert. Not the font assert. Not anything in the refit path. Every failure is
`fillBuffer`'s **first gate**:

```
Error: shell exited (PTY drained — no further output)
```

— the `'process exited'` marker never appears in the terminal buffer within the 8s poll. The test
dies before any full-view / refit machinery runs.

## Forensics — identical on every reproduction

Instrumented failure branch (all values via existing `callE2E` hooks — `terminalMounted`,
`terminalLive`, `terminalHeldBytes`, `getViewport`, `getBoards`, `readTerminal`):

```
mounted: true            ← terminal mounted, xterm alive
live:    false           ← Lane-A liveness gate says HIDDEN
held:    401             ← 401 PTY bytes held by the write coalescer
vp:      {x:-1078, y:0.5, zoom:1.5}
win:     1264x781
board:   {x:0, y:0, w:420, h:340}
buf:     16 empty lines  ← nothing ever rendered into the buffer
```

`held=401 ∧ buf empty ∧ live=false` is the whole story: **the PTY spawned, ran `exit`, and emitted
its output** — the bytes sit in the Lane-A liveness hold (`useTerminalSpawn.ts` § render-liveness
gate: a hidden terminal's PTY data is HELD, not rendered; flushed losslessly on visibility). The
buffer the spec polls stays empty because the board is genuinely invisible.

Geometry check (the liveness gate is *correct*, not stale): visible world-x at
`vp={x:-1078, zoom:1.5}`, window 1264 wide = `[(0−(−1078))/1.5, (1264−(−1078))/1.5]` =
**[719, 1561]**. The board spans **[0, 420]** — fully off-screen, ~300 world-px left of the
viewport.

## The causal chain

1. **dataFlow leaves the camera panned right.** Each dataFlow test seeds TWO boards (`src`, then
   `df` — `seedBoard` advances a per-test x-cursor) and ends with `fitView(df)` — a fit on the
   **second**-seeded board. Measured parting camera: `{x:-508, y:130.5, zoom:1}`. This violates
   the documented cross-spec camera contract (`e2eHooks.ts` `reset()` step 4): the camera is
   *deliberately not reset* between tests, and *"what a spec owes the next one is a camera framed
   near x≈0 — fit the board you seeded FIRST, not one seeded to the right of it
   (swarmLedger.e2e.ts)"*.
2. **The scrollback spec's tests inherit that camera.** All three tests started at
   `{x:-508, y:130.5, zoom:1}` in the paired run (camera-forensics logging). Visible world-x at
   zoom 1: `[508, 1772]`.
   - Test 1's board is 520 wide → its right edge pokes 12 world-px into view → the liveness gate
     (any-intersection) keeps it live → passes. *(Arithmetic from the measured camera; the margin
     was not separately instrumented.)*
   - Test 2's board is 900 wide → comfortably intersects → passes.
   - **Test 3's board is the default 420×340 → `[0,420]` vs `[508,1772]` — off-screen already at
     zoom 1.**
3. **`setZoom(1.5)` widens the miss.** React Flow's `zoomTo` anchors the viewport center:
   `632 − ((632+508)×1.5) = −1078` — matching the forensic line exactly — and the visible world
   shrinks to `[719, 1561]`.
4. **The Lane-A liveness gate does its designed job.** Off-screen ⇒ hold PTY bytes, render
   nothing. The `'process exited'` marker never reaches the buffer; the 8s poll fails; the test
   dies before `setFullView` (which force-lives the board and would have flushed the hold).

Why it looked "NON-1-zoom": test 3 is the only test with a default-size (420-wide) board — the
only one narrower than dataFlow's 508px parting pan. The zoom worsens the geometry but is not the
essential trigger; the board size is.

Why alone-runs pass: fresh app starts at `{0,0,1}`; test 3 begins at `{x:372, zoom:1}` → post-zoom
visible world `[-161, 681]` ⊇ board.

## Verdict — test-side; disjoint from terminal-clip; no production defect

- **Disjoint from the terminal-clip defect** (`docs/reviews/2026-07-28-terminal-clip-adjacency.md`):
  that is a real production `fitWhole` row-shed failure measured on a *visible, rendering* board
  (overflow +2px with the shed loop not absorbing it). This flake never reaches the fit path at
  all. The two share only the *trigger source* — dataFlow's contract-violating parting camera (the
  clip investigation's "board sits 90 px higher" observation is the same leak; there it was a
  translation-invariant symptom, here the camera position is the cause).
- **Adversarial pass — why no production defect hides here:** the product's behavior at every
  step is deliberate and lossless. The liveness gate's verdict was *geometrically correct* (board
  ∩ viewport = ∅ — this is not a stale-flag bug, which WOULD have been production). The held
  bytes flush losslessly on visibility (Lane-A design, covered by `terminalLiveness.e2e.ts`), and
  the test's own later `setFullView` would have force-lived the board and flushed. No user-visible
  failure mode exists: a user cannot poll an invisible terminal's buffer; when they look at it (or
  maximise it), it catches up. The failure is the spec *assuming* a seeded board renders without
  ensuring it is in view.
- Instrumenting xterm's internal cell metric (the clip playbook's step) proved unnecessary — the
  failure is upstream of any font/metric machinery.

## Fix plan (Phase B — after `terminal-clip` merges; spec-side only)

1. **Harden `terminalScrollback.e2e.ts`:** after each test's `setZoom`, ensure the seeded board is
   in view (`fitCameraInstant(id)` — existing hook, instant, converges) before `fillBuffer`. Kills
   the flake regardless of predecessor behavior. Applies to all three tests (tests 1–2 pass today
   by 12px/392px of luck).
2. **Fix the contract violation in `dataFlow.e2e.ts`:** its tests should leave the camera framed
   per the reset() step-4 contract (fit `src`, the FIRST-seeded board, or `fitCameraInstant` it
   at teardown). Cross-zone edit — coordinated on ACTIVE-WORK (the terminal-clip lane also
   benefits: it removes their adjacency *trigger*, though their shed defect must still be fixed on
   its own merits).
3. Keep the Phase-A instrumentation (probe lines are cheap, run-forensic, and use only existing
   hooks through the #401 transport discipline) — or strip `logCamera`/`logProbe` to the failure
   branches only, reviewer's call.
4. Re-run the battery at `--retries=0` post-fix: expect paired 0/N.

Constraints honored: no poll timeout was shrunk; no retry/skip changes; all new probes go through
`callE2E`/`pollCall` (the one `evalIn` addition is a fixed-text literal, `window.innerWidth…`);
`useTerminalSpawn.ts` / `useTerminalReraster.ts` untouched (read-only).

## Reproduce

```
CANVAS_E2E=1 pnpm build   # flavored build — mainCall specs silent-fail on a plain build
pnpm exec playwright test dataFlow terminalScrollback --retries=0 --workers=1 --reporter=line
```

Fails `terminalScrollback.e2e.ts` › the NON-1-zoom test, every run, with the
`[scrollback-probe] fill:exit-marker-missing` forensic line above.
