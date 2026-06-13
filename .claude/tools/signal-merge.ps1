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

.PARAMETER Sha       Full or short SHA now on origin/main. Defaults to current origin/main.
.PARAMETER Pr        PR number (digits, with or without '#').
.PARAMETER Subject   One-line subject. Defaults to the tip commit's subject.
.PARAMETER Lockfile  Set if the merged PR changed pnpm-lock.yaml (adds the
                     `pnpm install && pnpm rebuild` reminder to the rebase banner).
.PARAMETER Date      yyyy-MM-dd. Defaults to today.

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
  [string]$Date
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
