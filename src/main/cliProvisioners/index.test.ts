/**
 * Public-surface tests: launch-command → CLI resolution, detection, status, sync (incl. error
 * isolation + token-never-leaked), unsync, and the spawn-time provider's consent/CLI gating.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Unique throwaway "home" path computed WITHOUT importing os (vi.hoisted runs before imports);
// the directory is created after the imports below.
const { TEST_HOME, orchEnabled } = vi.hoisted(() => {
  const base = (process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp').replace(
    /[\\/]+$/,
    ''
  )
  return {
    TEST_HOME: `${base}/orch-idx-${process.pid}-${Date.now()}`,
    orchEnabled: { value: true }
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => TEST_HOME }
})
// Override only the consent getter; keep the real canRelay / types.
vi.mock('../orchestration/seam', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestration/seam')>()
  return { ...actual, isOrchestrationEnabled: () => orchEnabled.value }
})

import {
  cliIdForLaunchCommand,
  detectInstalled,
  getProvisionStatus,
  makeOrchestrationSyncProvider,
  runProvisionerSync,
  unsyncProvisioners
} from './index'
import type { TerminalToken } from '../orchestration/seam'

const TOK: TerminalToken = { token: 'SECRET-zzz', tier: 'connected', port: 4321 }
const mintToken = (): TerminalToken => TOK

mkdirSync(TEST_HOME, { recursive: true })

function freshProject(): string {
  return mkdtempSync(join(TEST_HOME, 'p-'))
}

beforeEach(() => {
  orchEnabled.value = true
  for (const d of ['.claude', '.gemini', '.codex', '.config']) {
    rmSync(join(TEST_HOME, d), { recursive: true, force: true })
  }
})
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }))

describe('cliIdForLaunchCommand', () => {
  it('resolves the CLI through flags, runners, paths, and extensions', () => {
    expect(cliIdForLaunchCommand('claude')).toBe('claude')
    expect(cliIdForLaunchCommand('claude --resume')).toBe('claude')
    expect(cliIdForLaunchCommand('npx --yes gemini')).toBe('gemini')
    expect(cliIdForLaunchCommand('pnpm dlx opencode')).toBe('opencode')
    expect(cliIdForLaunchCommand('C:\\bin\\codex.exe --model o4')).toBe('codex')
    expect(cliIdForLaunchCommand('/usr/local/bin/claude')).toBe('claude')
  })
  it('returns null for a plain shell / unknown command / empty', () => {
    expect(cliIdForLaunchCommand(undefined)).toBeNull()
    expect(cliIdForLaunchCommand('')).toBeNull()
    expect(cliIdForLaunchCommand('vim')).toBeNull()
    expect(cliIdForLaunchCommand('npm run dev')).toBeNull()
  })
})

describe('detectInstalled', () => {
  it('is all-false in a clean home and flips per config dir', async () => {
    expect(await detectInstalled()).toEqual({
      claude: false,
      codex: false,
      gemini: false,
      opencode: false
    })
    mkdirSync(join(TEST_HOME, '.gemini'), { recursive: true })
    expect((await detectInstalled()).gemini).toBe(true)
  })
})

describe('getProvisionStatus', () => {
  it('returns a masked endpoint (no raw token) + a row per CLI in registry order', async () => {
    mkdirSync(join(TEST_HOME, '.claude'), { recursive: true })
    const status = await getProvisionStatus({ projectDir: freshProject(), port: 4321 })
    expect(status.endpoint).toEqual({ host: '127.0.0.1', port: 4321, maskedToken: '••••••' })
    expect(JSON.stringify(status)).not.toContain('SECRET') // token never reaches the modal payload
    expect(status.rows.map((r) => r.id)).toEqual(['claude', 'codex', 'gemini', 'opencode'])
    expect(status.rows.find((r) => r.id === 'claude')?.detected).toBe(true)
    expect(status.rows.find((r) => r.id === 'gemini')?.detected).toBe(false)
  })
})

describe('runProvisionerSync', () => {
  it('syncs the selected CLIs and reports a path, never leaking the token', async () => {
    const dir = freshProject()
    const results = await runProvisionerSync({ projectDir: dir, ids: ['gemini'], token: TOK })
    expect(results).toEqual([
      {
        id: 'gemini',
        status: 'synced',
        detail: expect.stringContaining('.gemini'),
        path: expect.any(String)
      }
    ])
    expect(JSON.stringify(results)).not.toContain('SECRET')
    expect(existsSync(join(TEST_HOME, '.gemini', 'settings.json'))).toBe(true)
  })

  it('isolates a failing CLI — others still sync', async () => {
    const dir = freshProject()
    writeFileSync(join(dir, '.mcp.json'), '{ this is : not json') // makes claude throw
    const results = await runProvisionerSync({
      projectDir: dir,
      ids: ['claude', 'gemini'],
      token: TOK
    })
    expect(results.find((r) => r.id === 'claude')?.status).toBe('error')
    expect(results.find((r) => r.id === 'gemini')?.status).toBe('synced')
  })
})

describe('unsyncProvisioners', () => {
  it('removes our entry from every CLI by default', async () => {
    const dir = freshProject()
    await runProvisionerSync({ projectDir: dir, ids: ['gemini'], token: TOK })
    await unsyncProvisioners({ projectDir: dir })
    const cfg = JSON.parse(readFileSync(join(TEST_HOME, '.gemini', 'settings.json'), 'utf8'))
    expect((cfg.mcpServers ?? {})['canvas-ade']).toBeUndefined()
  })
})

describe('makeOrchestrationSyncProvider (spawn-time hook)', () => {
  it('writes the matching CLI config to the board cwd when consent is on', () => {
    const dir = freshProject()
    const provider = makeOrchestrationSyncProvider({ getProjectDir: () => dir, mintToken })
    provider({ id: 'b1', launchCommand: 'claude --resume', cwd: dir })
    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers['canvas-ade'].url).toBe('http://127.0.0.1:4321/mcp')
  })

  it('no-ops when consent is off, no project, or the command is not a known CLI', () => {
    const dir = freshProject()
    const provider = makeOrchestrationSyncProvider({ getProjectDir: () => dir, mintToken })

    orchEnabled.value = false
    provider({ id: 'b', launchCommand: 'claude', cwd: dir })
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false)

    orchEnabled.value = true
    provider({ id: 'b', launchCommand: 'vim', cwd: dir })
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false)

    const noProject = makeOrchestrationSyncProvider({ getProjectDir: () => null, mintToken })
    noProject({ id: 'b', launchCommand: 'claude', cwd: dir })
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false)
  })

  it('falls back to the project dir when the board cwd is empty', () => {
    const dir = freshProject()
    const provider = makeOrchestrationSyncProvider({ getProjectDir: () => dir, mintToken })
    provider({ id: 'b', launchCommand: 'claude', cwd: '' })
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true)
  })
})
