/**
 * Unit + integration tests for recapConsent.ts.
 * Unit tier: readConsent/writeConsent pure file I/O (no Electron).
 * Integration tier: registerRecapHandlers via ipcTestHarness — exercises the foreign-sender
 * guard on both channels (checklist #17/#20 pattern, same as llmIpc.integration.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConsent, writeConsent, registerRecapHandlers } from './recapConsent'
import { createIpcCapture, foreignEvent, internalEvent, mainWin } from './ipcTestHarness'

// ---------------------------------------------------------------------------
// Unit: pure store round-trips
// ---------------------------------------------------------------------------
describe('recapConsent', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-consent-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined (undecided) when unknown', () => {
    expect(readConsent(dir, '/some/project')).toBeUndefined()
  })

  it('round-trips a per-project decision', () => {
    writeConsent(dir, '/proj/a', 'enabled')
    writeConsent(dir, '/proj/b', 'declined')
    expect(readConsent(dir, '/proj/a')).toBe('enabled')
    expect(readConsent(dir, '/proj/b')).toBe('declined')
    expect(readConsent(dir, '/proj/c')).toBeUndefined()
  })

  it('only persists valid decisions (ignores unknown values on disk)', () => {
    // write a corrupted file directly, then confirm readConsent ignores bad values
    writeConsent(dir, '/proj/ok', 'enabled')
    // overwrite with a value that has an invalid decision mixed in — readAll filters it
    writeFileSync(
      join(dir, 'recap-consent.json'),
      JSON.stringify({ '/proj/ok': 'enabled', '/proj/bad': 'maybe' }),
      'utf8'
    )
    expect(readConsent(dir, '/proj/ok')).toBe('enabled')
    expect(readConsent(dir, '/proj/bad')).toBeUndefined()
  })

  // BUG-022: the SAME Windows project directory reopened via a differently-cased or
  // trailing-slashed path string must resolve to the SAME stored decision — getCurrentDir()
  // never normalizes what project:open/create was given, so the consent-store key must.
  it('BUG-022: a Windows-style path is looked up case-insensitively (case-insensitive filesystem)', () => {
    writeConsent(dir, 'C:\\Users\\x\\Proj', 'enabled')
    expect(readConsent(dir, 'c:\\users\\x\\proj')).toBe('enabled')
    expect(readConsent(dir, 'C:\\USERS\\X\\PROJ')).toBe('enabled')
  })

  it('BUG-022: a trailing separator does not create a distinct key', () => {
    writeConsent(dir, 'C:\\Users\\x\\Proj', 'declined')
    expect(readConsent(dir, 'C:\\Users\\x\\Proj\\')).toBe('declined')
  })

  it('BUG-022: POSIX-style paths stay case-SENSITIVE (no over-approving on a real POSIX fs)', () => {
    writeConsent(dir, '/Users/x/Proj', 'enabled')
    expect(readConsent(dir, '/users/x/proj')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Integration: registerRecapHandlers via fake ipcMain
// ---------------------------------------------------------------------------
describe('registerRecapHandlers', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-consent-ipc-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function setup(projectDir: string | null = '/proj/test') {
    const cap = createIpcCapture()
    const decisions: Array<{ path: string; decision: string }> = []
    registerRecapHandlers(
      cap.ipcMain,
      mainWin,
      dir,
      () => projectDir,
      (path, decision) => decisions.push({ path, decision })
    )
    return { cap, decisions }
  }

  it('getConsent returns "undecided" for a new project (internal call)', async () => {
    const { cap } = setup()
    const result = await cap.invoke('recap:getConsent')
    expect(result).toBe('undecided')
  })

  it('setConsent persists the decision and calls onDecision (internal call)', async () => {
    const { cap, decisions } = setup()
    const r = await cap.invoke('recap:setConsent', 'enabled')
    expect(r).toEqual({ ok: true })
    expect(decisions).toEqual([{ path: '/proj/test', decision: 'enabled' }])
    // Subsequent getConsent reflects the persisted decision
    expect(await cap.invoke('recap:getConsent')).toBe('enabled')
  })

  it('setConsent then getConsent round-trips "declined"', async () => {
    const { cap, decisions } = setup()
    await cap.invoke('recap:setConsent', 'declined')
    expect(decisions[0]).toEqual({ path: '/proj/test', decision: 'declined' })
    expect(await cap.invoke('recap:getConsent')).toBe('declined')
  })

  it('setConsent rejects an invalid decision value', async () => {
    const { cap, decisions } = setup()
    const r = await cap.invoke('recap:setConsent', 'maybe')
    expect(r).toEqual({ ok: false })
    expect(decisions).toHaveLength(0)
  })

  it('getConsent returns "declined" when no project dir is open', async () => {
    const { cap } = setup(null)
    expect(await cap.invoke('recap:getConsent')).toBe('declined')
  })

  it('setConsent returns {ok:false} when no project dir is open', async () => {
    const { cap, decisions } = setup(null)
    expect(await cap.invoke('recap:setConsent', 'enabled')).toEqual({ ok: false })
    expect(decisions).toHaveLength(0)
  })

  // Foreign-sender guard (checklist #17/#20)
  it('getConsent returns "declined" for a foreign sender (guard blocks)', async () => {
    const { cap } = setup()
    // First persist a real decision so we can prove the guard returns 'declined' not 'undecided'
    await cap.invoke('recap:setConsent', 'enabled')
    // Foreign sender must see 'declined', NOT the real persisted value
    const r = await cap.invokeAs(foreignEvent, 'recap:getConsent')
    expect(r).toBe('declined')
  })

  it('setConsent returns {ok:false} for a foreign sender and does NOT persist', async () => {
    const { cap, decisions } = setup()
    const r = await cap.invokeAs(foreignEvent, 'recap:setConsent', 'enabled')
    expect(r).toEqual({ ok: false })
    expect(decisions).toHaveLength(0)
    // The real getConsent still sees 'undecided' — nothing was written
    expect(await cap.invoke('recap:getConsent')).toBe('undecided')
  })

  it('internal vs foreign behave differently on the same handlers', async () => {
    const { cap } = setup()
    // Internal write succeeds
    expect(await cap.invokeAs(internalEvent, 'recap:setConsent', 'enabled')).toEqual({ ok: true })
    // Foreign read is denied
    expect(await cap.invokeAs(foreignEvent, 'recap:getConsent')).toBe('declined')
    // Internal read returns the real value
    expect(await cap.invokeAs(internalEvent, 'recap:getConsent')).toBe('enabled')
  })

  // FIND-012: a throw from onDecision (e.g. installRecapHook fails writing settings.local.json)
  // must NOT leave consent persisted out of sync with the hook. The write is rolled back to its
  // prior state and the handler reports {ok:false}, so the stored decision matches reality.
  it('rolls consent back to its prior state when onDecision throws (returns {ok:false})', async () => {
    const cap = createIpcCapture()
    let shouldThrow = false
    registerRecapHandlers(
      cap.ipcMain,
      mainWin,
      dir,
      () => '/proj/test',
      () => {
        if (shouldThrow) throw new Error('installRecapHook failed')
      }
    )

    // undecided → enable whose hook install THROWS → rolled back to undecided (not 'enabled').
    shouldThrow = true
    expect(await cap.invoke('recap:setConsent', 'enabled')).toEqual({ ok: false })
    expect(await cap.invoke('recap:getConsent')).toBe('undecided')

    // Establish a real 'enabled' state, then a failing 'declined' rolls back to 'enabled'
    // (the prior value) — never silently to undecided.
    shouldThrow = false
    expect(await cap.invoke('recap:setConsent', 'enabled')).toEqual({ ok: true })
    shouldThrow = true
    expect(await cap.invoke('recap:setConsent', 'declined')).toEqual({ ok: false })
    expect(await cap.invoke('recap:getConsent')).toBe('enabled')
  })
})
