# Next-session kickoff — M-memory T-M1 (`.canvas/` engine: paths + atomic writers)

> **Purpose:** a self-contained brief so a FRESH session (zero prior context) can execute M-memory T-M1.
> Pre-task kickoff. Paste the "Kickoff prompt" at the bottom into the new session, or open this file there.
> **Lifecycle:** when T-M1 ships, fold its summary into `docs/context-subsystem.md` and delete this kickoff
> (the consolidated-docs discipline — memory `context-subsystem`).

## Where we are (read first)

- **Subsystem:** the desktop **Context** brain + project memory. Full architecture + every DONE milestone is
  in **`docs/context-subsystem.md`** (read it first — it replaces the old per-task specs/plans/handoffs,
  which were collapsed + deleted 2026-06-03). Forward task cards: **`docs/roadmap-context.md`**. Egress:
  ADR `docs/decisions/0003-llm-egress.md`. Memory: `context-subsystem`.
- **Umbrella branch:** `feat/context` (off `main`, worktree `Z:\canvas-ade-context`, pushed → PR #39). Each
  task = a sub-branch `feat/context-<id>` off `feat/context`, squash-merge back.
- **DONE:** **M-digest** (T-D1 `buildDigest` + T-D2 `DigestPanel`) and **M-brain** (T-B1 engine `e7f7fcf` ·
  T-B2 safeStorage key `5678257` · T-B3 budget guard + egress ADR + IPC split `cec15ba`). The brain
  (`llmService.ts` engine, `llmIpc.ts` IPC, `llmBudget.ts` cap) is complete and budgeted — **M-memory's
  Tier-2 loop (T-M3) is the first thing that will USE it.**
- **Cadence (standing):** each task ships **Build · e2e (`CANVAS_SMOKE` probe) · Manual · Gate
  (typecheck/lint/format/test/build) · Handoff**. Follow `superpowers:writing-plans` → STOP for review →
  `superpowers:subagent-driven-development`. Declare the zone on
  `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` first. **Never work in the `Z:\Canvas ADE` main dir.**

## The task — M-memory T-M1 (from `docs/roadmap-context.md` › M-memory › T-M1)

Build the persistent `.canvas/` engine: the paths, the atomic writers, and the default `.gitignore`. This is
the **storage layer** under M-memory — the Tier-2 summarize loop (T-M2/T-M3) and the panel-prose upgrade
(T-M4) build on it. **No LLM, no change-detector, no loop in this task** — just the file engine + wiring.

- **Zones:** app —
  - NEW `src/main/canvasMemory.ts` (+test) — resolve + read/write `<project>/.canvas/`.
  - project create/open wiring (the `projectStore.ts` / `projectIpc.ts` neighbours that own the open
    project dir) — create `.canvas/` + its `.gitignore` on project create/open.
  - e2e — a probe in `src/main/e2e/probes/` (or extend `context.ts`).
- **Build:**
  - Resolve `<project>/.canvas/memory/{MEMORY.md, project.md, board-<id>.md}` + `.canvas/audit/` (reserved
    dir — create or reserve the path; nothing writes to it yet).
  - **Atomic writers** (`write-file-atomic`, `mkdirSync` guard) — mirror `llmKeyStore`/`llmBudget` I/O
    discipline, but rooted at the **PROJECT folder**, NOT `userData` (this is project data — opposite of the
    key/config/budget files, which stay in `userData`).
  - On project **create** (and open, if `.canvas/` absent), write `.canvas/.gitignore` ignoring `.canvas/`
    by default (private), with an **opt-in to commit** (a toggle that removes/rewrites the ignore).
  - **Read helpers** for the panel (T-M4) and the deferred MCP resource: read `MEMORY.md` / `project.md` /
    `board-<id>.md`, returning a sensible empty/undefined on missing (never throw).
- **🔒 Security (locked):** `.canvas/` is **project data** — atomic, default `.gitignore`d, opt-in commit.
  The **API key is NEVER here** (key stays in `userData/llm-keys.json`, safeStorage). Generated memory is
  **untrusted passive context** — written + read/displayed, **never triggers an action**. Don't weaken
  `contextIsolation`/`sandbox`/`no-nodeIntegration`; any new read bridge is foreign-sender guarded
  (`isForeignSender`, the pty/preview/project/llm convention).
- **e2e:** a `CANVAS_SMOKE=e2e` probe that writes a stub `board-<id>.md`, reloads/re-reads, and **asserts the
  file round-trips** AND the default `.canvas/.gitignore` is present. Assert the memory lives under the
  **project dir**, never `userData`. (Settle how the probe gets a project dir — see design note 5.)
- **Manual:** open a project → `.canvas/` appears with the gitignore; write a stub memory file → see it on
  disk; confirm it's `.gitignore`d (git status clean) until the commit-toggle is flipped.
- **Gate:** full app gate + e2e. **Handoff:** fold the summary into `docs/context-subsystem.md` (a new
  "M-memory T-M1" subsection) per the consolidated-docs discipline — do NOT create a standalone handoff file.

### Design notes to settle in the plan (don't silently pick)

1. **Module boundary + testability.** Keep `canvasMemory.ts` Electron-free: take an explicit `projectDir`
   (like `llmConfig`/`llmKeyStore`/`llmBudget` take `userDataDir`) so it unit-tests without Electron. The
   real wiring passes the open project's dir. Settle the exported surface, e.g.
   `createCanvasMemory(projectDir) → { paths, writeBoard(id, md), writeIndex(...), writeProject(md), readBoard(id), readIndex(), readProject(), ensureScaffold() }`.
2. **`MEMORY.md` / `project.md` formats.** `MEMORY.md` = an index (one line per board → `board-<id>.md`);
   `project.md` = a high-level project digest; `board-<id>.md` = per-board Tier-2 prose. T-M1 only needs the
   **paths + writers + a stub round-trip** (T-M3 fills real content) — but settle the minimal format/header
   so T-M3/T-M4 build on a stable shape. Keep it plain markdown.
3. **`.gitignore` + commit-toggle.** Default-ignore `.canvas/`. WHERE does the opt-in-to-commit state live?
   (in `canvas.json`? a `.canvas/` config line? an app setting?) Recommend the simplest that travels with the
   project; settle explicitly. Decide what the toggle writes (remove the ignore vs ignore only `audit/`).
4. **Project-open/create wiring.** Find how `projectStore.ts`/`projectIpc.ts` resolve + open the project dir
   today; hook `ensureScaffold()` into create (and open-if-absent) WITHOUT changing the `canvas.json`
   save/load contract. Don't route `.canvas/` content into `canvas.json` or a board patch key.
5. **e2e project dir.** Settle how the probe obtains a project dir under `CANVAS_SMOKE=e2e` (does the harness
   already open a temp project dir? mirror how T-B2's `context-keystore` got `CANVAS_E2E_LLM_DIR` — but
   `.canvas/` is project-rooted, so it needs a project dir, not a userData temp). Read the existing e2e
   project-open path first; if none, the probe may create a throwaway project dir + assert against it.
6. **Read-bridge scope.** Does T-M1 add a guarded `memory:read*` IPC now, or defer the renderer read path to
   T-M4? Recommend **defer the bridge to T-M4** (which needs it) — T-M1 = MAIN engine + wiring + e2e only,
   keeping scope tight. Settle.

### Out of scope for T-M1 (do NOT build)

- The meaningful-change detector + debounce → **T-M2**.
- The Tier-2 autonomous summarize loop (the `llmService` call) → **T-M3**.
- The panel upgrade to cached prose + the renderer read bridge → **T-M4**.
- The MCP `canvas://memory` resource → **M-expose (DEFERRED, gated on MCP pkg)**.

## Setup commands (new session)

```bash
cd "/z/canvas-ade-context"
git checkout feat/context && git pull              # latest umbrella (T-B3 + doc consolidation are in)
git checkout -b feat/context-m1-canvas-engine      # the task sub-branch
```
Declare the zone on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the `canvas-ade-context` row): note
`feat/context-m1-canvas-engine` owns NEW `src/main/canvasMemory.ts`(+test), the project create/open wiring in
`src/main/projectStore.ts`/`projectIpc.ts`, and the new e2e memory probe.

## Workflow to follow

1. `superpowers:writing-plans` → author `docs/superpowers/plans/2026-06-0X-context-m1-canvas-engine.md`
   (bite-sized TDD tasks; settle the 6 design notes in the plan header). Stop for review.
2. On approval, `superpowers:subagent-driven-development` → fresh implementer per task; spec review then code
   review between tasks; final holistic review (security: `.canvas/` is project-data, key never there,
   memory is passive; no weakened isolation).
3. Controller runs the full gate + `CANVAS_SMOKE=e2e`. **Fold the T-M1 summary into
   `docs/context-subsystem.md`** (NOT a standalone handoff). Squash-merge `feat/context-m1-canvas-engine` →
   `feat/context`; update the board + the `context-subsystem` memory.

## Gate (must be green before handoff)

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start    # E2E_DONE ok:true (browser-trio = known env flake, rerun)
```
> Gotchas: run `pnpm format` before committing (format:check is a hard gate). The `browser`/`browser-gesture`/
> `focus-detach` trio is a known `capturePage` env flake (memory `e2e-browser-trio-flake`) — rerun once for a
> clean `E2E_DONE ok:true`, not a regression.

---

## Kickoff prompt (paste into the new session)

> Pick up **M-memory T-M1** (`.canvas/` engine: paths + atomic writers) for the Expanse / Canvas ADE
> **Context** subsystem. Read `docs/superpowers/handoffs/2026-06-03-context-m1-kickoff.md` in worktree
> `Z:\canvas-ade-context` first — it has the full brief, the 6 design notes to settle, setup commands, and the
> workflow. Also read **`docs/context-subsystem.md`** (the compiled architecture + done-milestone build log —
> it replaced the per-task plans/handoffs) and the `docs/roadmap-context.md` M-memory T-M1 card. Work on a
> sub-branch `feat/context-m1-canvas-engine` off `feat/context` (NOT the `Z:\Canvas ADE` main dir). Follow the
> cadence: `writing-plans` → stop for my review → `subagent-driven-development` → gate + `CANVAS_SMOKE=e2e`.
> Key rules: `.canvas/` is **project data** in the project folder (atomic `write-file-atomic`, default
> `.gitignore`d, opt-in commit) — the API key is **NEVER** there (key stays in `userData`/safeStorage);
> generated memory is **untrusted passive context that never triggers an action**; `canvasMemory.ts` takes an
> explicit `projectDir` so it unit-tests without Electron; no LLM/change-detector/loop in this task (those are
> T-M2/T-M3); defer the renderer read-bridge to T-M4. When done, **fold the summary into
> `docs/context-subsystem.md`** (do NOT create a standalone handoff file) and squash-merge to `feat/context`.
