/**
 * Unit + integration tests for orchestrationConfig.ts (configurable MCP spawn cap).
 * Unit tier: read/write/clamp pure file I/O (no Electron) + the DEFAULT_SPAWN_CAP lock-step.
 * Integration tier: registerSpawnCapHandlers via ipcTestHarness — exercises the foreign-sender
 * guard + arg validation on both channels (same pattern as orchestrationConsent.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readOrchestrationConfig,
  writeOrchestrationConfig,
  clampSpawnCap,
  registerSpawnCapHandlers,
  DEFAULT_SPAWN_CAP,
  MIN_SPAWN_CAP,
  MAX_SPAWN_CAP
} from './orchestrationConfig'
import { MCP_SPAWN_CAP } from './mcpRegistry'
import { createIpcCapture, foreignEvent, internalEvent, mainWin } from './ipcTestHarness'

// ---------------------------------------------------------------------------
// Lock-step: the config default mirrors the MAIN enforcement default
// ---------------------------------------------------------------------------
describe('orchestrationConfig defaults', () => {
  it('DEFAULT_SPAWN_CAP equals MCP_SPAWN_CAP (no drift from the enforcement default)', () => {
    expect(DEFAULT_SPAWN_CAP).toBe(MCP_SPAWN_CAP)
  })
  it('the default sits within the configurable range', () => {
    expect(DEFAULT_SPAWN_CAP).toBeGreaterThanOrEqual(MIN_SPAWN_CAP)
    expect(DEFAULT_SPAWN_CAP).toBeLessThanOrEqual(MAX_SPAWN_CAP)
  })
})

// ---------------------------------------------------------------------------
// Unit: clampSpawnCap
// ---------------------------------------------------------------------------
describe('clampSpawnCap', () => {
  it('passes a valid in-range integer through', () => {
    expect(clampSpawnCap(1)).toBe(1)
    expect(clampSpawnCap(8)).toBe(8)
    expect(clampSpawnCap(16)).toBe(16)
  })
  it('clamps below MIN and above MAX', () => {
    expect(clampSpawnCap(0)).toBe(MIN_SPAWN_CAP)
    expect(clampSpawnCap(-5)).toBe(MIN_SPAWN_CAP)
    expect(clampSpawnCap(999)).toBe(MAX_SPAWN_CAP)
  })
  it('floors a fractional value', () => {
    expect(clampSpawnCap(4.9)).toBe(4)
  })
  it('repairs a non-number / non-finite value to the default', () => {
    expect(clampSpawnCap(NaN)).toBe(DEFAULT_SPAWN_CAP)
    expect(clampSpawnCap(Infinity)).toBe(DEFAULT_SPAWN_CAP)
    expect(clampSpawnCap('8' as unknown)).toBe(DEFAULT_SPAWN_CAP)
    expect(clampSpawnCap(undefined)).toBe(DEFAULT_SPAWN_CAP)
    expect(clampSpawnCap(null)).toBe(DEFAULT_SPAWN_CAP)
  })
})

// ---------------------------------------------------------------------------
// Unit: read/write round-trip + disk repair
// ---------------------------------------------------------------------------
describe('orchestrationConfig file I/O', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-config-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the default cap when no file exists', () => {
    expect(readOrchestrationConfig(dir).spawnCap).toBe(DEFAULT_SPAWN_CAP)
  })

  it('round-trips a written cap', () => {
    writeOrchestrationConfig(dir, { spawnCap: 8 })
    expect(readOrchestrationConfig(dir).spawnCap).toBe(8)
  })

  it('clamps an out-of-range cap on write', () => {
    writeOrchestrationConfig(dir, { spawnCap: 999 })
    expect(readOrchestrationConfig(dir).spawnCap).toBe(MAX_SPAWN_CAP)
    writeOrchestrationConfig(dir, { spawnCap: 0 })
    expect(readOrchestrationConfig(dir).spawnCap).toBe(MIN_SPAWN_CAP)
  })

  it('repairs a poisoned/garbage cap read from disk to the default', () => {
    writeFileSync(
      join(dir, 'orchestration-config.json'),
      JSON.stringify({ spawnCap: 'lots' }),
      'utf8'
    )
    expect(readOrchestrationConfig(dir).spawnCap).toBe(DEFAULT_SPAWN_CAP)
    writeFileSync(join(dir, 'orchestration-config.json'), '{ not json', 'utf8')
    expect(readOrchestrationConfig(dir).spawnCap).toBe(DEFAULT_SPAWN_CAP)
  })

  it('writes orchestration-config.json into the given userData dir, never elsewhere', () => {
    writeOrchestrationConfig(dir, { spawnCap: 6 })
    expect(existsSync(join(dir, 'orchestration-config.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'orchestration-config.json'), 'utf8'))).toEqual({
      spawnCap: 6
    })
  })
})

// ---------------------------------------------------------------------------
// Integration: registerSpawnCapHandlers via fake ipcMain
// ---------------------------------------------------------------------------
describe('registerSpawnCapHandlers', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-config-ipc-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function setup() {
    const cap = createIpcCapture()
    registerSpawnCapHandlers(cap.ipcMain, mainWin, dir)
    return cap
  }

  it('getSpawnCap returns the default for a fresh dir (internal call)', async () => {
    const cap = setup()
    expect(await cap.invoke('orchestration:getSpawnCap')).toBe(DEFAULT_SPAWN_CAP)
  })

  it('setSpawnCap persists and getSpawnCap reads it back (internal call)', async () => {
    const cap = setup()
    expect(await cap.invoke('orchestration:setSpawnCap', 8)).toEqual({ ok: true })
    expect(await cap.invoke('orchestration:getSpawnCap')).toBe(8)
  })

  it('setSpawnCap rejects a non-integer / out-of-range / non-number arg (and does NOT persist)', async () => {
    const cap = setup()
    expect(await cap.invoke('orchestration:setSpawnCap', 4.5)).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await cap.invoke('orchestration:setSpawnCap', 0)).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await cap.invoke('orchestration:setSpawnCap', 17)).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await cap.invoke('orchestration:setSpawnCap', 'eight')).toEqual({
      ok: false,
      reason: 'invalid'
    })
    // none of the rejected writes touched disk → still the default
    expect(await cap.invoke('orchestration:getSpawnCap')).toBe(DEFAULT_SPAWN_CAP)
  })

  it('getSpawnCap returns the default for a foreign sender (guard hides the real value)', async () => {
    const cap = setup()
    await cap.invoke('orchestration:setSpawnCap', 12)
    expect(await cap.invokeAs(foreignEvent, 'orchestration:getSpawnCap')).toBe(DEFAULT_SPAWN_CAP)
    // the real value is still readable internally
    expect(await cap.invokeAs(internalEvent, 'orchestration:getSpawnCap')).toBe(12)
  })

  it('setSpawnCap returns {ok:false} for a foreign sender and does NOT persist', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'orchestration:setSpawnCap', 12)).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(await cap.invoke('orchestration:getSpawnCap')).toBe(DEFAULT_SPAWN_CAP)
  })
})
