# Next-session kickoff — M-memory T-M3 (Tier-2 autonomous summarize loop) 🔒

> **Purpose:** a self-contained brief so a FRESH session (zero prior context) can execute M-memory T-M3 —
> the **first autonomous-spend path** in the app. Pre-task kickoff. Paste the "Kickoff prompt" at the
> bottom into the new session, or open this file there.
> **Lifecycle:** when T-M3 ships, fold its summary into `docs/context-subsystem.md` and **delete this
> kickoff** (consolidated-docs discipline — memory `context-subsystem`).
> **🔒 This is the milestone the whole subsystem's guards were built for.** The detector (T-M2) only
> emitted an id; T-M3 turns that id into a real LLM call that spends money and writes files. Treat the
> budget guard, the no-key fallback, and the passive-output rule as load-bearing, not optional.

## Where we are (read first)

- **Subsystem:** the desktop **Context** brain + project memory. Full architecture + every DONE milestone is
  in **`docs/context-subsystem.md`** (read it first — it replaced the per-task specs/plans/handoffs).
  Forward task cards: **`docs/roadmap-context.md`** (› M-memory › **T-M3**). Egress ADR
  `docs/decisions/0003-llm-egress.md`. Memory: `context-subsystem`.
- **Umbrella branch:** `feat/context` (off `main`, worktree `Z:\canvas-ade-context`). Each task = a
  sub-branch `feat/context-<id>` off `feat/context`, squash-merge back.
- **DONE:** **M-digest** (T-D1 `buildDigest` + T-D2 `DigestPanel`) · **M-brain** (T-B1 engine · T-B2
  safeStorage key · T-B3 budget guard + egress ADR + IPC split) · **M-memory T-M1** (`.canvas/` engine
  `canvasMemory.ts`) · **M-memory T-M2** (change detector `memoryEngine.ts`, squash `221ddf8`). The brain,
  the key store, the budget cap, the `.canvas/` storage, AND the change detector are all in.
- **T-M3 is the LOOP that wires them together:** the detector's `{ boardId }` intent →
  `llmService.runSummarize` → `canvasMemory.writeBoard` + refresh the index. **T-M3 calls the LLM and
  writes memory** (the first task that does either autonomously).
- **Cadence (standing):** each task ships **Build · e2e (`CANVAS_SMOKE=e2e` probe) · Manual · Gate
  (typecheck/lint/format:check/test/build) · Handoff (fold into `context-subsystem.md`)**. Follow
  `superpowers:writing-plans` → STOP for review → `superpowers:subagent-driven-development` → gate +
  `CANVAS_SMOKE=e2e`. Declare the zone on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the
  `canvas-ade-context` row) first. **Never work in the `Z:\Canvas ADE` main dir.**

## The pieces T-M1/T-M2/M-brain left for you (the exact seams)

**1. The intent seam (T-M2).** `src/main/memoryEngine.ts` exports
`createMemoryEngine({ onIntent, debounceMs?, schedule? }) → { observe, reset }`. Today the engine is
constructed with a **default `onIntent` that only logs** (`logSummarizeIntent` in `src/main/projectIpc.ts`,
the 5th defaulted param of `registerProjectHandlers`). **T-M3 replaces that default `onIntent` with the
real summarize loop.** The intent payload is `{ boardId: string }` — it carries the id ONLY, so the loop
must re-read the board's current content itself (see seam 2).

**2. The current doc on disk (T-M1/persistence).** `src/main/projectStore.ts` exports
`getCurrentDir(): string | null` and `readProject(dir): ProjectResult` (`{ ok: true, dir, doc, name } |
{ ok: false, error }`). Because the detector fires AFTER `project:save` wrote `canvas.json`, the loop can
read the board's latest content from disk: `readProject(getCurrentDir())` → `doc.boards.find(b => b.id ===
boardId)`. (The board's persisted shape is in `src/renderer/src/lib/boardSchema.ts`; **MAIN cannot import
that** — `tsconfig.node` = `src/main/**` — so read the board defensively as `unknown`, the same discipline
`memoryEngine.boardFingerprint` already uses.)

**3. The brain (M-brain).** `src/main/llmService.ts` exports `runSummarize(config, input, deps) →
SummarizeResult` (NEVER throws):
```ts
type SummarizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-provider' }       // no key → degrade to Tier-1, no spend
  | { ok: false; reason: 'budget-exceeded' }   // over the per-day cap → Tier-1
  | { ok: false; reason: 'provider-error'; message: string }
interface SummarizeInput { system?: string; text: string }
interface ProviderDeps { fetch; env; keyStore?; budget? }   // budget reserves a call PRE-fetch
```
`config = readLlmConfig(llmDataDir)` (`src/main/llmConfig.ts`). Deps need a `keyStore`
(`createKeyStore(llmDataDir, encryptor)`, `src/main/llmKeyStore.ts`) and a `budget`
(`createBudgetStore(llmDataDir, () => new Date())`, `src/main/llmBudget.ts`). **Both stores are
file-backed** (`userData/llm-keys.json` / `userData/llm-budget.json`), so a SECOND instance pointed at the
same `llmDataDir` shares the same key and the same daily cap as the one `registerLlmHandlers` built — the
budget is still enforced. Under `CANVAS_SMOKE=e2e` / `CANVAS_LLM_MOCK=1`, `getProvider` returns a mock
(`[mock] <text>`) → **no real network in CI/e2e**.

**4. The store (T-M1).** `src/main/canvasMemory.ts` exports `createCanvasMemory(projectDir) →
{ writeBoard(id, md): boolean, writeIndex(md), writeProject(md), readBoard/readIndex/readProject,
ensureScaffold, ... }`. `writeBoard` returns `false` for an unsafe id (`safeBoardId`). **Memory is
project-rooted** (`<project>/.canvas/memory/`), default-`.gitignore`d, opt-in commit.

**5. index.ts wiring point.** `src/main/index.ts:165` calls `registerProjectHandlers(ipcMain, () =>
mainWindow, app.getPath('userData'))` (3 args → default logging engine). `:179` calls
`registerLlmHandlers(ipcMain, () => mainWindow, llmDataDir, undefined, llmEncryptor)`, where `llmDataDir`
(= `userData`, or a temp dir under e2e) and `llmEncryptor` (safeStorage) are already built. **T-M3 builds
the summary loop here (it needs `llmDataDir` + `llmEncryptor`), constructs the engine with the real
`onIntent`, and passes that engine as the 5th arg to `registerProjectHandlers`** so the SAME engine that
`project:save` feeds + `open/current` reset also drives the loop.

## The task — M-memory T-M3 (from `docs/roadmap-context.md` › M-memory › T-M3)

Build the **Tier-2 autonomous summary loop**: detector intent → summarize the board's current content →
write `<project>/.canvas/memory/board-<id>.md` + refresh `MEMORY.md` (index) + `project.md`. **Opt-in +
gated** (no key → no-provider → no-op; over budget → Tier-1; mock under e2e). Generated memory is
**untrusted passive context** — written + displayed, it **never triggers an action**.

- **Zones:** app —
  - NEW `src/main/summaryLoop.ts` (+test) — the loop: id → read board → build input → `runSummarize` →
    `canvasMemory` writers + index refresh. Holds a per-board in-flight guard.
  - `src/main/index.ts` — build the loop + construct the engine with the real `onIntent` + pass it to
    `registerProjectHandlers`. (⚠️ CROSS-ZONE: `index.ts` is also touched additively by
    `feat/mcp-integration` — coordinate; no shared lines expected.)
  - `src/main/llmService.ts` — add a **fetch timeout** (see Build below).
  - `src/main/canvasMemory.ts` — wrap `writeBoard`/`writeIndex`/`writeProject` in try/catch + a
    `safeBoardId` length cap (the T-M1 follow-up — required before an autonomous loop calls them).
  - e2e — a probe in `src/main/e2e/probes/` (new, or extend `memory.ts`).
- **Build:**
  - **Loop:** `createSummaryLoop({ llmDataDir, encryptor, getCurrentDir, readProject, now, fetch? }) →
    { onIntent(intent), ... }`. On `onIntent({ boardId })`:
    1. `dir = getCurrentDir()`; bail if null.
    2. `r = readProject(dir)`; bail if `!r.ok`; `board = r.doc.boards.find(b => b.id === boardId)`; bail if
       absent (it was deleted between the debounce and the fire).
    3. Build a `SummarizeInput` from the board's content (MAIN-side defensive pick — terminal
       `launchCommand`/`cwd`/`port`; browser `url`/`viewport`; planning checklist titles+items + note
       text). A short `system` instruction ("Summarize what this board is for in 1–2 sentences…").
       Keep the prompt builder pure + unit-tested.
    4. `config = readLlmConfig(llmDataDir)`; `result = await runSummarize(config, input, deps)` where
       `deps = { fetch, env: process.env, keyStore: createKeyStore(llmDataDir, encryptor),
       budget: createBudgetStore(llmDataDir, now) }`.
    5. On `result.ok` → `mem = createCanvasMemory(dir)`; `mem.writeBoard(boardId, prose)`; refresh
       `MEMORY.md` (rebuild the index from the per-board files / the doc) and `project.md` (a short
       project-level roll-up). On any `!ok` reason → **no-op** (Tier-1 prose-less digest stays).
    6. **In-flight guard:** a `Set<boardId>` so a board already summarizing doesn't start a second
       concurrent call (the debounce coalesces saves, but a slow call + a fresh intent can overlap).
  - **Fetch timeout (llmService):** wrap the provider `fetch` in an `AbortController` with a sane timeout
    (e.g. 30s) so a hung endpoint can't wedge the loop. `runSummarize` already maps a throw to
    `provider-error` → Tier-1, so a timeout degrades gracefully. Keep the transport injectable.
  - **canvasMemory hardening (T-M1 follow-up):** `writeBoard`/`writeIndex`/`writeProject` currently let a
    `write-file-atomic` throw propagate. Wrap each in try/catch (log + return a falsy/void on failure) so
    a disk error in the autonomous loop is non-fatal; add a `safeBoardId` length cap (~64).
- **🔒 Security (locked — this is the milestone the guards protect):**
  - **Opt-in / no implicit spend:** no key → `runSummarize` returns `no-provider` → the loop writes
    nothing and makes no network call. Egress exists only after the user sets a key (Settings, T-B2).
  - **Capped:** the loop MUST go through `runSummarize`, which reserves a call against the **same**
    file-backed per-day budget before the fetch (ADR 0003). Do NOT add a second egress path that
    bypasses the cap. A runaway detector degrades to Tier-1, never overspends.
  - **Passive output (lethal-trifecta):** the summary is **untrusted passive context** — written to disk
    + shown (and later MCP-read). It **never triggers an action**: the loop's only effects are the LLM
    call and the `.canvas/` writes; nothing it produces returns to the PTY write channel, a board patch,
    or any tool. Board content fed INTO the prompt (terminal scrollback, browser page text) is itself
    untrusted — that's fine because the output is treated as passive and the input only ever becomes
    request-body text.
  - **No security-posture change:** `contextIsolation`/`sandbox`/`no-nodeIntegration` untouched; no new
    IPC channel is required (the loop is MAIN-internal, driven by the existing `project:save` feed); the
    key NEVER leaves MAIN / never lands in `.canvas/` / `canvas.json`.
- **e2e:** a `CANVAS_SMOKE=e2e` probe (provider mocked) — point the open dir at a throwaway project (like
  `context-memory`), drive a meaningful change through the engine/loop, and **assert
  `.canvas/memory/board-<id>.md` content CHANGED to the mock summary** AND `MEMORY.md` lists the board.
  Self-clean (restore `setCurrentDir(null)` + rm the temp dir in `finally`), keep it late in the PLAYLIST
  if it touches `currentDir`. Assert off the real on-disk files, not a proxy.
- **Manual:** set a real OpenRouter key in Settings, open a project, edit a note / toggle a checklist item →
  after the ~45s debounce, `.canvas/memory/board-<id>.md` updates with a real summary; reopen → it's
  there. With NO key → nothing is written (Tier-1 only); with a tiny `maxCallsPerDay` cap → after the cap,
  edits stop producing summaries (budget-exceeded → Tier-1).
- **Gate:** full app gate + `CANVAS_SMOKE=e2e`. **Handoff:** fold the summary into
  `docs/context-subsystem.md` (new "M-memory T-M3" subsection) + delete this kickoff. Squash-merge.

### Design notes to settle in the plan (don't silently pick)

1. **Shared deps vs second instance.** Recommended: the loop builds its OWN `keyStore`/`budget` pointed at
   the same `llmDataDir` (file-backed → cap + key are shared with `registerLlmHandlers`). Confirm this
   shares the budget correctly (two `createBudgetStore` on the same `llm-budget.json` — the atomic
   read-modify-write makes it safe), OR refactor index.ts to build ONE `ProviderDeps` and pass it to both
   `registerLlmHandlers` (its `injectedDeps` param) and the loop. Pick one; the file-backed-share is
   lower-churn.
2. **Enablement.** v1 = implicitly opt-in (runs iff a key is configured; no key → no-op). Decide whether to
   add an explicit `memoryLoopEnabled` toggle in `llm-config.json` + Settings now or defer it (recommend
   defer — the key-presence gate + budget cap already bound spend; an explicit off-switch is a small
   follow-on).
3. **`MEMORY.md` / `project.md` shape.** Settle the index format (a list of boards with a one-line gist?
   rebuilt from the per-board files or from the doc?) and how much `project.md` aggregates. Keep it small;
   the panel (T-M4) renders `board-<id>.md` prose first and these as context.
4. **Prompt + input size.** Cap the board-content text fed to the model (truncate long terminal scrollback
   — but note T-M3 reads CONTENT from canvas.json, which does NOT contain live scrollback; see note 5).
   Settle the `system` instruction + a max input length.
5. **Terminal runtime last-command/status is OUT of T-M3 core.** The roadmap mentions capturing the
   terminal's last command + live status, but that needs a PTY-state source (open question #2 in
   `docs/roadmap-context.md` — scrape `pty.ts` output vs a structured terminal-state hook) and is NOT in
   `canvas.json`. **Recommend: T-M3 = content-summary-from-`canvas.json` only**; the runtime last-command
   capture is a separate follow-on card (it touches `pty.ts`, a different zone). Flag this split in the
   plan so the card stays bite-sized.
6. **Concurrency / debounce interaction.** The per-board in-flight guard (Set) + the existing 45s debounce
   should keep spend to ~one call per board per settle. Confirm a board changing again WHILE its summary
   is in flight re-arms the debounce (T-M2 behavior) and the loop doesn't double-fire.

### Out of scope for T-M3 (do NOT build)

- The **panel upgrade** to render cached `.canvas/memory/` prose on reopen + the renderer read bridge →
  **T-M4**.
- The **terminal runtime last-command/live-status** capture (PTY-state plumbing) → a follow-on (note 5).
- The MCP `canvas://memory` **read resource** → **M-expose (DEFERRED, gated on the MCP pkg)**.
- Embeddings / vector search / multi-project memory / any memory-driven *write* action (forbidden).

## Setup commands (new session)

```bash
cd "/z/canvas-ade-context"
git checkout feat/context && git pull           # latest umbrella (T-M2 is in: 221ddf8)
git checkout -b feat/context-m3-summary-loop     # the task sub-branch
```
Declare the zone on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the `canvas-ade-context` row): note
`feat/context-m3-summary-loop` owns NEW `src/main/summaryLoop.ts`(+test), the `index.ts` loop+engine wiring
(⚠️ cross-zone w/ `feat/mcp-integration`, additive), the `llmService.ts` fetch-timeout, the `canvasMemory.ts`
writer-hardening, and the new e2e probe.

## Workflow to follow

1. `superpowers:writing-plans` → author `docs/superpowers/plans/2026-06-0X-context-m3-summary-loop.md`
   (bite-sized TDD tasks; settle the 6 design notes in the plan header). STOP for review.
2. On approval, `superpowers:subagent-driven-development` → fresh implementer per task; spec review then code
   review between tasks; **final holistic SECURITY review** (autonomous spend: confirm no-key → no-op, the
   loop goes through the budgeted `runSummarize`, output is passive/never-acts, no posture change, writers
   can't crash the loop).
3. Controller runs the full gate + `CANVAS_SMOKE=e2e`. **Fold the T-M3 summary into
   `docs/context-subsystem.md`** (NOT a standalone handoff) + delete this kickoff. Squash-merge
   `feat/context-m3-summary-loop` → `feat/context`; update the board + the `context-subsystem` memory.

## Gate (must be green before handoff)

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start    # E2E_DONE — your T-M3 probe ok:true
```
> **Gotchas:** run `pnpm format` before committing (format:check is a hard gate — prettier drift bit
> T-B2/T-B3). The board-e2e `browser`/`browser-gesture`/`focus-detach` trio + `whiteboard-paste-*` /
> `preview-edge` probes are **non-deterministic live-`WebContentsView`/clipboard env flakes on a contended
> host** (memory `e2e-browser-trio-flake`; proven disjoint across runs in T-M2) — your T-M3 probe must be
> green; rerun once for a clean overall, those are NOT regressions. Commit messages with backticks: use a
> quoted heredoc `git commit -F -` (memory `bash-tool-commit-backticks`). Baseline at T-M2: **724 unit**.

---

## Kickoff prompt (paste into the new session)

> Pick up **M-memory T-M3** (Tier-2 autonomous summarize loop) for the Expanse / Canvas ADE **Context**
> subsystem — **the first autonomous-spend path in the app**. Read
> `docs/superpowers/handoffs/2026-06-04-context-m3-kickoff.md` in worktree `Z:\canvas-ade-context` first —
> it has the full brief, the exact seams (T-M2 `{boardId}` intent via the engine's `onIntent`;
> `getCurrentDir`+`readProject` for the board content; budgeted `runSummarize`; `canvasMemory` writers;
> the `index.ts` wiring point), the 6 design notes, setup commands, and the workflow. Also read
> **`docs/context-subsystem.md`** (the compiled architecture + done-milestone build log) and the
> `docs/roadmap-context.md` M-memory T-M3 card and the egress ADR `docs/decisions/0003-llm-egress.md`. Work
> on a sub-branch `feat/context-m3-summary-loop` off `feat/context` (NOT the `Z:\Canvas ADE` main dir).
> Follow the cadence: `writing-plans` → stop for my review → `subagent-driven-development` → gate +
> `CANVAS_SMOKE=e2e`. Build NEW `src/main/summaryLoop.ts`: on a `{boardId}` intent, re-read the board from
> `readProject(getCurrentDir())`, build a `SummarizeInput` from the board's content (MAIN-side defensive
> pick — MAIN can't import the renderer `boardSchema`/`digest.ts`), call the **budgeted** `runSummarize`
> (deps = `createKeyStore`+`createBudgetStore` on `llmDataDir`, file-backed so the cap/key are shared),
> and on `ok` write `.canvas/memory/board-<id>.md` + refresh `MEMORY.md`/`project.md` via `canvasMemory`;
> on `no-provider`/`budget-exceeded`/`provider-error` → **no-op** (Tier-1 stays). Wire it in `index.ts`:
> build the loop (it needs `llmDataDir`+`llmEncryptor`), construct the engine with the real `onIntent`, and
> pass that engine as the 5th arg to `registerProjectHandlers`. Also: add a fetch timeout (AbortController)
> to `llmService` so a hung provider can't wedge the loop; wrap `canvasMemory`'s
> `writeBoard`/`writeIndex`/`writeProject` in try/catch + a `safeBoardId` length cap (the T-M1 follow-up).
> 🔒 Key rules: **no key → no spend / no write**; the loop MUST go through the budgeted `runSummarize` (no
> second egress path that bypasses the cap); generated memory is **untrusted passive context that never
> triggers an action**; no `contextIsolation`/`sandbox`/`nodeIntegration` change; the key never leaves MAIN
> / never lands in `.canvas/`. Mock the provider under e2e (no real network); add a per-board in-flight
> guard. **Out of scope:** the panel cached-prose upgrade (T-M4), the terminal runtime last-command/status
> capture (a follow-on — needs `pty.ts` state, NOT in `canvas.json`), the MCP read resource (M-expose).
> e2e: drive a meaningful change → assert `board-<id>.md` content changed to the mock summary + `MEMORY.md`
> lists the board. When done, **fold the summary into `docs/context-subsystem.md`** (do NOT create a
> standalone handoff) + delete the kickoff, and squash-merge to `feat/context`.
