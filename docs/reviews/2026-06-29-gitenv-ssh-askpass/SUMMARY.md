# gitEnv `SSH_ASKPASS` git-seam failure — SUMMARY

**Date:** 2026-06-29 · **Status:** ✅ FIXED · **Scope:** `src/main/gitEnv.ts` (+ `gitEnv.test.ts`)
**Surfaced by:** the pre-push e2e gate false-failing when run from a **Git Bash** shell.

## Root cause

`repoScopedEnv()` (the shared MAIN read-only git-env scrubber behind every `simple-git` seam —
`boardGitDiff`, `file:gitPermalink`) strips every `GIT_*` var so git's directory discovery falls back
to the spawn path. That sweep happens to clear the dangerous vars `simple-git`'s
`blockUnsafeOperationsPlugin` refuses to spawn on (`GIT_ASKPASS`, `GIT_SSH`, …) — **but `SSH_ASKPASS`
is an OpenSSH var with no `GIT_` prefix**, so the sweep missed it and the guard still tripped:

```
GitPluginError: Use of "SSH_ASKPASS" is not permitted without enabling allowUnsafeAskPass
```

Any user whose shell exports `SSH_ASKPASS` (e.g. the app launched from Git Bash, which sets
`SSH_ASKPASS=/mingw64/bin/git-askpass.exe`) hit a broken `gitDiff` / `gitPermalink` seam — a real
user-facing robustness bug, not a test-only artifact. It only *looked* like a flake because the dev
box runs the suite from PowerShell, where the var isn't set.

## Fix

In `repoScopedEnv()`, after the `GIT_*` strip, explicitly `delete env.SSH_ASKPASS` and its companion
`delete env.SSH_ASKPASS_REQUIRE`. A read-only LOCAL git read never needs an askpass helper. The
`simple-git` guard is **kept** — we removed the trigger, NOT enabled `allowUnsafeAskPass` (that would
weaken the model). Both simple-git call sites already route through `repoScopedEnv()`
(`gitDiff.ts`, `fileIpc.ts`) — no stray env site.

## Verification

- **Unit** (`gitEnv.test.ts`): new case asserts `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE` are cleared;
  the "preserves non-GIT vars" case stays green (targeted deletion, not a broad strip). 6/6 pass.
- **e2e contrast** (`e2e/gitDiff.e2e.ts`, run from Git Bash **with `SSH_ASKPASS` set**):
  - un-fixed code → `:104 @terminal` test **FAILS** (1 failed / 2 passed) — reproduces the regression.
  - fixed code → all **3 pass** with `SSH_ASKPASS` still set. ← acceptance signal.
- Gate: typecheck · lint (0 errors) · format:check all green.

## Memory

`e2e-ssh-askpass-gitbash` — the `env -u SSH_ASKPASS` workaround for running the gate is now obsolete
for these seams (the centralized scrubber strips it). The note remains relevant for *other* raw
`simple-git`/SSH invocations outside `repoScopedEnv()`, if any are added.
