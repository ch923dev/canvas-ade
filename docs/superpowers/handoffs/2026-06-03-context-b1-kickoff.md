# Next-session kickoff — M-brain T-B1 (provider-agnostic LLM service)

> **Purpose:** a self-contained brief so a FRESH session (zero prior context) can execute M-brain T-B1.
> This is a *pre-task kickoff*, not a post-task handoff. Paste the "Kickoff prompt" below into the new
> session, or just open this file there.

## Where we are (read first)

- **Subsystem:** the desktop **Context** brain + project memory — a MAIN-side LLM that summarizes the
  canvas into a persistent per-board digest. Sibling of the MCP roadmap, **one-way dep**, ships
  independently. Full design: `docs/superpowers/specs/2026-06-03-desktop-context-memory-design.md`.
  Task roadmap: `docs/roadmap-context.md`.
- **Umbrella branch:** `feat/context` (off `main`, worktree `Z:\canvas-ade-context`). It is THE single
  umbrella for ALL Context phases (decided 2026-06-03). Synced with latest `main` at merge `ec04454`.
- **Done:** **M-digest** (T-D1 pure `buildDigest` in `src/renderer/src/lib/digest.ts` + T-D2 slide-in
  `DigestPanel`). Gate green (607 unit), e2e `context-digest` green.
- **Cadence (standing):** each task = a sub-branch `feat/context-<id>` off `feat/context`,
  squash-merge back when green. Every task ships **Build · e2e (CANVAS_SMOKE probe) · Manual · Gate
  (typecheck/lint/format/test/build) · Handoff doc**. Declare zones on
  `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` first. Never work in the `Z:\Canvas ADE` main dir.
- **Memory:** `context-subsystem` (the durable state of this work).

## The task — M-brain T-B1

Build MAIN's provider-agnostic LLM adapter (the engine only; key-storage UX is T-B2, budget+ADR is
T-B3). From `docs/roadmap-context.md` › M-brain › T-B1:

- **Zones:** app — `src/main/llmService.ts` (+ `llmService.test.ts`), `src/preload/index.ts` (a guarded
  `llm:summarize` / `llm:status` bridge), `src/main/index.ts` (register the IPC handlers).
- **Build:** `summarize(input) → string` behind a small `Provider` interface; implementations for
  **OpenRouter (default)**, OpenAI, Anthropic, a local endpoint. One HTTP shape per provider. Provider +
  model config persisted in `userData`; default model = a **cheap/fast class** model, user-overridable.
- **Graceful degrade:** no key / provider error → a typed `NoProvider` (callers fall back to Tier-1).
  The app NEVER blocks on the brain.
- **e2e:** a probe (extend `src/main/e2e/probes/context.ts` or a new `brain.ts`) with a **mock provider**
  (injected via an env/test seam — NO real network in CI) asserting the IPC round-trip returns the stub
  summary.
- **Manual:** with a real key set, a dev-mode trigger calls `summarize("hello")` → the model's reply
  shows in the MAIN log.

### Design notes / decisions to settle in the plan (don't silently pick)

1. **Key source for T-B1.** Full key storage (`safeStorage` + Settings modal) is **T-B2**. For T-B1,
   read the key from an **env var** (e.g. `OPENROUTER_API_KEY`) as a stopgap so the adapter is testable
   now; T-B2 swaps in `safeStorage`. Confirm this in the plan. **Never** read/write the key from the
   project folder / `.canvas/` / `canvas.json` — it is app config (userData / env only).
2. **Mock seam for e2e.** Decide how MAIN injects a stub provider under `CANVAS_SMOKE` (e.g. an env flag
   `CANVAS_LLM_MOCK=1` that makes `llmService` resolve a fixed string without a network call). The
   contract test for `llmService` should use a fake `fetch`/transport, not the network.
3. **Egress.** T-B1 introduces the FIRST outbound call (MAIN → the LLM endpoint) — the one new egress
   beyond loopback. It is opt-in (no key/config → `NoProvider`, no call). The formal **ADR lands in
   T-B3**; T-B1 should keep the call isolated behind the `Provider` interface so the ADR + budget guard
   bolt on cleanly. Do NOT weaken `contextIsolation`/`sandbox`/`no-nodeIntegration`.
4. **Injection safety.** Board content will later flow INTO `summarize` (M-memory). Keep `llmService`
   pure I/O — it returns text; it must never execute or act on the model output. (The untrusted-passive
   rule is enforced at the memory layer, but don't add any "tool call"/action capability here.)
5. **Provider interface shape.** Keep it minimal + stable across providers:
   `interface Provider { summarize(input: SummarizeInput): Promise<string> }` with a factory
   `getProvider(config): Provider | null` (null → `NoProvider`). Pin the request/response mapping per
   provider (OpenRouter ≈ OpenAI chat-completions shape; Anthropic = messages API; local = configurable
   base URL).

### Out of scope for T-B1 (do NOT build)

- `safeStorage` key store + Settings modal → **T-B2**.
- Budget guard + egress ADR → **T-B3**.
- The `.canvas/` memory engine + autonomous summary loop → **M-memory**.

## Setup commands (new session)

```bash
cd "/z/canvas-ade-context"
git checkout feat/context && git pull            # ensure latest umbrella
git checkout -b feat/context-b1-llmservice       # the task sub-branch
```
Declare the zone on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the `canvas-ade-context` row):
note `feat/context-b1-llmservice` owns `src/main/llmService.ts(+test)`, `src/preload/index.ts`,
`src/main/index.ts`, the e2e brain probe.

## Workflow to follow

1. `superpowers:writing-plans` → author `docs/superpowers/plans/2026-06-0X-context-b1-llmservice.md`
   (bite-sized TDD tasks; settle the 5 design notes above in the plan header). Stop for review.
2. On approval, `superpowers:subagent-driven-development` → implement task-by-task (fresh implementer
   per task; spec review then code review between tasks).
3. Controller runs the full gate + `CANVAS_SMOKE=e2e` (the harness still runs locally; note CI's board
   smoke is frozen by #35). Write the T-B1 handoff. Squash-merge `feat/context-b1-llmservice` →
   `feat/context`; push; update the coordination board + the `context-subsystem` memory.

## Gate (must be green before handoff)

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start    # E2E_DONE ok:true (browser-trio = known env flake)
```

---

## Kickoff prompt (paste into the new session)

> Pick up **M-brain T-B1** (provider-agnostic LLM service) for the Expanse / Canvas ADE **Context**
> subsystem. Read `docs/superpowers/handoffs/2026-06-03-context-b1-kickoff.md` in worktree
> `Z:\canvas-ade-context` first — it has the full brief, the design notes to settle, setup commands, and
> the workflow. Then read the design spec `docs/superpowers/specs/2026-06-03-desktop-context-memory-design.md`
> §5.2 and the `docs/roadmap-context.md` M-brain T-B1 card. Work on a sub-branch
> `feat/context-b1-llmservice` off `feat/context` (NOT the `Z:\Canvas ADE` main dir). Follow the
> cadence: `writing-plans` → stop for my review → `subagent-driven-development` → gate + `CANVAS_SMOKE=e2e`
> + handoff. Key rule: the API key is app config (env var for T-B1, `safeStorage` later) — NEVER the
> project folder; no key → `NoProvider` graceful-degrade; mock the provider in e2e (no real network).
