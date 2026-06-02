<#
.SYNOPSIS
  Create a coordinated Canvas ADE worktree: isolated dir + branch, node_modules junction,
  shared settings, and a row on the coordination board. One command = isolated AND coordinated.

.EXAMPLE
  pwsh .claude/tools/new-worktree.ps1 -Name mcp-resize -Zone "src/main/mcp/resize.ts"
  # -> Z:\canvas-ade-mcp-resize on feat/mcp-resize, ready to open a session in.
#>
param(
  [Parameter(Mandatory)][string]$Name,
  [string]$Branch,
  [string]$Base = 'main',
  [string]$Zone = '(declare zones)'
)
$ErrorActionPreference = 'Stop'
$Main = 'Z:\Canvas ADE'
$wt   = "Z:\canvas-ade-$Name"
if (-not $Branch) { $Branch = "feat/$Name" }
if (Test-Path $wt) { throw "Worktree path already exists: $wt" }

# 1. create the worktree on its own branch
git -C $Main worktree add -b $Branch $wt $Base

# 2. junction main node_modules in (skips the slow per-worktree electron/node-pty native rebuild;
#    OS-transparent so .node natives load; same Z: volume required). Memory: parallel-agent-worktrees.
cmd /c mklink /J "$wt\node_modules" "$Main\node_modules" | Out-Null

# 3. share the project settings (permissions + coordination hooks) into the worktree
Copy-Item "$Main\.claude\settings.json" "$wt\.claude\settings.json" -Force

# 4. register on the coordination board
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$row = "| canvas-ade-$Name | $Branch | $Zone | active | $stamp | |"
Add-Content "$Main\.claude\coordination\ACTIVE-WORK.md" $row

Write-Host "Worktree ready: $wt  (branch $Branch)"
Write-Host "Open a Claude session there. Refine your zones in $Main\.claude\coordination\ACTIVE-WORK.md"
