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
  __resetProvisionedDirs,
  bindProvisionedDirStore,
  cliIdForLaunchCommand,
  detectInstalled,
  getProvisionStatus,
  loadPersistedProvisionedDirs,
  makeOrchestrationSyncProvider,
  revokeOrchestration,
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
  __resetProvisionedDirs() // FIND-001: drop the divergent-dir registry (module-level) between cases
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
    // Leading env wrapper / inline `KEY=value` assignments are skipped, not dead-ended on.
    expect(cliIdForLaunchCommand('env ANTHROPIC_API_KEY=xxx claude')).toBe('claude')
    expect(cliIdForLaunchCommand('FOO=bar claude --resume')).toBe('claude')
  })
  it('resolves a quoted first token (spaced path) instead of dead-ending', () => {
    expect(cliIdForLaunchCommand('"C:\\Program Files\\claude.exe" --flag')).toBe('claude')
    expect(cliIdForLaunchCommand("'/opt/my apps/codex' --resume")).toBe('codex')
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

  // FIND-001 (High): the spawn hook writes project-scoped configs to the board's cwd, which the user
  // can point at a subfolder. Consent-revoke must clean those divergent configs too — the bug was
  // that unsync removed only the project root, leaving a live bearer token on disk in <cwd>/.mcp.json.
  it('cleans a divergent board cwd the spawn hook wrote into, not just the project root', async () => {
    const dir = freshProject()
    const sub = join(dir, 'packages', 'api')
    mkdirSync(sub, { recursive: true })
    const provider = makeOrchestrationSyncProvider({ getProjectDir: () => dir, mintToken })
    provider({ id: 'b-root', launchCommand: 'claude', cwd: dir }) // project-root write
    provider({ id: 'b-sub', launchCommand: 'claude', cwd: sub }) // divergent board-cwd write
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true)
    expect(existsSync(join(sub, '.mcp.json'))).toBe(true)
    // The plaintext bearer really landed in the divergent config (the leak vector).
    const subCfg = JSON.parse(readFileSync(join(sub, '.mcp.json'), 'utf8'))
    expect(subCfg.mcpServers['canvas-ade'].headers.Authorization).toContain('SECRET')

    await unsyncProvisioners({ projectDir: dir })

    // No bearer token left anywhere — both the root AND the divergent cwd config are gone.
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false)
    expect(existsSync(join(sub, '.mcp.json'))).toBe(false)
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

// W1-E / F8 (HIGH, defect-audit 2026-06-20): the divergent-dir registry is in-memory only, so a
// bearer token the spawn hook wrote into a board cwd in Session A survives BOTH an app restart AND a
// consent-revoke in Session B (the empty Map makes unsync clean only the project root). The fix
// persists the registry to userData and re-hydrates it at boot. A fresh temp userData stands in for
// `app.getPath('userData')` (stable across restarts → re-binding the same path == the binding surviving).
describe('persisted provisionedDirs across restart (F8)', () => {
  const freshUserData = (): string => mkdtempSync(join(TEST_HOME, 'ud-'))

  it('after a simulated restart + reload, revoke cleans a PRIOR-session divergent cwd (F8-cross-restart)', () => {
    const ud = freshUserData()
    bindProvisionedDirStore(ud)
    const dir = freshProject()
    const sub = join(dir, 'packages', 'api')
    mkdirSync(sub, { recursive: true })

    // Session A: the spawn hook writes a project-scoped config (plaintext bearer) into the board cwd.
    const provider = makeOrchestrationSyncProvider({ getProjectDir: () => dir, mintToken })
    provider({ id: 'b-sub', launchCommand: 'claude', cwd: sub })
    expect(existsSync(join(sub, '.mcp.json'))).toBe(true)
    expect(
      JSON.parse(readFileSync(join(sub, '.mcp.json'), 'utf8')).mcpServers['canvas-ade'].headers
        .Authorization
    ).toContain('SECRET')

    // Quit + restart: the in-memory Map (and its binding) are gone; boot re-binds the SAME userData
    // path and hydrates the persisted set before any revoke callback can fire.
    __resetProvisionedDirs()
    bindProvisionedDirStore(ud)
    loadPersistedProvisionedDirs(ud)

    return unsyncProvisioners({ projectDir: dir }).then(() => {
      // The divergent token is gone even though THIS session never spawned a board with that cwd.
      expect(existsSync(join(sub, '.mcp.json'))).toBe(false)
    })
  })

  it('WITHOUT the reload, the prior-session token survives revoke (documents the F8 bug)', () => {
    const ud = freshUserData()
    bindProvisionedDirStore(ud)
    const dir = freshProject()
    const sub = join(dir, 'packages', 'api')
    mkdirSync(sub, { recursive: true })
    const provider = makeOrchestrationSyncProvider({ getProjectDir: () => dir, mintToken })
    provider({ id: 'b-sub', launchCommand: 'claude', cwd: sub })

    // Restart WITHOUT hydrating from disk (the pre-fix behavior): the Map is empty…
    __resetProvisionedDirs()

    return unsyncProvisioners({ projectDir: dir }).then(() => {
      // …so unsync touches only the project root and the divergent token is left readable on disk.
      expect(existsSync(join(sub, '.mcp.json'))).toBe(true)
    })
  })

  it('reloaded revoke is safe when the persisted dir no longer exists (F8-vanished-dir)', () => {
    const ud = freshUserData()
    bindProvisionedDirStore(ud)
    const dir = freshProject()
    const sub = join(dir, 'gone')
    mkdirSync(sub, { recursive: true })
    const provider = makeOrchestrationSyncProvider({ getProjectDir: () => dir, mintToken })
    provider({ id: 'b-sub', launchCommand: 'claude', cwd: sub })

    // The board cwd vanished between sessions (deleted project subfolder), but the store still lists it.
    rmSync(sub, { recursive: true, force: true })
    __resetProvisionedDirs()
    bindProvisionedDirStore(ud)
    loadPersistedProvisionedDirs(ud)

    // removeSync on a vanished dir is a clean no-op (existsSync guards the read) → unsync resolves.
    return expect(unsyncProvisioners({ projectDir: dir })).resolves.toBeUndefined()
  })
})

// W1-E / F22 (LOW): on consent-revoke the on-disk bearer tokens must be removed BEFORE the live
// in-memory tokens are invalidated — otherwise there is a window where an on-disk token outlives the
// in-memory one it mirrors. `revokeOrchestration` chains revoke in `.finally` after unsync resolves.
describe('revokeOrchestration ordering (F22)', () => {
  it('revokes in-memory tokens only AFTER the on-disk unsync resolves', async () => {
    const order: string[] = []
    const unsync = vi.fn(
      (_opts: { projectDir: string }) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push('unsync')
            resolve()
          }, 10)
        })
    )
    const revoke = vi.fn(() => void order.push('revoke'))

    await revokeOrchestration('/proj', unsync, revoke)

    expect(unsync).toHaveBeenCalledWith({ projectDir: '/proj' })
    expect(order).toEqual(['unsync', 'revoke'])
  })

  it('still revokes when the on-disk unsync rejects (best-effort cleanup must not block revoke)', async () => {
    const revoke = vi.fn()
    await revokeOrchestration(
      '/proj',
      () => Promise.reject(new Error('locked config file')),
      revoke
    )
    expect(revoke).toHaveBeenCalledTimes(1)
  })
})
