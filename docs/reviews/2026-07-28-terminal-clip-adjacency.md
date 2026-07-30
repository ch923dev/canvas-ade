# Terminal clip-free fit — the `dataFlow` → `terminalClip` adjacency defect (2026-07-28)

**Status: FIXED (2026-07-30, `fix/terminal-clip`).** Found by PR #396, narrowed in PR #398, fixed by
the terminal-clip lane. The full investigation (symptom, measurement tables, the ruled-out list) is
this file's git history — `git log --all --oneline -- docs/reviews/2026-07-28-terminal-clip-adjacency.md`.

## The defect (as root-caused, with the investigation's hypothesis corrected)

`e2e/terminalClip.e2e.ts` failed with genuine bottom-row clipping (up to 12 px) when `dataFlow` ran
immediately before it — and the same sequence was reachable by a real user resizing a terminal
board into an unlucky height remainder on a busy canvas.

Per-fit instrumentation inside `fitWhole` (shed-time rect + xterm's internal cell metric + 1-frame /
2-frame deferred re-measures, alone vs paired) settled the two open questions:

- **The investigation's "sub-pixel cell-metric drift" hypothesis was REFUTED.** xterm's internal
  `dimensions.css.cell.height` read 18.0 px in BOTH configurations, every fit. `FitAddon`'s one-row
  over-proposal is the codebase's long-known padding blindness (the reason the shed loop exists),
  not a paired-run drift.
- **The real differential: xterm's DOM renderer applies a row-count change asynchronously under
  load.** Alone, the rect measured right after `fit.fit()` already renders the new row count (the
  shed loop fired and corrected every over-proposal — sync path healthy). Paired, the reflow landed
  **1–2 frames after** `term.resize`: the same-tick rect still showed the pre-fit grid (tell:
  measured `cellH = 162 px / 10 rows = 16.2`), so the shed read a clean — even negative — overflow
  and correctly did nothing; the real +2 px spill materialized after `fitWhole` returned, and
  nothing re-measured. Suspect A (stale pre-layout rect) confirmed; the `!didFit` early exit and the
  null-element guard were both refuted by the same capture.

## The fix

- `terminalClipVerify.ts` (new): after every fit, a **coalesced clip-verify watch window** — six
  rAF ticks re-measuring the rendered grid against the clipping well, shedding any REAL overflow
  that appears. Two load-bearing properties: it never early-exits on a clean read (a stale rect
  READS clean — only the frame budget ends the chain), and corrections are rows-only (lossless, no
  S2-backstop involvement). Unit-tested with a fake rAF (mid-window materialization, no-early-exit,
  coalescing, disposed-term / backstop-in-flight / portal-hop guards).
- `shedTargetRows` extracted to `terminalSpawnMath.ts` (shared by the synchronous shed and the
  chain; pure, unit-tested) and `measureClipGeometry` shared so both passes measure the identical
  grid-vs-well contract the e2e probe reads.

## Verification

- The explicit `dataFlow terminalClip` pair at `--retries=0`: the sweep test **8/8 green** across
  repeated runs (baseline on the same tree: fails). One `stays clip-free across font sizes` flake
  on the first run after a fresh build only (warmup class; 7/8 runs fully green, and the chain can
  only shrink the grid — it cannot create a clip).
- Terminal keep-set (`terminalCrisp` · `terminalScrollback` · `terminalXterm6` · `terminalClip`)
  re-run locally; full matrix at the merge gate.

## Constraints carried forward (still live for future edits)

- The sweep steps (**13**, **23**) **must stay ODD** — an even step walks a fixed parity of
  remainders against `cellHeight` and silently drops the fractional-remainder coverage.
- **Poll budgets are free when green** — never shrink an `expect.poll` timeout for speed.
