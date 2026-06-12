# Kickoff — Canvas Backdrop (wallpaper mode)

> For the implementation session opening in `Z:\Canvas ADE\.worktrees\canvas-backdrop`
> (branch `feat/canvas-backdrop`). Read `spec.md` in this folder first — it is the contract.
> The design artifact is ALREADY SIGNED OFF (mocks in `mocks/`); do NOT redo the design loop.

## Context in 30 seconds

The user wants a per-project wallpaper behind the canvas (their reference: vivid anime river art
with terminals floating over it). Direction, UX, defaults, schema shape, and architecture were all
decided with the user on 2026-06-11 in a spec session; the visible design artifact (interactive
mocks) was reviewed and approved. This feature was deliberately **queued behind design-audit waves
D3/D4** so the backdrop lands on stable chrome. You are the implementation session.

## Preconditions — verify before writing code

1. **D3/D4 merged?** Check `.claude/coordination/ACTIVE-WORK.md` (injected at session start) and
   `docs/reviews/2026-06-10-design-ux-audit-waves.md`. If D3/D4 are NOT merged yet, stop and tell
   the user — they fired this kickoff early on purpose or by mistake; let them decide.
2. **Rebase** this branch onto the current Integration tip (the worktree was cut at `53a90d1`,
   2026-06-11 — it will be stale). Resolve nothing silently; the spec's file-touch list is small.
3. **Schema v9 still ours?** The ACTIVE-WORK row for `canvas-backdrop` claims v9. If anything else
   shipped v9 meanwhile, bump to the next free version and update spec.md §5.
4. **Defaults confirm** (one question to the user, batched): dim 0.25 / saturation 0.70 / 200MB
   video cap — or their final numbers.

## Build order (from spec §8)

PR 1: S1 schema+store → S2 layer+media hook → S3 picker+toasts+caps → S4 e2e → S5 contract docs
(ADR 0003, CLAUDE.md row, roadmap line). Then PR 2: S6 scene port → S7 motion gating + e2e.
Each S-step ends green (cheap trio + relevant unit). TDD where the repo already does (store,
schema, hooks).

## Repo gotchas that WILL bite this feature (from memory/build-history)

- **Edit tool + non-ASCII:** keep new code ASCII; smallest old_string; typecheck after edits.
- **First push of a new branch skips the pre-push e2e matrix** — run `pnpm test:e2e:matrix`
  manually before that push (Docker Desktop up for the Linux leg; beware the global image tag if
  other lanes run).
- **e2e:** use `pnpm test:e2e` (builds first), never bare `playwright test`; real input via
  `sendInputEvent` for pointer probes; leading-reset any persistent state; read `failure.png`
  before calling flake; check OCCLUSION on empty-result real-input failures.
- **Popovers:** use the ref-counted `Set<useId token>` pattern (PREV-C) or the backdrop picker will
  collide with the Tidy picker / board menus.
- **Window listeners:** register once + read via refs (mid-dispatch removal class — D1/D2 lesson);
  jsdom can't catch it, only real-input e2e can.
- **Autosave:** background changes ride the debounced autosave — no new save paths.
- **Reviewer protocol:** reply INLINE on every bot review comment with a disposition; do not push
  fix-only rounds for trailing nits (close them with inline "accepted as low"/"declined: reason").
- **node_modules is a junction to main's** — do NOT `pnpm install` here; if deps look stale, fix in
  the MAIN checkout (`pnpm rebuild` after any install — node-pty spaced-path gotcha).

## Definition of done (per PR)

Gate green (typecheck · lint · format:check · unit) + e2e matrix BOTH legs + the spec's e2e probes
passing + contract docs landed (PR 1) + build-history entry appended & ACTIVE-WORK row updated on
merge. Delete `docs/canvas-backdrop/` in the PR that merges PR 2.
