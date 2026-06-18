/**
 * Unit + integration tests for orchestrationConsent.ts (Agent Orchestration Onboarding P1).
 * Unit tier: readDecision/writeDecision pure file I/O + the bound seam accessors (no Electron).
 * Integration tier: registerOrchestrationHandlers via ipcTestHarness — exercises the
 * foreign-sender guard on both channels (same pattern as recapConsent.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readDecision,
  writeDecision,
  bindConsentStore,
  isEnabled,
  setEnabled,
  registerOrchestrationHandlers
} from './orchestrationConsent'
import { createIpcCapture, foreignEvent, internalEvent, mainWin } from './ipcTestHarness'

// ---------------------------------------------------------------------------
// Unit: pure store round-trips
// ---------------------------------------------------------------------------
describe('orchestrationConsent store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-consent-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined (undecided) when unknown', () => {
    expect(readDecision(dir, '/some/project')).toBeUndefined()
  })

  it('round-trips a per-project decision', () => {
    writeDecision(dir, '/proj/a', 'enabled')
    writeDecision(dir, '/proj/b', 'declined')
    expect(readDecision(dir, '/proj/a')).toBe('enabled')
    expect(readDecision(dir, '/proj/b')).toBe('declined')
    expect(readDecision(dir, '/proj/c')).toBeUndefined()
  })

  it('only persists valid decisions (ignores unknown values on disk)', () => {
    writeDecision(dir, '/proj/ok', 'enabled')
    // overwrite with a corrupted value mixed in — readAll filters it
    writeFileSync(
      join(dir, 'orchestration-consent.json'),
      JSON.stringify({ '/proj/ok': 'enabled', '/proj/bad': 'maybe' }),
      'utf8'
    )
    expect(readDecision(dir, '/proj/ok')).toBe('enabled')
    expect(readDecision(dir, '/proj/bad')).toBeUndefined()
  })

  it('stores orchestration consent in its OWN file, separate from recap consent', () => {
    writeDecision(dir, '/proj/a', 'enabled')
    expect(existsSync(join(dir, 'orchestration-consent.json'))).toBe(true)
    // A separate consent (decision 2026-06-19) — must not touch the recap store's file.
    expect(existsSync(join(dir, 'recap-consent.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit: the bound seam accessors (isEnabled / setEnabled)
// ---------------------------------------------------------------------------
describe('orchestrationConsent seam accessors', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-consent-seam-'))
    bindConsentStore(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('isEnabled is false for an undecided project', () => {
    expect(isEnabled('/proj/x')).toBe(false)
  })

  it('setEnabled(true) → isEnabled true; setEnabled(false) → isEnabled false', () => {
    setEnabled('/proj/x', true)
    expect(isEnabled('/proj/x')).toBe(true)
    expect(readDecision(dir, '/proj/x')).toBe('enabled')
    setEnabled('/proj/x', false)
    expect(isEnabled('/proj/x')).toBe(false)
    expect(readDecision(dir, '/proj/x')).toBe('declined')
  })

  it('isEnabled is project-scoped (one grant does not leak to another project)', () => {
    setEnabled('/proj/a', true)
    expect(isEnabled('/proj/a')).toBe(true)
    expect(isEnabled('/proj/b')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration: registerOrchestrationHandlers via fake ipcMain
// ---------------------------------------------------------------------------
describe('registerOrchestrationHandlers', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-consent-ipc-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function setup(projectDir: string | null = '/proj/test') {
    const cap = createIpcCapture()
    const changes: Array<{ path: string; on: boolean }> = []
    registerOrchestrationHandlers(
      cap.ipcMain,
      mainWin,
      dir,
      () => projectDir,
      (path, on) => changes.push({ path, on })
    )
    return { cap, changes }
  }

  it('getConsent returns "undecided" for a new project (internal call)', async () => {
    const { cap } = setup()
    expect(await cap.invoke('orchestration:getConsent')).toBe('undecided')
  })

  it('setConsent persists the decision and calls onChange (internal call)', async () => {
    const { cap, changes } = setup()
    const r = await cap.invoke('orchestration:setConsent', 'enabled')
    expect(r).toEqual({ ok: true })
    expect(changes).toEqual([{ path: '/proj/test', on: true }])
    expect(await cap.invoke('orchestration:getConsent')).toBe('enabled')
  })

  it('setConsent("declined") round-trips and fires onChange(false)', async () => {
    const { cap, changes } = setup()
    await cap.invoke('orchestration:setConsent', 'declined')
    expect(changes[0]).toEqual({ path: '/proj/test', on: false })
    expect(await cap.invoke('orchestration:getConsent')).toBe('declined')
  })

  it('setConsent rejects an invalid decision value', async () => {
    const { cap, changes } = setup()
    const r = await cap.invoke('orchestration:setConsent', 'maybe')
    expect(r).toEqual({ ok: false })
    expect(changes).toHaveLength(0)
  })

  it('getConsent returns "declined" when no project dir is open', async () => {
    const { cap } = setup(null)
    expect(await cap.invoke('orchestration:getConsent')).toBe('declined')
  })

  it('setConsent returns {ok:false} when no project dir is open', async () => {
    const { cap, changes } = setup(null)
    expect(await cap.invoke('orchestration:setConsent', 'enabled')).toEqual({ ok: false })
    expect(changes).toHaveLength(0)
  })

  // Foreign-sender guard
  it('getConsent returns "declined" for a foreign sender (guard blocks the real value)', async () => {
    const { cap } = setup()
    await cap.invoke('orchestration:setConsent', 'enabled')
    expect(await cap.invokeAs(foreignEvent, 'orchestration:getConsent')).toBe('declined')
  })

  it('setConsent returns {ok:false} for a foreign sender and does NOT persist', async () => {
    const { cap, changes } = setup()
    const r = await cap.invokeAs(foreignEvent, 'orchestration:setConsent', 'enabled')
    expect(r).toEqual({ ok: false })
    expect(changes).toHaveLength(0)
    expect(await cap.invoke('orchestration:getConsent')).toBe('undecided')
  })

  it('internal vs foreign behave differently on the same handlers', async () => {
    const { cap } = setup()
    expect(await cap.invokeAs(internalEvent, 'orchestration:setConsent', 'enabled')).toEqual({
      ok: true
    })
    expect(await cap.invokeAs(foreignEvent, 'orchestration:getConsent')).toBe('declined')
    expect(await cap.invokeAs(internalEvent, 'orchestration:getConsent')).toBe('enabled')
  })

  it('the seam getter sees a decision written via the IPC handler (shared store binding)', async () => {
    const { cap } = setup('/proj/seamcheck')
    await cap.invoke('orchestration:setConsent', 'enabled')
    // registerOrchestrationHandlers bound the store to `dir`, so the seam getter resolves it.
    expect(isEnabled('/proj/seamcheck')).toBe(true)
  })
})
