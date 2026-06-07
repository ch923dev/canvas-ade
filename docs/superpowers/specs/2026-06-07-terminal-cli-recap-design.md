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

**Resume handling (verified).** `SessionStart` fires on **resume** too (`source: "resume"`), not only
fresh starts. So if a user opens a new terminal board and runs `claude --resume <id>` / `--continue`,
the hook fires with the resumed session's `session_id` + the existing `transcript_path`, and our
`CANVAS_RECAP_BOARD` env binds it to the new board → that board's recap shows the **full resumed
history** (and the mtime watcher keeps it fresh). This also covers conversations *started outside
Expanse* and resumed in one of our terminals. The hook only binds when `CANVAS_RECAP_BOARD` is set
(i.e. terminals we spawn); a resume in an external terminal fires the hook but has no board to bind to
(correct — not our board). Two boards may point at the same transcript over time (original + resumer) —
fine, both render the same recap; the app keys board→transcript and uses the latest mapping line per
board.

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
- **"Your data stays yours" assurance block (must be accurate — no false zero-egress claim):**
  - "Expanse has **no server and no account** — nothing is ever sent to us, and there's **no telemetry**."
  - "Your transcripts are **read locally**, on your machine."
  - "The only thing that leaves your computer is a short, **secret-scrubbed** slice of the conversation
    sent to **the LLM provider you choose, with your own key**, to write the summary — and only if
    you've set a key. **Choose a local model and nothing leaves your machine at all.**"
  - "**File contents and command output are never sent** — only the conversation text, capped."
- **Cost line:** "Summaries are cheap (~a fraction of a cent) and never run without a key. Turn it off
  anytime in Settings."
- **Buttons:** `Enable recaps` (primary) · `Not now` (declines for this project; revisitable in
  Settings). No dark patterns; "Not now" is a real, equal choice.

**Settings = the feature-flag control plane (the user's framing).** A per-project "Expanse features"
section with an **Agent recaps** flag mirrors/changes the decision later — enabling installs the hook,
disabling removes our hook entry from `settings.local.json`. This section is the home for future flags
(e.g. the deferred MCP swarm / self-report enrichment, §12), so one clear opt-in surface governs all
agent-integration features instead of silent per-feature installs.

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
- **No Expanse backend / no telemetry:** the app has no server or account; transcript data is never
  sent to Expanse or any third party we control. The hook, mapping file, and transcript reads are all
  local. (Single-user desktop app — there is no backend.)
- **Egress is user-chosen + avoidable:** the only egress is the summarize call to the LLM **provider the
  user configured, with their own key** — same class as existing Tier-2 egress (ADR `0003-llm-egress`).
  A **local (loopback) provider means zero egress**; no key means no call at all.
  **tool_result bodies are never forwarded**; only capped conversation text, light secret-scrub
  (`sk-…`/`ghp_…`/`AKIA…`) before egress.
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

> **Spike result 2026-06-07: PASS.** Real `claude` 2.1.162 launched headless (`claude -p "say hi"
> --dangerously-skip-permissions`) from a shell with `CANVAS_RECAP_BOARD=spike-123` exported, in a temp
> project carrying a `SessionStart` hook → the hook's `hook-saw.txt` recorded `BOARD=spike-123`. Env IS
> inherited by SessionStart hooks; the env-var bridge is validated. **Fallback (cwd+spawn-order) NOT
> needed.** Also confirmed (Claude Code docs, hook schema): the hook object supports an `args: []` array
> (exec form — no shell, safe for the spaced repo path), and stdin carries `session_id` ·
> `transcript_path` · `cwd` · `source`. **Install (Task 4) uses exec form `command:"node", args:[script,
> map]` — not the shell-form command string the spike used.**

> **Implementation status 2026-06-08: COMPLETE + LIVE-VERIFIED.** All plan tasks T0–T16 built via
> subagent-driven TDD (each task: implementer + 2-stage spec/quality review, all green). A final
> whole-implementation review returned **SHIP** — end-to-end flow connected, the privacy guarantee
> verified at the egress boundary (a test captures the real fetch body and asserts raw `sk-…`/`ghp_…`
> tokens are absent / `[redacted]`), cross-zone changes additive + clean.
>
> **✅ Live-verified by the user (real `claude`, 2026-06-08):** ran a real agent doing a PR review in a
> terminal board → flipped → the recap showed an accurate NOW + a real-timestamped timeline of the
> resume-relevant moments. Four issues found + fixed during the live pass (all gate-green): (1) the
> recap was unclickable — the 3-D flip mis-mapped pointer hit-testing → replaced with an opaque overlay;
> (2) a hand-typed `claude` left an empty boardId in the map — the env var was gated on
> `launchCommand==='claude'` → now injected for any terminal in a consented project (summaryLoop likewise
> keys on the learned transcript, not the launch string); (3) the model wrapped its JSON in a ```json
> fence → `parseRecapPayload` now slices the `{…}` out before parsing; (4) the timeline was a verbose
> per-turn log → the model now curates the 3-5 most resume-relevant beats (`{now, notes:[{i,text}]}`),
> code stamps real times via the milestone index, capped at `MAX_RECAP_NOTES`.
>
> **Resume shipped in-branch (was §12 fast-follow):** the Restart control now offers Resume / New on a
> board with a learned `agentSessionId`; Resume respawns `claude --resume <id>`. Live-confirmed.
>
> Gate green at tip `f0bd4cd`: `typecheck` clean · `lint` 0 errors · `format:check` clean · `vitest`
> **1486 passed / 120 files**; deterministic flip-to-recap e2e passes. (`claudeProjectSlug` slug-dir
> fallback dropped as dead code — the spike passed, so it was never wired.)

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

---

## 12. Deferred follow-ups (not this feature)

1. **Resume agent — ✅ SHIPPED in-branch (2026-06-08, was a deferred fast-follow).** The Restart control
   on a board with a learned `agentSessionId` opens a Resume / New menu; Resume respawns
   `claude --resume <sessionId>` to continue the real conversation (one-shot `launchOverride` consumed by
   `respawn`). Live-verified. Remaining follow-up: an e2e for the menu/spawn-command (currently covered
   only by the live pass) + handling multiple past sessions per board (a picker) if needed.

2. **MCP self-report enrichment + swarm wiring.** Evaluated and deferred (2026-06-07). Verification
   showed MCP **cannot replace the hook** for recaps:
   - The MCP connection is anonymous beyond `clientInfo` (name/version) — it carries **no** `session_id`
     / `transcript_path`; the agent **cannot self-discover** its own session id/transcript path (only a
     hook gets them). So MCP can't locate the transcript.
   - Wiring `claude`→MCP is **not** more invisible: a committed `.mcp.json` (worse), a global
     `~/.claude.json` mutation, or a visible `--mcp-config` flag. No invisible env path exists.
   - `write_result` is **self-report only** (pull/agent-cooperation; no auto-push; can be
     stale/missing; no guaranteed timeline) — lower quality than the independent transcript observer.
   - It also requires building the currently-**unwired** claude→Expanse MCP client (token/URL
     injection) — a separate swarm-layer effort.
   **Future value:** once that wiring exists, `write_result` is excellent **opportunistic enrichment
   layered on top of** the transcript recap (high-intent "agent says it's done", `status`/`refs`), and
   it unlocks the swarm roadmap. It slots into the same Settings feature-flag panel (§4.8) as a new
   flag. Build it as its own feature; this recap does not block on it.
