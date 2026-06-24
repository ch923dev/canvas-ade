# Handoff — Phase 1 (transfer engine) + Picker pixel mock

**For:** a worker session (own worktree). **Feature:** cross-board element transfer between Planning
boards. **Umbrella (integration target):** `feat/planning-cross-board-transfer` — already on origin.
**You do NOT merge.** A separate main/integration session verifies (full e2e matrix) and merges your PR
into the umbrella.

Paste the prompt below into a fresh Claude Code session.

---

## PROMPT

You are a worker session for the Canvas ADE **cross-board element transfer** feature. Deliver **two**
things on **one** branch off the umbrella, then open **one** PR into the umbrella and stop (a separate
integration session merges it).

### 0. Read first (do not skip)
- Spec — `docs/research/2026-06-24-planning-cross-board-transfer.md` (on the umbrella branch). It has the
  full data model, the locked decisions (§10), the engine design (§4), and the picker wireframe (§3.A).
  **Do not re-litigate any locked decision.**
- Project contract — `CLAUDE.md` (scene/session split, undo invariants, single commit path, worktree
  rules, gate routine).

### 1. Set up your worktree (off the UMBRELLA, not main)
```
pwsh .claude/tools/new-worktree.ps1 -Name planning-xfer-engine -Branch feat/planning-xfer-engine \
  -Base feat/planning-cross-board-transfer \
  -Zone "planning/elements.ts + store/canvasStore.ts (transfer engine) + docs/research/mocks (picker mock)"
```
Open a session in `.worktrees/planning-xfer-engine`. Set `$env:CANVAS_DEV_TITLE='worker — xfer engine'`
for any dev check. Confirm your base is the umbrella: `git log --oneline -1` should show the umbrella seed
commit as an ancestor.

### 2. Task A — Phase 1: the pure transfer engine (UI-free)
Implement exactly what spec §4 describes. No UI wiring this phase.
- `planning/elements.ts`:
  - `extractForTransfer(els, ids)` → `{ payload, remaining }`. `payload` = the **group-expanded**
    (`expandGroups`) selection, deep-cloned, **normalized** so the selection's union-bbox top-left is at
    the origin (subtract min x/y; use `unionBBox`/`elementBBox`). `remaining` = source minus moved ids —
    **skip-locked-on-move** (locked members stay in `remaining`, are NOT in `payload` when extracting for
    a move). Keep pure/immutable + caller-supplied ids.
  - `insertTransferred(targetEls, payload, at, newId)` → `{ elements, newIds }`. Fresh id per element +
    **group-id remap** (reuse the `duplicateElements` remap logic), translate every element by `at`
    (per-kind correct via `shiftElement`), append to `targetEls`. Return `newIds` for reselection.
  - Asset refs (`assetId`/`source`/`svgCache`/`path`) copy **verbatim** — same project, valid references.
- `store/canvasStore.ts`:
  - `transferElements(sourceId, targetId, ids, mode: 'copy'|'move', at)` → **one undo step**:
    `beginChange()` once, `updateBoard(targetId, …)`, and on `move` also `updateBoard(sourceId, …)` — the
    two writes coalesce (the first consumes the pending checkpoint; verify against `canvasStore.ts`
    `takePendingPast`). **No-op guards** (empty payload, `target===source` on move, target not a planning
    board) must return WITHOUT arming a checkpoint (phantom-undo discipline). Return `{ newIds }`.
  - A small selector/helper: list the **other** planning boards (`type==='planning' && id!==sourceId`).
- Tests (the substance of this PR):
  - `elements.test.ts` — extract normalizes payload to origin; group expand + remap on insert; move
    skips locked; asset-ref verbatim copy; arrow/stroke point integrity through extract→insert.
  - A store test — `transferElements` move = **one** Ctrl+Z restoring BOTH boards; copy leaves source
    intact; each no-op guard arms no checkpoint and clears nothing.
- Honor: scene/session split (nothing ephemeral into `elements[]`/`PATCHABLE_KEYS`), undo invariants,
  single commit path, **no schema bump** (reuses existing kinds + the project asset store).
- Note: this engine is **not wired to UI** yet (that is Phase 2–4), so there is **no new e2e** here — the
  e2e leg is a regression check that existing planning behavior still passes.

### 3. Task B — Picker pixel mock (design-artifact gate for Phase 2)
- Build a **throwaway** self-contained **`.html`** mock of `SendToBoardPanel` using the **real tokens**
  from `src/renderer/src/index.css` (copy the CSS custom properties you need inline). Match the spec §3.A
  layout: title "Send N items to…", a **Copy / Move** radio, a list of other planning boards (e.g. Sprint
  Plan / Architecture / Bug Triage), and a **"+ New planning board"** row. Mirror the `BrowserPickPanel`
  look (`.ca-port-picker` family).
- Render + **screenshot** it (Playwright `_electron`, or load the file and use the `CANVAS_SHOT` path).
  Commit the HTML + the PNG under **`docs/research/mocks/`** as the design artifact. It must **NOT** be
  wired into `src/` or the build (pure `.html`, outside TS).
- If `format:check` flags the HTML, add `docs/research/mocks/` to `.prettierignore` (or `pnpm format` it).

### 4. Gate — all green BEFORE you report done
- `pnpm typecheck && pnpm lint && pnpm format:check` (the pre-commit trio).
- `pnpm test` (unit + integration) — your new engine tests included.
- e2e: **run it manually** — the pre-push hook **SKIPS** the matrix on a new branch's first push, so run
  `pnpm test:e2e` (Windows leg) yourself; it must be green. (The integration session runs the FULL
  `pnpm test:e2e:matrix` at merge — you do not need both legs unless you touched `src/main|preload`/e2e
  config.)
- Verify `git config core.hooksPath` is `.githooks` (else the gate silently no-ops).
- Open **ONE** PR: base `feat/planning-cross-board-transfer`, head `feat/planning-xfer-engine`. Make the
  CI **`check`** job go green (typecheck · lint · format:check · unit + integration).

### 5. Do NOT
- Do NOT merge into the umbrella, and do NOT target/branch off `main`.
- Do NOT `pnpm install` from the worktree (symlinked node_modules — it recreates the shared tree and
  breaks electron for every worktree). Use the junctioned deps; if a rebuild is needed, `pnpm rebuild`.
- Do NOT wire the engine into the UI (that is Phase 2+), and do NOT bump `schemaVersion`.

### 6. Report back (so the integration session can verify + merge)
- PR number + link; the green CI run; local `pnpm test` + `pnpm test:e2e` results.
- The mock screenshot path under `docs/research/mocks/`.
- Any deviation from the spec, and anything you want the integration session to double-check.

---

## Integration session's job (the other/main session) — for reference
On "done": fetch the PR branch, re-run the **full** gate + **`pnpm test:e2e:matrix` (both legs)**, confirm
CI `check` is green, eyeball the engine diff + the mock screenshot, then merge `feat/planning-xfer-engine`
into `feat/planning-cross-board-transfer` and advance the umbrella. The mock is reviewed for the Phase 2
sign-off; the engine is the merge.
