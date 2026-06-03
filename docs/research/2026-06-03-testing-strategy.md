# Testing strategy — Electron desktop (research + Canvas ADE migration map)

**Date:** 2026-06-03 · **Status:** research, drives a future test-restructure feature ·
**Method:** deep-research workflow (6 angles, 16 sources, 68 claims → 25 verified, 24 confirmed /
1 killed, 3-vote adversarial) + measured audit of this repo's current test files.

> One-line verdict: this codebase is **not** raw-volume e2e-heavy (≈3:1 unit-over-e2e by lines),
> but its e2e is a **brittle homegrown harness** that **duplicates** lower-tier coverage and leaves
> **security/MAIN surfaces under-tested at the fast tier**. Fix is the **Testing Trophy**: thicken
> integration, push redundant probes down to Vitest, keep a *thin* real-instance e2e for the
> native + happy-path + security + cross-platform surfaces only.

---

## 1. The model — Trophy, not Pyramid (for JS/Electron)

Kent C. Dodds' **Testing Trophy** ("Write tests. Not too many. Mostly integration.") is the right
fit for a JS/TS/React/Electron app — **integration is the largest effort tier**, not unit. The
traditional unit-heavy pyramid claim was the *one claim the research killed* (refuted 1-2).

Tiers top→bottom: **E2E · Integration · Unit · Static**. Guiding principle (verified, high
confidence): *"the more your tests resemble the way the software is used, the more confidence they
give"* — but higher tiers cost more and run slower, so integration is the **confidence-per-cost
sweet spot** and e2e stays thin. Tiers are distinguished by mocking: unit mocks collaborators,
integration exercises multiple real units together, e2e mocks as little as possible.

**Distribution (directional, not gospel):** an Electron-specific guide prescribes **~80% unit /
~15% integration / ~5% e2e**; 70/20/10 is also cited. The Trophy itself disputes rigid percentages
(Searls: "a distraction"). Treat ratios as direction, not a quota.

Static counts too: **TypeScript strict + ESLint = the base of the trophy** — already in place here
(`tsc` strict, `eslint`). Free bug-catching tier; keep it green as a gate.

---

## 2. What belongs in e2e — and what does NOT

E2E is for **user-facing critical workflows** only. Verified SHOULD / SHOULD-NOT lists:

**E2E SHOULD cover (thin set):**
- Core feature **happy path** (app boots → seed each board type → renders).
- **Critical business workflows** (create/open project → boards persist → reopen fidelity).
- **Settings / state persistence** across restart.
- **Auto-update flow** (electron-updater) — high-value, fragile, not unit-testable.
- **Security boundaries** end-to-end sanity (see §5) and **cross-platform / OS-specific** behavior
  (process-tree kill, ConPTY) that only a real OS exercises.

**E2E SHOULD NOT cover (push down):**
- Edge cases → integration or unit.
- Validation / business logic → unit.
- *Every* possible user path → unit/integration.
- Styling / visual detail → component/visual tests.

> Anything resolvable in a fast unit/integration test is **redundant** as e2e: same coverage,
> slower, flakier, higher maintenance. That redundancy is exactly this repo's problem (§6).

---

## 3. Test MAIN / preload / IPC **without** launching the app

Verified pattern (high confidence): you do **not** need a full Electron boot to test IPC.

- **Shared-interface substitution** — one TS interface `T` shared across main / preload / test;
  swap the implementation per context (`electron-testable-ipc-proxy`: `setupForMain` real impl /
  `setupForPreload` contextBridge proxy / `setupForTest` injects mocks). Test-time, no Electron.
- **Drop-in IPC mocks** — `electron-mock-ipc` gives `ipcMain`/`ipcRenderer` mocks that talk to each
  other (incl. `invoke`/`handle`) **without changing production code**. Also `electron-mocks`.
- **VS Code confirms the desktop pattern**: its primary tests are *integration* tests run **inside a
  real instance** (Extension Development Host) with full API access — distinct from unit tests that
  need no instance. Real desktop apps center on integration-in-real-instance, not maximal e2e.

Implication: most of what our `CANVAS_SMOKE=e2e` harness drives through a real Electron boot can run
as **Vitest integration tests** with mocked IPC + jsdom component rendering.

---

## 4. Tooling

| Tier | Tool | Notes |
|---|---|---|
| Static | TypeScript strict + ESLint | already gated here |
| Unit + integration | **Vitest** (+ Testing Library, jsdom) | already here — 602 tests, 46 files |
| IPC integration | `electron-mock-ipc` / shared-interface proxy | **not yet adopted** — the gap |
| E2E (thin) | **Playwright `_electron`** or **WebdriverIO `@wdio/electron-service`** | Spectron is dead |

- **Spectron is deprecated (2022-02-01, archived)** — do not adopt. Electron officially recommends
  **Playwright** and **WebdriverIO**; Electron maintains no first-party e2e tool.
- Playwright `_electron` / `ElectronApplication` supports multi-window + **MAIN-process IPC** across
  the process boundary (`ipcMainInvokeHandler`, `ipcMainEmit`).

> 🔒 **Repo-critical constraint:** Playwright's / `electron-playwright-helpers`' **renderer-side**
> IPC helpers require `contextIsolation:false` + `nodeIntegration:true` — which **violates this
> codebase's locked security model** (CLAUDE.md "never weaken"). If we adopt Playwright `_electron`,
> use **only MAIN-process helpers**; never flip the sandbox to make a test convenient.

---

## 5. Security boundaries are an *enumerable, testable* set

Electron's official **20-item security checklist** turns "security" into concrete assertions that
belong at the **unit/integration** tier, not broad e2e. High-value items to assert directly:

- #3 **Context isolation enabled**, #4 **sandbox enabled** — assert on the `BrowserWindow`
  `webPreferences` we construct in `src/main/index.ts`.
- #17 **Validate the sender of every IPC message** — we already do this (`isForeignSender` /
  frame-guard pattern in `boardRegistry.ts`, `projectIpc.ts`); **add direct unit tests** that a
  foreign sender is rejected.
- #13/#14 **navigation + new-window limits** — assert `setWindowOpenHandler` denies in-app nav /
  routes externals to `shell.openExternal`.
- #20 **no Electron APIs to untrusted content** — assert Browser-board content can't reach the PTY
  write channel (our locked rule).

These are cheap, fast, and far more reliable than asserting security through a full e2e.

---

## 6. Canvas ADE — current state (measured 2026-06-03)

| Layer | Files | Lines | Tests |
|---|---|---|---|
| Unit + integration (Vitest) | 46 | 6,522 | 602 |
| E2E (custom `CANVAS_SMOKE=e2e` harness) | 9 probes + harness | 2,253 | 9 probe areas |

**So volume is already ~3:1 unit-over-e2e.** The real issues:

1. **E2E is a brittle homegrown harness, not a tool.** Boots real Electron, drives probes via
   `webContents.sendInputEvent`. Large scar-tissue surface (sendInputEvent-vs-dispatchEvent,
   synthetic-modifier-keys, paste-fires-at-document, browser-trio flake, whiteboard-probe rules).
   **Currently FROZEN in CI** (not a gate) because it's unreliable — confirming the cost.
2. **Security / MAIN files have NO fast tests** — covered only by e2e smoke or nothing:
   `src/main/index.ts` (window security opts, IPC wiring, `setWindowOpenHandler`),
   `src/main/localServer.ts`, `src/main/mcp.ts`. **§5 says these are the highest-value unit targets.**
3. **Redundant e2e** — several probes re-test logic already covered by the 602 unit tests.

### Per-probe migration map

| Probe | Verdict | Lower-tier coverage that already exists / should exist |
|---|---|---|
| `seed.ts` | **keep** | harness scaffolding (seeds boards) |
| `terminal.ts` | **keep thin e2e** | native node-pty roundtrip + ConPTY → real instance (see §7) |
| `browserPreview.ts` | **keep thin e2e** | native `WebContentsView` — no DOM; bounds math already unit (`cameraBounds`, `canvasView`) |
| `fullview.ts` | **keep thin e2e** | portal relocation + native view rebind; needs real input (memory `fullview-detach-not-close`) |
| `whiteboard.ts` | **push down** | logic already unit (`erase`/`marquee`/`snapping`/`tools`/`elements`); keep ONLY transform-hit-testing-at-zoom |
| `menu.ts` | **push down** | `BoardMenu.test.tsx` (jsdom) already covers it |
| `layout.ts` | **push down** | `tidyLayout`/`tileLayout`/`layoutPresets`/`cameraBounds` unit-tested; keep only live-camera settle |
| `planning.ts` | **push down** | component tests exist (`NoteCard`/`ChecklistCard`/`FreeText`/`ImageCard`) |
| `previewLink.ts` | **push down** | `portDetect`/`previewTarget`/`previewEdges` unit-tested; keep only the live arrow render |

**Net:** keep ~4 e2e areas (seed + the 3 native/real-instance surfaces); migrate ~5 to Vitest
integration. That moves us toward the trophy **without losing coverage** — it removes duplication.

---

## 7. Hard surfaces (research open questions → repo judgment)

The research did **not** verify native-module / WebContentsView / process-tree testing — these are
repo-specific judgment, flagged as such:

- **node-pty** — the *logic* (state machine, output parse, kill-command construction, `listPtySessions`)
  → **unit, mock node-pty** (we have `pty.test.ts`). The actual **spawn→echo roundtrip** runs in plain
  Node (node-pty is a Node native module, not Electron-only) → a focused **Vitest integration test in
  the `node` environment** is viable cross-platform, *if* the native build matches the test runtime;
  otherwise keep it as the `terminal` e2e probe. Don't both — pick one per behavior.
- **OS process-tree kill** (`taskkill /PID x /T /F` vs negative pgid) — assert the **command string
  we build** as a unit test; leave the *actual* tree-kill to ONE thin integration/e2e that spawns a
  real child tree. Cross-platform-specific → legitimately e2e.
- **WebContentsView** (native OS layer, no DOM) — already correct here: bounds/scale math is
  extracted to `cameraBounds.ts`/`canvasView.ts` and **unit-tested**; only "does `setBounds`/`capturePage`
  fire and produce a non-blank frame" needs a real instance. This is the trophy already working —
  replicate the pattern, don't expand the e2e. See `docs/research/self-smoke-testing.md` for the
  deferred Playwright `_electron` + MAIN-side `capturePage` harness.

---

## 8. Recommended sequence (when the restructure becomes a feature)

1. **Plug the security-unit gap first** (§5) — direct tests for `index.ts` webPreferences
   (contextIsolation/sandbox), `setWindowOpenHandler` deny+openExternal, IPC sender-rejection on
   `boardRegistry`/`projectIpc`/`mcp`. Highest value, cheapest, currently missing.
2. **Adopt an IPC integration layer** (`electron-mock-ipc` or shared-interface proxy) so MAIN/IPC
   behavior is testable without a boot (§3).
3. **Migrate the 5 push-down probes** (§6) to Vitest integration; delete the redundant probe code.
4. **Re-scope the e2e harness to the thin keep-set** (seed + terminal + browserPreview + fullview),
   then **re-enable it as a gate** (it's frozen now) — small + reliable enough to trust. Optionally
   replace the homegrown harness with **Playwright `_electron`, MAIN-process helpers only** (§4 lock).
5. **Add the auto-update e2e** when Phase 5 (packaging/signing/electron-updater) lands — that's a
   genuine e2e-only surface.

---

## Sources (verified)

- Kent C. Dodds — Testing Trophy / classifications / write-tests (3 posts).
- Electron docs — automated-testing, **security checklist (20 items)**, Spectron deprecation notice.
- VS Code — extension testing (integration-in-real-instance model).
- `electron-testable-ipc-proxy`, `electron-mock-ipc` (shared-interface + drop-in IPC mocks).
- Playwright `_electron` example, WebdriverIO `@wdio/electron-service`.
- Electron-specific testing guide (emadibrahim) — the 80/15/5 + SHOULD/SHOULD-NOT lists.

**Caveats:** 80/15/5 rests on a single blog (competes with 70/20/10) — directional only. Trophy vs
pyramid is normative opinion, not empirical fact. Some Spectron/Playwright claims passed 2-1
(framing overreach) but substance held. Native-module / WebContentsView / process-tree specifics
(§7) are repo judgment, not verified research.
