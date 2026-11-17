/**
 * WS-8 (O-5) — the Claude workspace rules: path form, rule set, merge/strip that never touches the
 * user's own entries, and the ledger that makes revoke remove exactly what Expanse added.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetClaudeRulesLedger,
  bindClaudeRulesLedger,
  buildWorkspaceRules,
  claudeAbsPath,
  mergeRules,
  ownedRulesFor,
  setOwnedRules,
  stripRules
} from './claudeRules'

afterEach(() => __resetClaudeRulesLedger())

describe('claudeAbsPath', () => {
  it('writes Windows drive paths in the //<drive>/ form (spike-proven), lowercasing the drive', () => {
    expect(claudeAbsPath('M:\\expanse\\api')).toBe('//m/expanse/api')
    expect(claudeAbsPath('C:/Users/De Asis PC/proj/')).toBe('//c/Users/De Asis PC/proj')
  })
  it('writes POSIX paths as //abs', () => {
    expect(claudeAbsPath('/home/u/proj/api')).toBe('//home/u/proj/api')
  })
  it('refuses what it cannot express safely: UNC, relative, glob metacharacters', () => {
    expect(claudeAbsPath('\\\\server\\share\\x')).toBeNull()
    expect(claudeAbsPath('relative/dir')).toBeNull()
    expect(claudeAbsPath('M:\\odd[name]')).toBeNull()
    expect(claudeAbsPath('/a/b*')).toBeNull()
  })
})

describe('buildWorkspaceRules', () => {
  const base = {
    projectDir: 'M:\\proj',
    ownRoot: 'M:\\proj\\.canvas\\worktrees\\ws-api',
    otherRoots: ['M:\\proj\\uploader', 'M:\\proj'],
    worktreeDirs: [
      'M:\\proj\\.canvas\\worktrees\\ws-api',
      'M:\\proj\\.canvas\\worktrees\\builder-1',
      'M:\\proj\\uploader'
    ]
  }
  it('denies other roots + sibling worktrees + the canvas doc + the context files, skipping self and ancestors', () => {
    expect(buildWorkspaceRules({ ...base, platform: 'win32' })).toEqual({
      deny: [
        'Edit(//m/proj/uploader/**)',
        'Edit(//m/proj/.canvas/worktrees/builder-1/**)',
        'Edit(//m/proj/.canvas/canvas.json)',
        'Edit(//m/proj/.canvas/workspaces/**)'
      ],
      sandbox: false
    })
  })
  it('sets sandbox only on macOS / Linux (WSL2 runs the Linux build)', () => {
    expect(buildWorkspaceRules({ ...base, platform: 'darwin' }).sandbox).toBe(true)
    expect(buildWorkspaceRules({ ...base, platform: 'linux' }).sandbox).toBe(true)
    expect(buildWorkspaceRules({ ...base, platform: 'win32' }).sandbox).toBe(false)
  })
})

describe('mergeRules / stripRules', () => {
  const desired = { deny: ['Edit(//m/p/b/**)', 'Edit(//m/p/.canvas/canvas.json)'], sandbox: true }

  it('adds ours after the user’s entries and keeps the user’s strings + order byte-identical', () => {
    const user = {
      permissions: { allow: ['Bash(ls)'], deny: ['Read(./.env)', 'Edit(./secrets/**)'] },
      model: 'opus'
    }
    const r = mergeRules(structuredClone(user), desired, undefined)
    expect(r.settings).toEqual({
      permissions: {
        allow: ['Bash(ls)'],
        deny: ['Read(./.env)', 'Edit(./secrets/**)', ...desired.deny]
      },
      model: 'opus',
      sandbox: { enabled: true }
    })
    expect(r.owned).toEqual({ deny: desired.deny, sandbox: true })
    // Revoke: exactly the user's file comes back.
    expect(stripRules(r.settings, r.owned).settings).toEqual(user)
  })

  it('a rule the user already had stays THEIRS — revoke leaves it', () => {
    const user = { permissions: { deny: ['Edit(//m/p/b/**)'] } }
    const r = mergeRules(structuredClone(user), desired, undefined)
    expect(r.owned.deny).toEqual(['Edit(//m/p/.canvas/canvas.json)'])
    expect(stripRules(r.settings, r.owned).settings).toEqual(user)
  })

  it('an explicit user sandbox setting wins (false stays false, never recorded as ours)', () => {
    const r = mergeRules({ sandbox: { enabled: false } }, desired, undefined)
    expect(r.settings.sandbox).toEqual({ enabled: false })
    expect(r.owned.sandbox).toBe(false)
  })

  it('re-provisioning the same rules is a no-op; a changed layout swaps only our entries', () => {
    const first = mergeRules({}, desired, undefined)
    const again = mergeRules(structuredClone(first.settings), desired, first.owned)
    expect(again.changed).toBe(false)
    expect(again.settings).toEqual(first.settings)
    const moved = mergeRules(
      structuredClone(first.settings),
      { deny: ['Edit(//m/p/c/**)'], sandbox: true },
      first.owned
    )
    expect((moved.settings.permissions as { deny: string[] }).deny).toEqual(['Edit(//m/p/c/**)'])
  })

  it('leaving the workspace (empty desired) removes ours and the containers WE emptied only', () => {
    const first = mergeRules({}, desired, undefined)
    const r = mergeRules(first.settings, { deny: [], sandbox: false }, first.owned)
    expect(r.settings).toEqual({})
    // …but a user's own empty containers stay as they are.
    const keep = mergeRules(
      { permissions: { deny: [] }, sandbox: {} },
      { deny: [], sandbox: false },
      undefined
    )
    expect(keep.settings).toEqual({ permissions: { deny: [] }, sandbox: {} })
    expect(keep.changed).toBe(false)
  })

  it('an unexpected shape is left untouched', () => {
    const r = mergeRules({ permissions: 'weird', sandbox: true }, desired, undefined)
    expect(r.settings).toEqual({ permissions: 'weird', sandbox: true })
    expect(r.owned).toEqual({ deny: [], sandbox: false })
  })
})

describe('the ledger', () => {
  it('persists what Expanse owns per dir and reloads it in a later session', () => {
    const userData = mkdtempSync(join(tmpdir(), 'rules-ledger-'))
    try {
      bindClaudeRulesLedger(userData)
      setOwnedRules('M:\\p\\a', { deny: ['Edit(//m/p/b/**)'], sandbox: false })
      expect(
        JSON.parse(readFileSync(join(userData, 'provisioned-claude-rules.json'), 'utf8'))
      ).toEqual({ 'M:\\p\\a': { deny: ['Edit(//m/p/b/**)'], sandbox: false } })
      __resetClaudeRulesLedger()
      expect(ownedRulesFor('M:\\p\\a')).toBeUndefined()
      bindClaudeRulesLedger(userData) // a new session
      expect(ownedRulesFor('M:\\p\\a')).toEqual({ deny: ['Edit(//m/p/b/**)'], sandbox: false })
      setOwnedRules('M:\\p\\a', { deny: [], sandbox: false }) // nothing owned → forgotten
      expect(
        JSON.parse(readFileSync(join(userData, 'provisioned-claude-rules.json'), 'utf8'))
      ).toEqual({})
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
