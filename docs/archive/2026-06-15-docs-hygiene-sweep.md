# Docs-hygiene sweep — compiled residue (2026-06-15)

> Point-in-time compilation of several shipped slice-specs, done research notes, and closed
> review/findings docs that were **deleted in the 2026-06-15 docs-hygiene sweep**. This file is their
> durable residue, alongside the per-PR lines already in `docs/archive/build-history.md`.
> **Not live truth** — the durable contract is `CLAUDE.md`; the current build order + open work is
> `docs/roadmap.md`; the PR-by-PR record with SHAs is `docs/archive/build-history.md`. Raw originals
> live in git history — recover any with `git log --all -- <path>` then `git show <commit>:<path>`.

---

## Terminal recap redesign (#140)

Replaced the #89 recap (sound but text-only) with a two-zone "glance + evidence" face. **Layer 0 —
local facts** (`recapFacts.ts`): pure, zero-egress, no-consent computation from the transcript JSONL
tail — status (`waiting-on-you`/`running`/`idle`/`exited`/`spawn-failed`), title, turns, last ask,
changed files, commands; persisted to a `.canvas/memory/board-<id>.recap.json` sidecar (gitignored,
never egressed, never MCP-read). **Layer 1 — narrative** (extracted to `recapNarrative.ts`):
tool-aware milestones (Edit/Write/Bash `description`, collapsed Read/Grep runs), caps raised
(milestones 12->30, input 4k->12k), second-person prompt with a suggested `next` action,
code-stamped beat durations. Trigger economics flipped: transcript bursts now refresh **facts only**
(free, 2s debounce); narrative refreshes on a Stop hook / quiet-detect / stale-on-flip — net fewer
budgeted LLM calls, fresher when actually viewed. Added a front-face status dot in the terminal title
bar via a `recap:facts` push + ephemeral `recapStore`. No `canvas.json` schema change (sidecar +
ephemeral store only). All redaction/consent/`isTrustedTranscriptPath` invariants unchanged.
**Deferred:** canvas-level attention cues (zoom-out ring on waiting boards), clickable diff-stat
chips, unread/since-last-look anchoring, MCP exposure of the facts sidecar, Notification-hook
"blocked" detection.

## New Terminal agent-preset dialog (#142 Phase A, #149 Phase B)

Gave Terminal boards a first-class **identity + creation flow**. **Phase A (#142, app-only):** a
place-first create flow — drag-to-create (#75) drops an idle board (transient ephemeral
`configPending` suppresses auto-spawn), then `NewTerminalDialog` opens over it. Quick-Start preset
tiles with monochrome brand glyphs (claude/codex/gemini/opencode/shell, added to `Icon.tsx`) +
a searchable per-agent command builder (`agentPresets.ts` option schema -> pure
`composeCommand`/`parseCommand`; the composed `launchCommand` string stays the persisted
source-of-truth, builder re-hydrates via `parseCommand`). Schema bumped **v9->v10** (additive
`agentKind?`/`monitorActivity?`; `minReaderVersion` stays 9 per ADR 0007). The dialog is unified
create+edit (Option A) — the old in-canvas `TerminalConfig` popover + its `configDirty` guard were
removed. **Phase B (#149, MCP observation):** `agentKind` published in the MAIN board mirror +
`canvas://boards`; `monitorActivity:false` boards excluded from `canvas://attention`
(`@expanse-ade/mcp` minor bump for the additive resource field). `agentKind` is metadata, not an exec
vector — `launchCommand` hardening (sanitize -> confirm -> audit) unchanged. **Deferred -> Phase C
(Feature Workspaces):** `spawn_board({type, agentKind})` spawn-by-kind, orchestrator/role presets,
preset->MCP prompt templates, user-editable preset list.

## Terminal font-blur fix + native re-raster (#122 -> superseded by #125)

Two-stage fix for the terminal being the only board whose content is a fixed-resolution bitmap under
the camera transform (xterm's WebGL canvas is sized from `devicePixelRatio` alone; any settled
camera zoom z!=1 bilinear-resamples it -> structural blur; Chromium's at-rest re-raster rescues DOM
text but never a canvas). **#122 (`fix/terminal-font-blur`):** renderer policy = WebGL only at a
crisp/settled z, DOM renderer otherwise (proven crisp at every zoom at rest), plus a [0.95, 1.06]->1
settled-zoom snap band. **#125 (native re-raster, supersedes the renderer-swap valve; keeps the snap
band):** a **FREEZE counter-scale** — `useTerminalReraster` lays the xterm host out at
`boardContent x z` with `transform: scale(1/z)` so the net visual scale is exactly 1 at rest, mapping
the backing store 1:1 to device pixels. A single font seam (`effective = pin x cs`, never routed
through `updateBoard`/undo) is the only post-construction `fontSize` writer; cols/rows are frozen
across zoom (ResizeObserver gates on the z-invariant screen size — zoom never reflows the live TUI);
a bounded rAF no-clip correction absorbs integer-cell quantization slack as a same-background gutter;
the selection shim reads the net element scale to avoid double-correction. Rejected alternatives
(documented): refit-on-settle (reflows the TUI on nearly every zoom), DPR monkey-patch (no public
API, churn-prone), Chromium-zoom/per-terminal WebContentsView (window-global / re-imports the native
occlusion class), CSS `zoom`. **Residual non-goals:** physically-small text below ~65% zoom (product
levers: focus / full view / LOD digest / per-board font; a future opt-in "readable mode" =
refit + font floor), during-gesture softness (by design, Figma-like), the zoom-dependent gutter.

## e2e + lint hygiene (#93)

Cleared two pre-existing main-side loose ends found while landing the text create/edit slice. **(1)**
the `terminalIO:117` "scale-correct selection" e2e flake (`Error: selection was ""` in the full
Windows suite, green in isolation) — root cause was a **leaked recap-consent modal scrim** occluding
the canvas center so the real-OS drag hit a `<code>` element, not `.xterm`; fixed by gating the
modal render on `projectDir !== null` (memory `e2e-terminalio-selection-flake`). **(2)** eslint-10
(post 9->10 bump) lint-flooding generated `playwright-report/**` + `test-results/**` (3935 errors
after any e2e run, since eslint 10 dropped `.eslintignore`) — fixed by adding those dirs to the flat
`eslint.config.mjs` `ignores`. Earned back a clean matrix gate (no `--no-verify`).

## MCP in-depth review (2026-06-05) -> #68, #146, #148

Two-pass adversarial re-read of the MCP layer (app `src/main` + `@expanse-ade/mcp` v0.8.2). Verdict:
**healthy, no open Critical/High/Medium** — every 2026-06-04 backlog fix re-derived from `file:line`
as real (not just claimed), the Host-header DNS-rebind gap confirmed closed, the structural tier model
+ fail-closed dispatch-confirm-audit chain sound. The fresh pass surfaced only **3 LOW + 2 INFO**:
APP-N1 (configureBoard approves-but-ack-fails leaves no audit entry), APP-N2 (`reapIdle`
re-entrancy), APP-N3 (spawnBoard type allowlist is renderer-side only), PKG-N1 (session reuse routed
by header without asserting token `boardId` ownership), PKG-N2 (the `commandBoardId` relay gate
contract-tested but never driven over real HTTP). The three app-side items (APP-N1/N2/N3) shipped in
**#68**; **PKG-N1 later closed by #146**, **PKG-N2 by #148**. (Note: the real release blocker
flagged here was the unrelated Electron 33->42 bump, since shipped as T9.)

## Design / UI-UX audit umbrella (2026-06-10, COMPLETE 2026-06-12)

Full-renderer design/UX audit (6 parallel read agents vs `DESIGN.md` + tokens; **not** a correctness
hunt — that was the same-date `2026-06-10-full-app-audit.md`). Verdict: high quality for a pre-1.0
tool (token discipline ~95%, motion disciplined, preview liveness senior-grade); weaknesses were
**feedback + discoverability**, not the visual language. Worst finding: silent save failure
(console-only). Driven to completion as a sequential **wave umbrella** (file-disjoint parallel lanes,
full gate + e2e matrix after each merge):

- **D0 (#108)** — quick wins: `--text-1` ghost-token fix, contrast pass (`--text-3` lighten,
  `--text-faint` restricted), tokenized connector/notch/scrim colors + new `--scrim`, dock tooltips,
  port-picker Esc, switcher clamp, export/screenshot failure surfaces, `role=status`/`aria-live`,
  project-switch loading state, interim save-failure chip, full-view Esc hint.
- **D1 — primitives:** Toast (#112, single transient channel; absorbed the D0-8 chip into a sticky
  save-failure toast + Retry), shared `<Modal>` (#111, `--scrim` + focus trap/restore, killed 3
  hardcoded scrims), shared `<Menu>` (#113, `menuitem` roles + roving tabindex + unified clamp). Two
  real cross-lane bug classes caught: mid-dispatch listener removal, deferred xterm focus-restore.
- **D2 — chrome + feedback parity:** inline board title edit (#114, double-click + F2, closes the
  DESIGN.md §6 mandate), terminal polish (#116, config unsaved guard / spawning sliver / first-run
  hint / A6 flip-focus), browser resilience (#117, render-process-gone crashed state + Reload,
  snapshot-until-ready, URL sanity, evicted "paused" badge, status word), motion polish (#115,
  LOD crossfade / focus-dim ease / reduced-motion sweep).
- **D3 — whiteboard category gaps:** note tint picker (#120), arrow endpoint editing (#118),
  planning keyboard + a11y (#119, arrow-nudge / in-well Ctrl+G / Shift+F10 menu / checkbox role).
- **D4 — discoverability backbone:** command palette Ctrl+K + `?` shortcuts (#121), keyboard-first
  canvas (#123, closes the last two High a11y findings A3+A4 — Tab-cycle boards, arrow move/resize,
  Esc-from-native-preview focus return), wayfinding minimap (#124, user picked minimap over board
  list).

Proposed contract deltas that landed with sign-off: `--text-3` value change, `--scrim` token,
`--text-1` resolution. Umbrella complete 2026-06-12 (D0 #108 · D1 #111/#112/#113 · D2
#114/#115/#116/#117 · D3 #118/#119/#120 · D4 #121/#123/#124).

---

## Collapsed in this sweep (originals in git history)

| Deleted path | PR(s) |
|---|---|
| `docs/superpowers/specs/2026-06-13-recap-redesign-spec.md` | #140 |
| `docs/superpowers/specs/2026-06-13-new-terminal-presets/spec.md` | #142 (Phase A) · #149 (Phase B); Phase C deferred (Feature Workspaces) |
| `docs/superpowers/specs/2026-06-09-e2e-lint-hygiene-kickoff.md` | #93 |
| `docs/research/2026-06-11-terminal-font-blur.md` | #122 (renderer-swap plan later superseded by #125) |
| `docs/research/2026-06-12-terminal-native-reraster-audit.md` | #125 |
| `docs/reviews/2026-06-05-mcp-indepth-review.md` | #68 (APP-N1/N2/N3) · #146 (PKG-N1) · #148 (PKG-N2) |
| `docs/reviews/2026-06-10-design-ux-audit.md` | umbrella -> #108/#111-#124 |
| `docs/reviews/2026-06-10-design-ux-audit-waves.md` | umbrella -> #108/#111-#124 |
