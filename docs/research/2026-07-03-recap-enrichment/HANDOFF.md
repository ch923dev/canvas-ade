# HANDOFF — Workstream C: richer recap facts (`feat/recap-enrichment`)

> **You are the implementation session for this feature.** Work ONLY in this worktree
> (`Z:\Canvas ADE\.worktrees\recap-enrichment`, branch `feat/recap-enrichment`, based on
> `3ca57748` = main tip with #290 + #292 merged). Never edit the MAIN checkout, never run
> `pnpm install` from this worktree (node_modules is a junction to MAIN — see
> `CLAUDE.md › Parallel sessions` and the coordination board row already created for you).

## Mission

Enrich the terminal-board recap face with data that is ALREADY in the agent transcript JSONL but
unused today. All new facts parse in `computeRecapFacts`'s existing single 64KB tail pass — no
new I/O, no LLM cost, no consent change. The design below is **signed off by the user**
(2026-07-03, from the approved plan `do-an-indepth-review-linked-minsky.md`) — build to it.

## Context you need (read these first)

- `src/main/recapFacts.ts` — the Layer-0 facts parser (local, ungated, runs per `recap:get`).
  Your main target. It already does one pass over the transcript tail; fold every new field into
  that pass.
- `src/renderer/src/canvas/RecapView.tsx` — the recap face (two-zone: narrative + facts). Renders
  the new rows. Feature-detect every new field (facts bundle is never persisted → **no schema
  bump**, older data just lacks the fields).
- `src/main/resultSynth.ts` / `buildRecapInput` — the narrative prompt builder (P3 only).
  `redactSecrets` (ADR 0003) must scrub anything you add; respect `MAX_INPUT_CHARS`.
- Just shipped on your base (PR #290): `summaryLoop.refresh()` returns typed `RefreshOutcome`,
  `recap:updated` push, `lib/recapNote.ts` why-notes, `resolveLiveTranscriptPath` lineage
  handling, preload recap api in `src/preload/recapApi.ts`. Don't re-fight that plumbing — you
  only ADD fields to facts + UI.
- `e2e/recap.e2e.ts` — 5 specs, all green on your base. You extend the seeded-fixture pattern.

## Scope (all four tiers approved)

New OPTIONAL fields on the facts type in `recapFacts.ts` (all additive):

- **P0**
  - `todos?: { done: number; total: number; active?: string }` — from the LAST TodoWrite
    tool_use in the tail (later entries win).
  - `errors?: { count: number; last?: string }` — tool_results with `is_error: true`; `last` =
    a short scrubbed excerpt of the most recent one.
  - `model?: string` — from assistant message metadata.
  - `gitBranch?: string` — from the transcript (e.g. gitStatus context block), NOT by running git.
- **P1**
  - `contextTokens?: number` — the LAST assistant `usage` (input + cache-read). A point metric —
    honest under tail truncation. Deliberately NOT a summed cost.
  - Per-file `adds`/`dels` on the existing changed-file entries — from `structuredPatch` in
    Edit/Write tool_results.
- **P2**
  - `agents?: { count: number; labels: string[] }` — Task tool_use activity, labels capped at 3.
- **P3 (narrative, the only tier that costs tokens)**
  - Append ≤2 lines to `buildRecapInput`: plan progress + last error — through `redactSecrets`,
    inside `MAX_INPUT_CHARS`. `RECAP_SYSTEM` schema stays UNCHANGED.

## Signed-off design (build exactly this; tokens from `src/renderer/src/index.css`)

```
┌────────────────────────────────────────────────────────────────────┐
│ ● running · 36m session · as of 14:02        [Resume ⏎]  [⟳]      │
│ ★ claude-sonnet-5 · feat/voice-to-text · 62k ctx        (mono/dim) │
│                                                                    │
│ Voice V3 UI and injection implementation                (title)    │
│                                                                    │
│ Now   Wiring the flyout Send path into the PTY …                   │
│ ★Plan  4/7 — wiring terminalInputRegistry            ▂▂▂▂▂░░ (2px) │
│ Next  Approve the settle-delay approach.              (accent bar) │
│ ──────────────────────────────────────────────────────────────────│
│ Timeline                                                           │
│  14:32 ● You: review auth                                          │
│  14:35 ○ Found 3 issues …                                          │
│                                                                    │
│ CHANGED                        COMMANDS                            │
│ [MEMORY.md ★+12 −4 ×2]        [Re-push feat/voice-to-text]         │
│ [voiceStore.ts ★+88 −7 new]   [Check push output]                  │
│ ★ 2 tool errors — last: "EBUSY: rename …"        (warn meta line)  │
│                                                                    │
│ Last ask: "continue"                                    (footer)   │
└────────────────────────────────────────────────────────────────────┘
```

- ★ meta row: `model · branch · Nk ctx` — mono `--fs-meta`, `--text-3`, ellipsized; renders only
  when at least one field exists.
- ★ Plan row: same `34px 1fr` grid as Now/Next; `done/total — <active item>`; 2px progress bar,
  `--border-subtle` track / `--accent` fill (mirrors the Planning checklist bar).
  `data-test="recap-plan"`.
- ★ Diff stats on Changed chips: `+adds` in `--ok`, `−dels` in `--err`, meta font.
- ★ Errors line: warn-toned meta above the last-ask footer, only when `count > 0`.
  `data-test="recap-errors"`.
- Calm/dense Linear-Raycast feel, one accent, no gradients/glow — `design-reference/` rules apply.

## Tests required

- **Unit (`recapFacts` tests):** a fixture per new field; a partial/truncated-tail robustness
  case per field (field absent, never a throw); caps (labels ≤3, `last` excerpt bounded);
  later-TodoWrite-wins; is_error counting.
- **Renderer (`RecapView` tests):** each new row renders when the field exists and is ABSENT
  when it doesn't (feature-detect branches); plan-bar width math; errors line only when count>0.
- **e2e (`recap.e2e.ts`):** extend the seeded fixture transcript with a TodoWrite entry + an
  `is_error` tool_result → assert `recap-plan` + `recap-errors` render with NO LLM key
  (deterministic, zero egress).
- **P3:** unit that `buildRecapInput` includes the two lines, scrubbed, and never exceeds
  `MAX_INPUT_CHARS`.

## Verification protocol (all mandatory before PR)

1. Full gate: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` (lint must be
   0 errors; warnings pre-exist).
2. **Manual dev check in the running app**: `$env:CANVAS_DEV_TITLE='PR recap-enrichment'; pnpm dev`
   — confirm the window title reads the stamp, flip a real terminal board to its recap, see the
   new rows with real data. Screenshot it.
3. Pre-push e2e gate runs on push (this diff touches `src/main` → LINUX_SENSITIVE → full matrix;
   Docker Desktop must be running).
4. Open the PR (`gh` — account `ch923dev`; if 403, `gh auth switch --user ch923dev`). When the
   bot review posts inline comments, you MUST reply inline on EACH with its disposition
   (CLAUDE.md › Responding to the Claude PR reviewer). Do not merge — merging is the
   integration session's job (sequential gate).
5. Update your row in `.claude/coordination/ACTIVE-WORK.md` when the PR is open.

## Environment gotchas (all verified on this machine, 2026-07-03)

- **Node:** session shells may default to node 25 → 5 false unit failures. Use
  `nvm use 22.17.0` + corepack pnpm. Verify `node -v` = 22.17 before testing.
- **Unit tests:** redirect TEMP to a fresh LONG-FORM subdir and unset ambient recap env or
  `export:save` false-fails machine-wide (top-level %TEMP% renames EBUSY; 8.3 short-name TEMP
  breaks pathSafe):
  `export TEMP='C:\Users\De Asis PC\AppData\Local\Temp\cc-recap-c' TMP=$TEMP; unset CANVAS_RECAP_BOARD`.
- **e2e recap specs:** the renderer must be bound to the temp project
  (`window.__canvasE2E.openProjectFromDisk`) + explicit `window.api.project.save(...)` or main
  reads an empty doc. BOTH consents (recap + orchestration) must be set BEFORE
  `openProjectFromDisk` — two modal scrims otherwise swallow clicks. Mock LLM via the
  `setLlmMock` e2e seam (runtime toggle). Build with `CANVAS_E2E=1` (plain `pnpm build` strips
  the seams; `pnpm test:e2e` does this for you — never `pnpm exec playwright test` alone).
- **Edit tool mangles non-ASCII** (em-dashes, `…`, curly quotes — this codebase is full of them).
  For edits near them use a small Node script or replace_all with exact ASCII anchors; always
  re-run typecheck after.
- **Known e2e flakes** (rerun in isolation before suspecting your diff): osrCropSupersample,
  browserReconnect, browser-trio capturePage, dataFlow (Linux leg). A 0xC0000142 worker death =
  machine load, not code.
- Push with `env -u SSH_ASKPASS` (Git Bash gitDiff spec/push gotcha).

## Out of scope (do NOT touch)

- `canResume` gating / Resume validation (separate lane: `fix/terminal-resume-validation`).
- summaryLoop/refresh plumbing (shipped in #290).
- Any schema/`PATCHABLE_KEYS` change — facts are computed, never persisted to canvas.json.
- Whiteboard/preview/MCP areas — other sessions own them (check the coordination board).
