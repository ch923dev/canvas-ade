# Handoff — Context-brain follow-up (start here, next session)

**You are picking up the non-blocking follow-on backlog for the Context subsystem.** The core
(M-digest + M-brain + M-memory) already SHIPPED to `main` (2026-06-04, `4c321c2`, PR #39). This work is
**not** MCP-gated (that's M-expose, separate/deferred).

## Where you are
- **These planning docs live on branch `feat/context-followup`** (pushed; base `main` `b69a30a`). There is
  **no pre-made worktree or PR** — when you start implementing, create your own worktree from this branch
  (`pwsh .claude/tools/new-worktree.ps1 -Name context-followup -Base feat/context-followup ...`) so you get
  these docs + node_modules junction. One session per worktree.
- **READ FIRST:** the kickoff plan `docs/superpowers/plans/2026-06-04-context-followup-kickoff.md` — full
  scope, per-task design, the open question, cross-zone, gate, ordering. This handoff is the short version.
- Supporting context: `docs/context-subsystem.md` (shipped build log), `docs/roadmap-context.md`,
  `docs/decisions/0003-llm-egress.md` (egress invariants — do not weaken).

## What to build (one PR off `main`, scope = "everything non-blocking")
1. **T-F1 (headline) — terminal runtime status capture.** Digest/memory currently shows nothing about a
   terminal's runtime (running/idle/exited, last activity) — Tier-1 is disk-only, the Tier-2 loop only reads
   `canvas.json`. Fold runtime state into the summary via the loop (MAIN-side).
   - 🔓 **OPEN QUESTION — brainstorm + decide first:** how does the loop source runtime data?
     **Option A (recommended): a structured terminal-state hook in `pty.ts`** (`getTerminalRuntime(id)`,
     reuse the existing `PtyState` union, add `lastActivityAt`) injected into `createSummaryLoop`.
     Option B: scrape PTY scrollback (brittle — avoid). Ship **state** first; literal last-typed-command is a
     stretch.
   - ⚠️ **`pty.ts` is CROSS-ZONE with MCP #32** (the next merge, owns `listPtySessions`/`writeToPty`/state).
     **Recommended: do the `pty.ts` part AFTER MCP #32 lands on `main`** (rebase onto post-MCP main, reuse
     MCP's session state). If you start earlier, keep the `pty.ts` touch minimal + additive.
2. **T-F2** — F-C: make `boardFingerprint` and `summaryLoop.boardContent` agree on `title` (recommend: drop
   `title` from `boardContent`). Fixes "title rename never refreshes prose." Update docstrings + tests.
3. **T-F3** — a11y: add `inert` to the `DigestPanel` `<aside>` when closed.
4. **T-F4** — manual "refresh summary" per card: guarded `memory:refresh(boardId)` IPC → `summaryLoop.onIntent`
   (bypass debounce, same key+budget gate, still passive) + a ⟳ control that re-reads prose.
5. **T-F5** — re-verify `DEFAULT_MODELS` ids are current (openrouter `google/gemini-2.5-flash`, openai
   `gpt-4.1-nano`, anthropic `claude-haiku-4-5`); keep `llmConfig.ts` ↔ `llmModels.ts` in lockstep (add a
   deep-equal unit test).
6. **T-F6** — Linux no-keyring: add `encryptionAvailable` to `llm:status` + a proactive Settings notice.

**Out of scope:** UI *placement* tweaks (deferred to after MCP per the user) · M-expose · a live
`terminal:status` IPC.

## Constraints (do not weaken)
Key inbound-only + `safeStorage`-in-userData · generated memory is untrusted passive context, NEVER drives
an action · every IPC frame-guards foreign senders · egress only via the budgeted `runSummarize` (opt-in,
capped) · `contextIsolation`/`sandbox`/`no-nodeIntegration` untouched.

## Cadence & gate
- Subagent-driven, one task at a time, per-task spec + two-stage review + a final holistic security-aware
  review before the →main PR. Squash sub-branches back into `feat/context-followup`.
- **Gate per task:** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`. No
  mandatory e2e for Context (`docs/testing/TESTING.md`), but T-F1 touches MAIN/`pty.ts` → keep the
  pre-commit Playwright matrix green (Docker up for the Linux leg).
- Record DONE into `docs/context-subsystem.md` (consolidated-docs — no per-task handoffs); update
  `docs/roadmap-context.md`.

## Suggested order
Start with the **MCP-disjoint small items in parallel** (T-F2, T-F3, T-F5, T-F6) and **T-F4** to get value
in fast and de-risk. Hold **T-F1** until MCP #32 is on `main` (or do its non-`pty.ts` plumbing first, then
the `pty.ts` getter last on a rebased tree). Either way: **rebase onto current `main` before the →main PR**
and re-run the full gate + matrix.

## Coordination
Row is on `.claude/coordination/ACTIVE-WORK.md` (`canvas-ade-context-followup`). Other live worktrees:
`feat/mcp-integration` (#32, owns `pty.ts`/`index.ts`/`preload` — coordinate), `integration/context-mcp`,
`chore/docs-hygiene`. Stay in your zone; the `pty.ts`/`index.ts`/`preload` lines are shared — note before
editing.
