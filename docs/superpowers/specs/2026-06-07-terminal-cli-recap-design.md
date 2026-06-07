# Design — Terminal / Agent-CLI Session Recap

**Date:** 2026-06-07
**Branch:** `feat/terminal-recap`
**Status:** Design — awaiting user sign-off before plan
**Author:** session on `main` (lead) → worktree `canvas-ade-terminal-recap`

---

## 1. Goal

When a terminal board runs an agentic CLI (e.g. `claude` doing a code review), the app should
produce a **high-quality, resume-able recap of what the agent was doing**, so the user can glance at
a board and pick up where they left off ("reviewed `auth.ts`, found 3 issues, mid-fix on the token
expiry check") instead of re-reading the whole terminal.

This is the **first feature to be verified end-to-end and working**. The bar is: spawn a real
`claude` session, do some work, trigger the recap, see an accurate prose summary in the UI — proven
with a live run, not just unit tests.

---

## 2. Problem & research findings

The Context-Brain already has a Tier-2 summarizer (`summaryLoop` → `runSummarize` → prose in
`.canvas/memory/board-{id}.md`, shown in `DigestPanel`). Today it summarizes only **board config**
(launchCommand / cwd / port) + a **runtime status line** (running/idle/exited). It does NOT see what
the agent actually did. The desired capability does not exist yet.

Three research threads (2026-06-07) settled the *how*:

1. **Scraping PTY scrollback is the wrong source.** Agentic CLIs (Claude Code, Codex, Gemini) run in
   the terminal **alternate-screen buffer** — full-screen redraws via cursor addressing; content is
   never committed to scrollback. `readPtyOutput` (`src/main/pty.ts:829`) returns a 256 KB
   ANSI-stripped ring (`RING_CAP_BYTES = 262144`), paged at 25 KB (`MAX_OUTPUT_PAGE`). For a TUI that
   yields a soup of half-drawn frames + spinner glyphs — only the final frame survives, mangled.
   Low signal. **Last-resort fallback only.**

2. **The real source is the agent's on-disk transcript.** Claude Code persists a full JSONL
   conversation transcript at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` — one JSON object
   per line (user turns, assistant messages, tool_use, tool_result). It is appended live, so it is
   readable mid-session. Reading the file costs **zero tokens** (it already exists on disk). This is
   the universal high-quality signal; every major CLI writes an equivalent (Codex JSONL, Gemini
   JSONL, aider markdown, opencode SQLite).

3. **Hands-free is realistic two ways:** (a) install a Claude Code `Stop`/`SessionEnd` **hook** that
   pushes `session_id` + `transcript_path` — accurate but mutates the user's `~/.claude/settings.json`
   (invasive, trust concern, Claude-specific); or (b) **mtime-poll** the transcript file — hands-free,
   no config mutation, CLI-agnostic. We choose (b).

---

## 3. Scope

**In scope (this feature, two slices):**

- **Slice A (on-demand, the first verified slice):** Read the Claude Code transcript for a terminal
  board, extract a small clean slice, feed it through the existing Tier-2 summarizer, show the recap
  in the UI. Trigger: a **manual "Summarize" action** (deterministic → verifiable live).
- **Slice B (hands-free):** A debounced **mtime watcher** on the transcript file auto-fires the same
  summarize path on change. No user action, no config mutation.

**Target CLI:** Claude Code first (`launchCommand` first token === `claude`). The design leaves a
clean seam for a per-CLI ladder (Codex/Gemini/aider/opencode) later, but only Claude is implemented
now (YAGNI; the locked agent-agnostic decision is honored by the seam, not by building all adapters
up front).

**Out of scope (deferred, explicitly):**

- Hook-push trigger (Tier-1 push) — defer; mtime-poll covers hands-free without touching user config.
- MCP `write_result` self-report (Tier-0) — requires building MCP token/URL injection into spawned
  agents (NOT currently wired: `src/main/pty.ts:466` spawns with `env:{...process.env}`, no token).
  Worth it later as opportunistic enrichment, but a separate feature.
- Codex / Gemini / aider / opencode adapters — ladder documented, not built.
- Raw-scrollback Tier-3 fallback for unknown CLIs — documented, not built in slice A/B. Unknown CLIs
  keep today's config+runtime digest.
- Agent *resume* automation (`claude --resume <id>`) — out of scope; recap is read-only context.

---

## 4. Architecture & components

One new MAIN module, plus minimal wiring and one summarizer extension. Everything reuses the existing
egress / budget / memory / DigestPanel pipeline — no new LLM plumbing.

### 4.1 `src/main/agentTranscript.ts` (NEW — pure, Electron-free, unit-testable)

Single clear purpose: **locate and distill an agent CLI transcript into a small recap input string.**
No LLM, no network, no Electron imports (takes an injected home dir + fs reader for testability).

```
// Detect which CLI a launchCommand runs (first meaningful token).
detectAgentCli(launchCommand?: string): 'claude' | 'unknown'

// Claude Code cwd → transcript dir slug. Encoding: every non-alphanumeric char → '-'.
//   'Z:\Canvas ADE'  ->  'Z--Canvas-ADE'   (verified against this repo's own ~/.claude/projects dir)
claudeProjectSlug(cwd: string): string

// Find the newest *.jsonl in ~/.claude/projects/<slug>/ (by mtime). undefined if none.
locateClaudeTranscript(home: string, cwd: string, fs): string | undefined

// Parse JSONL → a compact, capped recap input: last user prompt + last assistant text +
// recent tool_use breadcrumbs (tool name + path/arg headline ONLY — never raw tool_result bodies).
//   Returns { text } capped to MAX_RECAP_CHARS, or undefined if nothing usable.
distillTranscript(jsonl: string, opts): { text: string } | undefined
```

Key decisions:
- **Newest-by-mtime** picks the session when a cwd holds several. Known limitation: two `claude`
  boards sharing one cwd are ambiguous → documented; distinct board cwds avoid it. (Slice-B watcher
  inherits the same heuristic.)
- **Breadcrumbs, not bodies.** We include `tool_use` *names + a one-line arg headline*
  (e.g. `Read auth.ts`, `Edit src/token.ts`), and skip `tool_result` contents entirely. This is what
  keeps the input tiny and cheap (see §6) and avoids leaking file bodies to the summarizer.

### 4.2 `src/main/summaryLoop.ts` (EXTEND)

`buildSummarizeInput` (currently `:201-214`) gains a terminal branch: for a terminal board, if a
transcript recap is available, **append a "Recent activity:" section** right after the existing
runtime status line. `boardContent` (`:103-113`) stays a pure board→text function (no recap logic
there — the recap needs the injected getter, not the on-disk board). Mechanism: a new optional dep,
mirroring the existing `getTerminalRuntime` seam:

```
SummaryLoopDeps.getAgentRecap?(boardId, board): { text: string } | undefined
```

The loop calls it defensively (absent/throwing getter ⇒ omit the section, never fail the summarize —
same discipline as `getTerminalRuntime`, `summaryLoop.ts:308-312`). The SYSTEM prompt gets a small
addition instructing the model to describe *what the agent is doing and how to resume* when activity
is present.

### 4.3 `src/main/index.ts` (WIRE — minimal, shared file)

Provide the `getAgentRecap` impl when constructing the summary loop (near the existing
`getTerminalRuntime` wiring at `:264`). The impl: read the board (type/launchCommand/cwd) →
`detectAgentCli` → if `claude`, `locateClaudeTranscript` + `distillTranscript`. Resolve cwd from the
board's `cwd`, falling back to the open project dir.

### 4.4 Trigger surfaces

- **Slice A:** reuse the existing `memory:refresh` IPC path (`src/main/projectIpc.ts:320-329` →
  `summaryLoop.onIntent`). The `DigestPanel` ⟳ button already calls it (`DigestPanel.tsx:56-79`).
  Optionally add a "Summarize" affordance in the terminal board chrome
  (`src/renderer/.../TerminalBoard.tsx:698-715`) that calls the same `window.api.memory.refresh(id)`.
  Either way → existing pipeline, no new IPC.
- **Slice B:** a new MAIN watcher (`src/main/agentRecapWatcher.ts`, or folded into index wiring)
  watches `~/.claude/projects/<slug>/` for the active terminal boards; on a debounced mtime change it
  fires `summaryLoop.onIntent({ boardId })`. Reuses the loop's in-flight guard + fingerprint dedupe so
  an unchanged transcript never re-summarizes.

### 4.5 Output / display (UNCHANGED pipeline)

Summarizer writes prose to `.canvas/memory/board-{id}.md` (`canvasMemory.writeBoard`), `DigestPanel`
renders it (Tier-2 prose when present, else Tier-1 lines). No UI rebuild required for slice A.

---

## 5. Data flow

### Slice A (on-demand)
```
user clicks ⟳ / "Summarize" on a terminal board
  → window.api.memory.refresh(boardId)            (existing IPC)
  → projectIpc 'memory:refresh' → summaryLoop.onIntent({boardId})
  → loop reads board from disk (config) 
  → getAgentRecap(boardId, board):
        detectAgentCli('claude…') === 'claude'
        locateClaudeTranscript(home, board.cwd) → newest *.jsonl
        distillTranscript(jsonl) → { text: "last prompt + last reply + tool breadcrumbs" }  [FREE]
  → buildSummarizeInput appends "Recent activity:" section (capped)
  → runSummarize(config, input, budgeted)         (existing; ONE cheap LLM call)
  → sanitize + write .canvas/memory/board-{id}.md
  → DigestPanel re-reads prose → shows recap
```

### Slice B (hands-free)
```
agent writes a turn → transcript *.jsonl mtime changes
  → watcher (debounced ~10–30s) → summaryLoop.onIntent({boardId})
  → (identical to above from onIntent onward; dedupe skips no-change)
```

---

## 6. Token / cost control (explicit — user asked)

- **Reading the transcript = 0 tokens** (disk file).
- **Cost = the one summarize call**, billed to the **user's own provider key** (Settings), NOT the
  agent's bill and NOT a hidden app charge. **No key ⇒ no spend** (falls back to Tier-1 heuristic;
  opt-in by ADR 0003).
- **No re-running the agent.** We read the file; we never invoke `claude -p` (that would be a second
  full agent run = real money — explicitly rejected).
- **Bounded input.** `distillTranscript` sends last prompt + last assistant text + tool *names/paths*
  only (no `tool_result` bodies), capped to `MAX_RECAP_CHARS` (~3000), inside the existing
  `MAX_INPUT_CHARS = 4000` ceiling ⇒ ≈ 1k input tokens, ≈ 300 out.
- **Existing guards:** per-day budget cap (`llmBudget.ts`, default 200 calls/day); cheap default
  models (gemini-2.5-flash / gpt-4.1-nano / claude-haiku); slice A spends only on click; slice B is
  debounced + fingerprint-deduped.
- **Ballpark:** ~$0.0002 / summary; ≤ ~4¢/day at the 200-call cap. Effectively free.

---

## 7. Security / privacy

- **Egress:** transcript content (prompts, code paths) reaches an external LLM — same class as the
  existing Tier-2 egress, governed by ADR `0003-llm-egress.md`. No new egress surface; same opt-in,
  same budget, same provider.
- **Redaction:** because we send breadcrumbs (tool names + path headlines) and NOT raw tool_result
  bodies, file contents / command output (where secrets usually appear) are **not** forwarded. A
  light secret-scrub pass (obvious `sk-…` / `ghp_…` / `AKIA…` token patterns) on the distilled text
  before egress is a low-cost extra guard — include it.
- **Path safety:** `claudeProjectSlug` only ever *reads* under `~/.claude/projects/<slug>/`; slug is
  derived, not user-supplied free text; restrict to `*.jsonl` in that one dir. No traversal.
- **Generated recap stays untrusted passive context** — written to `.canvas/memory`, displayed /
  MCP-readable, **never drives an action** (existing invariant; unchanged).
- **No mutation of the user's Claude Code config** in slice A/B (the reason we picked mtime-poll over
  a hook).

---

## 8. Error handling / fallback

Every step is best-effort and degrades, never throws into the save/summarize path:

- No transcript dir / no `*.jsonl` / unreadable → `getAgentRecap` returns undefined → summary is just
  today's config+runtime (no regression).
- Non-`claude` launchCommand → `detectAgentCli` → `'unknown'` → no recap section (current behavior).
- LLM no-key / over-budget / provider error → Tier-1 heuristic prose (existing behavior).
- Malformed JSONL lines → skipped individually; partial distillation still returns what parsed.
- Watcher (slice B) errors are swallowed; the ⟳ on-demand path always remains.

---

## 9. Testing & verification plan

**Unit (vitest, pure — `agentTranscript.test.ts`):**
- `detectAgentCli`: `claude`, `claude --resume x`, `npx claude`, `pwsh -c claude`, `aider`, empty.
- `claudeProjectSlug`: `Z:\Canvas ADE` → `Z--Canvas-ADE`; posix paths; trailing slash.
- `locateClaudeTranscript`: picks newest by mtime; none → undefined (injected fake fs).
- `distillTranscript`: extracts last prompt/reply + tool breadcrumbs; **omits tool_result bodies**;
  caps at `MAX_RECAP_CHARS`; skips malformed lines; secret-scrub redacts `sk-…`/`ghp_…`.

**Integration (vitest):**
- `summaryLoop` with a stub `getAgentRecap` → terminal `buildSummarizeInput` includes "Recent
  activity:"; absent/throwing getter → omitted, summarize still succeeds.

**E2E (Playwright `_electron`) — the live proof (the user's bar):**
- Seed a terminal board whose `launchCommand` is a tiny **fake-claude fixture** script that writes a
  realistic JSONL transcript into a temp `HOME/.claude/projects/<slug>/` (deterministic, no network,
  no real Claude bill — `CANVAS_LLM_MOCK=1` for the summarizer too).
- Trigger ⟳ → assert `.canvas/memory/board-{id}.md` contains the distilled activity and DigestPanel
  shows it. This proves the full chain in the real app.

**Manual live verification (sign-off gate):** run a real `claude` session in a terminal board doing
an actual task, click Summarize, confirm the recap is accurate and resume-useful. Capture a
screenshot. (This is what "first feature verified and working" means.)

Gate per CLAUDE.md: `pnpm typecheck · lint · format:check · vitest`, then the pre-push e2e matrix.

---

## 10. Open questions

1. **Summarize affordance placement** — DigestPanel ⟳ only (zero new UI), or also a button on the
   terminal board chrome? (Lean: reuse ⟳ for slice A; add board-chrome button only if the live test
   shows it's awkward.)
2. **Slice-B debounce window** — 10s? 30s? (Lean 20–30s: agent turns are bursty; avoid mid-turn
   half-states.)
3. **Multiple `claude` boards in one cwd** — accept newest-by-mtime ambiguity for now, or require a
   per-board cwd? (Lean: accept + document; revisit if it bites.)
4. **Ship slice A alone first, or A+B together?** (Lean: land + live-verify A, then B — matches "first
   verified feature.")

---

## 11. File touch summary

| File | Change |
|---|---|
| `src/main/agentTranscript.ts` | NEW — detect / locate / distill (pure) |
| `src/main/agentTranscript.test.ts` | NEW — unit |
| `src/main/summaryLoop.ts` | EXTEND — terminal recap section + `getAgentRecap` dep |
| `src/main/index.ts` | WIRE — provide `getAgentRecap` (minimal, shared file) |
| `src/main/agentRecapWatcher.ts` | NEW (slice B) — debounced mtime watcher |
| `src/renderer/.../TerminalBoard.tsx` | OPTIONAL — "Summarize" chrome button (reuses memory:refresh) |
| `e2e/*recap*.e2e.ts` + fixture | NEW — live-chain proof |
