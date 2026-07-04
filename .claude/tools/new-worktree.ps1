<#
.SYNOPSIS
  Create a coordinated worktree: isolated dir + branch, node_modules junction, shared settings, and a
  row on the coordination board. One command = isolated AND coordinated. Worktrees are nested under
  `<repo>/.worktrees/<name>` (gitignored) so they travel with the repo and survive a folder/brand
  rename - no hardcoded drive path.

.EXAMPLE
  pwsh .claude/tools/new-worktree.ps1 -Name mcp-resize -Zone "src/main/mcp/resize.ts"
  # -> <repo>/.worktrees/mcp-resize on feat/mcp-resize, ready to open a session in.
#>
param(
  [Parameter(Mandatory)][string]$Name,
  [string]$Branch,
  [string]$Base = 'main',
  [string]$Zone = '(declare zones)'
)
$ErrorActionPreference = 'Stop'

# MAIN repo root, resolved from git so it is correct whether this script runs from main OR a worktree,
# and survives a folder/brand rename (no hardcoded path). --git-common-dir always points at MAIN's .git.
$gitCommon = (git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir).Trim()
$Main = (Split-Path $gitCommon -Parent)
$wtRoot = Join-Path $Main '.worktrees'
$wt = Join-Path $wtRoot $Name
if (-not $Branch) { $Branch = "feat/$Name" }
if (Test-Path $wt) { throw "Worktree path already exists: $wt" }
if (-not (Test-Path $wtRoot)) { New-Item -ItemType Directory -Path $wtRoot | Out-Null }

# 1. create the worktree on its own branch, nested in-repo (gitignored via .worktrees/)
git -C $Main worktree add -b $Branch $wt $Base

# 2. junction main node_modules in (skips the slow per-worktree electron/node-pty native rebuild;
#    OS-transparent so .node natives load; same volume required). Memory: parallel-agent-worktrees.
#    Nesting under the spaced repo path is safe: the junction means node-pty is NEVER built here
#    (the winpty/space-in-path build failure only bites a real install, which we skip).
cmd /c mklink /J "$wt\node_modules" "$Main\node_modules" | Out-Null

# 3. share the project settings (permissions + coordination hooks) into the worktree.
#    settings.json is tracked (already in the checkout) - re-copy to guarantee main's exact version.
#    settings.local.json is machine-local + gitignored (bridgespace hooks) - copy it too if present so
#    the worktree session keeps the same local hooks, without ever tracking it.
Copy-Item (Join-Path $Main '.claude\settings.json') (Join-Path $wt '.claude\settings.json') -Force
$localSettings = Join-Path $Main '.claude\settings.local.json'
if (Test-Path $localSettings) {
  Copy-Item $localSettings (Join-Path $wt '.claude\settings.local.json') -Force
}

# 3b. provision the Canvas ADE MCP into the worktree. .mcp.json is gitignored machine-runtime state
#     (the live Expanse app stamps the current 127.0.0.1:<port> + bearer token into it), so a fresh
#     checkout has NONE - without this the worktree session can't reach the canvas (no plan-viz, no
#     board tools). Copy MAIN's current one. NOTE: it goes stale if the app restarts (new port) - the
#     SessionStart coordination hook detects that and prints a re-copy + `/mcp` reconnect nudge.
$mcpJson = Join-Path $Main '.mcp.json'
if (Test-Path $mcpJson) {
  Copy-Item $mcpJson (Join-Path $wt '.mcp.json') -Force
} else {
  Write-Host "NOTE: no .mcp.json in MAIN - start the Expanse app so it stamps one, then re-copy into $wt."
}

# 4. register on the coordination board (worktree identity = its dir name = $Name)
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
$row = "| $Name | $Branch | $Zone | active | $stamp | |"
Add-Content (Join-Path $Main '.claude\coordination\ACTIVE-WORK.md') $row

Write-Host "Worktree ready: $wt  (branch $Branch)"
Write-Host "Open a Claude session there. Refine your zones in $Main\.claude\coordination\ACTIVE-WORK.md"
