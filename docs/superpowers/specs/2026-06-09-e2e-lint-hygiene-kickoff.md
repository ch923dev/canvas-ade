# Kickoff — e2e + lint hygiene (two main-side loose ends)

**Date:** 2026-06-09 · **Type:** kickoff brief (not a spec — next session runs brainstorming → spec → plan)
**Where:** a NEW `fix/*` branch off latest `main` (do NOT do this on a feature branch; it's
cross-cutting repo hygiene). This doc is intentionally **untracked** on `main` until that branch
commits it. **No worktree/PR created by the kickoff session** — the implementing session does that.

Both items surfaced while landing the `feat/text-create-edit-ux` slice (text create/edit UX). Neither
is caused by that slice — they are pre-existing on `main`. Memory: `e2e-terminalio-selection-flake`.

---

## Loose end 1 — `terminalIO:117` cross-spec e2e flake (the important one)

**Symptom.** `e2e/terminalIO.e2e.ts:117` — *"terminal I/O › drag-select tracks the cursor at zoom ≠ 1
(scale-correct selection)"* — fails in the FULL Windows e2e suite with `Error: selection was ""` (the
xterm drag-select yields an empty selection). The assertion is `expect(sel.startsWith('ABCDEFGHIJ'))`.

**Proven pre-existing + cross-spec.**
- Passes in **isolation**: `pnpm test:e2e -g "scale-correct selection"` → 1 passed.
- Fails in the **full suite** on clean `main` @ `27e5f44` (origin/main) WITHOUT any feature branch:
  2 failed / 47 passed (the failing set varies run-to-run → timing-dependent leak).
- Failed **3 consecutive** `pnpm test:e2e:matrix` runs on the feature worktree (50 passed / 1 failed
  each), always this same test. A "retry once" did not clear it.
- Playwright runs 1 worker, specs alphabetical → `terminalIO` sorts before `textCreate`/`textToolbar`,
  so the leak comes from a spec that runs BEFORE it (browser/focus family — cf. the known
  `e2e-browser-trio-flake`), NOT from anything text-related.

**Impact.** The **pre-push hook runs the matrix** (`.githooks/pre-push` → `pnpm test:e2e:matrix`), so
this red **forces `git push --no-verify` on every branch**. It erodes the gate and hides real
regressions. Also: the matrix is `pnpm test:e2e && pnpm test:e2e:linux`; the Windows leg failing FIRST
short-circuits the `&&`, so **the Linux Docker leg never runs** — a matrix red here tells you nothing
about Linux.

**Diagnosis-first (do this before fixing).**
1. Reproduce: `pnpm test:e2e` (full Windows leg) on clean `main` → confirm `terminalIO:117` red.
2. Bisect the leaking predecessor: run `terminalIO` after each candidate earlier spec
   (`pnpm exec playwright test <predecessor>.e2e.ts terminalIO.e2e.ts --workers=1`) until the empty
   selection reproduces with a single predecessor. Strong suspects: `browser*`/`focus-detach`
   (window-focus / native-view state) — same class as `e2e-browser-trio-flake`.
3. Inspect the failure trace/screenshot (the run already drops them under
   `test-results/terminalIO.e2e.ts-…/attachments/`): is the terminal not focused, is the drag landing
   off the grid, or is the prior spec's WebContentsView/clipboard state bleeding in?

**Fix options (pick the smallest reliable one — confirm with `retries:0`, no masking).**
- **(a) Re-establish state in `terminalIO`'s setup:** a `beforeEach` (or in-test guard) that focuses the
  terminal board + clears any selection/clipboard before the drag, so it doesn't inherit dirty focus.
- **(b) Fix the leaking spec's teardown:** whatever predecessor leaks focus/native-view/clipboard,
  restore it in an `afterEach`.
- **(c) Playwright project/worker isolation:** put the terminal specs in their own project so they don't
  share a worker with the leaker (heavier; last resort).

**Acceptance.**
- `pnpm test:e2e` (full Windows) green **3× consecutive**, `retries:0` (no flake masking).
- The Linux leg is **reached** (Windows passes) and green: `pnpm test:e2e:matrix` fully green.
- `terminalIO:117` still passes in isolation.
- Update memory `e2e-terminalio-selection-flake` → resolved (or refine if the root cause differs).

---

## Loose end 2 — eslint-10 lints generated Playwright artifacts (local-DX paper cut)

**Symptom.** After the eslint 9→10 bump (dependabot #78, on `main`), `pnpm lint` (= `eslint .`) reports
**thousands of errors** in `playwright-report/**` and `test-results/**` (generated minified bundles,
e.g. `playwright-report/trace/assets/*.js`) whenever those dirs exist locally — i.e. after any e2e run.
Observed: **3935 errors**, all in generated files; deleting the two gitignored dirs returns lint to
0 errors. eslint 10 dropped `.eslintignore` support, and the flat `eslint.config.mjs` `ignores` array
does not list these generated dirs.

**Impact.** Local `pnpm lint` is unusable after running e2e (must `rm -r playwright-report test-results`
first). CI is unaffected (clean checkout has no artifacts), so it's local-only — but a real foot-gun
that can mask or drown the 3 real warnings.

**Fix.** In `eslint.config.mjs`, add to the global `ignores`:
```js
ignores: [ /* …existing… */, 'playwright-report/**', 'test-results/**' ]
```
Confirm `out/**`, `release/**`, `dist/**`, `coverage/**` are already ignored (build output must be, or
lint would have flagged it pre-bump) — add any that are missing. If a stale `.eslintignore` exists,
migrate its entries into the flat `ignores` (eslint 10 ignores the file).

**Acceptance.** Run an e2e (so the dirs exist), then `pnpm lint` → **0 errors** (only the 3 pre-existing
`Canvas.tsx` react-refresh warnings). `pnpm format:check` clean. CI `check` job still green.

---

## Suggested shape

One small PR off `main`: `chore(e2e): fix terminalIO cross-spec selection flake + eslint-10 ignores`.
Item 2 is a ~2-line config change (do it first, fast win). Item 1 is the real work (diagnose → minimal
fix → 3× green). Full gate + `pnpm test:e2e:matrix` must be green (both legs) before merge — this PR is
the one that EARNS back the clean matrix gate, so it must not itself use `--no-verify`.
