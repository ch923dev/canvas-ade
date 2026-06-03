# Next-session kickoff — M-brain T-B3 (budget guard + egress ADR)

> **Purpose:** a self-contained brief so a FRESH session (zero prior context) can execute M-brain T-B3.
> Pre-task kickoff, not a post-task handoff. Paste the "Kickoff prompt" at the bottom into the new
> session, or just open this file there.

## Where we are (read first)

- **Subsystem:** the desktop **Context** brain + project memory (MAIN-side LLM that summarizes the canvas
  into a per-board digest). Sibling of MCP, one-way dep, ships independently. Design:
  `docs/superpowers/specs/2026-06-03-desktop-context-memory-design.md`. Roadmap: `docs/roadmap-context.md`.
- **Umbrella branch:** `feat/context` (off `main`, worktree `Z:\canvas-ade-context`). Each task = a
  sub-branch `feat/context-<id>` off `feat/context`, squash-merge back.
- **Done on `feat/context`:** **M-digest** (T-D1 + T-D2). **M-brain T-B1** (provider-agnostic engine,
  `e7f7fcf`) and **T-B2** (safeStorage key store + Settings UX, `5678257`). The umbrella is up as **PR #39**
  (`feat/context` → `main`). Read the **T-B2 handoff first**:
  `docs/superpowers/handoffs/2026-06-03-context-b2-keystore.md` — it documents the engine, the key store,
  the IPC surface, and the security model T-B3 builds on.
- **Cadence (standing):** each task ships **Build · e2e (`CANVAS_SMOKE` probe) · Manual · Gate
  (typecheck/lint/format/test/build) · Handoff doc**. Follow `writing-plans` → STOP for review →
  `subagent-driven-development`. Declare the zone on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md`
  first. Never work in the `Z:\Canvas ADE` main dir.
- **Memory:** `context-subsystem`.

## What T-B1/T-B2 left for you (the seams)

- **`src/main/llmService.ts`** owns the engine: `runSummarize(config, input, deps) → SummarizeResult`
  (never throws; maps every failure to a typed result), `getProvider(config, deps)`, and the IPC handlers
  (`registerLlmHandlers`). The **one outbound egress** is isolated inside the real `Provider.summarize`
  (the `deps.fetch` call) — exactly where the budget guard bolts on. `SummarizeResult` is the typed union
  that crosses IPC: `{ok:true,text} | {ok:false,reason:'no-provider'} | {ok:false,reason:'provider-error',message}`.
- **`src/main/llmConfig.ts`** persists `{provider, model, baseUrl?}` to `userData/llm-config.json` (atomic,
  explicit `userDataDir` → testable without Electron). **`src/main/llmKeyStore.ts`** is the safeStorage key
  store (injectable `Encryptor`, same `userDataDir` discipline). Mirror these patterns for budget state.
- **Mock seam:** `isMockEnabled(env)` (true under `CANVAS_LLM_MOCK=1` or `CANVAS_SMOKE=e2e`) returns a mock
  provider — **checked first**, no network in CI/e2e.

## The task — M-brain T-B3 (from `docs/roadmap-context.md` › M-brain › T-B3)

- **Zones:** app — budget logic in `src/main/llmService.ts` (or a new `src/main/llmBudget.ts` — settle in
  the plan), `src/preload/index.ts` (extend the `SummarizeResult` mirror), `docs/decisions/` (NEW ADR).
- **Build:**
  - **Per-day budget cap** (configurable: token and/or call cap). Hard-stop when hit → a new typed
    result `{ok:false, reason:'budget-exceeded'}` surfaced through `runSummarize` (never throws; the app
    falls back to Tier-1). Cheap/fast default cap. Spend counter persisted in `userData` (atomic write,
    per-day reset), injectable like `llmConfig`/`llmKeyStore` so it unit-tests without Electron.
  - **Egress ADR** (`docs/decisions/0003-llm-egress.md` — confirm 0003 is free on `feat/context`):
    the MAIN→LLM endpoint is the one new egress beyond loopback — **opt-in** (no key/no mock → no call,
    already true), user-controlled, documented. Confirm `contextIsolation`/`sandbox`/`no-nodeIntegration`
    unchanged; note the browser-board Host-header attack surface is out of scope here (that's the MCP ADR,
    memory `mcp-spec-state-2026-06`).
- **e2e:** a `context.ts`/`settings.ts`-style probe under `CANVAS_SMOKE=e2e` (mock provider, no network):
  set a tiny cap, drive calls past it → assert `{ok:false, reason:'budget-exceeded'}` AND the app stays
  usable (Tier-1 digest still renders / `runSummarize` degrades cleanly). Assert the spend counter lives in
  the temp e2e dir, never a project folder.
- **Manual:** set a tiny cap → trigger summaries → hit the cap → see the surfaced stop; Tier-1 digest still
  renders. Confirm the counter resets the next day.
- **Gate:** full app gate + e2e. **Handoff:** `…-context-b3-budget-egress.md` + the ADR link.

### Design notes / decisions to settle in the plan (don't silently pick)

1. **Module boundary.** Budget in a **new `src/main/llmBudget.ts`** (mirrors `llmKeyStore.ts`: explicit
   `userDataDir`, injectable clock) vs folded into `llmService.ts`. Recommend a separate module — keeps the
   engine lean and the T-B1 follow-up (below) cleaner. Settle.
2. **Cap dimension.** Token cap, call cap, or both. Tokens need a usage source — OpenAI/OpenRouter
   responses carry `usage.total_tokens`, Anthropic carries `usage.{input,output}_tokens`; `local` may omit
   it. Decide: count CALLS as the deterministic v1 cap (simple, always available) and/or tokens from
   response usage when present (estimate otherwise). Settle the default cap value.
3. **Reset window.** Per calendar-day (local) vs rolling 24h. Needs a clock → **inject the clock** so unit
   tests are deterministic (don't call `Date.now()` directly in the tested core).
4. **Where the guard fires.** Before the `deps.fetch` inside the real provider, or in `runSummarize`
   before `getProvider`. The mock seam must NOT be capped (CI/e2e is unlimited unless the probe sets a cap
   explicitly via an injected budget). Settle so the mock path stays free.
5. **Contract addition.** `SummarizeResult` gains `{ok:false, reason:'budget-exceeded'}` — mirror it in
   `src/preload/index.ts` (`LlmSummarizeResult`) and confirm every caller treats it like `no-provider`
   (degrade to Tier-1). No new key/secret crosses IPC.
6. **Config surface.** Where the cap is set: `llmConfig.json` (add `maxCallsPerDay?`/`maxTokensPerDay?`) vs
   a dedicated budget config file. A Settings-modal budget field is **optional** (YAGNI — a config value is
   enough for T-B3; the modal already exists if you want one field). Settle.
7. **T-B1 follow-up (flagged by both T-B1 and T-B2 handoffs).** Now that `llmService.ts` is ~300 lines,
   **split the IPC layer out into `src/main/llmIpc.ts`**, leaving `llmService.ts` as the pure provider
   engine. Decide whether to do this AS PART OF T-B3 (natural moment — you're adding a budget result to the
   IPC) or defer. Recommend doing it here.

### Out of scope for T-B3 (do NOT build)

- The `.canvas/` memory engine + autonomous summary loop → **M-memory** (T-M1…T-M4).
- The MCP egress / Host-header ADR (separate, on the MCP branch).
- Rich budget analytics / per-provider budgets / multi-day history.

## Setup commands (new session)

```bash
cd "/z/canvas-ade-context"
git checkout feat/context && git pull              # ensure latest umbrella (T-B2 is in, PR #39 up)
git checkout -b feat/context-b3-budget-egress      # the task sub-branch
```
Declare the zone on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the `canvas-ade-context` row):
note `feat/context-b3-budget-egress` owns the new `src/main/llmBudget.ts`(+test) [or the budget block in
`llmService.ts`], the `SummarizeResult`/preload mirror addition, the optional `llmIpc.ts` split,
`docs/decisions/0003-llm-egress.md`, and the new e2e budget probe.

## Workflow to follow

1. `superpowers:writing-plans` → author `docs/superpowers/plans/2026-06-0X-context-b3-budget-egress.md`
   (bite-sized TDD tasks; settle the 7 design notes in the plan header). Stop for review.
2. On approval, `superpowers:subagent-driven-development` → fresh implementer per task; spec review then
   code review between tasks; final holistic review (security: confirm the egress stays opt-in + the cap
   can't be bypassed; no new secret on disk/IPC).
3. Controller runs the full gate + `CANVAS_SMOKE=e2e`. Write the T-B3 handoff + link the ADR. Squash-merge
   `feat/context-b3-budget-egress` → `feat/context`; update the board + the `context-subsystem` memory.

## Gate (must be green before handoff)

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start    # E2E_DONE ok:true (browser-trio = known env flake)
```

> **Gotchas (from T-B2):** implementers must run `pnpm format` before committing (format:check is a hard
> gate — prettier drift bit T-B2). The board-e2e browser/browser-gesture/focus-detach trio is a known
> `capturePage` env flake on a contended host — rerun once for a clean `E2E_DONE ok:true` (memory
> `e2e-browser-trio-flake`). Mock-first means e2e never hits the network; keep the budget cap from
> throttling the mock path unless the probe opts in.

---

## Kickoff prompt (paste into the new session)

> Pick up **M-brain T-B3** (per-day budget guard + egress ADR) for the Expanse / Canvas ADE **Context**
> subsystem. Read `docs/superpowers/handoffs/2026-06-03-context-b3-kickoff.md` in worktree
> `Z:\canvas-ade-context` first — it has the full brief, the 7 design notes to settle, setup commands, and
> the workflow. Also read the **T-B2 handoff** `docs/superpowers/handoffs/2026-06-03-context-b2-keystore.md`
> (the engine + key-store + IPC surface T-B3 builds on) and the `docs/roadmap-context.md` M-brain T-B3 card.
> Work on a sub-branch `feat/context-b3-budget-egress` off `feat/context` (NOT the `Z:\Canvas ADE` main dir).
> Follow the cadence: `writing-plans` → stop for my review → `subagent-driven-development` → gate +
> `CANVAS_SMOKE=e2e` + handoff. Key rules: the budget guard returns a typed `{ok:false,reason:'budget-exceeded'}`
> (never throws; app falls back to Tier-1); the cap is configurable + the spend counter lives in `userData`
> (never a project folder), injectable for tests; the MAIN→LLM egress stays opt-in (no key/no mock → no
> call) and gets an ADR (`docs/decisions/0003-llm-egress.md`); the mock seam (`CANVAS_SMOKE=e2e`) stays
> uncapped/no-network; consider splitting the IPC layer out of `llmService.ts` into `llmIpc.ts` while you're
> here.
