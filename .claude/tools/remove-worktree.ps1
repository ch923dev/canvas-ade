<#
.SYNOPSIS
  Safely tear down a Canvas ADE worktree. Drops the node_modules junction FIRST (removes the
  reparse point, NOT the target) so the recursive worktree removal can never follow the junction
  and delete the MAIN repo's node_modules. Memory: parallel-agent-worktrees TEARDOWN SAFETY.

.EXAMPLE
  pwsh .claude/tools/remove-worktree.ps1 -Name mcp-resize
#>
param(
  [Parameter(Mandatory)][string]$Name,
  [switch]$KeepBranch
)
$ErrorActionPreference = 'Stop'
$Main = 'Z:\Canvas ADE'
$wt   = "Z:\canvas-ade-$Name"
if (-not (Test-Path $wt)) { throw "No such worktree: $wt" }

# refuse if the worktree has uncommitted changes (locked decision: keep on disk + prompt, never silent --force)
$dirty = git -C $wt status --porcelain
if ($dirty) {
  Write-Warning "Worktree has uncommitted changes:`n$dirty"
  throw "Refusing to remove a dirty worktree. Commit/stash in $wt first, then re-run."
}

# 1. drop the junction FIRST (rmdir on a junction removes the link, not the target)
if (Test-Path "$wt\node_modules") { cmd /c rmdir "$wt\node_modules" }

# 2. now it is safe to remove the worktree
git -C $Main worktree remove $wt

# 3. mark the board row done (manual edit kept simple — flip Status to 'done')
Write-Host "Removed worktree $wt."
Write-Host "Edit $Main\.claude\coordination\ACTIVE-WORK.md -> set its Status to 'done'."
if (-not $KeepBranch) {
  Write-Host "Branch feat/$Name kept. Delete with: git -C `"$Main`" branch -d feat/$Name (after merge)."
}
