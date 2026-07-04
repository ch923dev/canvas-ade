import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  makeExternalMcpSyncProvider,
  onRegistryChanged,
  bindExternalSyncStore,
  __resetExternalSync,
  type ExternalSyncStore
} from './externalSync'
import type { ResolvedServer } from './types'

let home: string
let proj: string
let userData: string
const savedHome = process.env.HOME
const savedUserProfile = process.env.USERPROFILE

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sync-home-'))
  proj = mkdtempSync(join(tmpdir(), 'sync-proj-'))
  userData = mkdtempSync(join(tmpdir(), 'sync-ud-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  __resetExternalSync()
  bindExternalSyncStore(userData)
})
afterEach(() => {
  process.env.HOME = savedHome
  process.env.USERPROFILE = savedUserProfile
  __resetExternalSync()
})

const srv = (over: Partial<ResolvedServer> = {}): ResolvedServer => ({
  id: over.name ?? '1',
  name: 'linear',
  enabled: true,
  transport: 'http',
  url: 'https://x',
  headers: [{ name: 'Authorization', value: 'Bearer t' }],
  targets: [],
  ...over
})

/** A registry snapshot; `enabled` filter + name masking mirror the real store. */
function fakeStore(servers: ResolvedServer[]): ExternalSyncStore {
  return {
    listResolvedEnabled: () => servers.filter((s) => s.enabled),
    listMasked: () => servers.map((s) => ({ name: s.name }))
  }
}
const claudeMap = (): Record<string, unknown> =>
  (JSON.parse(readFileSync(join(proj, '.mcp.json'), 'utf8')).mcpServers ?? {}) as Record<
    string,
    unknown
  >

describe('spawn-time provider', () => {
  it('writes enabled servers for the launching CLI', () => {
    const provider = makeExternalMcpSyncProvider({
      getProjectDir: () => proj,
      store: fakeStore([srv()])
    })
    provider({ id: 'b1', launchCommand: 'claude --resume', cwd: proj })
    expect(claudeMap().linear).toBeDefined()
  })

  it('skips a server that does not target the launching CLI', () => {
    const provider = makeExternalMcpSyncProvider({
      getProjectDir: () => proj,
      store: fakeStore([srv({ targets: ['gemini'] })])
    })
    provider({ id: 'b1', launchCommand: 'claude', cwd: proj })
    // No claude-targeted server ⇒ nothing written (file may not even exist).
    expect(existsSync(join(proj, '.mcp.json')) ? claudeMap().linear : undefined).toBeUndefined()
  })

  it('is a no-op for a plain shell (unknown CLI)', () => {
    const provider = makeExternalMcpSyncProvider({
      getProjectDir: () => proj,
      store: fakeStore([srv()])
    })
    provider({ id: 'b1', launchCommand: 'pwsh', cwd: proj })
    expect(existsSync(join(proj, '.mcp.json'))).toBe(false)
  })
})

describe('onRegistryChanged cleanup', () => {
  it('removes a disabled server’s entry from a tracked project dir (secret off disk)', () => {
    const enabled = [srv()]
    const provider = makeExternalMcpSyncProvider({
      getProjectDir: () => proj,
      store: fakeStore(enabled)
    })
    provider({ id: 'b1', launchCommand: 'claude', cwd: proj })
    expect(claudeMap().linear).toBeDefined()

    // Disable it, then fire the change hook → the entry (and its decrypted header) is removed.
    onRegistryChanged(fakeStore([srv({ enabled: false })]))
    expect(existsSync(join(proj, '.mcp.json')) ? claudeMap().linear : undefined).toBeUndefined()
  })

  it('re-adds a re-enabled server to a tracked dir without a respawn', () => {
    const provider = makeExternalMcpSyncProvider({
      getProjectDir: () => proj,
      store: fakeStore([srv({ enabled: false, targets: ['claude'] })])
    })
    provider({ id: 'b1', launchCommand: 'claude', cwd: proj }) // tracks the dir even with nothing to write
    onRegistryChanged(fakeStore([srv({ enabled: true, targets: ['claude'] })]))
    expect(claudeMap().linear).toBeDefined()
  })
})

describe('empty-targets resolves to the DETECTED set (never an uninstalled CLI)', () => {
  it('spawn: an empty-targets server still reaches the launching CLI even if undetected', () => {
    // No ~/.claude in the temp home ⇒ claude is "undetected", but a claude terminal is launching.
    const provider = makeExternalMcpSyncProvider({
      getProjectDir: () => proj,
      store: fakeStore([srv()])
    })
    provider({ id: 'b1', launchCommand: 'claude', cwd: proj })
    expect(claudeMap().linear).toBeDefined()
  })

  it('onRegistryChanged: an empty-targets server writes only to detected home CLIs', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true }) // gemini detected; codex is NOT
    onRegistryChanged(fakeStore([srv()]))
    expect(existsSync(join(home, '.gemini', 'settings.json'))).toBe(true)
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false)
  })
})
