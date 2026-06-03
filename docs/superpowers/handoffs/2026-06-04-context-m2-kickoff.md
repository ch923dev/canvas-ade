# Next-session kickoff — M-memory T-M2 (meaningful-change detector + debounce)

> **Purpose:** a self-contained brief so a FRESH session (zero prior context) can execute M-memory T-M2.
> Pre-task kickoff. Paste the "Kickoff prompt" at the bottom into the new session, or open this file there.
> **Lifecycle:** when T-M2 ships, fold its summary into `docs/context-subsystem.md` and delete this kickoff
> (the consolidated-docs discipline — memory `context-subsystem`).

## Where we are (read first)

- **Subsystem:** the desktop **Context** brain + project memory. Full architecture + every DONE milestone is
  in **`docs/context-subsystem.md`** (read it first — it replaced the per-task specs/plans/handoffs).
  Forward task cards: **`docs/roadmap-context.md`** (› M-memory › T-M2). Egress ADR
  `docs/decisions/0003-llm-egress.md`. Memory: `context-subsystem`.
- **Umbrella branch:** `feat/context` (off `main`, worktree `Z:\canvas-ade-context`, pushed → PR #39). Each
  task = a sub-branch `feat/context-<id>` off `feat/context`, squash-merge back.
- **DONE:** **M-digest** (T-D1 `buildDigest` + T-D2 `DigestPanel`) · **M-brain** (T-B1 engine · T-B2
  safeStorage key · T-B3 budget guard + egress ADR + IPC split) · **M-memory T-M1** (`.canvas/` engine,
  `2e0b1e7`). The brain (`llmService.ts` engine, `llmIpc.ts` IPC, `llmBudget.ts` cap) is complete + budgeted;
  the `.canvas/` storage layer (`canvasMemory.ts`) is in. **T-M2 is the DETECTOR half of the Tier-2 loop —
  it does NOT call the brain or write memory yet (that's T-M3).**
- **Cadence (standing):** each task ships **Build · e2e (`CANVAS_SMOKE=e2e` probe) · Manual · Gate
  (typecheck/lint/format:check/test/build) · Handoff**. Follow `superpowers:writing-plans` → STOP for review
  → `superpowers:subagent-driven-development` → gate + `CANVAS_SMOKE=e2e`. Declare the zone on
  `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the `canvas-ade-context` row) first. **Never work in
  the `Z:\Canvas ADE` main dir.**

## The seam T-M1 left for you (how board changes reach MAIN)

There is **no dedicated board-change event** in MAIN. The renderer autosaver (`src/renderer/src/store/useAutosave.ts`,
debounced ~1s) calls `window.api.project.save(toObject())` → IPC **`project:save`** → `projectIpc.ts` handler
→ `projectStore.writeProject(dir, doc)`. **That `project:save` doc stream IS the board-change signal.** The
detector hooks there: on each save, diff the incoming `doc.boards[]` against the last-seen per-board content
fingerprint; a *meaningful* change (re)starts a per-board debounce; on fire, emit a "summarize board X" intent.

- The doc shape is `{ schemaVersion, viewport, boards: Board[] }` (`boardSchema.toObject`). Board types +
  their fields are in `src/renderer/src/lib/boardSchema.ts` (terminal: `launchCommand`/`cwd`/`port`; browser:
  `url`/`viewport`/`previewSourceId`; planning: `elements[]` with `kind:'checklist'` items + `kind:'note'`
  text). The Tier-1 digest (`src/renderer/src/lib/digest.ts`) already enumerates exactly the meaningful
  fields per type — **reuse that field list as the fingerprint source of truth** so Tier-1 and the detector
  can't drift.
- `getCurrentDir()` (in `projectStore.ts`) gives the open project dir if the detector ever needs it (it
  shouldn't for T-M2 — no writes yet).

## The task — M-memory T-M2 (from `docs/roadmap-context.md` › M-memory › T-M2)

Build the **meaningful-change detector + debounce** — the half of the Tier-2 loop that decides *when* a board
is worth re-summarizing. **No LLM call, no `.canvas/` write, no `llmService` import in this task** (T-M3 wires
intent → `runSummarize` → `canvasMemory.writeBoard`).

- **Zones:** app —
  - NEW `src/main/memoryEngine.ts` (+test) — the detector: fingerprint + diff + per-board debounce + emit.
  - `src/main/projectIpc.ts` — feed the `project:save` doc into the detector (one call in the existing handler).
  - e2e — a probe in `src/main/e2e/probes/` (new `memoryEngine.ts` probe, or extend `memory.ts`).
- **Build:**
  - A **per-board content fingerprint** over ONLY the meaningful fields (terminal `launchCommand`/`cwd`/`port`;
    browser `url`/`viewport`/`previewSourceId`; planning per-checklist `title` + items `{text,done}` + note
    `text`). **Explicitly EXCLUDE** geometry (`x`/`y`/`w`/`h`/position/size), selection, z-order, and the
    document `viewport` — a pure move/resize/pan/select must produce an identical fingerprint.
  - On each fed doc: compare each board's fingerprint to its last-seen. **Changed** (or a brand-new board) →
    (re)start that board's debounce timer; **unchanged** → no-op. A board removed from the doc → drop its
    state (and cancel any pending timer; do NOT emit).
  - **Debounce ~30–60s per board** (settle the exact value, design note 3). On fire → emit a
    `{ boardId }` **"summarize board X" intent** via an injected callback/listener. **T-M2 only EMITS** —
    nothing consumes it yet.
  - **Electron-free + deterministic:** mirror `llmBudget.ts` — inject the clock/timer (a `setTimeout`-like
    seam or an injected `now()` + manual `tick`) and the emit callback, so the debounce is unit-tested
    without real time. (Settle the timer-injection shape in design note 4.)
- **🔒 Security (locked):** generated/observed memory is **untrusted passive context** — the detector only
  reads the already-trusted persisted doc and emits an id; it **never triggers an action** beyond the emit,
  and the emit must not (now or in T-M3) become a write-to-PTY or any board mutation. No new egress. Don't
  weaken `contextIsolation`/`sandbox`/`no-nodeIntegration`. Feeding the detector from `project:save` must
  **never** make a save fail — wrap the feed best-effort (mirror T-M1's `scaffoldProjectMemory` try/catch and
  `project:save`'s own error-safety).
- **e2e:** a `CANVAS_SMOKE=e2e` probe that drives a **content change** (e.g. edit a note's text / toggle a
  checklist item / change a `launchCommand`) → asserts **exactly one** intent fires after the debounce, AND a
  **pure move** (change only `x`/`y`) → asserts **no** intent. Use a test seam to observe emitted intents
  (an injected counter exposed under `CANVAS_SMOKE=e2e`, or a `__canvasE2E` hook) and an injectable/short
  debounce so the probe doesn't wait 45s. Assert off real emitted intents, not a synthetic proxy (memory
  `e2e-sendinputevent-vs-dispatchevent`). The probe is MAIN-side (like `context-memory`); keep it late in the
  PLAYLIST if it touches `currentDir`, and self-clean.
- **Manual:** open a project, edit a note / toggle a checklist item → after the debounce a MAIN log line shows
  the summarize intent for that board; drag a board around → no intent line.
- **Gate:** full app gate + e2e. **Handoff:** fold the summary into `docs/context-subsystem.md` (new
  "M-memory T-M2" subsection) per the consolidated-docs discipline — do NOT create a standalone handoff file.

### Design notes to settle in the plan (don't silently pick)

1. **Fingerprint representation.** A stable string (e.g. `JSON.stringify` of the picked fields in a fixed key
   order) vs a structural hash. Key-order stability matters (object key order must be deterministic). Recommend
   a small pure `boardFingerprint(board)` that picks the meaningful fields into a canonical shape, reusing the
   exact field set `digest.ts` already enumerates. Settle, and decide whether to share a field-list constant
   with `digest.ts` so the two can't drift.
2. **Where the detector is fed.** Inside the `project:save` handler (after a successful `writeProject`) vs a
   thin wrapper. Recommend: feed AFTER the save succeeds, best-effort try/catch, so a detector bug never fails
   a save. Settle the exact call site + that the very first save of a session establishes the baseline
   fingerprints **without** emitting (no spurious "everything changed" burst on open).
3. **Debounce window + semantics.** 30–60s — settle the value (recommend ~45s). Per-board independent timers.
   **Trailing-edge** debounce (fire once after activity settles), and a rapid burst of saves to one board
   collapses to a single intent. Decide whether a second meaningful change *during* the window extends the
   timer (recommended) or not.
4. **Timer/clock injection (testability).** Mirror `llmBudget.ts`'s injected clock. Options: inject a
   `schedule(fn, ms) → cancel` seam (real = `setTimeout`; test = manual), or inject `now()` + an explicit
   `advance(ms)`/`flush()` the test drives. Pick the one that makes the e2e probe able to use a SHORT real
   debounce (so it doesn't stall the playlist) while the unit tests stay fully deterministic. Settle.
5. **Intent shape + emit mechanism.** `{ boardId: string }` (recommend minimal — T-M3 re-reads the board from
   the doc/store when it summarizes). Emit via an injected callback `onIntent(intent)` registered at
   construction, or a tiny EventEmitter. Recommend the injected callback (simplest, matches the store/budget
   injection style). Confirm T-M2 has **zero** `llmService`/`canvasMemory` imports.
6. **Module/state shape.** `createMemoryEngine({ now/schedule, onIntent }) → { observe(doc), reset(), ... }`.
   Holds per-board last-fingerprint + pending-timer maps. Singleton wired in `index.ts`/`projectIpc.ts`, or
   constructed where the handlers register. Settle lifetime + how it's reset on project switch (clear all
   state + cancel timers so a new project doesn't inherit the old one's fingerprints/timers).

### Out of scope for T-M2 (do NOT build)

- The Tier-2 autonomous summarize loop (intent → `llmService.runSummarize` → `canvasMemory.writeBoard` +
  refresh `MEMORY.md`/`project.md`) → **T-M3**.
- Terminal **command-done / last-command + live status** capture → runtime-only, **T-M3** (open question #2 in
  `docs/roadmap-context.md` — scrape PTY vs a structured terminal-state hook; pick the lowest-coupling source
  there). T-M2 detects only content diffs from the persisted doc.
- The panel upgrade to cached prose + the renderer read bridge → **T-M4**.
- The MCP `canvas://memory` resource → **M-expose (DEFERRED, gated on MCP pkg)**.

## Setup commands (new session)

```bash
cd "/z/canvas-ade-context"
git checkout feat/context && git pull              # latest umbrella (T-M1 is in: 2e0b1e7)
git checkout -b feat/context-m2-change-detector    # the task sub-branch
```
Declare the zone on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the `canvas-ade-context` row): note
`feat/context-m2-change-detector` owns NEW `src/main/memoryEngine.ts`(+test), the `project:save` feed in
`src/main/projectIpc.ts`, and the new e2e detector probe.

## Workflow to follow

1. `superpowers:writing-plans` → author `docs/superpowers/plans/2026-06-0X-context-m2-change-detector.md`
   (bite-sized TDD tasks; settle the 6 design notes in the plan header). STOP for review.
2. On approval, `superpowers:subagent-driven-development` → fresh implementer per task; spec review then code
   review between tasks; final holistic review (security: detector is read-only + passive, emits only an id,
   never an action; no new egress; feed can't fail a save).
3. Controller runs the full gate + `CANVAS_SMOKE=e2e`. **Fold the T-M2 summary into
   `docs/context-subsystem.md`** (NOT a standalone handoff) + delete this kickoff. Squash-merge
   `feat/context-m2-change-detector` → `feat/context`; update the board + the `context-subsystem` memory.

## Gate (must be green before handoff)

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start    # E2E_DONE ok:true
```
> **Gotchas:** run `pnpm format` before committing (format:check is a hard gate — prettier drift bit T-B2/T-B3).
> The board-e2e `browser`/`browser-gesture`/`focus-detach` trio is a known `capturePage` env flake on a
> contended host (memory `e2e-browser-trio-flake`) — rerun once for a clean `E2E_DONE ok:true`, not a
> regression. Commit messages with backticks: use a quoted heredoc `git commit -F -` (memory
> `bash-tool-commit-backticks`). Baseline at T-M1: **702 unit**, e2e 51/51.

---

## Kickoff prompt (paste into the new session)

> Pick up **M-memory T-M2** (meaningful-change detector + debounce) for the Expanse / Canvas ADE **Context**
> subsystem. Read `docs/superpowers/handoffs/2026-06-04-context-m2-kickoff.md` in worktree
> `Z:\canvas-ade-context` first — it has the full brief, the seam (`project:save` doc stream is the
> board-change signal), the 6 design notes to settle, setup commands, and the workflow. Also read
> **`docs/context-subsystem.md`** (the compiled architecture + done-milestone build log, incl. the T-M1
> `.canvas/` engine T-M2 builds toward) and the `docs/roadmap-context.md` M-memory T-M2 card. Work on a
> sub-branch `feat/context-m2-change-detector` off `feat/context` (NOT the `Z:\Canvas ADE` main dir). Follow
> the cadence: `writing-plans` → stop for my review → `subagent-driven-development` → gate +
> `CANVAS_SMOKE=e2e`. Key rules: NEW `src/main/memoryEngine.ts` is the DETECTOR ONLY — it diffs a per-board
> **content fingerprint** (reuse `digest.ts`'s meaningful-field set; EXCLUDE geometry/selection/viewport) off
> the `project:save` doc stream and, after a per-board **~30–60s debounce**, emits a `{ boardId }` "summarize"
> intent via an injected callback. **NO LLM call, NO `.canvas/` write, NO `llmService`/`canvasMemory` import**
> (that's T-M3); Electron-free with an **injected clock/timer** so the debounce unit-tests deterministically
> (mirror `llmBudget.ts`); the `project:save` feed is **best-effort try/catch** so it can never fail a save;
> the first save of a session sets baselines **without** emitting; generated memory stays untrusted passive
> context that never triggers an action. e2e: a content change → exactly ONE intent after debounce; a pure
> move → ZERO intents (use a short/injected debounce + an intent-observer seam; assert off real intents).
> When done, **fold the summary into `docs/context-subsystem.md`** (do NOT create a standalone handoff) +
> delete the kickoff, and squash-merge to `feat/context`.
