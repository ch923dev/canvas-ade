# Design — Terminal / Agent-CLI Session Recap

**Date:** 2026-06-07
**Branch:** `feat/terminal-recap`
**Status:** Design — awaiting final spec sign-off before plan
**Author:** session on `main` (lead) → worktree `canvas-ade-terminal-recap`

---

## 1. Goal

When a terminal board runs an agentic CLI (e.g. `claude` doing a code review), the app produces a
**high-quality, resume-able recap of what the agent is doing** — a short "NOW" line plus a timestamped
timeline of meaningful moments — so the user can glance at a board and pick up where they left off,
instead of re-reading the whole terminal.

The recap appears **on the board itself**: the user **flips the terminal** (front = live terminal,
back = recap). It also appears in the project-wide `DigestPanel`.

This is the **first feature verified end-to-end and working**: spawn a real `claude` session, do work,
flip the board, see an accurate timestamped recap — proven with a live run, not just unit tests.

---

## 2. Problem & research findings

The Context-Brain already has a Tier-2 summarizer (`summaryLoop` → `runSummarize` → prose in
`.canvas/memory/board-{id}.md`, shown in `DigestPanel`). Today it summarizes only **board config**
(launchCommand / cwd / port) + a **runtime status line** — never what the agent did. The desired
capability does not exist yet.

Research (2026-06-07, three threads + two verifications) settled the *how*:

1. **Scraping PTY scrollback is the wrong source.** Agentic CLIs run in the terminal **alternate-screen
   buffer** — full-screen redraws; content is never committed to scrollback. `readPtyOutput`
   (`src/main/pty.ts:829`) returns a 256 KB ANSI-stripped ring. For a TUI that's a soup of half-drawn
   frames. **Last resort only.**

2. **The real source is the agent's on-disk transcript JSONL.** Claude Code writes a full conversation
   transcript at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, **each record carrying a real
   timestamp**, appended live. Reading it costs **zero tokens**.

3. **Identify the per-board session via an invisible env var + a hook (verified).** We do NOT inject a
   visible CLI flag (a user typing `claude` must not see `claude --session-id …` appear — rejected on
   trust/UX grounds). Instead:
   - Set an **invisible env var** `CANVAS_RECAP_BOARD=<boardId>` on the spawned shell (env vars don't
     appear in the terminal). Claude inherits it from the shell.
   - A **`SessionStart` hook** receives `session_id` + `transcript_path` + `cwd` on stdin (verified:
     present on *all* hooks) and can read `CANVAS_RECAP_BOARD` from its inherited env (strongly implied
     by the documented `CLAUDE_ENV_FILE` pattern — **must be smoke-tested first**, see §9). It appends
     `{boardId, session_id, transcript_path, cwd}` to an **app-owned mapping file**.
   - The app watches the mapping file → learns, per board, the exact transcript path — unambiguous even
     for **N concurrent `claude` sessions in the same cwd** (the env var carries our board id; the hook
     hands us the exact transcript path).

4. **Hands-free is realistic** by watching the learned transcript file's mtime → auto-summarize on
   change. No further hooks needed.

---

## 3. Scope

**In scope (one feature, shipped together — A + B):**

- **A — flip-to-recap, on-demand.** A flip control on the terminal board: front = live terminal, back =
  recap. Flipping renders the cached recap instantly (free, from disk) + a ⟳ to refresh.
- **B — hands-free refresh.** A debounced (20–30s) mtime watcher on the board's transcript file fires
  the summarize path on change, keeping the recap current without a click.

**Identification (the user's concern — no visible injection):** invisible env var + `SessionStart`
hook → mapping file → app learns each board's `session_id` + `transcript_path`. Installed the
least-invasive way (§4.2), **only after explicit, friendly, per-project consent** (§4.8) — the hook
never touches the repo without the user opting in.

**Recap content model (approved):**
- **NOW** — 1–2 lines: what the agent is doing + the resume point.
- **Timeline** — meaningful moments only, each `HH:MM — note`: user requests/decisions + agent
  milestones/conclusions. **Excluded:** raw tool calls (read/edit/grep), file contents, command output.
- **Timestamps real** (code, from JSONL), **notes summarized** by the LLM in one call.

**Target CLI:** Claude Code first (`detectAgentCli`). Clean seam for a Codex/Gemini/aider/opencode
ladder later; only Claude built now (YAGNI; agent-agnostic honored by the seam).

**Out of scope (deferred, explicit):**
- Visible `--session-id` injection — **rejected** (spooky in a real terminal).
- Mutating the user's `~/.claude/settings.json`, or any visible CLI flag.
- MCP `write_result` self-report — needs MCP token/URL injection into spawned agents (not wired).
- Codex/Gemini/aider/opencode adapters — ladder documented, not built.
- Raw-scrollback fallback for unknown CLIs — unknown CLIs keep today's config+runtime digest.
- Agent *resume* automation — recap is read-only context.

---

## 4. Architecture & components

### 4.1 `src/main/agentTranscript.ts` (NEW — pure, Electron-free, unit-testable)

Purpose: **detect the CLI and distill a transcript into meaningful, timestamped milestones.** No LLM,
no network, no Electron.

```
detectAgentCli(launchCommand?: string): 'claude' | 'unknown'   // first meaningful token

interface Milestone { ts: number; role: 'user' | 'agent'; text: string }
extractMilestones(jsonl, opts): Milestone[]
// Keep ONLY meaningful turns: user messages + assistant natural-language messages.
// EXCLUDE tool_use and tool_result entirely (no read/edit/grep, no bodies).
// Real timestamp per milestone (from the record). Skip malformed lines.
// Cap to last N (e.g. 12) + per-text char cap.

claudeProjectSlug(cwd): string   // fallback only; 'Z:\Canvas ADE' -> 'Z--Canvas-ADE'
```

The exact transcript path comes from the hook mapping (§4.3) — `claudeProjectSlug` + newest-by-mtime
is only a fallback when no mapping entry exists (e.g. user supplied their own claude flags).

### 4.2 The identification bridge (env var + hook + mapping) — NEW

This is the per-board session mechanism. Three pieces:

**(a) Invisible env vars at spawn** — `src/main/pty.ts` (spawn already passes `env:{...process.env}` at
`:466`). Add, for terminal boards:
- `CANVAS_RECAP_BOARD=<boardId>` — carries our board id into the hook.
- `CANVAS_RECAP_MAP=<abs path>` — where the hook appends mapping lines (app-owned, under `userData`,
  outside any repo).
Nothing is added to the command line; the user still sees plain `claude`.

**(b) A `SessionStart` hook** installed the least-invasive way — written/merged into
**`<cwd>/.claude/settings.local.json`** (gitignored by default → not committed; merges with the user's
hooks; no edit to `~/.claude/settings.json`; no visible flag). Exec form, app-resolved node path
(`process.execPath`) so the hook does not depend on `node` being on PATH:

```jsonc
// .claude/settings.local.json  (merged, idempotent — added once)
{ "hooks": { "SessionStart": [ { "matcher": "",
  "hooks": [ { "type": "command", "command": "<app node path>",
              "args": ["<app>/.../recordSession.js"] } ] } ] } }
```

**(c) `recordSession.js`** (shipped hook script): reads the hook stdin JSON + `process.env.CANVAS_RECAP_
BOARD` → appends `{boardId, session_id, transcript_path, cwd, ts}` to `CANVAS_RECAP_MAP`.

**(d) App-side `agentRecapMap.ts`** (NEW, MAIN): install/merge the hook into `settings.local.json`
(idempotent, removable), and watch the mapping file → maintain an in-memory `boardId →
{ sessionId, transcriptPath }`. Persist the learned `transcriptPath` + `sessionId` onto the board
(see §4.5) so the recap survives an app reopen.

**Install is gated by explicit per-project consent (§4.8)** and is reversible (a Settings toggle that
removes our hook entry from `settings.local.json`). The app installs the hook ONLY after the user
clicks "Enable" in the consent modal — never silently.

> **⚠️ Linchpin:** hook env inheritance (does the hook see `CANVAS_RECAP_BOARD`?) is implied but not
> explicitly documented → **§9 smoke test gates the build.** Fallback if it fails: hook writes
> `{session_id, transcript_path, cwd}` keyed by cwd; the app correlates the new entry to the board it
> just spawned by spawn order (racy only for simultaneous same-cwd spawns — documented).

### 4.3 `src/main/summaryLoop.ts` (EXTEND — terminal recap path)

For a terminal board with milestones available, the loop builds a **numbered milestone prompt** and
makes **one** structured LLM call → `{ now: string, notes: string[] }` (notes[i] ↔ milestone i).
**Code — not the model — assembles the recap markdown**, injecting the *real* timestamps:

```
**Now:** <now>

- 14:32 — <notes[0]>
- 14:35 — <notes[1]>
```

Tolerant parse (unparseable payload → whole completion as `now`, no timeline). No key / over budget /
error → Tier-1 config+runtime digest. New optional dep mirroring `getTerminalRuntime`
(`summaryLoop.ts:308-312` discipline): `getAgentMilestones?(boardId, board): Milestone[] | undefined`.
`boardContent` (`:103-113`) stays pure. Output via existing `canvasMemory.writeBoard` →
`.canvas/memory/board-{id}.md`.

### 4.4 `src/main/index.ts` (WIRE — minimal, shared file)

Provide `getAgentMilestones` near the `getTerminalRuntime` wiring (`:264`): read board → if
`detectAgentCli==='claude'` and the recap map has this board's `transcriptPath`, read that file →
`extractMilestones`. (Fallback: `claudeProjectSlug(cwd)` + newest-by-mtime.)

### 4.5 Board schema

Add `agentSessionId?: string` + `agentTranscriptPath?: string` to `TerminalBoard`
(`src/renderer/.../boardSchema.ts`), persisted so the recap re-finds the transcript after reopen.
**⚠️ cross-zone:** `boardSchema.ts` is owned by the `feat/text-font-toolbar` worktree (TextElement +
schema v6) — coordinate the field add + any `schemaVersion` bump in `ACTIVE-WORK.md` before editing.

### 4.6 Renderer — flip UI

- **`TerminalBoard.tsx`** gains a **flip control** (`IconBtn` in the title-bar `actions`, by ⏹/🌐/⚙/🔄)
  + a flipped state. A terminal board is plain HTML/xterm (NOT a native `WebContentsView`), so a CSS 3D
  flip (`rotateY(180deg)`, `backface-visibility:hidden`) works inside the BoardFrame content well
  (`BoardFrame.tsx:561`). **The xterm stays mounted on the front** — the session survives the flip.
  Respect `prefersReducedMotion()` (instant swap).
- **`RecapView.tsx`** (NEW back face): renders the recap markdown (NOW block + timeline list) with a ⟳
  → `window.api.memory.refresh(id)` (existing IPC, `projectIpc.ts:320-329`); reads prose via
  `window.api.memory.readBoards([id])`.
- **DigestPanel unchanged** — project-wide overview, same doc.

### 4.7 `src/main/agentRecapWatcher.ts` (slice B — hands-free)

Once a board's `transcriptPath` is known (from the map), watch its mtime (debounced 20–30s) →
`summaryLoop.onIntent({ boardId })`. Reuses the loop's in-flight guard + fingerprint dedupe. Errors
swallowed; the flip ⟳ always works.

### 4.8 Consent & install UX (NEW — `RecapConsentModal.tsx` + per-project consent store)

The hook is installed ONLY with explicit, informed, per-project consent. Asked **once per project**
(first open of a project with an undecided consent), persisted; not re-asked on every open.

**Consent store:** decision (`'enabled' | 'declined' | undecided`) keyed by project path, in the app
config under `userData` — NEVER in the project folder (CLAUDE.md rule). New IPC:
`recap:getConsent(projectPath)` / `recap:setConsent(projectPath, decision)`.

**Flow at project open** (`projectIpc` open/current + renderer App):
- consent `enabled` → ensure the hook is installed/merged (idempotent); proceed.
- consent `undecided` → show `RecapConsentModal`.
- consent `declined` → do nothing (recap off for this project; the flip control shows a one-line
  "Enable agent recaps in Settings" hint instead of a recap).

**`RecapConsentModal.tsx`** (renderer portal, like `SettingsModal`) — friendly + benefit-first, with
full transparency:
- **Benefit (lead):** "See what each terminal agent is doing at a glance. Expanse can give every
  terminal a **flip-to-recap** — a short 'now' summary + a timestamped timeline of what the agent and
  you decided — so you can resume instantly instead of re-reading the whole session."
- **Exactly what it adds (transparency):** "To find the right transcript per terminal, Expanse adds
  **one hook** to this project's `.claude/settings.local.json` (**gitignored — never committed**, and
  it does **not** touch your global `~/.claude` settings or your own hooks). The hook only records each
  session's id + transcript path." Include an expandable "What gets added?" showing the exact JSON
  snippet + the file path.
- **Privacy/cost line:** "Transcripts are read locally. Summaries use your own LLM key (Settings), are
  cheap (~a fraction of a cent), and never run without a key. Turn it off anytime in Settings."
- **Buttons:** `Enable recaps` (primary) · `Not now` (declines for this project; revisitable in
  Settings). No dark patterns; "Not now" is a real, equal choice.

**Settings:** a per-project "Agent recaps" toggle mirrors/changes the decision later — enabling installs
the hook, disabling removes our hook entry from `settings.local.json`.

---

## 5. Data flow

```
PROJECT OPEN:
  consent undecided → RecapConsentModal → Enable → install hook + persist 'enabled'
                                        → Not now → persist 'declined' (recap off for project)
  consent 'enabled' → ensure hook merged into <cwd>/.claude/settings.local.json (idempotent)

SPAWN (claude terminal board, only if consent 'enabled'):
  pty.spawn(env: { …, CANVAS_RECAP_BOARD=<id>, CANVAS_RECAP_MAP=<abs> })   // invisible

IDENTIFY:
  claude starts → SessionStart hook → recordSession.js reads stdin {session_id, transcript_path, cwd}
    + env CANVAS_RECAP_BOARD → appends to CANVAS_RECAP_MAP
  app watches the map → boardId → { sessionId, transcriptPath } → persisted on the board

FLIP (on-demand):
  click flip → back face → readBoards([id]) → render cached recap                       [FREE]
  click ⟳   → memory:refresh(id) → onIntent → (summarize below)

HANDS-FREE (slice B):
  agent writes a turn → transcriptPath mtime changes → watcher (debounced) → onIntent({id})

SUMMARIZE (shared):
  onIntent → getAgentMilestones(id, board): read board.agentTranscriptPath → extractMilestones  [FREE]
    → one LLM call → { now, notes[] }                                       (budgeted, cheap)
    → CODE assembles markdown: NOW + real-timestamp timeline
    → sanitize + write .canvas/memory/board-{id}.md → flip/DigestPanel show it
```

---

## 6. Token / cost control (user-requested)

- **Reading the transcript = 0 tokens.** **Cost = one summarize call**, on the **user's own provider
  key** — not the agent's bill, not a hidden charge. **No key ⇒ no spend** (Tier-1 fallback, ADR 0003).
- **No re-running the agent** (never `claude -p`).
- **Bounded input:** last ~12 milestones, message text only (no tool calls/bodies), capped to
  `MAX_RECAP_CHARS` (~3000) within `MAX_INPUT_CHARS = 4000`. ≈ 1k in; output ≈ 300–500 tokens.
- **Guards:** per-day budget (`llmBudget.ts`, default 200/day); cheap default models; flip ⟳ spends
  only on click; watcher debounced + deduped. **Ballpark ~$0.0003/recap; ≤ ~6¢/day at the cap.**

---

## 7. Security / privacy

- **No visible command change; no mutation of the user's `~/.claude/settings.json`.** Our hook lives in
  `.claude/settings.local.json` (gitignored, merged, removable via the opt-in toggle).
- **Egress:** message text → external LLM, same class as existing Tier-2 egress (ADR `0003-llm-egress`).
  **tool_result bodies are never forwarded**; light secret-scrub (`sk-…`/`ghp_…`/`AKIA…`) before egress.
- **Mapping file** is app-owned under `userData` (outside any repo); only the hook appends to it.
- **Path safety:** only ever *reads* the transcript path the hook reported (or, in fallback,
  `*.jsonl` under the derived slug dir). No traversal.
- **Generated recap is untrusted passive context** — displayed / MCP-readable, **never drives an
  action** (existing invariant).
- **Hook script** runs in the user's env; we ship it and invoke via an app-resolved node path (exec
  form) so we don't depend on PATH and don't shell-expand untrusted strings.

---

## 8. Error handling / fallback

Best-effort throughout; never throws into save/summarize:
- No mapping entry / no transcript / non-`claude` → no recap section → today's config+runtime digest.
- Hook env var not inherited (smoke-test fail) → cwd + spawn-order correlation fallback (documented
  raciness) — or, last resort, newest-by-mtime.
- LLM no-key / over-budget / error → Tier-1 heuristic prose.
- Unparseable structured payload → NOW = whole completion, no timeline.
- Malformed JSONL lines → skipped; partial milestones still usable.
- Watcher / hook-install errors swallowed; flip ⟳ always works.

---

## 9. Testing & verification plan

**Spike (gates the build):** an env-inheritance smoke test — spawn `claude` (or a stub) from a PTY with
`CANVAS_RECAP_BOARD` set + a `SessionStart` hook that writes `env` → confirm the hook sees the var. If
it fails, switch to the cwd+spawn-order fallback before building on it.

**Unit (vitest, pure — `agentTranscript.test.ts`):**
- `detectAgentCli`: `claude`, `claude --resume x`, `npx claude`, `pwsh -c claude`, `aider`, empty.
- `extractMilestones`: keeps user + assistant text turns w/ real timestamps; **drops tool_use/
  tool_result**; caps count + per-text; skips malformed lines.
- `claudeProjectSlug`: `Z:\Canvas ADE` → `Z--Canvas-ADE` (fallback path).
- `agentRecapMap`: parse a mapping JSONL → boardId→{sessionId,transcriptPath}; idempotent hook-merge
  into a fixture `settings.local.json` (no clobber of existing hooks); removal.

**Integration (vitest):**
- `summaryLoop` with stub `getAgentMilestones` + fake `{now,notes}` → written markdown has NOW + `HH:MM
  — note` lines with the *injected real* timestamps; absent getter → omitted; unparseable → NOW-only.

**E2E (Playwright `_electron`) — the live proof:**
- Seed a terminal whose `launchCommand` is a tiny **fake-claude fixture** that (i) emulates the
  SessionStart hook by writing a mapping line and (ii) writes a realistic timestamped transcript JSONL
  into a temp `HOME` (deterministic, no network; `CANVAS_LLM_MOCK=1`).
- **Flip** the board → assert `RecapView` shows NOW + timeline; click ⟳ → assert
  `.canvas/memory/board-{id}.md` updates and the back-face re-renders.

**Manual live verification (sign-off gate):** real `claude` session doing a real task → flip → confirm
the recap is accurate + resume-useful; screenshot.

Gate per CLAUDE.md: `pnpm typecheck · lint · format:check · vitest`, then the pre-push e2e matrix.

---

## 10. Resolved decisions

1. **Surface:** board **flip** (primary) + DigestPanel (overview).
2. **Slice-B debounce:** 20–30s.
3. **Per-board identification:** invisible env var + `SessionStart` hook → mapping file. **No visible
   CLI injection** (user rejected it). Pinpoints N same-cwd sessions. Verified hook mechanics.
4. **Hook install:** `.claude/settings.local.json` (gitignored, merged, no `~/.claude` mutation),
   reversible.
5. **Consent:** a friendly, benefit-first `RecapConsentModal` asked **once per project** (persisted in
   userData), gating the hook install. "Not now" is an equal choice; revisitable in Settings. The hook
   is NEVER installed silently.
6. **Ship A + B together.**
7. **Recap content:** NOW + timestamped meaningful-moment notes; drop tool-call noise; real timestamps
   by code, notes by one LLM call.

---

## 11. File touch summary

| File | Change |
|---|---|
| `src/main/agentTranscript.ts` (+test) | NEW — detect / extractMilestones / slug (pure) |
| `src/main/agentRecapMap.ts` (+test) | NEW — install/merge SessionStart hook into settings.local.json (idempotent, removable); watch mapping file → board→{sessionId,transcriptPath} |
| `src/main/hooks/recordSession.js` | NEW — shipped hook script: stdin + env → append mapping line |
| `src/main/pty.ts` | set `CANVAS_RECAP_BOARD` + `CANVAS_RECAP_MAP` env at spawn (invisible); ensure hook installed |
| `src/main/summaryLoop.ts` | EXTEND — milestone prompt, one structured call, code-assembled timeline; `getAgentMilestones` dep |
| `src/main/index.ts` | WIRE — provide `getAgentMilestones` (minimal) |
| `src/main/agentRecapWatcher.ts` | NEW (slice B) — debounced transcript-mtime watcher |
| `src/main/recapConsent.ts` (+test) | NEW — per-project consent store (userData); `recap:getConsent`/`setConsent` IPC; gates install |
| `src/renderer/.../boardSchema.ts` | `agentSessionId?` + `agentTranscriptPath?` on TerminalBoard (**cross-zone: text-font-toolbar**) |
| `src/renderer/.../RecapConsentModal.tsx` | NEW — friendly per-project consent modal (benefit-first, "What gets added?" transparency) |
| `src/renderer/.../SettingsModal.tsx` | add a per-project "Agent recaps" toggle (enable→install / disable→remove hook) |
| `src/renderer/.../TerminalBoard.tsx` | flip control + flipped state (xterm stays mounted) |
| `src/renderer/.../RecapView.tsx` | NEW — back-face NOW + timeline + ⟳ |
| `e2e/*recap*.e2e.ts` + fake-claude fixture | NEW — live-chain proof (incl. consent path) |
