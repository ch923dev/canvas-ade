export type AgentCli = 'claude' | 'unknown'

/** First meaningful token of a launchCommand -> which agent CLI it runs. */
export function detectAgentCli(launchCommand?: string): AgentCli {
  if (typeof launchCommand !== 'string') return 'unknown'
  // tokens that wrap the real command; look past them for the agent binary
  const wrappers = new Set([
    'npx',
    'pnpm',
    'dlx',
    'sudo',
    'pwsh',
    'powershell',
    'cmd',
    'bash',
    'sh',
    'zsh'
  ])
  const flags = new Set(['-c', '/c', '-lc', '-l', '-i'])
  const toks = launchCommand.trim().split(/\s+/).filter(Boolean)
  for (const t of toks) {
    if (wrappers.has(t) || flags.has(t)) continue
    return /(^|[\\/])claude(\.\w+)?$/i.test(t) ? 'claude' : 'unknown'
  }
  return 'unknown'
}

export interface Milestone {
  ts: number
  role: 'user' | 'agent'
  text: string
}
export interface ExtractOpts {
  maxMilestones?: number
  maxTextChars?: number
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: unknown })?.type === 'text')
      .map((b) => String((b as { text?: unknown }).text ?? ''))
      .join('\n')
  }
  return ''
}

/** Parse a Claude transcript JSONL into meaningful milestones (user + assistant text only). */
export function extractMilestones(jsonl: string, opts: ExtractOpts = {}): Milestone[] {
  const maxN = opts.maxMilestones ?? 12
  const cap = opts.maxTextChars ?? 600
  const out: Milestone[] = []
  for (const raw of jsonl.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    let rec: {
      type?: unknown
      timestamp?: unknown
      message?: { role?: unknown; content?: unknown }
    }
    try {
      rec = JSON.parse(s)
    } catch {
      continue // skip malformed lines
    }
    const role = rec.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textFromContent(rec.message?.content).trim()
    if (!text) continue // assistant tool-only turns have no text -> dropped
    const ts = Date.parse(String(rec.timestamp ?? '')) || 0
    out.push({ ts, role: role === 'user' ? 'user' : 'agent', text: text.slice(0, cap) })
  }
  return out.slice(-maxN)
}
