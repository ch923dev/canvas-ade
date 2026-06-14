# Spec — Terminal recap redesign (two-zone face + local facts layer + front-face status)

- **Lane:** `feat/recap-redesign` (worktree `.worktrees/recap-redesign`, base `f5dfc99`)
- **Status:** spec approved direction; implementation follows on this lane
- **Design artifact:** the two-zone wireframe below — **approved by the user 2026-06-13** via the
  AskUserQuestion preview panel (option "Two-zone: glance + evidence"), plus "front-face status dot"
  approved in the same exchange. Then rendered as a token-faithful HTML mock
  (`2026-06-13-recap-redesign-mock.html`, this folder — open in any browser; uses the repo's Geist
  woff2 via relative path) showing both states (narrative+facts "waiting on you"; facts-only
  "running") + the title-bar dot — **pixel render approved by the user 2026-06-13** ("looks good").
  This mock is the S1 reference. Per CLAUDE.md "Design artifact before code".
- **Doc lifecycle:** this file is a slice artifact — delete in the merge PR; residue =
  one line in `docs/archive/build-history.md`.

## 1. Problem

The shipped recap (#89) is architecturally sound (consent-gated, secret-scrubbed,
code-stamped timestamps) but weak on frame, design, context, and content:

1. **The LLM never sees what the agent did — only what it said.** `extractMilestones`
   keeps user/assistant *text* turns only; every `tool_use` (Edit/Write paths, Bash
   commands with human `description` fields) is dropped. The model can only produce a
   vague third-person audit log.
2. **Starvation caps.** 12 milestones x 600 chars, total input sliced at 4,000 chars
   (`MAX_INPUT_CHARS`), 3-5 output notes. Long sessions vanish through the keyhole.
3. **No live status in the recap.** `getTerminalRuntime` exists but only feeds the
   *fallback* (non-recap) path. The recap cannot answer "is it waiting on me?"
4. **Raw text dump rendering.** `RecapView` renders cached markdown with
   `whiteSpace: pre-wrap` — literal `**Now:**` asterisks, raw backticks, raw `- `
   bullets, 12.5px, one micro-label, vast empty board below.
5. **Every recap costs a budgeted LLM call** (25s write-burst debounce) even if the
   board is never flipped; budget exhaustion = silently stale recap. Yet most of the
   value (status, duration, files, commands, title, last ask) is computable locally
   from the transcript JSONL at zero cost.
6. **Prompt produces a log, not a glance.** No voice, no next-action, no open-question
   surfacing.

Verified against a real transcript JSONL: it carries `ai-title` records (Claude's own
session title), `last-prompt` records (the user's last ask), `tool_use` blocks with
file paths and Bash `description` strings, per-message token usage, and full
timestamps. All locally extractable with **zero egress**.

## 2. Research basis (2026-06-13 sweep: Devin, Cursor, Conductor, Maestri, Warp, Copilot agent, Codex, Amp, Factory)

Patterns adopted, ranked:

1. **"Waiting on you" is the apex signal — words, not just color** (Devin "Action
   Required" labels + orange dot up to the favicon; Warp blocked-agent notifications;
   Codex "awaiting input" threads).
2. **Mechanical fact chips beat prose** (Devin clickable `+N/-M` diff stats; Claude
   Code /resume rows = message count + age + branch, all computed).
3. **NOW line + timestamped beats with durations; skeleton mechanical, only the beat
   label is LLM prose** (Devin work-log accordion; Copilot collapsed-subagent HUD).
4. **On completion: headline + suggested next action** (Maestri Ombro: "summarizes
   what happened and suggests what to do next").
5. **The recap is the resume handle** (Devin checkpoint scrubber; Conductor turn
   revert; our `claude --resume` already exists — put it ON the face).

## 3. Approved design artifact

### 3.1 Flip face — two-zone "glance + evidence"

```
+----------------------------------------------+
| @ WAITING ON YOU . 47m       [Resume]  [R]   |   <- zone 1: status header
|                                              |
| NOW  Asked whether to move docs/ into        |   <- LLM "now" (or facts-only
|      dunly-backend or delete the shots --    |      fallback when no key)
|      answer to continue.                     |
|----------------------------------------------|
| TIMELINE                                     |   <- zone 2: evidence (scrolls)
|  04:21 - Reviewed docs/ + root; found 18     |
|     2m    stray verification PNGs (~2.2MB)   |
|  04:39 - You: are the screenshots useful?    |
|  04:40 - Deleted 17 PNGs; cleanup rule       |
|     1m    added to CLAUDE.md                 |
|                                              |
| CHANGED                  COMMANDS            |
|  CLAUDE.md  x2            rm x17             |
|  17 PNGs deleted          git status         |
|----------------------------------------------|
| Last ask: "Does the screenshots really..."   |   <- footer fact
+----------------------------------------------+
```

(The Unicode box mock with `●`/`─` glyphs as approved lives in the PR description;
this ASCII copy is the in-repo reference.)

**Token mapping** (mirror of `index.css` / DESIGN.md §2-4; no new tokens):

- Face bg `--surface`; zone divider `--border-subtle`.
- Status label: micro role (10-11px, 500, `--mono`, uppercase) colored by status:
  `--warn` waiting-on-you · `--ok` running · `--text-3` idle/exited(0) ·
  `--err` exited(non-zero)/spawn-failed. 8px dot, same color (status = dots/words
  per contract; no glow).
- Session age + meta: meta role, `--mono`, `--text-2`.
- NOW: UI font 13-14px, `--text`, lh 1.5; label `NOW` micro `--text-3`.
- NEXT (when narrative provides one): one line under NOW, `--accent-wash` bg +
  3px `--accent` left border (functional accent only).
- Timeline: timestamps `--mono` `--text-3`; durations `--mono` `--text-3` (NOT
  `--text-faint` — disabled-only); beat text `--text-2`; user beats get an
  `--accent` 6px dot, agent beats `--border-strong`.
- Chips: `--surface-raised` bg, `--border` 1px, meta type, `--text-2`.
- Buttons: existing `IconBtn`/board-chrome button styles; `[Resume]` reuses the
  TerminalRestartMenu resume path (gated on `agentSessionId`, exactly like today).

### 3.2 Front-face status (board title bar)

```
| > TERMINAL  Terminal     @ waiting   - + [] ... |
```

- Dot (8px) + lowercase word in the terminal board's title bar, right cluster,
  before the window controls; meta type, colored as §3.1. Shown for boards with a
  known agent session only (facts present); plain shell boards render nothing.
- Tooltip = the NOW line when one exists.
- NOT clickable in v1 (the flip button next to it is the affordance).

## 4. Architecture

### 4.1 Layer 0 — local facts (free, instant, zero egress, no consent needed)

New MAIN module `src/main/recapFacts.ts`:

`computeRecapFacts(jsonlTail, runtime, now) -> RecapFacts` — pure, total:

```ts
interface RecapFacts {
  v: 1
  status: 'spawning' | 'running' | 'waiting-on-you' | 'idle' | 'exited' | 'spawn-failed'
  exitCode?: number
  title?: string            // last ai-title record
  sessionStart?: number     // first timestamp in tail
  lastActivity?: number     // max(transcript ts, runtime lastActivityAt)
  turns: { user: number; agent: number }
  lastAsk?: string          // last `last-prompt` record (or last user text turn), capped
  files: { path: string; op: 'edit' | 'write'; count: number }[]   // deduped, basename + count
  commands: { label: string; count: number }[]  // Bash description (or cmd head), deduped
  generatedAt: number
}
```

**Status heuristic v1** (precedence top-down):

| status | rule |
|---|---|
| `spawn-failed` / `spawning` | runtime says so |
| `exited` | runtime exited (carry exitCode) |
| `waiting-on-you` | runtime alive AND last meaningful transcript event is an assistant text turn whose tail reads as a question (`?` in the last ~200 chars) OR an `AskUserQuestion` tool_use with no later user turn |
| `running` | runtime running AND activity < `IDLE_AFTER_MS` (60s, existing const) |
| `idle` | otherwise |

Persisted as a sidecar `.canvas/memory/board-<id>.recap.json` = `{ facts, narrative? }`.
Sidecar is `.canvas/`-scoped (already gitignored by the scaffold); **never egressed**,
**never read by MCP** in this slice. `board-<id>.md` (DigestPanel/MCP markdown) is
**unchanged in shape** — still written by the narrative path.

Recompute: on transcript change (reuse `agentRecapWatcher`, new fast lane ~2s
debounce), on `pty` state change, and on demand from `recap.get`. Cost = one 64KB
tail read + parse (`readTranscriptTail` already exists); sync + trivial.

### 4.2 Layer 1 — LLM narrative (consent-gated, budgeted — the enhancement)

Recap-specific code moves out of `summaryLoop.ts` (587 lines, ratchet citizenship)
into `src/main/recapNarrative.ts`. Changes:

- **Tool-aware milestones** (`extractMilestones` v2): keep text turns as today; ADD
  agent milestones for `tool_use` — Edit/Write/NotebookEdit -> `edited <basename>`,
  Bash -> its `description` (fallback: first 60 chars of command), consecutive
  Read/Grep/Glob collapsed to one `read N files` milestone. Same redactSecrets path.
- **Caps raised:** `MAX_MILESTONES` 12 -> 30; recap input cap 4,000 -> 12,000 chars
  (config-summary path keeps 4,000); beats rendered cap 5 -> 8.
- **Payload gains `next`:** `{now, next?, notes:[{i,text}]}` — `next` is the
  suggested user action ("Approve X", "Answer the question about Y"). Parser
  tolerates absence (back-compat with cached payloads).
- **Prompt rewrite** (RECAP_SYSTEM v2): second person ("You asked... It deleted..."),
  lead with any open question, require `next` when the agent is blocked, prefer
  decisions/scope/findings, still: no timestamps (code stamps from `i`), JSON only.
- **Durations:** code computes each beat's duration = gap to the next milestone's ts
  (floor 0, omit when < 60s); rendered on the rail. Mechanical, trustworthy.
- Markdown for `board-<id>.md` is still generated (digest/MCP unchanged); the
  structured payload additionally lands in the sidecar for the renderer.

### 4.3 Trigger economics (the perf win)

| event | today | after |
|---|---|---|
| transcript write burst | 25s debounce -> **LLM call** | 2s debounce -> **facts only** (free) |
| agent turn completes | (invisible) | **Stop hook** (new, installed/removed by the same idempotent `installRecapHook` mechanism + consent surface as the SessionStart hook) appends a turn-complete line -> narrative refresh, 5s debounce |
| no Stop hook installed | — | fallback: transcript-quiet detection (no writes for 30s after a burst) -> narrative refresh |
| flip to recap | read cache only | facts always fresh; if `narrative.asOf < lastActivity` -> auto refresh narrative (budgeted) |
| manual refresh button | LLM call | unchanged (forces narrative) |

Net: fewer budgeted calls than today (no mid-flow churn), fresher when actually
viewed. Budget store, consent gate, `isTrustedTranscriptPath`, and redaction are
all unchanged in kind.

### 4.4 IPC surface (preload-mirrored, frame-guarded like existing channels)

- `recap:get (boardId) -> { facts, narrative? }` — recomputes facts on call.
- `recap:refresh (boardId)` — forces a narrative summarize (existing
  `memory.refresh` semantics move here for terminal boards; DigestPanel path
  untouched).
- `recap:facts` push event (boardId + facts) on the fast lane -> drives the
  front-face dot + a mounted RecapView without polling. Renderer store: a small
  `recapStore` (Zustand, ephemeral — NEVER serialized into canvas.json; scene/
  session split per CLAUDE.md).

No `canvas.json` schema change anywhere in this feature (sidecar + ephemeral store
only) — no schemaVersion/minReaderVersion bump.

## 5. Slices

| # | scope | files (zone) | tests |
|---|---|---|---|
| S0 | `recapFacts.ts` extractor + status heuristic + sidecar write + fast-lane watcher wiring | `src/main/recapFacts.ts` (new), `agentRecapWatcher.ts`, `index.ts` wiring | unit: fixture JSONL -> facts; status table; TOCTOU/malformed lines |
| S1 | RecapView rebuild (two-zone, components, tokens) + `recap:get` IPC + Resume button + freshness stamp | `RecapView.tsx` (+ split if ratchet demands), `preload/index.ts`, `projectIpc.ts` or new `recapIpc.ts` | unit: render states (facts-only, facts+narrative, empty, exited); e2e: flip shows facts **with no LLM key** |
| S2 | narrative upgrade: tool-aware milestones, caps, prompt v2 + `next`, durations; extract `recapNarrative.ts` | `agentTranscript.ts`, `summaryLoop.ts` -> `recapNarrative.ts` | unit: milestone extraction incl. tool_use + collapse; payload parse w/ `next`; duration stamping |
| S3 | trigger model: Stop hook + quiet-detect fallback + stale-on-flip; remove per-burst summarize | `agentRecapMap.ts` (hook install), `hooks/recordTurn.js` (new), `agentRecapWatcher.ts`, `summaryLoop.ts` | unit: hook merge idempotency; debounce lanes; e2e: no LLM call during burst (mock provider counter) |
| S4 | front-face status dot in terminal title bar + `recap:facts` push + `recapStore` | `TerminalBoard.tsx`, `store/recapStore.ts` (new), preload | unit: dot states; e2e: seeded fixture transcript -> waiting dot visible without flip |

Merge as ONE PR (slices = commits) unless review size forces a split; S0+S1 alone
are shippable (facts-only recap is already a strict improvement).

## 6. Invariants (do not weaken)

- Layer 0 facts NEVER leave the machine; no consent needed to compute/show them.
- Narrative egress: consent-gated, `redactSecrets` on every milestone (now including
  tool-derived text — file paths/commands go through the same scrub),
  `isTrustedTranscriptPath` guard stays, key never leaves MAIN.
- `sanitizeSummary`/`sanitizeTitle` on all LLM text before disk/render (now/next/beats).
- Hook install stays idempotent + non-clobbering in `settings.local.json`; Stop hook
  rides the SAME install/remove/consent surface as SessionStart (no new consent).
- Flip mechanics untouched: flat-at-rest 3D, PTY never tears down, A6 focus transfer.
- DigestPanel/MCP `board-<id>.md` contract unchanged.
- e2e gate: pre-push Windows leg; FULL matrix at pre-merge (this lane touches
  `src/main` -> Linux leg is push-sensitive per the hook's `LINUX_SENSITIVE`).

## 7. Out of scope (deliberate)

- Canvas-level attention cues (zoom-out ring on waiting boards) — follow-up candidate.
- Clickable diff-stat chips opening scoped diffs (needs git plumbing) — follow-up.
- Unread/delta anchoring ("since you last looked") — follow-up.
- MCP exposure of the facts sidecar — decide with the MCP roadmap, not here.
- Permission-prompt "blocked" detection (not in transcript JSONL) — Stop hook covers
  turn-complete; Notification-hook-based blocked detection is a follow-up.
