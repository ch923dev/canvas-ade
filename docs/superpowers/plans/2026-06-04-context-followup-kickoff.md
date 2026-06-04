# Context-brain follow-up — kickoff (non-blocking polish + terminal runtime capture)

> **Branch:** `feat/context-followup` (base `main`, worktree `Z:\canvas-ade-context-followup`).
> **Why:** the core Context subsystem (M-digest + M-brain + M-memory) shipped to `main` 2026-06-04
> (`4c321c2`, PR #39). This PR clears the **non-blocking** follow-on backlog that does **not** require MCP.
> The MCP-gated piece (**M-expose** — `canvas://memory` read resource) is a SEPARATE later milestone and is
> NOT in this PR.
> **Build log of the shipped subsystem:** `docs/context-subsystem.md`. **Roadmap:** `docs/roadmap-context.md`.
> **Egress contract:** `docs/decisions/0003-llm-egress.md`.

Legend: 🚦 gate · ✅ acceptance · 🔒 security-critical · ⛓ depends-on · ∥ parallelizable · ⚠️ cross-zone.

---

## 0. Scope (decided 2026-06-04)

**Everything non-blocking, in ONE PR off `main`:** the headline terminal-runtime-status capture + five
small polish items. UI *placement* tweaks (panel/Settings positioning the user flagged while testing) are
**OUT** — deferred to after MCP per the user.

| Task | What | Size | ∥? | ⚠️ |
|---|---|---|---|---|
| **T-F1** | Terminal runtime status capture (last-command / live status into memory) | **headline** | no | pty.ts CROSS-ZONE w/ MCP |
| **T-F2** | F-C — align board `title` between summary input and change fingerprint | S | ∥ | |
| **T-F3** | Panel a11y — `inert` on the digest `<aside>` when closed | S | ∥ | |
| **T-F4** | Stale/refresh affordance — manual "refresh summary" per board | M | ∥ | adds a renderer-triggered (budget-gated) summarize path |
| **T-F5** | Model-id verify — confirm/refresh `DEFAULT_MODELS` vs live provider docs | S | ∥ | |
| **T-F6** | Linux no-keyring warn — surface safeStorage-unavailable in Settings | S | ∥ | |

The small items (T-F2/3/5/6) are MCP-disjoint and can land in any order. **T-F1 is the only cross-zone
risk** (see §2).

**Do NOT change** the locked security model: key inbound-only / `safeStorage`-in-userData / generated
memory is untrusted passive context that never drives an action / `contextIsolation`+`sandbox`+
`no-nodeIntegration` untouched / egress only via the budgeted `runSummarize`.

---

## 1. Tasks

### T-F1 — Terminal runtime status capture 🔒 ⚠️ (headline)

**Problem.** The digest shows what's *configured* on a terminal board (`launchCommand`/`cwd`/`port` from
`canvas.json`) but **nothing about runtime** — is the agent running or idle? what did it last run? Tier-1 is
disk-only by design (`digest.ts` comment: "terminal last-command + live status are runtime-only → NOT in
Tier-1; the Tier-2 loop captures them later"), and the Tier-2 loop currently summarizes `canvas.json`
content only. So runtime status is captured **nowhere** today. This task closes that gap.

**Architectural constraint (read before designing).** Runtime state lives in **MAIN** (`pty.ts`), not on
disk. The renderer/Tier-1 path cannot see it. Two ways to surface it:
- **(a) Tier-2 loop folds it into `board-<id>.md`** — MAIN already runs the loop and can read pty state;
  shown on reopen (not live). Consistent with the existing architecture, **no new live surface**.
- **(b) a live `terminal:status` IPC feeding the panel** — richer (live), but a new renderer-facing surface
  + more frame-guarded IPC.
Recommend **(a) for this PR** (fold into the summarize input + prose), optionally a thin live line later.

**🔓 OPEN QUESTION (decide in the executing session's brainstorm — left open on purpose):**
*How does the loop source the runtime data?*
- **Option A — structured terminal-state hook in `pty.ts` (RECOMMENDED).** Track a per-session record
  `{ state, lastActivityAt, exitCode? }` (the `PtyState` `'spawning'|'running'|'exited'|'spawn-failed'`
  union already exists in `preload/index.d.ts` / `pty.ts`). Expose a **MAIN-internal getter**
  (`getTerminalRuntime(boardId)`), inject it into `createSummaryLoop` like `getCurrentDir`/`readProject`.
  Low coupling, no scrollback parsing, deterministic + unit-testable with a fake.
- **Option B — scrape the PTY scrollback** for the last typed command + status. Higher coupling, brittle
  (ANSI/ConPTY soft-wrap, prompt detection), hard to test. **Not recommended.**
- **Scope nuance:** capturing the literal *last typed command* is the brittle part (needs input/output
  parsing). The cheap, high-value win is **state** (running/idle/exited + `lastActivityAt`) + the already-known
  `launchCommand`. Recommend shipping **state first**; treat typed-last-command as a stretch/Option-B follow-on.

**⚠️ CROSS-ZONE — `pty.ts` is heavily owned by MCP** (`feat/mcp-integration` #32: `listPtySessions`,
`writeToPty`, session state). MCP #32 is the **next merge** after context. To avoid a painful `pty.ts`
conflict:
- **Sequence T-F1 to land AFTER MCP #32 is on `main`**, and **reuse** whatever session-state structure MCP
  added (it already tracks `PtyState`; likely a `lastActivityAt` is a tiny addition). Do NOT duplicate a
  parallel state machine.
- If you start before MCP lands, keep the `pty.ts` touch **minimal + additive** (one getter + one field) and
  expect to rebase.

**Build (Option A shape):**
- `src/main/pty.ts` — add/confirm a per-session `lastActivityAt` (bump on data) + a `getTerminalRuntime(id)
  → { state, lastActivityAt, exitCode? } | undefined` MAIN-internal accessor. No new renderer IPC for (a).
- `src/main/summaryLoop.ts` — inject `getTerminalRuntime` into `SummaryLoopDeps`; in `buildSummarizeInput`
  for a terminal board, append a runtime line (`Status: running, last active <relative>` / `idle` /
  `exited (code N)`). Keep it defensive (getter returns undefined → omit, never throw). Update the
  `boardContent` parity comment.
- `src/main/index.ts` — wire the real `getTerminalRuntime` into `createSummaryLoop`.
- **Detector:** runtime status changing does NOT change `canvas.json`, so `project:save` won't fire the
  detector. Decide: (i) accept that runtime status only refreshes when *content* changes (cheapest), or
  (ii) add a lightweight idle→active transition nudge into the engine. Recommend **(i)** for this PR +
  rely on **T-F4 manual refresh** for on-demand runtime updates. Document the choice.

**Tests:** unit `buildSummarizeInput` with a fake `getTerminalRuntime` (running/idle/exited/undefined);
`summaryLoop` integration with a stub runtime; pty getter unit (state + lastActivityAt). No e2e mandatory
(per `docs/testing/TESTING.md` Context has no e2e sliver — but a pty.ts change is MAIN/native, so if MCP's
pty e2e exists, keep it green).

**✅ Acceptance:** with a key + the loop on, a running terminal board's `board-<id>.md` prose reflects its
runtime state; no-pty-state → graceful omit; never throws / never blocks a save.

---

### T-F2 — F-C: align `title` between summary input and fingerprint (S, ∥)

**Problem.** `summaryLoop.boardContent` puts the board **title** in the summary prompt, but
`memoryEngine.boardFingerprint` excludes it → a title-only rename never re-summarizes, so cached prose can
keep naming the old title. The module docstrings claim the two field sets mirror each other; they diverge on
`title`.

**Decision (pick one; recommend the first):**
- **Drop `title` from `boardContent`** (cheapest — no rename-triggered spend; the panel card already shows
  the live title; `stripHeading` removes the `# title` line anyway). Make the prompt type-generic
  (`"Terminal board."` etc.). Update docstrings + the `summaryLoop` tests.
- *or* **Add `title` to `boardFingerprint`** (rename refreshes prose; costs one summarize per rename).
  Update `memoryEngine.test.ts` (the move-invariant test currently asserts a `title:'Renamed'` change is
  identical — flip it) + the parity docstrings.

**✅ Acceptance:** the fingerprint and the summary input agree on `title`; docstrings true; tests cover it.

---

### T-F3 — Panel a11y: `inert` when closed (S, ∥)

The digest `<aside>` stays mounted + slid off-screen when closed, so its buttons remain in the tab order.
Add `inert` (+ keep `aria-hidden`) on `DigestPanel.tsx`'s `<aside>` when `!open`. jsdom test asserts the
attribute reflects `open`. (Original M-digest follow-up.)

---

### T-F4 — Stale/refresh affordance (M, ∥)

A manual "refresh summary" control so a user can force a re-summary without waiting for the 45s debounce or
a content edit (also the on-demand path for T-F1 runtime status).

- **MAIN:** a guarded IPC `memory:refresh(boardId)` → calls `summaryLoop.onIntent({ boardId })` directly
  (bypasses the debounce; still goes through the budgeted `runSummarize` + key gate — **no new egress
  rules**, same opt-in/cap). Foreign-sender guarded. Returns a typed `{ ok }` / no-op when no key/over-cap.
- **Preload:** `api.memory.refresh(boardId)`.
- **Renderer:** a small ⟳ on each `DigestPanel` card → calls refresh, shows an "updating…" state, then
  re-reads prose via the existing `memory.readBoards`. Respect `prefers-reduced-motion`.
- 🔒 Still passive: refresh only writes `.canvas/` prose; never drives an action.

**Tests:** integration for `memory:refresh` (foreign-sender reject · no-dir no-op · calls the loop);
jsdom for the card control (calls refresh + shows pending). 

**Open nuance:** `summaryLoop.onIntent` is currently fire-and-forget `void`; for a UI "updating…→done" you
may want it to resolve. It already returns `Promise<void>` and is best-effort — await it for the refresh
path. Keep the detector path fire-and-forget.

---

### T-F5 — Model-id verify (S, ∥)

The defaults were bumped 2026-06-04 (openrouter `google/gemini-2.5-flash`, openai `gpt-4.1-nano`, anthropic
`claude-haiku-4-5`) after the openrouter default was discontinued. **Re-confirm each id is current at
execution time** (provider docs / OpenRouter models list) and bump if any drifted. Keep
`src/main/llmConfig.ts` `DEFAULT_MODELS` and `src/renderer/src/lib/llmModels.ts` **in lockstep** (they are
hand-mirrored). Consider a tiny unit test asserting the two `DEFAULT_MODELS` objects are deep-equal to kill
the drift class for good.

---

### T-F6 — Linux no-keyring warn (S, ∥)

When `safeStorage.isEncryptionAvailable()` is false (Linux without a keyring), the key can't be encrypted —
today `setKey` only fails on Save with `encryption-unavailable`. Surface it **proactively**: add an
`encryptionAvailable` boolean to `llm:status`, and in `SettingsModal` show a one-line notice ("No system
keyring — key can't be stored encrypted; set an env var like `OPENROUTER_API_KEY` instead") when false.
Don't weaken the no-plaintext rule. jsdom test for the notice.

---

## 2. Ordering, cross-zone, merge

- **Small items (T-F2/3/5/6) are MCP-disjoint** — safe to build in parallel, any order.
- **T-F1 touches `pty.ts` → CROSS-ZONE with MCP #32** (the next merge). **Recommended: do T-F1's `pty.ts`
  work after MCP #32 lands on `main`** (rebase this branch onto post-MCP main first) so you reuse MCP's
  session-state rather than colliding. If MCP slips, keep T-F1 additive + minimal.
- **T-F4** depends on `summaryLoop` only (no MCP).
- **This PR targets `main`.** Merge order in the queue: MCP #32 next → … → rebrand #17 last. Slot this
  follow-up **after MCP** (because of `pty.ts`); the small items could even be split into an earlier
  MCP-disjoint PR if you want them in sooner.

---

## 3. Gate & cadence

- **Gate (every task):** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`
  (Vitest unit + integration). **No mandatory e2e** for Context per `docs/testing/TESTING.md` — but T-F1
  touches MAIN/`pty.ts`, so if the local pre-commit Playwright matrix covers terminal/pty, keep it green
  (the pre-commit hook runs it automatically; Docker must be up for the Linux leg).
- **Cadence:** subagent-driven, one sub-task at a time, per-task spec + two-stage review, a final holistic
  (security-aware) review before the →main PR. Squash-merge sub-branches back into `feat/context-followup`.
- **Docs:** record DONE tasks into `docs/context-subsystem.md` (consolidated-docs discipline — do NOT create
  per-task handoffs); update `docs/roadmap-context.md` cards; clear the resolved entries from its
  "Open questions".

---

## 4. Files in scope (declare on the coordination board)

`src/main/{summaryLoop,memoryEngine,llmConfig,llmKeyStore,pty.ts,index.ts}.ts` ·
`src/main/projectIpc.ts` (if T-F4 IPC) · `src/preload/index.ts` (T-F4/T-F6 bridge fields) ·
`src/renderer/src/canvas/{DigestPanel,SettingsModal}.tsx` · `src/renderer/src/lib/{digest,llmModels}.ts` ·
`docs/{context-subsystem,roadmap-context}.md`. ⚠️ `pty.ts` + `index.ts` + `preload` overlap
`feat/mcp-integration` — coordinate / sequence after MCP.

## 5. Out of scope

UI placement/layout tweaks (deferred to after MCP) · M-expose (`canvas://memory` MCP resource, MCP-gated) ·
live `terminal:status` IPC (option (b) above — defer unless the executing session decides the loop-fold is
insufficient) · token-dimension budget · multi-project/global memory.
