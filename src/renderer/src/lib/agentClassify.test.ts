/**
 * agentClassify — the C9 `agent` producer (L11). Pins the known-CLI list, the token rules (env
 * prefixes · runners · paths · extensions), the plain-shell / dev-server negatives, and D9: the
 * module only ever hands back a boolean.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as agentClassify from './agentClassify'
import { isAgentLaunchLine, isAgentTerminal } from './agentClassify'
import { AGENT_PRESETS } from '../canvas/boards/terminal/agentPresets'

describe('isAgentLaunchLine — the known agent CLIs', () => {
  it.each([
    'claude',
    'codex',
    'gemini',
    'opencode',
    'aider',
    'amp',
    'goose',
    'qwen',
    'cursor-agent'
  ])('%s is an agent', (bin) => {
    expect(isAgentLaunchLine(bin)).toBe(true)
    expect(isAgentLaunchLine(`${bin} --some-flag value`)).toBe(true)
  })

  it('mirrors every New Terminal preset bin (single source: AGENT_PRESETS)', () => {
    const bins = AGENT_PRESETS.map((p) => p.bin).filter((b) => b.length > 0)
    expect(bins.length).toBeGreaterThan(0)
    for (const bin of bins) expect(isAgentLaunchLine(bin)).toBe(true)
  })

  it('matches agent npm packages launched through a runner, with or without a version', () => {
    expect(isAgentLaunchLine('npx @anthropic-ai/claude-code')).toBe(true)
    expect(isAgentLaunchLine('npx -y @anthropic-ai/claude-code@latest --resume')).toBe(true)
    expect(isAgentLaunchLine('pnpm dlx @openai/codex')).toBe(true)
    expect(isAgentLaunchLine('bunx @google/gemini-cli@0.9.0')).toBe(true)
    expect(isAgentLaunchLine('yarn dlx opencode-ai')).toBe(true)
    expect(isAgentLaunchLine('npm exec -- @sourcegraph/amp')).toBe(true)
    expect(isAgentLaunchLine('npx claude@latest')).toBe(true)
    expect(isAgentLaunchLine('npx.cmd --yes codex')).toBe(true)
  })

  it('skips leading KEY=value env assignments (quoted values included) and an `env` prefix', () => {
    expect(isAgentLaunchLine('ANTHROPIC_API_KEY=sk-ant-123 claude')).toBe(true)
    expect(isAgentLaunchLine('FOO=1 BAR="a b c" codex --full-auto')).toBe(true)
    expect(isAgentLaunchLine("A='x y' npx @anthropic-ai/claude-code")).toBe(true)
    expect(isAgentLaunchLine('env -i HOME=/tmp gemini')).toBe(true)
  })

  it('compares the basename, lowercased, with .exe/.cmd/.bat/.ps1 stripped', () => {
    expect(isAgentLaunchLine('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')).toBe(true)
    expect(isAgentLaunchLine('"C:\\Program Files\\nodejs\\Claude.EXE" --continue')).toBe(true)
    expect(isAgentLaunchLine('/usr/local/bin/codex')).toBe(true)
    expect(isAgentLaunchLine('& "C:\\tools\\gemini.ps1"')).toBe(true)
    expect(isAgentLaunchLine('C:\\Users\\me@corp\\bin\\aider.bat')).toBe(true)
    expect(isAgentLaunchLine('  CLAUDE  ')).toBe(true)
  })

  it('is false for plain shells, dev servers and everything else', () => {
    for (const line of [
      undefined,
      '',
      '   ',
      'pwsh',
      'powershell -NoLogo',
      'bash',
      'pnpm dev',
      'npm run start',
      'npm run dev -- --port 3000',
      'pnpm dlx vite',
      'npx serve .',
      'node server.js',
      'python -m http.server 8000',
      'cd apps/web',
      'PORT=3000 node index.js',
      'claude-desktop',
      'clauded',
      'git status'
    ]) {
      expect(isAgentLaunchLine(line)).toBe(false)
    }
  })

  it('matches only the FIRST command token (an agent named later is not the launched command)', () => {
    expect(isAgentLaunchLine('echo claude')).toBe(false)
    expect(isAgentLaunchLine('pnpm dev claude')).toBe(false)
  })
})

describe('isAgentTerminal — agentKind, then the launch line', () => {
  it('any preset agentKind but `shell` is an agent, whatever the launch line says', () => {
    expect(isAgentTerminal({ agentKind: 'claude' })).toBe(true)
    expect(isAgentTerminal({ agentKind: 'codex', launchCommand: 'pnpm dev' })).toBe(true)
    expect(isAgentTerminal({ agentKind: 'my-custom-agent' })).toBe(true)
  })

  it('the `shell` preset (and no preset) falls through to the launch line', () => {
    expect(isAgentTerminal({ agentKind: 'shell' })).toBe(false)
    expect(isAgentTerminal({ agentKind: 'shell', launchCommand: 'claude' })).toBe(true)
    expect(isAgentTerminal({ launchCommand: 'pnpm dev' })).toBe(false)
    expect(isAgentTerminal({ launchCommand: 'X=1 codex' })).toBe(true)
    expect(isAgentTerminal({})).toBe(false)
    expect(isAgentTerminal({ agentKind: '' })).toBe(false)
  })
})

describe('🔒 D9 — only the boolean ever leaves the module', () => {
  afterEach(() => vi.restoreAllMocks())

  const SECRET = 'sk-live-SECRET-0123456789'
  const lines = [
    `OPENAI_API_KEY=${SECRET} codex --full-auto`,
    `ANTHROPIC_API_KEY="${SECRET}" claude`,
    `TOKEN=${SECRET} pnpm dev`,
    `"C:\\${SECRET}\\claude.exe"`
  ]

  it('every export is a function returning exactly true/false — never the line or a token', () => {
    const exported = Object.entries(agentClassify)
    expect(exported.map(([name]) => name).sort()).toEqual(['isAgentLaunchLine', 'isAgentTerminal'])
    for (const line of lines) {
      for (const result of [
        agentClassify.isAgentLaunchLine(line),
        agentClassify.isAgentTerminal({ launchCommand: line }),
        agentClassify.isAgentTerminal({ agentKind: 'shell', launchCommand: line })
      ]) {
        expect(typeof result).toBe('boolean')
        expect(JSON.stringify(result)).not.toContain(SECRET)
      }
    }
  })

  it('never logs the launch line (no console output at all)', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )
    for (const line of lines) {
      isAgentLaunchLine(line)
      isAgentTerminal({ launchCommand: line })
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('does not mutate the board it reads', () => {
    const board = { agentKind: 'shell', launchCommand: lines[0] }
    const before = JSON.stringify(board)
    isAgentTerminal(board)
    expect(JSON.stringify(board)).toBe(before)
  })
})
