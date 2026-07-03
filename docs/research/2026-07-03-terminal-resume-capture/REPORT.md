# Terminal resume — why "No conversation found", and how to fix capture

**Date:** 2026-07-03 · **Status:** research (no code changed) · **Owner ask:** Resume on a closed
terminal session fails with `No conversation found with session ID: <id>`; suspicion was "the
SessionStart hook isn't working — should we capture via an MCP function triggered at session
start instead?"

**TLDR:** The hook *is* the right channel and it *is* firing (it's how an id ends up shown at
all). The defect is **when** the id is captured and **that nothing ever validates it** before
offering/running Resume. Claude Code has **no native way** to trigger an MCP tool at session
start, and MCP servers never learn the Claude session id — so the MCP-hook idea is a dead end as
the *capture* channel. The fix is a 4-layer hardening of the existing hook pipeline:
capture at `UserPromptSubmit`/`SessionEnd` (not just `SessionStart`), validate the transcript
exists before flipping `canResume`, re-resolve the id at Resume-click time in MAIN, and surface
hook health instead of failing silently.

---

## 1. The resume chain as built today

| Step | Where | What |
|---|---|---|
| Spawn | `src/main/index.ts:399` (`setRecapEnvProvider`) | Consented project → every PTY spawn gets `CANVAS_RECAP_BOARD=<boardId>` |
| Capture | `src/main/hooks/recordSession.js` via **SessionStart** hook in `<project>/.claude/settings.local.json` (installed by `agentRecapMap.ts`) | Appends `{boardId, sessionId, transcriptPath, cwd, source, ts}` to `userData/recap/session-map.jsonl` |
| Learn | `src/main/index.ts:850` (`watchRecapMap`) → `recap:learned` → `App.tsx:58` → `patchBoardMeta` | Sets `board.agentSessionId` + `agentTranscriptPath`; **persisted in canvas.json** |
| Offer | `TerminalBoard.tsx:196` | `canResume = !!board.agentSessionId` — no other check |
| Execute | `resumeCommand.ts` → `launchOverrideRef` → fresh PTY | Writes `claude --resume <sanitized-id>` as the first PTY line — **no MAIN-side validation at click time** |

Resume surfaces (all share the same `canResume` + `resumeCommand` path): exited-terminal CTA
(`TerminalEndCTA`), restored bar, Inspector Session controls, command palette, recap face.

## 2. Root-cause analysis — the id shown is not (necessarily) the session you had

Four independent ways the stored `agentSessionId` goes wrong. All were possible before PR #290;
#290 fixed the *transcript resolution* side only (recap display), not the *resume* side.

**RC-1 — Eager capture (confirmed 2026-07-01, memory `recap-resume-eager-session-capture-gap`).**
SessionStart fires at `claude` launch with a `session_id`, but the `<id>.jsonl` transcript is only
written once the conversation has content. Launch-then-quit → id stored, `canResume` flips true,
transcript never exists → `--resume` correctly errors. Confirmed on disk: `c99893f2-…` existed
only as a `tool-results/` directory, no `.jsonl`.

**RC-2 — Mid-session rotation.** This repo's own empirical case (the `agentTranscript.ts:124`
comment block): compaction / `/resume` rolled the live session onto a NEW transcript
(`5e985fe0.jsonl` gone, live `b22cb76e.jsonl`) — the stored id points at a dead file.
⚠️ Current official docs claim `--resume` keeps the same id and compaction rewrites in place
(see §3.7) — that **conflicts with our observed behavior**; treat rotation as real across CC
versions and design defensively.

**RC-3 — Hook silently dead → stale id survives.** `agentSessionId` persists in canvas.json
forever. If the hook stops firing, the board keeps offering a months-old id. Silent-death causes,
all real in this codebase/environment:
- **Packaged build + no `node` on PATH** → `recapRunner` null → hook never installed;
  only a `console.warn` (`src/main/index.ts:386`). User never learns capture is off.
- **`settings.local.json` clobbered by third-party tooling** — the user's own environment has a
  known clobberer (bridgespace rewrites `.claude/settings.local.json`; see CC-setup memory). The
  app re-ensures the hook only on project open, so a mid-session clobber kills capture until the
  next open.
- **Consent gating**: recap consent declined/unset → no env var, no hook. Note the coupling smell:
  Resume (local-only) is gated behind *recap* consent (an LLM-egress consent).
- **cwd mismatch**: hook lives in `<projectDir>/.claude/`; a claude launched in another directory
  records nothing (and its sessions live under a different project slug anyway — see §3.10).

**RC-4 — Transcript retention.** Claude Code deletes transcripts older than `cleanupPeriodDays`
(default **30**) *at startup*. A stored id older than that fails resume even if everything else
was correct.

Any of RC-1…4 produce exactly the user-observed symptom: a resume code is shown (stored long ago
or captured eagerly), but it does not correspond to a resumable conversation.

## 3. Claude Code facts (verified against current docs, 2026-07-03)

Researched via docs (code.claude.com/docs: hooks, sessions, how-claude-code-works, env-vars,
settings). Numbered to match the questions asked.

1. **SessionStart** stdin: `{session_id, prompt_id, transcript_path, cwd, permission_mode,
   hook_event_name}`. `source` values: `startup | resume | clear | compact`. It **does re-fire**
   on resume (`source:"resume"`) and on compaction (`source:"compact"`).
2. **When `.jsonl` is created: NOT documented.** Empirically (RC-1): not at launch — only once
   the conversation has content. Any fix must *check the file*, never assume.
3. **UserPromptSubmit** hook exists, gets the same common fields incl. `session_id` +
   `transcript_path`. Whether the `.jsonl` already exists at fire time is **unverified** → the
   hook script must `fs.existsSync(transcript_path)` and record the result, not assume.
4. **Stop** (fires when Claude finishes a turn) and **SessionEnd** (fires at session termination;
   matcher = reason: `clear|resume|logout|prompt_input_exit|…|other`) both exist with the same
   common payload. SessionEnd reliability on hard kill (`taskkill /T /F` — which is exactly how
   our PTY teardown kills the tree) is **undocumented** → don't rely on SessionEnd alone.
5. **Exec-form hooks (`{type:'command', command, args[]}`) are officially supported** — separate
   argv, no shell tokenization; Windows requires `command` to be a real `.exe` (node.exe = fine).
   Our current install shape is valid; the hook-schema hypothesis is ruled out.
6. **MCP + session lifecycle: nothing native.** Hooks cannot invoke MCP tools; MCP servers get no
   session-start notification and never learn the Claude `session_id` (not in initialize params,
   not in env). Also the model itself does not know its own session id, so "agent calls an MCP
   tool to register itself" cannot work either. **→ the user's proposed MCP-triggered capture is
   not implementable as the id source. Hooks remain the only channel that carries `session_id`.**
   (An MCP/HTTP endpoint could replace the *map file* as transport — §5, F-alt — but that changes
   nothing about timing/validity.)
7. **Docs say** `--resume` continues under the **same id** appending to the same `.jsonl`, and
   compaction rewrites in place without changing the id; `/branch` / `--fork-session` mint new
   ids. **Conflicts with our field observation (RC-2).** Either older CC versions rotated, or
   rotation happens in undocumented paths. Design must tolerate both.
8. **Retention:** `cleanupPeriodDays` default 30, pruned at CC startup. Multi-month-old stored ids
   are dead by design unless the user raises it.
9. **No `CLAUDE_SESSION_ID` env** for child processes (only `CLAUDE_CODE_BRIDGE_SESSION_ID` under
   Remote Control, not our case). Hook stdin is the only id source — confirms §3.6.
10. **`--resume <id>` lookup is scoped to the current project directory (cwd slug) + its git
    worktrees**, not machine-wide. Error text when missing: exactly
    `No conversation found with session ID: <id>`. → Resume must run in the same cwd the session
    was created in (our boards default to the project folder, so normally fine — but a custom
    board cwd or a launchCommand that `cd`s breaks it).

## 4. Verdict on the "MCP function triggered at session start" idea

**Not viable as the capture mechanism** — three independent blockers:
- No hook→MCP invocation path exists in Claude Code.
- MCP servers (incl. `@expanse-ade/mcp` on the auto-cabled terminals) never receive the session id.
- The agent can't self-report an id it doesn't know.

What *is* viable and keeps the spirit of the idea: keep the hook as the trigger, but make the
pipeline robust and observable (below). If we ever want a live push instead of file-watch, the
hook can POST to the app's existing local HTTP server — but the file+watch transport is not the
broken part, so this is optional.

## 5. Fix design — four layers (each independently shippable)

**F1 — Gate `canResume` on transcript reality (highest value / smallest change).**
MAIN-side check (extend `recapIpc` or the existing facts flow): resolved transcript for the board
exists, is non-empty, and — where the #290 lineage machinery applies — its tail actually belongs
to `agentSessionId`'s lineage. Renderer replaces `canResume = !!board.agentSessionId`
(`TerminalBoard.tsx:196`) with the learned, MAIN-validated boolean (re-checked on exit/flip/open,
not per-render). Kills the false Resume CTA for RC-1/2/4 in one move.

**F2 — Capture later, and validate inside the hook.**
Register the SAME `recordSession.js` for **UserPromptSubmit** and **SessionEnd** in addition to
SessionStart (three entries in `agentRecapMap.installRecapHook`, same exec-form shape). The script
adds two fields: `hookEvent` and `transcriptExists: fs.existsSync(transcript_path)`.
`readRecapMap` prefers the latest entry with `transcriptExists:true` for resume purposes (keeps
the eager SessionStart entry for recap-map freshness). Effects: an id only becomes resume-grade
once the conversation is real; mid-session rotation self-heals every turn boundary instead of
only at SessionStart; map growth stays trivial (~1 line/prompt). Grace logic from #290
(`resolveLiveTranscriptPath` ts-gating) keeps working unchanged.

**F3 — Re-resolve at Resume-click time (MAIN), with fallback.**
Resume click → renderer asks MAIN for the resume line instead of building it locally:
1. stored id's `.jsonl` exists → `claude --resume <id>`.
2. missing → `resolveLiveTranscriptPath` scan + tail lineage → extract the transcript's ACTUAL
   session id → resume that (fixes "the code shown wasn't from my session").
3. nothing resumable → `claude --continue` (resumes the cwd's most recent session — docs-verified)
   or plain fresh start, with a one-line notice in the well.
Keep `resumeCommand`'s sanitization in MAIN (same charset rule — it's a security boundary,
canvas.json is untrusted input).

**F4 — Hook-health surfacing (kills the "is the hook even working?" class).**
- Packaged + `recapRunner === null` → visible status, not `console.warn`: Inspector Session block
  shows "Session capture off — Node.js not found on PATH".
- Consented project + claude spawn + no map entry for that board within ~15s → "capture didn't
  record this session" hint (catches the settings.local.json-clobber case live).
- On project open, the existing re-ensure already self-heals the hook; add a cheap
  isRecapHookInstalled re-check on window focus to heal mid-session clobbers.

**F-alt (optional, not required):** hook POSTs to the app's local server instead of file append —
live push, no fs.watch. Only worth it bundled with other work; transport is not the defect.

**Also worth deciding (product):** decouple Resume from recap consent — Resume is local-only
(`--resume` never egresses), but today capture (and therefore Resume) only works in
recap-consented projects. Either split consent (capture vs egress) or at least say so in the UI.

## 6. Suggested order

1. F1 + F3 together (one PR: MAIN-validated `canResume` + click-time resolution + fallback) —
   fixes the user-visible lie immediately, even with today's eager capture.
2. F2 (hook registration + script fields + map preference) — makes the stored id trustworthy.
3. F4 diagnostics.
4. Product call on consent decoupling; retention note (`cleanupPeriodDays`) in docs.

E2E notes: RC-1 is reproducible headlessly (launch claude, quit, assert no Resume offered);
F3 fallback testable by pointing a board at a fabricated stale id with a real newest transcript
beside it (fixture under a fake `CLAUDE_CONFIG_DIR` — `isTrustedTranscriptPath` honors it).
