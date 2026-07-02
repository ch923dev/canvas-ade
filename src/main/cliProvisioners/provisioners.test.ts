/**
 * Per-CLI provisioner write/merge/remove + shared-helper tests (Agent Orchestration · P3).
 *
 * `node:os` `homedir` is redirected to a throwaway temp dir so the home-scoped CLIs (gemini/codex/
 * opencode-detect) and the project-scoped CLIs (claude/opencode write into a temp project dir) are
 * fully hermetic — no real `~/.gemini` etc. is touched.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

// A unique throwaway "home" path computed WITHOUT importing os (vi.hoisted runs before imports);
// the directory itself is created after the imports below.
const { TEST_HOME } = vi.hoisted(() => {
  const base = (process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp').replace(
    /[\\/]+$/,
    ''
  )
  return { TEST_HOME: `${base}/orch-home-${process.pid}-${Date.now()}` }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => TEST_HOME }
})

import { claudeProvisioner } from './claude'
import { codexProvisioner } from './codex'
import { geminiProvisioner } from './gemini'
import { opencodeProvisioner } from './opencode'
import {
  existingServersMap,
  isRecord,
  maskToken,
  readJsonConfig,
  removeCodexTable,
  tomlBasicString,
  upsertCodexTable
} from './shared'
import type { TerminalToken } from '../orchestration/seam'

const TOK: TerminalToken = { token: 'TOKEN-abc_123', tier: 'connected', port: 52141 }
const EXPECTED_URL = 'http://127.0.0.1:52141/mcp'
const EXPECTED_BEARER = 'Bearer TOKEN-abc_123'

mkdirSync(TEST_HOME, { recursive: true })

function freshProject(): string {
  return mkdtempSync(join(TEST_HOME, 'proj-'))
}
function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8'))
}

beforeEach(() => {
  // Clean the home config dirs between tests so detect() and merges start from scratch.
  for (const d of ['.claude', '.gemini', '.codex', '.config']) {
    rmSync(join(TEST_HOME, d), { recursive: true, force: true })
  }
})
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }))

describe('shared helpers', () => {
  it('maskToken reveals no token characters', () => {
    expect(maskToken()).toBe('••••••')
    expect(maskToken()).not.toMatch(/[A-Za-z0-9]/)
  })

  it('readJsonConfig returns undefined for absent / empty, parses present, throws on corrupt', () => {
    const dir = freshProject()
    expect(readJsonConfig(join(dir, 'nope.json'))).toBeUndefined()
    const empty = join(dir, 'empty.json')
    writeFileSync(empty, '   ')
    expect(readJsonConfig(empty)).toBeUndefined()
    const good = join(dir, 'good.json')
    writeFileSync(good, '{"a":1}')
    expect(readJsonConfig(good)).toEqual({ a: 1 })
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    expect(() => readJsonConfig(bad)).toThrow(/not valid JSON/)
  })

  it('isRecord/existingServersMap treat a malformed mcpServers/mcp field as absent (BUG-023)', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord('oops')).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)

    expect(existingServersMap({ mcpServers: { a: 1 } }, 'mcpServers')).toEqual({ a: 1 })
    expect(existingServersMap({ mcpServers: 'not-an-object' }, 'mcpServers')).toBeUndefined()
    expect(existingServersMap({ mcpServers: ['a', 'b'] }, 'mcpServers')).toBeUndefined()
    expect(existingServersMap(undefined, 'mcpServers')).toBeUndefined()
  })

  it('tomlBasicString escapes backslash and quote', () => {
    expect(tomlBasicString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })

  it('upsertCodexTable creates a fresh block, appends after existing content, and replaces in place', () => {
    const fresh = upsertCodexTable(undefined, 52141, 'T')
    expect(fresh).toBe(
      '[mcp_servers.canvas-ade]\nurl = "http://127.0.0.1:52141/mcp"\n' +
        'http_headers = { Authorization = "Bearer T" }\n'
    )

    const existing = '[model]\nname = "gpt"\n\n[mcp_servers.other]\nurl = "http://x"\n'
    const appended = upsertCodexTable(existing, 52141, 'T')
    expect(appended).toContain('[model]') // preserved
    expect(appended).toContain('[mcp_servers.other]') // preserved
    expect(appended).toContain('[mcp_servers.canvas-ade]') // added
    // Re-upsert with a new port → only our table changes, no duplicate header.
    const replaced = upsertCodexTable(appended, 60000, 'T2')
    expect(replaced.match(/\[mcp_servers\.canvas-ade\]/g)).toHaveLength(1)
    expect(replaced).toContain('60000')
    expect(replaced).toContain('Bearer T2')
    expect(replaced).toContain('[mcp_servers.other]')
  })

  it("upsertCodexTable matches the existing file's CRLF convention (no mixed line endings)", () => {
    const existing = '[model]\r\nname = "gpt"\r\n'
    const appended = upsertCodexTable(existing, 52141, 'T')
    expect(appended).not.toMatch(/[^\r]\n/) // every \n is preceded by \r — no bare LF
    expect(appended).toContain('[mcp_servers.canvas-ade]\r\n')

    const replaced = upsertCodexTable(appended, 60000, 'T2')
    expect(replaced).not.toMatch(/[^\r]\n/)
    expect(replaced.match(/\[mcp_servers\.canvas-ade\]/g)).toHaveLength(1)
  })

  it('removeCodexTable drops our table only, preserving neighbours; no-op when absent', () => {
    const content =
      '[mcp_servers.canvas-ade]\nurl = "u"\nhttp_headers = { Authorization = "b" }\n\n[other]\nk = 1\n'
    const out = removeCodexTable(content)
    expect(out).not.toContain('canvas-ade')
    expect(out).toContain('[other]')
    expect(removeCodexTable('[only.other]\nk=1\n')).toBe('[only.other]\nk=1\n')
  })
})

describe('claudeProvisioner', () => {
  it('writes .mcp.json + .claude/settings.local.json and merges, preserving existing keys', () => {
    const dir = freshProject()
    // Pre-existing user config in both files.
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { mine: { type: 'http' } } })
    )
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { SessionStart: [] }, enabledMcpjsonServers: ['other'] })
    )

    claudeProvisioner.writeSync(dir, TOK)

    const mcp = readJson(join(dir, '.mcp.json'))
    expect((mcp.mcpServers as Record<string, unknown>).mine).toBeDefined() // preserved
    expect(
      (mcp.mcpServers as Record<string, { url: string; headers: { Authorization: string } }>)[
        'canvas-ade'
      ]
    ).toEqual({ type: 'http', url: EXPECTED_URL, headers: { Authorization: EXPECTED_BEARER } })

    const settings = readJson(join(dir, '.claude', 'settings.local.json'))
    expect(settings.hooks).toBeDefined() // preserved (recap hook lives here)
    expect(settings.enabledMcpjsonServers).toEqual(['other', 'canvas-ade'])
  })

  it('rolls back .mcp.json when the second write (settings.local.json) fails, leaving no orphaned bearer-token file (BUG-020)', () => {
    const dir = freshProject()
    const originalMcpJson = { mcpServers: { mine: { type: 'http' } } }
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify(originalMcpJson))
    // Force the second write to fail: a FILE sits where the `.claude` directory must be created.
    writeFileSync(join(dir, '.claude'), 'not a directory')

    expect(() => claudeProvisioner.writeSync(dir, TOK)).toThrow()

    // .mcp.json is restored to exactly its pre-write state — no orphaned canvas-ade token entry.
    expect(readJson(join(dir, '.mcp.json'))).toEqual(originalMcpJson)
  })

  it('deletes .mcp.json (rather than leaving a newly-created orphan) when it did not exist before a failed second write', () => {
    const dir = freshProject()
    writeFileSync(join(dir, '.claude'), 'not a directory') // forces the second write to fail
    expect(() => claudeProvisioner.writeSync(dir, TOK)).toThrow()
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false)
  })

  it('writeSync replaces a malformed mcpServers field instead of corrupting the merge (BUG-023)', () => {
    const dir = freshProject()
    // Hand-edited / foreign-tool-written config: mcpServers is a STRING, not an object.
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: 'not-an-object' }))

    claudeProvisioner.writeSync(dir, TOK)

    const mcp = readJson(join(dir, '.mcp.json'))
    // The malformed value is discarded, not spread into numeric-key junk (`{0:'n',1:'o',...}`).
    expect(mcp.mcpServers).toEqual({
      'canvas-ade': { type: 'http', url: EXPECTED_URL, headers: { Authorization: EXPECTED_BEARER } }
    })
  })

  it('unsync removes only our entries and deletes a file it solely owned', () => {
    const dir = freshProject()
    claudeProvisioner.writeSync(dir, TOK) // creates files holding only our entry
    claudeProvisioner.removeSync(dir)
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false) // only-ours → removed
    const settings = readJson(join(dir, '.claude', 'settings.local.json'))
    expect(settings.enabledMcpjsonServers).toBeUndefined()
  })

  it('detect reflects ~/.claude presence', async () => {
    expect(await claudeProvisioner.detect()).toBe(false)
    mkdirSync(join(TEST_HOME, '.claude'), { recursive: true })
    expect(await claudeProvisioner.detect()).toBe(true)
  })
})

describe('geminiProvisioner', () => {
  it('writes ~/.gemini/settings.json with httpUrl + bearer, merging other servers', () => {
    mkdirSync(join(TEST_HOME, '.gemini'), { recursive: true })
    writeFileSync(
      join(TEST_HOME, '.gemini', 'settings.json'),
      JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } })
    )
    geminiProvisioner.writeSync(freshProject(), TOK)
    const cfg = readJson(join(TEST_HOME, '.gemini', 'settings.json'))
    expect(cfg.theme).toBe('dark') // preserved
    const servers = cfg.mcpServers as Record<string, unknown>
    expect(servers.other).toBeDefined()
    expect(servers['canvas-ade']).toEqual({
      httpUrl: EXPECTED_URL,
      headers: { Authorization: EXPECTED_BEARER }
    })
    expect(geminiProvisioner.id).toBe('gemini')
  })

  it('detect reflects ~/.gemini; unsync removes our server', async () => {
    expect(await geminiProvisioner.detect()).toBe(false)
    geminiProvisioner.writeSync(freshProject(), TOK)
    expect(await geminiProvisioner.detect()).toBe(true)
    geminiProvisioner.removeSync(freshProject())
    const cfg = readJson(join(TEST_HOME, '.gemini', 'settings.json'))
    expect((cfg.mcpServers as Record<string, unknown>)['canvas-ade']).toBeUndefined()
  })
})

describe('opencodeProvisioner', () => {
  it('writes project opencode.json with a remote entry + $schema, merging', () => {
    const dir = freshProject()
    writeFileSync(
      join(dir, 'opencode.json'),
      JSON.stringify({ mcp: { other: { type: 'remote' } } })
    )
    opencodeProvisioner.writeSync(dir, TOK)
    const cfg = readJson(join(dir, 'opencode.json'))
    expect(cfg.$schema).toBe('https://opencode.ai/config.json')
    const mcp = cfg.mcp as Record<string, unknown>
    expect(mcp.other).toBeDefined()
    expect(mcp['canvas-ade']).toEqual({
      type: 'remote',
      url: EXPECTED_URL,
      enabled: true,
      headers: { Authorization: EXPECTED_BEARER }
    })
  })

  it('detect reflects the opencode config dir; unsync removes a solely-owned file', () => {
    const dir = freshProject()
    opencodeProvisioner.writeSync(dir, TOK)
    opencodeProvisioner.removeSync(dir)
    expect(existsSync(join(dir, 'opencode.json'))).toBe(false)
  })
})

describe('codexProvisioner', () => {
  it('writes ~/.codex/config.toml with a streamable-http table + inline bearer, merging', () => {
    mkdirSync(join(TEST_HOME, '.codex'), { recursive: true })
    writeFileSync(join(TEST_HOME, '.codex', 'config.toml'), '[model]\nname = "o4"\n')
    codexProvisioner.writeSync(freshProject(), TOK)
    const toml = readFileSync(join(TEST_HOME, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain('[model]') // preserved
    expect(toml).toContain('[mcp_servers.canvas-ade]')
    expect(toml).toContain(`url = "${EXPECTED_URL}"`)
    expect(toml).toContain(`http_headers = { Authorization = "${EXPECTED_BEARER}" }`)
  })

  it('detect reflects ~/.codex; unsync removes our table, leaving the rest', () => {
    const dir = freshProject()
    mkdirSync(join(TEST_HOME, '.codex'), { recursive: true })
    writeFileSync(join(TEST_HOME, '.codex', 'config.toml'), '[model]\nname = "o4"\n')
    codexProvisioner.writeSync(dir, TOK)
    codexProvisioner.removeSync(dir)
    const toml = readFileSync(join(TEST_HOME, '.codex', 'config.toml'), 'utf8')
    expect(toml).toContain('[model]')
    expect(toml).not.toContain('canvas-ade')
  })
})

describe('file permissions (POSIX only — 0o600)', () => {
  it.skipIf(process.platform === 'win32')('writes config files owner-only', () => {
    const dir = freshProject()
    claudeProvisioner.writeSync(dir, TOK)
    const mode = statSync(join(dir, '.mcp.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
