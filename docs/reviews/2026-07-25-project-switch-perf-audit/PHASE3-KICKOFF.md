# KICKOFF — Audit Phase 3: Main-process & IO (R7 · R8 · R11 · R14)

Handoff for a fresh session in its own worktree. Phase 2 shipped 2026-07-28 as PR #397
(`89c4d67b` on `main`, **v0.39.0**). You are Phase 3 of the same audit.

> **Name collision warning:** there is an unrelated `PHASE3-KICKOFF.md` at the repo root about
> **cloud TTS voice**. That is a different lane. Do not read it, edit it, or overwrite it.

## Setup

```
pwsh .claude/tools/new-worktree.ps1 -Name mainio-phase3     # creates .worktrees/mainio-phase3 + node_modules junction + .mcp.json
```
Branch `perf/main-io-phase3` off latest `main`. One session per worktree; never two in the same dir.
Check `git log --oneline -1 origin/main` first — `main` moves under you (it moved twice during
Phase 2). Confirm the MCP banner says `✅ LIVE`; if it says config missing/stale, re-copy MAIN's
`.mcp.json` and `/mcp` reconnect.

## Read first

- `CLAUDE.md` — durable contract. Non-negotiable. Note the **process model / security** section: R7
  touches the PTY host, so `contextIsolation`/`sandbox`/node-pty-in-MAIN-only are hard constraints.
- `docs/reviews/2026-07-25-project-switch-perf-audit/AUDIT.md` — §4 findings P-3/P-4, §3.2 SM-1,
  §3.3 DL-1/DL-2, §6 rows R7/R8/R11/R14, §7 Phase 3, §9 Remaining items 4 + 7.
- `docs/reviews/2026-07-25-bench/BASELINE.md` — the committed baseline. **Read its
  STALE-AGAINST-HEAD banner**: the 0/8/24 `paint` sweep predates Phase 2's R5 and was never re-taken.
- `docs/archive/build-history.md` › PR #397 — the Phase 2 entry. Its "gate-invocation lesson" section
  will save you an hour; read it before you run any gate.

## Scope — four items, 4.5 d

### R7 · PTY flow control on hop 1 (P-3, HIGH, 3 d) — the big one
`daemonMain.ts:184-188` does one `JSON.stringify(msg) + '\n'` socket write **per PTY chunk**
(`protocol.ts:91`); main `JSON.parse`s per line (`:105-118`). JSON-escaping is worst-case expensive
exactly for dense agent TUI output. Hops 2–4 are already good — main→renderer micro-batching
(`ptyDataBatch.ts:33-62`) and renderer rAF coalescing (`terminalWriteCoalescer.ts:73-151`). Hop 1 is
the gap.

Port VS Code's watermark protocol (`src/vs/platform/terminal/common/terminal.ts`,
`FlowControlConstants`): **`HighWatermarkChars = 100000`** unacked → `ptyProcess.pause()`;
**`LowWatermarkChars = 5000`** → `resume()`; **`CharCountAckSize = 5000`** per ack. The ack size
**must be ≤ the low watermark** or the pty never unpauses — that is the one way to get this subtly
and permanently wrong. Also coalesce same-tick daemon writes before `encodeLine`.

**The load-bearing mechanism is the ack/pause protocol, not the byte encoding.** Do not get drawn
into replacing JSON; the audit is explicit that flow control matters more.

### R8 · Gate `startLocalServer` off in production (P-4, MEDIUM, 0.5 d) — decided, not open
`await startLocalServer()` blocks `whenReady` at `index.ts:492`, with 17 `register*Handlers(` calls
before `createWindow()` at `:1081`. It serves **only hardcoded fixture HTML**. It is **not** the MCP
transport (MCP has its own lazy loopback via `createMcpBoot`/`ensureMcp()`, `index.ts:543-554`). Its
URL lands in one local, `defaultPreviewUrl`, with exactly two consumers — `installE2EMain` (gated
`__ENABLE_E2E_MAIN__ ∧ CANVAS_E2E`) and `runSelfTest` (gated `CANVAS_SMOKE`). In a distributed build
**the bound port is read by nothing**, yet every user pays an AV/firewall-inspected loopback bind on
the boot path.

Start it only under `CANVAS_E2E` / `CANVAS_SMOKE` / dev — **eagerly in those modes**, so the 26
`@preview` specs and the smoke self-test are unchanged. **Keep the BUG-026/027 error handling**
(`:494-500`) — it is careful and correct; it is merely guarding a server production does not need.
Separately audit the 17 handler registrations for anything deferrable past `ready-to-show`.

⚠️ **Audit §9 item 4 is an open question you must answer before shipping this:** confirm the gate
covers every dev workflow expecting the fixture pages (`/static`, `/download`, `/json`) — `pnpm dev`
must keep serving them.

### R11 · Asset GC off the open path (DL-1/DL-2, RE-SCOPED, ~1 d) — read the re-scope first
**Do not implement the original 1 d item.** Phase 0 measured MAIN's whole `project:open` handler flat
at ~12 ms from 0→24 boards, which retired it; the 2026-07-27 asset-bearing re-measurement then
**revived its premise**: `mainOpen` goes **9.8–13.0 ms → 65.4 ms at 44 assets**, reproduced at 74.1 ms
in the `full` config.

But the seeded assets are **deliberately unreferenced**, so `gcAssets` takes its worst path — a
quarantine copy-then-unlink of every file (3.5 MB of I/O per open). A real project whose doc
references its assets pays only `readdirSync` + a set lookup per file. **The task is therefore
"quantify the referenced-asset path first, then decide", not "resurrect the original estimate"**
(AUDIT §9 item 7). Measure before you optimize — that discipline has now killed R3 outright and
re-scoped R11 twice.

Sub-items if measurement justifies them: defer `readBak` + `gcAssets` (`projectIpc.ts:289-292`) to
idle; batch `rehydrateMissingSummaries` (`projectIpc.ts:134-151`) into one `readdir` instead of N
`existsSync`. Current cost formula: **14 + 2×boardCount** sync fs calls per `project:open`.

### R14 · Enforce the dir invariant once (SM-1, HIGH, 1 d)
Renderer `useCanvasStore.project.dir` and MAIN's module-level `currentDir` (`projectStore.ts:85-90`)
are two independent "current project" values, reconciled by **ad-hoc `expectedDir` pins bolted onto
three handlers** (`projectIpc.ts:371-374`, `:420`, `terminal:writeSnapshot`) — the BUG-009 fix. It
works, but every *new* project-scoped write handler must remember to re-derive the guard. Add a
`withProjectDir(handler)` wrapper in `ipcGuard.ts` and replace all three hand-rolled checks.

This is the "prevents the next BUG-009" item. BUG-009 is the class where MAIN's `currentDir` and the
renderer's project disagree and an autosave cross-writes one project's canvas into another's file.

## Gate (AUDIT §7, verbatim)

> boot-to-first-paint measured before/after (R8 should be visible here); a synthetic runaway-output
> PTY test shows pause/resume engaging at the watermarks; sync-fs count per `project:open` drops from
> 14+2N; full e2e matrix green — R8 touches the fixture server 26 `@preview` specs depend on, so the
> Linux leg is mandatory.

**The Linux leg is not optional here.** Phase 2's build-history records the precedent: a `dataFlow`
fix passed Windows 339/339 with zero flakes and a clean review, then **failed the Linux leg 3/3** on a
real store bug. Windows-green is not evidence for this class.

**On the boot measurement:** R1's marks exist (Phase 0). `bench:baseline` **refuses to write a
baseline above 25% CPU at rest** — Phase 2 measured 55.2% and could not take its numbers, which is
why Phase 2's own bench half was never taken. Quiet the box *before* you plan on a measurement.

## Rituals — all MUST, none optional

1. **Plan-viz first.** Draw the plan on the canvas (Planning board + checklist) via the `canvas-ade`
   MCP **before** implementing, and keep it live with `update_planning_element` — read
   `canvas://board/{id}/planning` for element+item ids, then **update in place**. Never
   `add_planning_elements` to re-draw something that exists; that litters the board with stale
   duplicates. Populate **after** spawn (the `spawn_board` seed silently misses: "board not found").
2. **Design artifact before code** — applies to R8 only if it surfaces any UI. R7/R11/R14 are
   non-visual; say so explicitly rather than skipping silently.
3. **Version bump in the same PR.** Check `main`'s version at rebase time, not at branch time — PR
   #394 took 0.38.0 out from under Phase 2 mid-gate and forced a renumber to 0.39.0.
4. **Manual dev check BEFORE `git push`**, title-stamped: `$env:CANVAS_DEV_TITLE='PR#NNN <feature>'; pnpm dev`.
   Confirm the taskbar title reads your stamp — that is your proof you are testing this PR's build.
5. **Push cheap / merge full.** A plain push runs the Windows leg on a scoped spec set. The FULL
   matrix is mandatory once per PR at the pre-merge gate.
6. **Reply inline on every reviewer `[critical]`/`[warning]`.** Items under "Nits (non-blocking)"
   need no reply.
7. **DO NOT MERGE without explicit per-merge authorization from the user.** Ask per PR.

## Traps Phase 2 hit — do not re-pay these

- **Run the merge gate as `E2E_PRECOMMIT=1 pnpm test:e2e:matrix`.** Bare, it is `retries:0`, and the
  probabilistic flakes documented in `playwright.config.ts:20` (`boardKeyboard:58`, `terminal:62`,
  `terminalCrisp:155/:200`) become hard failures. Phase 2 burned a full bisect back to `main` proving
  `terminal.e2e.ts:62` was pre-existing.
- **Unit ambient floor on this box is 5 failures** — `src/main/pathSafe.test.ts` ×2,
  `src/main/pty.recapenv.test.ts` ×3. Both reproduce on `main`. Don't chase them; do confirm the
  count and file list match before calling a run clean.
- **The Linux Docker leg can die at the container level** (`error waiting for container: unexpected
  EOF` mid-run). That is infrastructure, not a test result — re-run it.
- **`bench-baseline.mjs` spawns with `shell: true`**, so on Windows cmd.exe eats `|` in a `--grep`.
  Use single-token regexes with `.` for spaces: `per.project` (the 0/8/24 sweep), `streaming`
  (terminal fps), `resource.bearing` (the resource-bearing switch). `latency` collides — it pulls in
  the slow resources bench.
- **Squash-merge hides the branch from `git branch --merged`** and leaves `origin/main..HEAD`
  non-empty. Verify with `git diff <tip> origin/main` (empty = captured), not with `--merged`.
- **CI not firing on a push ⇒ suspect a conflict first.** `gh api repos/<owner>/<repo>/pulls/<n>
  --jq '{mergeable,mergeable_state}'`; `dirty` means GitHub runs no checks at all.
- **Rewriting `package.json` with a script breaks Prettier.** Run `pnpm exec prettier --write
  package.json` after, or `format:check` blocks the commit.
- **A test that passes on the broken code is worthless.** Mutation-verify every gate assertion —
  Phase 2's first root-render test passed with the regression reintroduced, because the `memo`
  wrappers masked it. Reach for an instrument that can see past your own fix.

## Definition of done

R7/R8/R11/R14 implemented or explicitly re-scoped **with the reason recorded** (R3 was dropped and
R11 re-scoped this way — a negative result is a first-class deliverable); gate met or the unmet half
written down in both `AUDIT.md` §9 and `BASELINE.md`; version bumped; `build-history.md` entry;
plan board ticked and `write_result`; dev check passed; full matrix green; reviewer dispositioned.

**Still owed from Phase 2, if you get a quiet box:** the `paint` before/after re-capture
(`per.project`), logged as AUDIT §9 item 6. Phase 2 proved R5/R6 as counts (14→0 renders per drag
frame, 61→1 layout reads, both mutation-verified) but never as milliseconds.

## After Phase 3

**Phase 4 — Bundle & hygiene (2.5 d): R12, R13, R15.** Gate: entry chunk gzip below a budget asserted
in `pr.yml`; idle CPU measured with zero boards open.
