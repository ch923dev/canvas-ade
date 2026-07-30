<#
.SYNOPSIS
  Announce a main advance to every parallel session. Run this as the FINAL step right
  after a PR merges / you push to origin/main. It updates the shared coordination
  signal so every OTHER session's stale-base self-check fires with the PR# + subject,
  and the push-to-main gate hard-blocks an un-rebased merge.

  It writes (via the node coordination hook, so the logic lives in one place):
    .claude/coordination/integration-tip.json   (atomic single source of truth)
    .claude/coordination/merge-signal.jsonl      (append-only audit of every advance)
    the **Auto-tip** line on ACTIVE-WORK.md       (human quick-reference, machine-synced)

  This REPLACES the old manual "bump the Integration tip SHA" step. Still update the
  human narrative paragraph + your row by hand for the rich context.

  With -E2E it also launches the detached async e2e matrix runner on the merged
  sha (scripts/e2e-async-runner.mjs — full Windows + Linux matrix in the
  background; result in .claude/coordination/e2e-async/last-result.json + an OS
  toast). The matrix is MANUAL-ONLY (user decision 2026-07-31): nothing launches
  it unless you pass -E2E here or run `make e2e-async` yourself.

.PARAMETER Sha       Full or short SHA now on origin/main. Defaults to current origin/main.
.PARAMETER Pr        PR number (digits, with or without '#').
.PARAMETER Subject   One-line subject. Defaults to the tip commit's subject.
.PARAMETER Lockfile  Set if the merged PR changed pnpm-lock.yaml (adds the
                     `pnpm install && pnpm rebuild` reminder to the rebase banner).
.PARAMETER Date      yyyy-MM-dd. Defaults to today.
.PARAMETER E2E       Opt-in: launch the detached async e2e matrix runner on Sha.

.EXAMPLE
  pwsh .claude/tools/signal-merge.ps1 -Pr 140 -Subject "terminal fill gutter"
.EXAMPLE
  pwsh .claude/tools/signal-merge.ps1 -Pr 141 -Subject "schema v10 migrate" -Lockfile
#>
param(
  [string]$Sha,
  [string]$Pr,
  [string]$Subject,
  [switch]$Lockfile,
  [string]$Date,
  [switch]$E2E
)
$ErrorActionPreference = 'Stop'

# Resolve MAIN repo root from git so this works from main OR any worktree and survives
# a folder/brand rename (no hardcoded path) — same pattern as new-worktree.ps1.
$gitCommon = (git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir).Trim()
$Main = (Split-Path $gitCommon -Parent)
$hook = Join-Path $Main '.claude\coordination\coordination-hook.cjs'

if (-not $Sha) {
  git -C $Main fetch --quiet origin main 2>$null
  $Sha = (git -C $Main rev-parse origin/main).Trim()
}
if (-not $Subject) { $Subject = (git -C $Main log -1 --format='%s' $Sha).Trim() }
if (-not $Date)    { $Date = (Get-Date -Format 'yyyy-MM-dd') }

$nodeArgs = @($hook, 'post-merge', '--sha', $Sha, '--subject', $Subject, '--date', $Date)
if ($Pr)       { $nodeArgs += @('--pr', $Pr) }
if ($Lockfile) { $nodeArgs += @('--lockfile', '1') }

# Run from MAIN so the hook's `updatedBy` reads the integration session, not a worktree.
Push-Location $Main
try { node @nodeArgs } finally { Pop-Location }

# OPT-IN (manual-only policy): launch the async full-matrix e2e run on the merged
# sha (detached; node not pwsh — the e2e specs taskkill pwsh shells mid-run).
# Fire-and-forget: a launch failure warns but never fails the merge signal.
# Runner self-serializes via its lock.
if ($E2E) {
  $runner = Join-Path $Main 'scripts\e2e-async-runner.mjs'
  try {
    Start-Process node -ArgumentList @($runner, '--sha', $Sha) -WindowStyle Hidden -WorkingDirectory $Main
    Write-Host "[signal-merge] async e2e matrix launched for $($Sha.Substring(0, [Math]::Min(7, $Sha.Length))) — result: .claude/coordination/e2e-async/last-result.json (+ OS toast)."
  } catch {
    Write-Warning "[signal-merge] could not launch the async e2e runner: $_  — run 'make e2e-async' yourself."
  }
}
