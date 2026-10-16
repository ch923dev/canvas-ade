/**
 * Agent-terminal classifier (spatial-awareness C9 producer, lane L11). Answers ONE question for the
 * role model (`src/shared/boardRoles.ts`): does this Terminal board run a known agentic CLI? The
 * answer becomes the `agent` boolean on the MCP mirror, which makes the board an `agent` (hero
 * weight 60) instead of a `server` / `shell` (ROLE-LAYOUT §2).
 *
 * Signals, in order:
 *  1. `agentKind` — the New Terminal preset id (`agentPresets.ts`). Any preset except `shell` (the
 *     plain-shell preset, which persists `agentKind: 'shell'`) is an agent.
 *  2. Otherwise the `launchCommand`'s FIRST command token, after skipping a PowerShell call
 *     operator (`&`), leading `KEY=value` env assignments (and an `env` prefix), and an optional
 *     package runner (`npx` · `bunx` · `pnpx` · `pnpm dlx` · `yarn dlx` · `npm exec`) with its
 *     flags. The token matches a known agent PACKAGE (`@anthropic-ai/claude-code@latest`), or its
 *     basename — lowercased, `.exe`/`.cmd`/`.bat`/`.ps1` stripped — matches a known agent BIN.
 *
 * The bin list mirrors the New Terminal presets (`AGENT_PRESETS[].bin`, the single source for
 * claude/codex/gemini/opencode) plus the other mainstream agent CLIs.
 *
 * 🔒 D9 (SPEC §2): ONLY the boolean leaves this module. The launch line can carry env-prefixed
 * secrets (`OPENAI_API_KEY=sk-… codex`), so it is never returned, stored, logged or echoed in a
 * thrown error — every export returns `true`/`false` and nothing else. Pure: no I/O, no DOM.
 */
import { AGENT_PRESETS } from '../canvas/boards/terminal/agentPresets'

/** Agent CLIs beyond the New Terminal presets (each is its CLI's installed bin name). */
const EXTRA_AGENT_BINS = ['aider', 'amp', 'goose', 'qwen', 'cursor-agent'] as const

/** Bins that run an agent: every non-empty preset bin + {@link EXTRA_AGENT_BINS}. */
const AGENT_BINS: ReadonlySet<string> = new Set([
  ...AGENT_PRESETS.map((p) => p.bin.toLowerCase()).filter((bin) => bin.length > 0),
  ...EXTRA_AGENT_BINS
])

/** npm packages whose bin is an agent CLI — matched when a runner launches them by package. */
const AGENT_PACKAGES: ReadonlySet<string> = new Set([
  '@anthropic-ai/claude-code',
  '@openai/codex',
  '@google/gemini-cli',
  'opencode-ai',
  '@sourcegraph/amp',
  '@qwen-code/qwen-code'
])

/** One-word package runners (`npx claude`, `bunx @openai/codex`). */
const RUNNERS: ReadonlySet<string> = new Set(['npx', 'bunx', 'pnpx'])
/** Two-word runners: the tool, then its sub-command (`pnpm dlx`, `yarn dlx`, `npm exec`). */
const RUNNER_SUBCOMMANDS: ReadonlyMap<string, string> = new Map([
  ['pnpm', 'dlx'],
  ['yarn', 'dlx'],
  ['npm', 'exec']
])

/** The preset id of the plain-shell preset — the one `agentKind` that is NOT an agent. */
const SHELL_PRESET = 'shell'

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const EXECUTABLE_EXT = /\.(exe|cmd|bat|ps1)$/

/**
 * Shell-ish words: runs of unquoted non-space characters and quoted spans, so a quoted path with
 * spaces (`"C:\Program Files\nodejs\claude.cmd"`) and a quoted env value (`KEY="a b"`) each stay
 * ONE word. An unterminated quote runs to the end of the line.
 */
const WORD = /(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g

const unquote = (word: string): string => word.replace(/["']/g, '')

/** A command word's comparable name: basename, lowercased, executable extension stripped. */
function binName(word: string): string {
  const base = unquote(word).split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(EXECUTABLE_EXT, '')
}

/** Drop a package version (`claude@latest` → `claude`) — never a scope's leading `@`. */
function withoutVersion(spec: string): string {
  const at = spec.indexOf('@', 1)
  return at > 0 ? spec.slice(0, at) : spec
}

/** Does this command word name a known agent — as a package spec, or by its bin's basename? */
function isAgentCommand(word: string): boolean {
  const lower = unquote(word).toLowerCase()
  if (AGENT_PACKAGES.has(withoutVersion(lower))) return true
  // The basename first, THEN the version: an `@` earlier in a path (`C:\Users\me@corp\…`) is not
  // a version separator.
  return AGENT_BINS.has(withoutVersion(binName(lower)))
}

/**
 * Does this launch line start a known agent CLI? See the module header for the token rules. A
 * blank / absent line is a plain shell (`false`). 🔒 D9: returns only the boolean.
 */
export function isAgentLaunchLine(launchCommand: string | undefined): boolean {
  if (typeof launchCommand !== 'string') return false
  const words = launchCommand.match(WORD) ?? []
  let i = 0
  const skipEnv = (): void => {
    while (i < words.length && ENV_ASSIGNMENT.test(words[i])) i++
  }
  const skipFlags = (): void => {
    while (i < words.length && words[i].startsWith('-')) i++ // `-y`, `--yes`, the `--` separator
  }
  if (words[i] === '&') i++ // PowerShell call operator: `& "C:\…\claude.exe"`
  skipEnv()
  if (i < words.length && binName(words[i]) === 'env') {
    i++
    skipFlags()
    skipEnv()
  }
  if (i < words.length) {
    const runner = binName(words[i])
    if (RUNNERS.has(runner)) {
      i++
      skipFlags()
    } else if (
      i + 1 < words.length &&
      RUNNER_SUBCOMMANDS.get(runner) === unquote(words[i + 1]).toLowerCase()
    ) {
      i += 2
      skipFlags()
    }
  }
  return i < words.length && isAgentCommand(words[i])
}

/** The Terminal-board fields the classifier reads — every live `TerminalBoard` satisfies it. */
export interface AgentClassifySource {
  agentKind?: string
  launchCommand?: string
}

/**
 * Is this Terminal board an agent? `agentKind` set to any preset but `shell`, else a launch line
 * that starts a known agent CLI ({@link isAgentLaunchLine}). 🔒 D9: returns only the boolean.
 */
export function isAgentTerminal(board: AgentClassifySource): boolean {
  const kind = board.agentKind
  if (typeof kind === 'string' && kind.length > 0 && kind !== SHELL_PRESET) return true
  return isAgentLaunchLine(board.launchCommand)
}
