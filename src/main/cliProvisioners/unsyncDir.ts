/**
 * G12 (design: docs/research/2026-11-02-project-workspaces §4.3): remove every agent-config file
 * Expanse itself wrote into ONE folder — Claude's `.mcp.json` + our keys/rules in
 * `.claude/settings.local.json`, OpenCode's `opencode.json`, and any recap hook entry. Expanse wrote
 * them, so Expanse removes them; whatever the user put in those files stays.
 *
 * The worktree allocator runs this right before `git worktree remove`, once its own-files status
 * reads clean, so a worker/workspace tree that wrote nothing is removed instead of being kept as
 * "dirty" over our config. It is NOT run on a live status read: stripping a running agent's deny
 * rules to make a number look tidy would weaken its confinement.
 *
 * Synchronous, best-effort per file, never throws. Home-scoped CLIs (codex/gemini) ignore the dir,
 * so they are not touched here.
 */
import { removeAnyRecapHook } from '../agentRecapMap'
import { claudeProvisioner } from './claude'
import { opencodeProvisioner } from './opencode'

export function unsyncProvisionedDir(dir: string): void {
  for (const strip of [
    (): void => removeAnyRecapHook(dir),
    (): void => claudeProvisioner.removeSync(dir),
    (): void => opencodeProvisioner.removeSync(dir)
  ]) {
    try {
      strip()
    } catch {
      /* a corrupt/locked file stays; the tree then reads dirty and is kept — the safe outcome */
    }
  }
}
