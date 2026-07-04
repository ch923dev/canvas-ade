import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { EXTERNAL_WRITERS, detectExternalClis, writerTargetDir } from './external'
import type { ResolvedServer } from '../mcpServers/types'

// Home-scoped writers (gemini/codex) resolve os.homedir(); point HOME + USERPROFILE at a temp dir so
// a test never writes into the real home. Project-scoped writers (claude/opencode) take an explicit dir.
let home: string
let proj: string
const savedHome = process.env.HOME
const savedUserProfile = process.env.USERPROFILE
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ext-home-'))
  proj = mkdtempSync(join(tmpdir(), 'ext-proj-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
})
afterEach(() => {
  process.env.HOME = savedHome
  process.env.USERPROFILE = savedUserProfile
})

const http = (over: Partial<ResolvedServer> = {}): ResolvedServer => ({
  id: '1',
  name: 'linear',
  enabled: true,
  transport: 'http',
  url: 'https://mcp.linear.app/sse',
  headers: [{ name: 'Authorization', value: 'Bearer tok' }],
  targets: [],
  ...over
})
const stdio = (over: Partial<ResolvedServer> = {}): ResolvedServer => ({
  id: '2',
  name: 'github',
  enabled: true,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: [{ name: 'GITHUB_TOKEN', value: 'ghp' }],
  targets: [],
  ...over
})
const readJson = (f: string): Record<string, unknown> => JSON.parse(readFileSync(f, 'utf8'))

describe('claude external writer', () => {
  it('writes http + stdio entries and enables them in settings.local', () => {
    EXTERNAL_WRITERS.claude.writeServers(proj, [http(), stdio()])
    const mcp = readJson(join(proj, '.mcp.json')).mcpServers as Record<string, unknown>
    expect(mcp.linear).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/sse',
      headers: { Authorization: 'Bearer tok' }
    })
    expect(mcp.github).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp' }
    })
    const local = readJson(join(proj, '.claude', 'settings.local.json'))
    expect(local.enabledMcpjsonServers).toEqual(expect.arrayContaining(['linear', 'github']))
  })

  it('merges — preserves a foreign server (e.g. canvas-ade) and removes only the named key', () => {
    writeFileSync(
      join(proj, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'canvas-ade': { type: 'http', url: 'x' } } })
    )
    EXTERNAL_WRITERS.claude.writeServers(proj, [http()])
    let mcp = readJson(join(proj, '.mcp.json')).mcpServers as Record<string, unknown>
    expect(mcp['canvas-ade']).toBeDefined()
    expect(mcp.linear).toBeDefined()
    EXTERNAL_WRITERS.claude.removeServers(proj, ['linear'])
    mcp = readJson(join(proj, '.mcp.json')).mcpServers as Record<string, unknown>
    expect(mcp['canvas-ade']).toBeDefined()
    expect(mcp.linear).toBeUndefined()
  })
})

describe('gemini external writer (home-scoped, transport by key)', () => {
  it('writes httpUrl for http and command for stdio', () => {
    EXTERNAL_WRITERS.gemini.writeServers('', [http(), stdio()])
    const map = readJson(join(home, '.gemini', 'settings.json')).mcpServers as Record<
      string,
      unknown
    >
    expect(map.linear).toEqual({
      httpUrl: 'https://mcp.linear.app/sse',
      headers: { Authorization: 'Bearer tok' }
    })
    expect(map.github).toMatchObject({ command: 'npx' })
  })
})

describe('codex external writer (surgical TOML)', () => {
  it('writes an http table with url + http_headers', () => {
    EXTERNAL_WRITERS.codex.writeServers('', [http()])
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain('[mcp_servers.linear]')
    expect(toml).toContain('url = "https://mcp.linear.app/sse"')
    expect(toml).toContain('http_headers = { "Authorization" = "Bearer tok" }')
  })
  it('writes a stdio table with command/args/env and removes only the named table', () => {
    EXTERNAL_WRITERS.codex.writeServers('', [stdio(), http()])
    let toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain('command = "npx"')
    expect(toml).toContain('args = ["-y", "@modelcontextprotocol/server-github"]')
    expect(toml).toContain('env = { "GITHUB_TOKEN" = "ghp" }')
    EXTERNAL_WRITERS.codex.removeServers('', ['github'])
    toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(toml).not.toContain('[mcp_servers.github]')
    expect(toml).toContain('[mcp_servers.linear]')
  })
})

describe('opencode external writer', () => {
  it('writes remote for http and local (command array) for stdio', () => {
    EXTERNAL_WRITERS.opencode.writeServers(proj, [http(), stdio()])
    const map = readJson(join(proj, 'opencode.json')).mcp as Record<string, unknown>
    expect(map.linear).toEqual({
      type: 'remote',
      url: 'https://mcp.linear.app/sse',
      enabled: true,
      headers: { Authorization: 'Bearer tok' }
    })
    expect(map.github).toEqual({
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-github'],
      enabled: true,
      environment: { GITHUB_TOKEN: 'ghp' }
    })
  })
})

describe('helpers', () => {
  it('writerTargetDir routes home vs project', () => {
    expect(writerTargetDir('gemini', proj)).toBe(join(home, '.gemini'))
    expect(writerTargetDir('claude', proj)).toBe(proj)
  })
  it('detectExternalClis reports a present config dir', async () => {
    mkdirSync(join(home, '.gemini'), { recursive: true })
    const d = await detectExternalClis()
    expect(d.gemini).toBe(true)
    expect(d.codex).toBe(false)
  })
  it('sanity: real homedir untouched by the test override cleanup', () => {
    expect(typeof homedir()).toBe('string')
    expect(existsSync(proj)).toBe(true)
  })
})
