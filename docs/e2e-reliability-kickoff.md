# Kickoff — e2e reliability follow-ups (`fix/e2e-reliability`)

Two defects PR #396 (`dd78cf0d`, v0.37.2) found, root-caused, and deliberately left. Both are real,
both are reproducible, and **both were verified on the Linux Docker leg** — which is the only leg that
can falsify either one.

Base: `main` @ `312b1402`. Branch: `fix/e2e-reliability`.

---

## Item 1 — the `dataFlow` seed race (a fix that has already failed once)

**The flake.** `e2e/dataFlow.e2e.ts` intermittently renders an empty Data-Flow graph. Two writers race
on `useOsrNetworkStore`: the harness seeds via `kind:'replay'`, then the bound Browser board's real
MAIN subscription delivers *its own* `replay`, which **replaces the board's records wholesale** and
wipes the seed. Near-deterministic on the slow Docker leg, rare on Windows.

Waiting it out is impossible — nothing distinguishes "the real replay already landed" from "it is
still coming". That is why the specs carry **re-seed-on-empty poll guards** (45s render / 30s export,
`intervals:[3000]`) instead of plain polls. Those guards are **load-bearing**. Do not remove them
until a replacement is proven on Linux.

**What was already tried and reverted (read this before writing code).** PR #396 added
`BoardNet.frozen`: `apply()` ignores replays on a frozen board, deltas and `cleared` still apply, and
`freezeNet()` is called synchronously right after the seeding `apply()` in `seedDataFlowDemo`.

That approach:
- passed the **entire Windows leg, 339/339, zero flakes**
- shipped **3 green unit tests** covering all three branches
- cleared a **FULL `claude-review` with 0 findings** (the reviewer traced the freeze ordering by hand)
- and **failed the Linux Docker leg 3/3 attempts**, with `0` service nodes after 45s — the graph never
  rendered at all.

**Root cause:** `clearBoard()` deletes the entire `byBoard[id]` entry, **including `frozen`**
(`src/renderer/src/store/osrNetworkStore.ts:209`). `useOsrNetwork` clears on unmount (FIND-011), so
any remount drops the freeze and the next real replay wipes the seed permanently. Windows timing hid
it. The re-seed guards survive `clearBoard` precisely because they **re-run the seeder** rather than
relying on retained state.

A second hypothesis — "Docker is merely slow, restore the 45s/30s budgets while keeping `frozen`" —
**also failed**, which is what ruled out latency and isolated `clearBoard`.

**Direction (not a mandate).** Hold the freeze **outside** `byBoard` — e.g. a module-level
`Set<boardId>` the store consults in `apply()` — so `clearBoard` cannot drop it. Or make `clearBoard`
preserve the flag. Either way it stays E2E-only, set exclusively by the `__canvasE2E` seed hooks, and
must not change production behaviour.

**Acceptance:** the guards can only come out once the Linux leg is green **without** them, twice.

---

## Item 2 — `dataFlow` → `terminalClip` adjacency (pre-existing on `main`)

`e2e/terminalClip.e2e.ts` fails its height sweep with **genuine clipping** (measured up to 12px
against a ~6px threshold) when `dataFlow.e2e.ts` runs immediately before it.

**Confirmed pre-existing**, not introduced by #396: reproduced by reverting all changed files to
`main`'s versions and re-running the pairing. The full suite hides it because alphabetical ordering
never puts those two adjacent.

Reproduce:
```
pnpm test:e2e -- dataFlow terminalClip --retries=0
```

This is the classic cross-spec leak: something `dataFlow` leaves behind (a board, a size, a zoom, a
font/DPR state) survives into `terminalClip`. Per the isolation playbook, the fix is to wire the
leaking surface into `reset()` — store → direct · CanvasInner → E2EHostHooks · AppChrome →
chromeOverlayGate. **Read the failure text; do not assume timing.**

---

## Hard-won constraints (violating these is how #396 burned two cycles)

- **A green Windows leg is NOT evidence for either bug.** Both live on the Linux Docker leg. Green
  Windows + green unit tests + a clean review is exactly the signal set that passed a broken fix.
- **Poll budgets are FREE when green.** `expect.poll` returns the instant the predicate holds, so a
  long timeout costs wall-clock only on genuine failure. Never shrink one for "speed" — there is no
  speed to win, and shrinking them produced a false lead that cost an 8-minute cycle.
- **Each Linux verification cycle is ~8 minutes.** Budget 3+ before starting. Do not iterate blind.
- `terminalClip` sweep steps (13, 23) **must stay ODD** — an even step walks a fixed parity of
  remainders against `cellHeight` and silently drops the fractional-remainder coverage.
- `unset CANVAS_RECAP_BOARD` before any `make check` / unit run — it leaks from an Expanse-hosted
  session into `pty.recapenv.test.ts` and aborts the gate before e2e ever runs.
- `src/main/pathSafe.test.ts` fails 2/28 on this machine (8.3-shortname TEMP + symlink privileges).
  **Reproduces on `main`** — not your diff.

## Ritual

Plan-viz first (planning board is already drawn) → implement → pre-commit gate → **manual dev check,
title-stamped, BEFORE push** → push (scoped gate) → PR → inline dispositions on every
`[critical]`/`[warning]` → full matrix at the merge gate → **explicit user merge auth** → build-history
· `signal-merge.ps1` · teardown.

Version bump required in the same PR (patch — this is a fix).
