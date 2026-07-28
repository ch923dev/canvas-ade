# Terminal clip-free fit — the `dataFlow` → `terminalClip` adjacency defect (2026-07-28)

**Status: OPEN — root-caused, reproducible, NOT fixed.** Found by PR #396, re-investigated and
narrowed in PR #397 (`fix/e2e-reliability`), which shipped the sibling `dataFlow` seed-race fix and
deliberately left this one rather than stack an unverified production change on a verified one.

**This is very likely a real user-facing bug, not only a test-isolation gap.** The e2e failure is the
messenger; the defect it exposes is in the terminal fit path.

---

## Symptom

`e2e/terminalClip.e2e.ts` › *the grid never spills past the well across a height sweep* fails with
**genuine bottom-row clipping** — measured overflow up to **12 px** against a ~6 px clipped-glyph
threshold — when `e2e/dataFlow.e2e.ts` runs immediately before it.

The full suite hides it: alphabetical ordering never puts the two files adjacent.

**Confirmed pre-existing.** PR #396 reproduced it on unmodified `main` by reverting every changed
file, so it predates both branches.

Reproduce (note: `pnpm test:e2e -- <specs>` does NOT forward the spec filter — pnpm swallows the
args and runs the whole suite; invoke Playwright directly):

```
pnpm build                       # or any prior `pnpm test:e2e` run's pretest build
pnpm exec playwright test dataFlow terminalClip --retries=0 --reporter=line
```

## Measurement — what actually differs

The sweep was instrumented to log geometry on **every** iteration (not just offenders) and run in
both configurations. `terminalGeometry` reports `dpr`, `rows`, `cols`, `cellHeight`, `gridBottom`,
`wellBottom`, `overflow`.

| config | h | rows | cellHeight | overflow | ⇒ well height |
|---|---|---|---|---|---|
| terminalClip **alone** | 226 | **9** | 18 | −16 | 162 + 16 = **178 px** |
| after **dataFlow** | 226 | **10** | 18 | **+2** | 180 − 2 = **178 px** |

The well is **178 px in both**. The cell renders **18 px in both**. `dpr` is 1 in both. The well grows
exactly +13 px per +13 px board step in both, so **zoom is 1 in both**.

`floor(178 / 18) = 9`. The paired run proposes **10**, and 10 × 18 = 180 > 178 — a one-row
over-proposal. The offenders form a clean sawtooth: overflow climbs +5 per step (18 − 13) until a
shed resets it.

The whole board also sits exactly **90 px higher** on screen in the paired run — `reset()`
deliberately does not reset the camera (`e2eHooks.ts` § step 4, and forcing `{0,0,1}` there was
tried and broke three specs). A pure translation cannot change a layout measurement, and the
identical well height above proves it did not. **The camera offset is a symptom of shared drift, not
the cause.**

## The two facts

1. **`FitAddon.proposeDimensions()` over-proposes by one row.** It divides the well's client height
   by xterm's *internal* cell metric, which is marginally **under** 18 px in the paired context while
   the DOM renders rows at exactly 18. A sub-pixel font-metric difference, off by one row.
   **The trigger for that drift is NOT yet identified** — see Ruled out.

2. **The shed loop that exists to absorb exactly this does not run.** `useTerminalSpawn.ts` (the
   `fitWhole` tail, "Compute the final row count in JS and call `term.resize` AT MOST ONCE"):

   ```js
   const cellH = grid.height / Math.max(1, term.rows)
   let overflow = grid.bottom - wellEl.getBoundingClientRect().bottom
   while (overflow > 1 && rows > 1) { rows -= 1; overflow -= cellH }
   ```

   With `cellH = 18`, an `overflow` of 12 becomes −6 in a single iteration. **A persisting overflow
   of 12 is proof this loop did not correct it.** Candidates, in order: the `getBoundingClientRect()`
   is read immediately after `fit.fit()` and sees a **stale pre-layout rect** (xterm's DOM renderer
   has not yet reflowed to the new row count); or the `if (!didFit) return` guard above it took the
   early exit; or `screenRef.current?.querySelector('.xterm-screen')` / `.closest('.nowheel')`
   resolved null and hit the guard `return`.

**Fact 2 is the defect. Fact 1 is only the trigger.** The metric drift is a legitimate sub-pixel
condition the shed loop was written to absorb; it is not absorbing it. Any real user resizing a
terminal board into an unlucky remainder can land the same clipped bottom row — no e2e involved.

## Ruled out (do not re-test these)

- **Timing / settle budget.** The sweep polls `overflow <= TOLERANCE` for 2000 ms per iteration and
  then reads the FINAL geometry. The overflow is still there afterwards, and nothing re-fits.
- **DPR.** `dpr: 1` in both configurations, every iteration.
- **Camera zoom.** The well grows exactly +13 px per +13 px board step in both ⇒ zoom = 1 in both.
- **Camera pan.** Real (90 px) but translation-invariant for `gridBottom − wellBottom`, and the well
  height is identical in both.
- **Mermaid injecting a global stylesheet.** `DiagramCard` calls `window.api.diagram.render(...)` —
  Mermaid runs in **MAIN** and returns SVG text displayed as an `<img>`. It injects nothing into the
  renderer document, so it cannot inherit-inflate xterm row height.
- **Sticky terminal font.** The spec writes `ca.terminal.fontSize` before seeding, and its
  `afterEach` restores it.

## Next steps

1. **Find the metric trigger.** Instrument xterm's internal cell metric
   (`term._core._renderService.dimensions.css.cell.height`) alongside the rendered height and diff
   alone-vs-paired. That single number identifies what `dataFlow` shifts.
2. **Fix the shed loop** so it cannot be defeated by a stale rect — most likely measure after a
   layout flush / on the next frame, and re-assert. This is the durable fix and it is production
   code.
3. **Verify across the terminal keep-set**, not just `terminalClip`: `terminalCrisp`,
   `terminalScrollback`, `terminalXterm6` all cover this fit path. Full matrix, both legs.

## Constraints carried forward

- The sweep steps (**13**, **23**) **must stay ODD** — an even step walks a fixed parity of
  remainders against `cellHeight` and silently drops the fractional-remainder coverage the sweep
  exists for. (#396's recon proposed 14/22, which would have gutted it.)
- **Poll budgets are free when green** — `expect.poll` returns the instant the predicate holds, so a
  long timeout costs wall-clock only on genuine failure. Never shrink one for speed.
