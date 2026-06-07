export type AgentCli = 'claude' | 'unknown'

/** First meaningful token of a launchCommand -> which agent CLI it runs. */
export function detectAgentCli(launchCommand?: string): AgentCli {
  if (typeof launchCommand !== 'string') return 'unknown'
  // tokens that wrap the real command; look past them for the agent binary
  const wrappers = new Set(['npx', 'pnpm', 'dlx', 'sudo', 'pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh'])
  const flags = new Set(['-c', '/c', '-lc', '-l', '-i'])
  const toks = launchCommand.trim().split(/\s+/).filter(Boolean)
  for (const t of toks) {
    if (wrappers.has(t) || flags.has(t)) continue
    return /(^|[\\/])claude(\.\w+)?$/i.test(t) ? 'claude' : 'unknown'
  }
  return 'unknown'
}

/** Claude Code transcript dir slug: every non-alphanumeric char -> '-'. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}
