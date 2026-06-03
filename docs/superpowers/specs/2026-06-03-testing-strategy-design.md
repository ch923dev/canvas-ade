# Testing Strategy — design & roadmap

**Date:** 2026-06-03 · **Branch:** `testing-strategy` · **Status:** approved design, pre-plan
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
| Branch name | `testing-strategy` (renamed from `docs/testing-strategy`; PR #36 preserved) |
| Test model | Testing Trophy — mostly integration; thin e2e |
| E2E tooling | **Playwright `_electron`** (Spectron dead; WebdriverIO the alternative we did not pick) |
| First phase | **T1 — security-unit gap** (cheapest, highest-value, no new dep) |
| Sequencing | Standalone, start now; independent of MCP / Phase 5 |
| Roadmap shape | **Bottom-up trophy build** (low tier → high tier), one phase per branch/PR |

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

## Roadmap — 5 phases

Each phase = its own `test/*` branch + PR; full gate (typecheck · lint · format · unit) green after
each. The static tier (TypeScript strict + ESLint) is already gated and stays as the trophy base.

### T1 — Security-unit gap  *(the executable plan; first)*
**Goal:** raise the security floor at the fast tier — the highest-value, cheapest win, no new dep.

**Architecture note:** `src/main/index.ts` currently builds the `BrowserWindow` `webPreferences`
inline, which is not unit-testable. Extract a pure **window-options builder** (e.g.
`buildWindowOptions()` returning the `webPreferences` object) so the security invariants can be
asserted without constructing a window. This is the one production refactor T1 requires; it follows
the existing "one file = one purpose" convention.

**Work (decomposed):**
1. Extract a pure window-options builder from `index.ts`.
2. Unit-assert `webPreferences`: `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`.
3. Test `setWindowOpenHandler` denies in-app nav and routes externals to `shell.openExternal`.
4. IPC **sender-rejection** unit tests on `boardRegistry`, `projectIpc`, `mcp` (foreign sender → rejected).
5. Test the locked rule: Browser-board content cannot reach the PTY write channel.

**Exit / gate:** new unit tests green in CI; Electron security-checklist items **#3, #4, #13, #14,
#17, #20** each have a direct assertion. **New dep:** none.

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
tests. T1–T3 are pure-Vitest and run in the existing `check` job. T4 adds a Playwright job; T5
re-enables the `smoke` job as a gate. This supersedes the 2026-06-03 e2e freeze once T4/T5 land.

---

## Open questions (resolve in per-phase plans, not here)
- T2: `electron-mock-ipc` vs shared-interface substitution — decide in the T2 plan against the actual
  IPC channel shapes.
- T3: do any "sliver" behaviors (transform-hit-test, live-camera) genuinely need a real instance, or
  can a jsdom + transform-math test cover them? Decide per-probe during T3.
- T4: can node-pty's spawn roundtrip run in a Vitest `node` integration test cross-platform (native
  build matching the runner), letting `terminal` shrink further — or must it stay Playwright?
