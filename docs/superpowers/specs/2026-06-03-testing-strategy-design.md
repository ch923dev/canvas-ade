# Testing Strategy — design & roadmap

**Date:** 2026-06-03 · **Branch:** `testing-strategy` (single branch for the whole initiative; PR #37) · **Status:** T1 shipped; T0 (Testing Foundation) approved, pre-plan
**Research backing:** `docs/research/2026-06-03-testing-strategy.md` (deep-research, 24/24 claims verified)

---

## Goal

Move Canvas ADE's test suite to the **Testing Trophy** shape (mostly integration; thin, trustworthy
e2e). The finish line: the **brittle homegrown `CANVAS_SMOKE=e2e` harness is gone**, replaced by a
**Playwright `_electron`** e2e that is small enough to trust and **re-enabled as a CI gate**, while
the highest-value coverage (security boundaries, MAIN/IPC) is asserted at the fast unit/integration
tier instead of through full-app e2e.

This is **cross-cutting infrastructure**, not a product feature. It runs **standalone, starting
now** — independent of the MCP merge and Phase 5 packaging.

### Non-goals
- No rigid coverage quota. Trophy ratios (~80/15/5 or 70/20/10) are directional, not enforced.
- No unrelated refactoring. Touch production code only where needed to make a unit testable.
- **Never weaken the locked security model** to make a test convenient (see T4 constraint).

---

## Locked decisions (from brainstorming, 2026-06-03)

| Decision | Choice |
|---|---|
| Branch | **Single `testing-strategy` branch / PR #37 for the ENTIRE initiative.** No new branches per phase (decided 2026-06-03 — avoid branch sprawl + redundant settings). |
| Test model | Testing Trophy — mostly integration; thin e2e |
| Tiers (taxonomy) | **3 tiers: unit · integration · e2e** (+ static base). Component-render (jsdom) counts as **integration** (renders a real component tree). |
| Naming convention | `*.test.ts(x)` = unit · `*.integration.test.ts(x)` = integration · e2e = separate harness. `.ts`→node, `.tsx`→jsdom (preserved). |
| Runner | **Vitest projects** split unit vs integration (`test:unit` / `test:integration` / `test`). |
| E2E tooling | **Playwright `_electron`** (Spectron dead; WebdriverIO the alternative we did not pick) |
| Foundation | **T0 — Testing Foundation** (identity doc + taxonomy + split runner + classify/retrofit all files) is the base; built AFTER T1 shipped, and **retrofits T1** into the convention. |
| T1 fate | **Keep + retrofit** (T1 shipped + green; folded under T0's convention, not discarded). |
| Sequencing | Standalone, start now; independent of MCP / Phase 5 |
| Roadmap shape | **Bottom-up trophy build** (low tier → high tier); all phases land on the one branch. |

### Approaches considered
- **A — Bottom-up trophy build (CHOSEN):** security-units → IPC layer → push-down → Playwright →
  re-enable gate. Each phase independently shippable + gateable; every step leaves CI greener.
- **B — Tooling-first:** Playwright early, migrate onto it. Rejected — front-loads the new dep and
  biggest risk; defers the cheap security wins (conflicts with the "security-unit first" decision).
- **C — Big-bang restructure:** one large PR. Rejected — huge, risky, against the phase-by-phase
  cadence this repo uses.

---

## Current state (measured 2026-06-03)

| Layer | Files | Lines | Tests |
|---|---|---|---|
| Unit + integration (Vitest) | 46 | 6,522 | 602 |
| E2E (homegrown `CANVAS_SMOKE=e2e`) | 9 probes + harness | 2,253 | 9 probe areas |

Already ~3:1 unit-over-e2e by volume. The problems are **quality and placement**, not raw count:
the e2e harness is brittle (currently **FROZEN in CI**, not a gate), several probes **duplicate**
unit coverage, and security/MAIN files (`index.ts`, `localServer.ts`, `mcp.ts`) have **no fast test**.

### Per-probe disposition (drives T3 / T4)
| Probe | Disposition |
|---|---|
| `seed` | keep (harness scaffolding) → T4 |
| `terminal` | keep thin e2e (node-pty/ConPTY, native) → T4 |
| `browserPreview` | keep thin e2e (`WebContentsView`, no DOM) → T4 |
| `fullview` | keep thin e2e (portal relocation + native rebind, real input) → T4 |
| `whiteboard` | push down → T3 (logic already unit; keep only transform-hit-test-at-zoom) |
| `menu` | push down → T3 (`BoardMenu.test.tsx` jsdom already covers) |
| `layout` | push down → T3 (`tidyLayout`/`tileLayout`/`layoutPresets`/`cameraBounds` unit-tested) |
| `planning` | push down → T3 (component tests exist) |
| `previewLink` | push down → T3 (`portDetect`/`previewTarget`/`previewEdges` unit-tested) |

---

## Roadmap — T0 foundation + 5 phases

**All phases land on the single `testing-strategy` branch (PR #37)** — no per-phase branches. Full
gate (typecheck · lint · format · unit + integration) green after each. The static tier (TypeScript
strict + ESLint) is already gated and stays as the trophy base.

> **Build order note:** T1 shipped first (the cheapest security win) BEFORE the foundation existed.
> T0 now retrofits T1 + the whole suite into a deliberate structure. Going forward the foundation is
> the base; T2–T5 build on it.

### T0 — Testing Foundation (identity + structure)
**Goal:** give the suite an *identity* — a single source of truth for which tier a test belongs to,
a self-owned structure (naming + split runner) so we never rely on ad-hoc per-file convention, and a
one-time classification/retrofit of every existing file (incl. T1) to that convention.

**Components:**

1. **Identity doc — `docs/testing/TESTING.md`** (the constitution):
   - Model (Trophy) + the 3 tiers + static base.
   - **The decision rule** (core artifact): *pure logic / single function* → **unit** (`*.test.ts`);
     *renders a component tree (jsdom) OR wires multiple real units / IPC handlers / mocked electron*
     → **integration** (`*.integration.test.ts`); *needs the real booted app* (native
     `WebContentsView`, node-pty roundtrip, OS process-tree, auto-update, cross-platform) → **e2e**.
   - What each tier MAY touch (unit: pure / mocked collaborators; integration: real units +
     `electron-mock-ipc` / jsdom, **no app boot**; e2e: real instance, **MAIN-helpers only, sandbox
     never weakened**).
   - Security-checklist → tier map (#3/#4/#13/#14/#17/#20, from T1).
   - e2e keep-set policy (native + happy-path + update + cross-platform only) → links research + this roadmap.

2. **Naming + taxonomy convention** — `*.test.ts(x)` = unit · `*.integration.test.ts(x)` =
   integration · e2e separate. `.ts`→node, `.tsx`→jsdom preserved.

3. **Split runner — Vitest projects** (`vitest.config.ts` → projects):
   - `unit` project: `src/**/*.test.{ts,tsx}` EXCLUDING `*.integration.*`.
   - `integration` project: `src/**/*.integration.test.{ts,tsx}`.
   - Both keep `environment: 'node'` + `environmentMatchGlobs [['**/*.tsx','jsdom']]`, the `react`
     plugin, and the `@renderer` alias (no duplication — shared base).
   - Scripts: `test` (all projects) · `test:unit` · `test:integration`. CI `check` runs `test` (both).

4. **Classification + retrofit map** (audit all ~44 files; every file ends with an explicit tier):
   - **Split the mixed main files** — extract the IPC-handler/registration suites into
     `pty.integration.test.ts`, `preview.integration.test.ts`, `projectIpc.integration.test.ts`;
     the pure-function suites stay in the matching `*.test.ts`. **← this is the T1 retrofit** (T1's
     foreign-sender rejection suites move into the new `*.integration.test.ts` files).
   - **6 jsdom component files → `*.integration.test.tsx`**: `BoardMenu`, `ChecklistCard`,
     `ElementContextMenu`, `FreeText`, `ImageCard`, `NoteCard`.
   - `persistence.integration.test.ts` already correct. `windowSecurity.test.ts` = unit (stays).
     ~35 pure-function files stay `*.test.ts` (unit).

**Exit / gate:** `TESTING.md` committed; `vitest.config.ts` runs `unit` + `integration` projects;
every test file matches the naming convention for its tier; `test:unit` + `test:integration` both
green; total test count preserved (~633); typecheck + lint clean. **New dep:** none.

### T1 — Security-unit gap  ✅ SHIPPED (retrofitted under T0)
**Status:** DONE (commits `dd7284d`..`9728277`, PR #37). 633 tests green. Plan:
`docs/superpowers/plans/2026-06-03-testing-t1-security-unit-gap.md`.

**Goal (achieved):** raise the security floor at the fast tier — highest-value, cheapest win, no dep.

**Delivered:**
1. Extracted the main-window security surface from `index.ts` → pure `src/main/windowSecurity.ts`
   (`buildMainWindowWebPreferences` #3/#4, `windowOpenDecision` #14, `computeAppOrigin` + `navDecision`
   #13), unit-tested.
2. Foreign-sender **rejection** tests for **every guarded IPC handler** in `pty` / `preview` /
   `projectIpc` (#17; #20 / Browser↛PTY).

**Retrofit under T0:** the rejection suites move from `pty.test.ts` / `preview.test.ts` /
`projectIpc.test.ts` into `*.integration.test.ts`; `windowSecurity.test.ts` stays unit.

**Scope correction:** the original draft named `boardRegistry` / `mcp` — those files do **not** exist
on this branch (pre-MCP); their rejection tests are deferred to `feat/mcp-integration`. Electron
security-checklist items **#3/#4/#13/#14/#17/#20** each have a direct assertion. **Dep added:** none.

### T2 — IPC integration layer
**Goal:** make MAIN-process logic + IPC testable **without launching the app**.

**Work:** adopt **`electron-mock-ipc`** (drop-in `ipcMain`/`ipcRenderer` mocks, incl. `invoke`/`handle`)
*or* the shared-interface-substitution pattern (`electron-testable-ipc-proxy` style — one TS
interface across main/preload/test). Choose during the T2 plan; `electron-mock-ipc` is the lower-touch
default. Write one reference integration test per IPC channel pattern as the template for T3.

**Exit / gate:** IPC behavior covered at the integration tier with no Electron boot.
**New dep:** `electron-mock-ipc` (devDependency).

### T3 — Push-down migration
**Goal:** eliminate redundant e2e by moving probe coverage down a tier.

**Work:** migrate `whiteboard` / `menu` / `layout` / `planning` / `previewLink` probe coverage to
Vitest integration tests (jsdom + Testing Library, using the T2 IPC layer where MAIN is involved);
**delete** the migrated probe code. Retain only the irreducible slivers (transform-hit-testing at
zoom, live-camera settle, live native-arrow render) — fold those into the T4 keep-set if they truly
need a real instance.

**Exit / gate:** 5 probes removed; equivalent coverage exists at unit/integration tier; the homegrown
harness has shrunk to the keep-set. **New dep:** none.

### T4 — Playwright `_electron` harness
**Goal:** replace the brittle homegrown e2e with a maintained tool.

**Work:** stand up Playwright `_electron`; port the keep-set (`seed` + `terminal` + `browserPreview`
+ `fullview`); retire the `CANVAS_SMOKE=e2e` harness once parity is reached.

> 🔒 **Hard constraint (locked security model):** Playwright's / `electron-playwright-helpers`'
> **renderer-side** IPC helpers require `contextIsolation:false` + `nodeIntegration:true`, which
> **violates** this codebase's sandbox. Use **MAIN-process helpers only** (`ipcMainInvokeHandler`,
> `ipcMainEmit`). Never flip the sandbox to make a test pass.

Native-surface coverage handled here: node-pty spawn→echo roundtrip, `WebContentsView`
bounds/`capturePage` (bounds math already unit-tested in `cameraBounds`/`canvasView` — e2e only
confirms `setBounds`/`capturePage` fire and produce a non-blank frame). See
`docs/research/self-smoke-testing.md` for the MAIN-side `capturePage` pattern.

**Exit / gate:** keep-set runs green on Playwright; old harness + `CANVAS_SMOKE=e2e` code deleted.
**New dep:** `@playwright/test` (devDependency).

### T5 — Re-enable gate + auto-update e2e
**Goal:** trustworthy e2e back as a CI gate; cover the genuinely-e2e-only surfaces.

**Work:** remove `if: false` from the `smoke` job in `.github/workflows/pr.yml` and `staging.yml`;
add a **process-tree-kill** cross-platform check; add an **auto-update** e2e **when Phase 5
packaging/electron-updater exists** (this is the one cross-link to Phase 5 — auto-update can't be
tested before packaging lands).

**Exit / gate:** e2e is a green, trusted CI gate again; the update flow is covered once packaging exists.
**New dep:** none.

---

## Testing of this work (meta)

Each phase adds the tests it describes; the phase is done only when CI is green including the new
tests. After **T0**, the `check` job runs the Vitest **`unit` + `integration` projects** (one
command, `pnpm test`, runs both). T0–T3 are pure-Vitest. T4 adds a Playwright job; T5 re-enables the
`smoke` job as a gate. This supersedes the 2026-06-03 e2e freeze once T4/T5 land. All phases share the
single `testing-strategy` branch / PR #37 — no per-phase branches, no duplicated runner config.

---

## Open questions (resolve in per-phase plans, not here)
- T2: `electron-mock-ipc` vs shared-interface substitution — decide in the T2 plan against the actual
  IPC channel shapes.
- T3: do any "sliver" behaviors (transform-hit-test, live-camera) genuinely need a real instance, or
  can a jsdom + transform-math test cover them? Decide per-probe during T3.
- T4: can node-pty's spawn roundtrip run in a Vitest `node` integration test cross-platform (native
  build matching the runner), letting `terminal` shrink further — or must it stay Playwright?
