# Handoff — build bug #15 (terminal session park/adopt on undo)

> **DONE / HISTORICAL (2026-05-30).** This work landed — terminal park/adopt-on-undo is
> implemented and on the integrated history (see `docs/handoffs/status-archive.md`). The
> branch instructions below are stale (the named branches are merged). Kept for design
> rationale only; do not run the git workflow.

> For a fresh session. Self-contained. **Design + plan are done and committed; NO
> implementation code is written yet.** Your job: execute the plan task-by-task.

## TL;DR

Undo of a deleted **Terminal board** currently spawns a *fresh* shell — a mid-task
agent is lost. #15 makes undo reattach the **same live `node-pty` process** (verified by
pid) and replay its scrollback. Approach: **park-on-delete / adopt-on-undo** in MAIN +
a capped output ring buffer. Everything is specified down to exact code in the plan.

## Where everything is

- **Branch:** `fix/terminal-undo-session-15` (off `fix/confirmed-bugs`). HEAD `64a856b`.
  You are in the MAIN working tree at `Z:\Canvas ADE` — `node_modules` is present, no
  worktree/junction needed. Just `git switch fix/terminal-undo-session-15` if not on it.
- **Plan (source of truth — has exact code + commands per task):**
  `docs/superpowers/plans/2026-05-30-terminal-undo-session-15.md`
- **Spec (the why + decisions):**
  `docs/superpowers/specs/2026-05-30-terminal-undo-session-15-design.md`
- **Working tree:** three files are intentionally uncommitted by the user —
  `.claude/settings.local.json`, `.gitignore`, `CLAUDE.md`. **Do NOT commit or revert
  them.** Only `git add` the specific files each task names.

## How to execute

Read the plan, then run it task-by-task with **superpowers:executing-plans** (inline,
recommended — the 10 tasks are tightly sequential and Tasks 1–5 all edit `pty.ts`, so
keeping context warm beats handoffs) or **superpowers:subagent-driven-development** (fresh
subagent per task) if you want a per-task review gate. Tasks 1 is real TDD (`appendRing`);
the park/adopt wiring is proven by the **Task 9 e2e** (delete→undo → same pid + replayed
marker), which is the integration test for Tasks 2–8.

## Locked decisions (do not relitigate)

- Park/adopt in MAIN; **256 KB drop-oldest ring buffer** replayed on adopt. **No new
  dependency** (`@xterm/addon-serialize` was rejected — MAIN already sees every output byte).
- `PARK_TTL_MS = 120_000` (2 min), `RING_CAP_BYTES = 256 * 1024`.
- **Redo of a delete kills** the session (no re-park) — needs no code: redo removes via the
  store, not the `onNodesChange` remove intent, so it never parks.
- **Delete chokepoint = `Canvas.onNodesChange` `remove` intent** (covers Backspace/Delete),
  NOT the React unmount.

## The one design insight you must not lose

`TerminalBoard`'s effect cleanup fires on **two** events: a true unmount (delete) AND an
effect re-run when spawn deps change (**config-respawn** — shell/launchCommand edited). The
config-respawn case **must still kill**. So we cannot "park whenever the box unmounts." The
fix: park is requested at the **delete site** (Canvas), which **moves** the session out of
the `sessions` map into `parked`. The unmount then calls `killTerminal` → `cleanup` finds
nothing in `sessions` → **no-op**. Config-respawn never calls park, so it kills normally.

Mechanics: the single `proc.onData` listener (registered once at spawn) looks up
`sessions.get(id)` at fire time, so output automatically follows onto the NEW port after an
adopt; the ring buffer is **boxed** (`{ data: string }`) so the same reference travels into
`parked` and back, and keeps recording while parked. (Full detail in the plan.)

## Verify after each task / at the end

```bash
pnpm test                 # vitest (Task 1 adds 5 appendRing tests)
pnpm test src/main/pty.test.ts   # just the pty unit tests
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm build && CANVAS_SMOKE=e2e pnpm start   # the e2e harness
```

Expected e2e end line: `E2E_DONE {"ok":true,...}`, including a NEW part
`E2E_TERMINAL-ADOPT {"name":"terminal-adopt","ok":true,"detail":"same pid <N> + scrollback replayed after undo"}`.

**Known host caveat (NOT your bug):** after ~15 Electron launches in one session this
Windows host's GPU degrades and `capturePage` returns blank → the e2e `browser` part shows
`attached=true empty=true`. It's environmental (reproduces on a clean baseline), not a
regression — re-run in a fresh session, and trust the deterministic gates. Task 9's
assertion uses **pid identity** (not capturePage), so it is unaffected.

## Constraints (CLAUDE.md)

- TypeScript strict, no unused locals/params. Match existing file style.
- `node-pty` stays pinned `1.2.0-beta.13` (winpty-free; spaced repo path). Don't touch.
- NEVER weaken security: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`;
  Browser-board content must never reach the PTY write channel. The new IPC (`pty:park` /
  `pty:adopt`) only takes a board id.
- Each phase ends runnable + committed; the plan commits per task.

## When done

All 6 gates green + `terminal-adopt` e2e part ok → #15 is complete. It's the **last open
bug** of the 50 from the 2026-05-30 hunt (49 already fixed on `fix/confirmed-bugs`). Then
merge `fix/terminal-undo-session-15` back into `fix/confirmed-bugs` (fast-forward) and report.
