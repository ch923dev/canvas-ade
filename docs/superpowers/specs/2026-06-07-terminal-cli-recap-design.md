# Design — Terminal / Agent-CLI Session Recap

**Date:** 2026-06-07
**Branch:** `feat/terminal-recap`
**Status:** Design — approved content model; awaiting final spec sign-off before plan
**Author:** session on `main` (lead) → worktree `canvas-ade-terminal-recap`

---

## 1. Goal

When a terminal board runs an agentic CLI (e.g. `claude` doing a code review), the app produces a
**high-quality, resume-able recap of what the agent is doing** — a short "NOW" line plus a
timestamped timeline of meaningful moments — so the user can glance at a board and pick up where they
left off, instead of re-reading the whole terminal.

The recap appears **on the board itself**: the user **flips the terminal** (front = live terminal,
back = recap). It also appears in the project-wide `DigestPanel`.

This is the **first feature verified end-to-end and working**: spawn a real `claude` session, do work,
flip the board, see an accurate timestamped recap — proven with a live run, not just unit tests.

---

## 2. Problem & research findings

The Context-Brain already has a Tier-2 summarizer (`summaryLoop` → `runSummarize` → prose in
`.canvas/memory/board-{id}.md`, shown in `DigestPanel`). Today it summarizes only **board config**
(launchCommand / cwd / port) + a **runtime status line** (running/idle/exited) — never what the agent
actually did. The desired capability does not exist yet.

Three research threads (2026-06-07) settled the *how*:

1. **Scraping PTY scrollback is the wrong source.** Agentic CLIs run in the terminal **alternate-screen
   buffer** — full-screen redraws via cursor addressing; content is never committed to scrollback.
   `readPtyOutput` (`src/main/pty.ts:829`) returns a 256 KB ANSI-stripped ring (`RING_CAP_BYTES =
   262144`), paged at 25 KB. For a TUI that's a soup of half-drawn frames + spinner glyphs. **Last
   resort only.**

2. **The real source is the agent's on-disk transcript.** Claude Code persists a full JSONL transcript
   at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` — one JSON object per line (user turns,
   assistant messages, tool_use, tool_result), **each carrying a real timestamp**. Appended live →
   readable mid-session. Reading the file costs **zero tokens**. Every major CLI writes an equivalent
   (Codex/Gemini JSONL, aider markdown, opencode SQLite).

3. **Hands-free is realistic via mtime-poll.** Watch the transcript file's mtime → auto-summarize on
   change. Hands-free, no mutation of the user's Claude config. (A `Stop`/`SessionEnd` hook would also
   work but mutates `~/.claude/settings.json` — rejected.)

---

## 3. Scope

**In scope (one feature, shipped together — A + B):**

- **A — flip-to-recap, on-demand.** A flip control on the terminal board: front = live terminal, back =
  recap. Flipping to the back renders the cached recap instantly (free, from disk) and offers a ⟳ to
  refresh. Deterministic → the live-verifiable core.
- **B — hands-free refresh.** A debounced (20–30s) mtime watcher on the transcript file fires the same
  summarize path on change, so the cached recap stays current without a click.

**Recap content model (approved):**

- **NOW** — 1–2 lines: what the agent is doing + the resume point.
- **Timeline** — a handful of **meaningful moments**, each `HH:MM — note`:
  - user requests/decisions ("You: continue the refresh-token path"),
  - agent milestones/conclusions ("found 3 issues", "fixed the expiry comparison").
  - **Excluded:** raw tool calls (read/edit/grep), file contents, command output — noise to the user.
- **Timestamps are real** (extracted by code from the JSONL), never invented by the model.
- **Notes are summarized** by the LLM in **one** call.

**Target CLI:** Claude Code first (`launchCommand` first token === `claude`). Clean seam for a per-CLI
ladder (Codex/Gemini/aider/opencode) later; only Claude built now (YAGNI; agent-agnostic honored by
the seam, not by building every adapter).

**Out of scope (deferred, explicit):**

- Hook-push trigger (mutates user's Claude config) — mtime-poll covers hands-free.
- MCP `write_result` self-report — needs MCP token/URL injection into spawned agents (NOT wired:
  `src/main/pty.ts:466` spawns `env:{...process.env}`, no token). Separate feature.
- Codex/Gemini/aider/opencode adapters — ladder documented, not built.
- Raw-scrollback Tier-3 fallback for unknown CLIs — unknown CLIs keep today's config+runtime digest.
- Agent *resume* automation (`claude --resume`) — recap is read-only context.
- A separate structured recap store / fancy timeline widget — v1 renders the recap markdown on both
  surfaces; add a JSON sidecar later only if a richer UI needs it.

---

## 4. Architecture & components

One new MAIN module + one renderer flip component + minimal wiring + a summarizer extension.
Reuses the existing egress / budget / memory / DigestPanel pipeline.

### 4.1 `src/main/agentTranscript.ts` (NEW — pure, Electron-free, unit-testable)

Purpose: **locate an agent transcript and extract meaningful, timestamped milestones.** No LLM, no
network, no Electron (injected home dir + fs reader).

```
detectAgentCli(launchCommand?: string): 'claude' | 'unknown'
// first meaningful token → 'claude' for `claude`, `claude --resume x`, `npx claude`, etc.

claudeProjectSlug(cwd: string): string
// every non-alphanumeric char → '-'.  'Z:\Canvas ADE' -> 'Z--Canvas-ADE'
// (verified against this repo's own ~/.claude/projects dir)

locateClaudeTranscript(home, cwd, fs, sessionId?): string | undefined
// PRIMARY: when sessionId is known (app-assigned, see §4.3), the file is exactly
//   ~/.claude/projects/<slug>/<sessionId>.jsonl  — verified: the transcript filename IS the
//   session id (Claude Code docs, cli-reference + sessions). If the slug path misses, glob
//   ~/.claude/projects/**/<sessionId>.jsonl (we own the uuid → find it regardless of slug).
// FALLBACK (no sessionId — user supplied own claude flags, or non-claude): newest *.jsonl by mtime.

interface Milestone { ts: number; role: 'user' | 'agent'; text: string }
extractMilestones(jsonl, opts): Milestone[]
// Keep ONLY meaningful turns: user messages + assistant natural-language messages.
// EXCLUDE tool_use and tool_result records entirely (no read/edit/grep, no bodies).
// Each milestone: real timestamp (from the record) + role + capped text.
// Skip malformed lines. Cap to last N milestones (e.g. 12) + per-text char cap.
```

- **App-assigned session id is the disambiguator.** Because the app mints the uuid and the transcript
  filename equals the session id, N concurrent `claude` boards in the *same* cwd each resolve to their
  own `<uuid>.jsonl` — no ambiguity. Newest-by-mtime is now only the fallback for boards where we did
  not inject a session id.
- Excluding tool records is what keeps the input small/cheap AND keeps the recap noise-free.

### 4.2 `src/main/summaryLoop.ts` (EXTEND — terminal recap path)

For a terminal board with milestones available, the loop builds a **numbered milestone prompt** and
makes **one** structured LLM call:

```
LLM returns:  { now: string, notes: string[] }   // notes[i] ↔ milestone i (by number)
```

- The model writes `now` (what's happening + resume) and a one-line `note` per numbered milestone.
- **Code — not the model — assembles the final recap markdown**, injecting the *real* timestamps:
  ```
  **Now:** <now>

  - 14:32 — <notes[0]>
  - 14:35 — <notes[1]>
  ...
  ```
- Tolerant parse: if the structured payload doesn't parse, fall back to treating the whole completion
  as `now` with no per-line notes (still a useful recap). No key / over budget / error → Tier-1
  config+runtime digest (existing behavior).
- Mechanism mirrors the existing `getTerminalRuntime` seam — a new optional dep:
  `SummaryLoopDeps.getAgentMilestones?(boardId, board): Milestone[] | undefined`, called defensively
  (absent/throwing ⇒ omit, never fail the summarize — `summaryLoop.ts:308-312` discipline).
- `boardContent` (`:103-113`) stays a pure board→text fn; the recap assembly lives in the loop, not
  there.
- Output is written via the existing `canvasMemory.writeBoard` → `.canvas/memory/board-{id}.md`. One
  artifact, rendered by both surfaces.

### 4.3 Session-id assignment at spawn (NEW — the disambiguator)

To pinpoint a board's transcript even with N concurrent same-cwd `claude` sessions, the **app assigns
the session id** instead of guessing:

- Add `agentSessionId?: string` to `TerminalBoard` (`src/renderer/.../boardSchema.ts`). Persisted so
  the recap survives an app reopen (the transcript lives under `~/.claude`, which persists).
  **⚠️ cross-zone:** `boardSchema.ts` is currently owned by the `feat/text-font-toolbar` worktree
  (TextElement + schema v6). Coordinate the field add + any `schemaVersion` bump on the board before
  editing (note in `ACTIVE-WORK.md`).
- At spawn, when `detectAgentCli(launchCommand) === 'claude'` **and** the command has no
  `--session-id` / `--resume` / `--continue`, mint a UUID v4, store it on the board, and append
  `--session-id <uuid>` to the command **written to the PTY** (`src/main/pty.ts:552-553`). The *stored*
  launchCommand text is unchanged (the user still sees `claude`); only the effective launch carries the
  flag. If the user already supplied those flags, do not inject (respect their intent) → that board
  falls back to newest-by-mtime.
- Restart (the ⟳/restart control) mints a fresh uuid → fresh session/transcript. Reopen reuses the
  persisted uuid → re-finds the same transcript.

### 4.3b `src/main/index.ts` (WIRE — minimal, shared file)

Provide `getAgentMilestones` when constructing the summary loop (near the existing `getTerminalRuntime`
wiring at `:264`): read board (type/launchCommand/cwd/**agentSessionId**) → `detectAgentCli` → if
`claude`, `locateClaudeTranscript(home, cwd, fs, agentSessionId)` + `extractMilestones`. cwd from the
board's `cwd`, fallback to the open project dir.

### 4.4 `src/main/agentRecapWatcher.ts` (NEW — slice B, hands-free)

A debounced (20–30s) mtime watcher over `~/.claude/projects/<slug>/` for the active terminal boards;
on change → `summaryLoop.onIntent({ boardId })`. Reuses the loop's in-flight guard + fingerprint
dedupe so an unchanged transcript never re-summarizes. Errors swallowed; the on-demand flip path
always remains.

### 4.5 Renderer — flip UI

- **`src/renderer/.../TerminalBoard.tsx`** gains a **flip control** (an `IconBtn` in the title-bar
  `actions`, alongside ⏹/🌐/⚙/🔄) and a flipped state.
- A terminal board is plain HTML/xterm (NOT a native `WebContentsView`), so a CSS 3D flip
  (`transform: rotateY(180deg)`, `backface-visibility:hidden`, two faces) works inside the BoardFrame
  content well (`BoardFrame.tsx:561`). **The xterm stays mounted on the front** — the session survives
  the flip; we rotate, not unmount. Respect `prefersReducedMotion()` (instant swap, no spin).
- **Back face = `RecapView`** (new small presentational component): renders the recap markdown
  (`.canvas/memory/board-{id}.md`) as a NOW block + timeline list, with a ⟳ that calls
  `window.api.memory.refresh(id)` (existing IPC, `projectIpc.ts:320-329`). Read prose via the existing
  `window.api.memory.readBoards([id])`.
- **DigestPanel unchanged** — still the project-wide overview, renders the same doc.

---

## 5. Data flow

```
FLIP (on-demand):
  click flip → back face → window.api.memory.readBoards([id])  → render cached recap   [FREE]
  click ⟳    → window.api.memory.refresh(id) → summaryLoop.onIntent({id}) → (summarize below)

HANDS-FREE (slice B):
  agent writes a turn → transcript *.jsonl mtime changes → watcher (debounced) → onIntent({id})

SUMMARIZE (shared):
  onIntent → loop reads board (config)
    → getAgentMilestones(id, board):
        detectAgentCli==='claude' → locateClaudeTranscript(home,cwd) → newest *.jsonl
        extractMilestones(jsonl) → [{ts, role, text}, …]   (meaningful turns only)   [FREE]
    → one LLM call → { now, notes[] }                       (budgeted, cheap)
    → CODE assembles markdown: NOW + real-timestamp timeline lines
    → sanitize + write .canvas/memory/board-{id}.md
    → flip back-face / DigestPanel re-read → recap shown
```

---

## 6. Token / cost control (user-requested)

- **Reading the transcript = 0 tokens** (disk file).
- **Cost = one summarize call**, billed to the **user's own provider key** (Settings) — NOT the
  agent's bill, NOT a hidden app charge. **No key ⇒ no spend** (Tier-1 fallback; ADR 0003).
- **No re-running the agent** (never `claude -p`).
- **Bounded input:** last ~12 milestones, user/assistant message text only (no tool calls, no bodies),
  capped to `MAX_RECAP_CHARS` (~3000) within the existing `MAX_INPUT_CHARS = 4000`. ≈ 1k in; output =
  NOW + ~12 one-liners ≈ 300–500 tokens.
- **Guards:** per-day budget cap (`llmBudget.ts`, default 200/day); cheap default models; flip ⟳ spends
  only on click; watcher debounced + fingerprint-deduped.
- **Ballpark:** ~$0.0003 / recap; ≤ ~6¢/day at the cap. Effectively free.

---

## 7. Security / privacy

- **Egress:** user + assistant message text reaches the external LLM — same class as existing Tier-2
  egress, governed by ADR `0003-llm-egress.md`. No new egress surface; same opt-in / budget / provider.
- **Reduced surface:** tool_result bodies (file contents, command output — where secrets usually live)
  are **never** forwarded; only message text + a light secret-scrub (`sk-…`/`ghp_…`/`AKIA…` patterns)
  before egress.
- **Path safety:** only ever *reads* `*.jsonl` under `~/.claude/projects/<derived-slug>/`; slug derived,
  not free text; no traversal.
- **Generated recap is untrusted passive context** — written to `.canvas/memory`, displayed /
  MCP-readable, **never drives an action** (existing invariant).
- **No mutation of the user's Claude Code config.**

---

## 8. Error handling / fallback

Best-effort throughout; never throws into save/summarize:

- No transcript / unreadable / non-`claude` launchCommand → no recap section → today's config+runtime
  digest (no regression).
- LLM no-key / over-budget / error → Tier-1 heuristic prose.
- Structured payload unparseable → NOW = whole completion, no timeline lines.
- Malformed JSONL lines → skipped individually; partial milestones still usable.
- Watcher errors swallowed; flip ⟳ always works.

---

## 9. Testing & verification plan

**Unit (vitest, pure — `agentTranscript.test.ts`):**
- `detectAgentCli`: `claude`, `claude --resume x`, `npx claude`, `pwsh -c claude`, `aider`, empty.
- `claudeProjectSlug`: `Z:\Canvas ADE` → `Z--Canvas-ADE`; posix; trailing slash.
- `locateClaudeTranscript`: newest by mtime; none → undefined (fake fs).
- `extractMilestones`: keeps user + assistant text turns with real timestamps; **drops tool_use /
  tool_result**; caps count + per-text; skips malformed lines.

**Integration (vitest):**
- `summaryLoop` with stub `getAgentMilestones` + a fake structured `{now,notes}` completion → asserts
  the written markdown has the NOW block + `HH:MM — note` lines with the *injected real* timestamps
  (not model text); absent getter → omitted, summarize still succeeds; unparseable payload → NOW-only.

**E2E (Playwright `_electron`) — the live proof (the bar):**
- Seed a terminal board whose `launchCommand` is a tiny **fake-claude fixture** that writes a realistic
  timestamped JSONL into a temp `HOME/.claude/projects/<slug>/` (deterministic, no network, no real
  bill; `CANVAS_LLM_MOCK=1` for the summarizer).
- **Flip** the board → assert the back-face `RecapView` shows NOW + timeline; click ⟳ → assert
  `.canvas/memory/board-{id}.md` updates and the back-face re-renders.

**Manual live verification (sign-off gate):** run a real `claude` session doing an actual task, flip
the board, confirm the recap is accurate + resume-useful, capture a screenshot.

Gate per CLAUDE.md: `pnpm typecheck · lint · format:check · vitest`, then the pre-push e2e matrix.

---

## 10. Resolved decisions

1. **Surface:** board **flip** (primary) + DigestPanel (project overview). Not ⟳-only.
2. **Slice-B debounce:** 20–30s.
3. **Same-cwd ambiguity → SOLVED by app-assigned session id.** App mints the uuid + injects
   `claude --session-id <uuid>`; transcript filename = the uuid, so N concurrent same-cwd sessions each
   resolve to their own file. Newest-by-mtime is only the fallback (user-supplied claude flags /
   non-claude). Verified against Claude Code docs.
4. **Ship A + B together.**
5. **Recap content:** NOW + timestamped meaningful-moment notes; drop tool-call noise; real timestamps
   by code, notes by one LLM call.

---

## 11. File touch summary

| File | Change |
|---|---|
| `src/main/agentTranscript.ts` | NEW — detect / locate-by-sessionId / extractMilestones (pure) |
| `src/main/agentTranscript.test.ts` | NEW — unit |
| `src/main/summaryLoop.ts` | EXTEND — terminal recap: milestone prompt, one structured call, code-assembled timeline; `getAgentMilestones` dep |
| `src/main/pty.ts` | inject `--session-id <uuid>` at spawn for claude (guarded); surface the minted id back to the board |
| `src/main/index.ts` | WIRE — provide `getAgentMilestones` (minimal) |
| `src/main/agentRecapWatcher.ts` | NEW (slice B) — debounced mtime watcher |
| `src/renderer/.../boardSchema.ts` | `agentSessionId?: string` on TerminalBoard (**cross-zone: text-font-toolbar owns this file + schema version**) |
| `src/renderer/.../TerminalBoard.tsx` | flip control + flipped state (xterm stays mounted) |
| `src/renderer/.../RecapView.tsx` | NEW — back-face NOW + timeline + ⟳ |
| `e2e/*recap*.e2e.ts` + fake-claude fixture | NEW — live-chain proof |
