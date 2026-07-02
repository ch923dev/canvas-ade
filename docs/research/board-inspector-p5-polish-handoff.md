# Board Inspector — P5 (polish) handoff

> **Fresh-session kickoff for the FINAL phase of the Board Inspector epic.** Read this, then
> **delete it in your first feature commit** (bootstrap residue — the build-history line is the
> durable record). Memory: [[board-inspector-redesign]]. Full contract: `CLAUDE.md`.

---

## Where we are

The Board Inspector = a compact **left-docked popover** that **reveals on select** and morphs by
the selected board type / element. It's portaled **outside** the React Flow transform (never
clips/camera-shrinks). Integration branch = **`feat/board-inspector-umbrella`**; each phase branches
OFF it and PRs INTO it; **umbrella → `main` happens ONCE at the very end** (see §"Epic-end").

**Done and merged into the umbrella (tip `abeb4fb7`):**

| Phase | What | Squash |
|---|---|---|
| P0 | Shell (screen-space popover, reveal-on-select, `inspectorSlotStore`) | `6224e087` |
| P0.5 | Per-type architecture + TerminalInspector + v2 popover redesign | `5016ccdb` |
| P1 | BrowserInspector | `abb5d2f5` |
| P2 | Command + Data-Flow + File inspectors | `1d27aea2` |
| P3 | Planning tools (8-tool palette moved off-board into the Inspector) | `8745a012` |
| P4 | Planning **element** bridge (typography/tint/lock/group/align/… re-homed into an Element section) | `117c245f` |
| P4b | Element **Appearance** sub-block: opacity (all kinds) · stroke colour+width (line kinds) · z-order (4 btns) | `abeb4fb7` |

Every phase: full e2e matrix both legs green, CI + reviewer clean, live dev-check signed off before merge.

**P5 is the last build phase.** After it, the only remaining step is the epic-end umbrella→main
promotion (§"Epic-end") — which is mechanical, not a feature.

---

## What P5 is

A **polish pass** across all seven inspector variants (Terminal · Browser · Command · Data-Flow ·
File · Planning-board · Planning-element) — visual/interaction/a11y consistency, no new
capability. The scope is **deliberately open** — confirm + prioritise with the maintainer before
building (their working style: research-first, keep designs open, approve phase-by-phase).

### Candidate items (sourced from the epic's own deferred notes — confirm/prune with maintainer)

1. **Persist section collapse state** to `localStorage`. Explicitly deferred: `canvas/inspector/primitives.tsx:20`
   — *"collapse state is local for now (localStorage-persisted in a later polish phase)."* Today each
   section's open/closed resets on remount. Give it a per-section persisted key (namespaced, e.g.
   `ca.inspector.collapse.<sectionId>`), matching how other panels persist UI prefs.
2. **Cross-type visual/spacing consistency sweep.** Seven inspectors grew phase-by-phase; do a
   side-by-side pass for uniform section headers, row rhythm, chip/meta styling, disabled states,
   divider treatment. Match `design-reference/` tokens (calm/dense Linear-Raycast; one accent
   `#4f8cff`; no glow/gradient).
3. **A11y polish.** Audit `aria-label`/`role`/focus-order/`inert` handling across all controls
   (P0 already back-ported `prefers-reduced-motion` + `inert={!revealed}`; extend the same rigor to
   the per-type controls added in P1–P4b — segmented/toggle/slider/swatches/icon-buttons).
4. **Reveal/dismiss + adaptive-position edge cases.** Verify the `left:12 → left:264` file-tree-lane
   shift, multi-select transitions, and the popover's `max-height`/body-scroll behaviour hold up as
   content density varies (P4b's Appearance sub-block made the Element section the tallest case).
5. **Empty/edge states.** e.g. the File inspector on an empty file board is intentionally empty
   (accepted in P2) — decide whether P5 gives it a placeholder or leaves it.

> This list is a **starting menu**, not a mandate. Bring it to the maintainer, let them cut/add,
> then scope the confirmed set into an implementation plan. **Any item that changes UI/UX needs a
> visible design artifact signed off BEFORE code** (CLAUDE.md › *Design artifact before code*) —
> extend the existing mocks in `docs/research/mocks/board-inspector-*` and screenshot.

---

## Epic-end: umbrella → main (AFTER P5, do ONCE)

This is the closing move for the whole epic — **not** part of P5's feature work. When P5 is merged
and the maintainer signs off the epic:

1. `git fetch origin && git rebase origin/main` (umbrella onto the live integration tip).
2. **⚠️ SCHEMA RE-NUMBER (mandatory).** The umbrella landed `SCHEMA_VERSION = 17` as an *additive*
   bump (floor stays 15). But **main already ships a DIFFERENT v17** (the Kanban breaking bump,
   floor 17). On this rebase you MUST **re-sequence the umbrella's schema to 18** (floor inherits
   main's 17). The hazard is called out in a prominent comment in
   `src/renderer/src/lib/boardSchemaVersion.ts` — also update `src/main/projectStore.ts` (mirror)
   and the migration pipeline / any `.toBe(17)` schema tests accordingly. Verify no doc written by
   the umbrella build is silently unreadable by main's reader floor.
3. **Full e2e matrix both legs** (`pnpm test:e2e:matrix`, Docker up) + full cheap trio + unit.
4. Open ONE umbrella→main PR (or direct integration per the maintainer's call), dev-check, merge,
   then `pwsh .claude/tools/signal-merge.ps1 -Pr <n> -Subject "<subj>"`.

This epic **blocks the Meridian redesign start** ([[meridian-redesign-epic]]) — Meridian is queued
behind it.

---

## Process rules (non-negotiable — same as P0–P4b)

- **Branch off the umbrella**, PR **into** the umbrella (NOT `main`). `feat/board-inspector-p5-polish`
  off `abeb4fb7`. Merge gated on the **maintainer's explicit OK after a title-stamped dev-check**
  (`$env:CANVAS_DEV_TITLE='PR#NNN P5 polish'; pnpm dev`).
- **Node 22 via nvm:** `export PATH="/c/nvm4w/nodejs:$PATH"` then `corepack pnpm …` (bare node
  defaults to 25 → test skew; see [[session-pnpm-via-nvm-node22]]).
- **⚠️ local mcp skew** (see [[worktree-junction-stale-deps]]): the shared `node_modules` junction
  has `@expanse-ade/mcp@0.18.0-rc.5` vs the branch's `^0.17.0` → `typecheck:node` (mcpOrchestrator)
  + `appModelDrift` F25 fail **LOCALLY ONLY**; CI clean-install (0.17.x) is green. Do NOT "fix" it in
  a renderer PR. The skew prints first and **masks real e2e/main typecheck errors** — **grep the FULL
  output filtered `-v mcpOrchestrator`, never `tail`.** Because pre-commit trio fails on the skew,
  commit/push `--no-verify` — but **run the cheap trio manually first, and re-run `format:check`
  immediately before every `--no-verify` push** (a post-format edit once shipped a red CI; see
  [[gate-must-run-format-check]]).
- **e2e:** touching `e2e/` → the pre-push hook runs the **FULL matrix both legs** — Docker Desktop
  MUST be running for the Linux leg ([[linux-e2e-leg-needs-docker-running]]). The `dataFlow`/browser
  Linux-Docker flakes are **retry-recovered** — rerun, don't "fix" ([[e2e-dataflow-linux-docker-flake]],
  [[e2e-scrollback-victim-osr-teardown-flake]]). If a probe passes a board id into a page-context
  eval, it MUST flow as a **DATA arg** to `page.evaluate`/`waitForFunction`, never interpolated into
  the eval'd string (CodeQL `js/bad-code-sanitization`); reference DOM in typed callbacks via
  `(globalThis as any).document` so the node-lib e2e typecheck stays green.
- **Pushes:** `gh auth switch --user ch923dev` first (ch-dev401 lacks push, 403 — see
  [[gh-account-push-access]]); push with `env -u SSH_ASKPASS git push …` ([[e2e-ssh-askpass-gitbash]]).
- **Reviewer:** reply **inline on each** `[critical]`/`[warning]` comment with its disposition
  (CLAUDE.md › *Responding to the Claude PR reviewer*). Nits under the summary need no reply.
- **Max-lines ratchet** is a hard gate — extract clusters rather than grow host files (the P3/P4
  pattern: `PlanningToolbar` / `usePlanningViewElements` / `planning/inspector/` sub-module).

---

## Key files (orientation)

- Shell: `canvas/BoardInspector.tsx`, `canvas/boardInspectorReveal.ts`, `canvas/inspectorSlotStore.ts`
- Primitives: `canvas/inspector/primitives.tsx` (Section/Row/Segmented/Toggle/Slider/Swatches/IconButtons/Stepper/Action/Meta)
- Per-type: `canvas/boards/{terminal,browser,command,dataflow,file}/…Inspector.tsx`
- Planning: `canvas/boards/planning/PlanningInspector.tsx` + `planning/inspector/` (elementModel · usePlanningElementInspector · ElementInspectorSection)
- Appearance tokens (P4b): `canvas/boards/planning/strokeStyle.ts`; export mirror `planning/whiteboardExport.ts`
- Styles: `styles/chrome/boardinspector.css`
- Schema: `lib/boardSchema.ts` · `lib/boardSchemaVersion.ts` (⚠️ the re-number comment) · `main/projectStore.ts` (mirror)
- e2e: `e2e/boardInspector.e2e.ts` (tags `@chrome/@terminal/@preview/@planning`)
- Mocks: `docs/research/mocks/board-inspector-*.{html,png}`
