import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  installRecapHook,
  removeRecapHook,
  isRecapHookInstalled,
  readRecapMap
} from './agentRecapMap'

describe('recordSession.js hook script', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-hook-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends a mapping line from stdin + env + argv', () => {
    const map = join(dir, 'map.jsonl')
    const stdin = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/h/.claude/projects/p/sess-1.jsonl',
      cwd: '/repo',
      source: 'startup'
    })
    execFileSync(process.execPath, ['src/main/hooks/recordSession.js', map], {
      input: stdin,
      env: { ...process.env, CANVAS_RECAP_BOARD: 'board-9' }
    })
    expect(existsSync(map)).toBe(true)
    const rec = JSON.parse(readFileSync(map, 'utf8').trim())
    expect(rec).toMatchObject({
      boardId: 'board-9',
      sessionId: 'sess-1',
      transcriptPath: '/h/.claude/projects/p/sess-1.jsonl',
      cwd: '/repo',
      source: 'startup'
    })
    expect(typeof rec.ts).toBe('number')
  })
})

describe('readRecapMap', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-map-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the LATEST entry per board, ignoring blank/malformed lines', () => {
    const map = join(dir, 'map.jsonl')
    writeFileSync(
      map,
      [
        JSON.stringify({ boardId: 'b1', sessionId: 's1', transcriptPath: '/t/s1.jsonl', ts: 1 }),
        'garbage',
        JSON.stringify({ boardId: 'b1', sessionId: 's2', transcriptPath: '/t/s2.jsonl', ts: 2 }),
        JSON.stringify({ boardId: '', sessionId: 'x', transcriptPath: '/t/x.jsonl', ts: 3 }),
        ''
      ].join('\n')
    )
    const m = readRecapMap(map)
    expect(m.get('b1')).toEqual({ sessionId: 's2', transcriptPath: '/t/s2.jsonl' })
    expect(m.has('')).toBe(false)
  })
  it('returns an empty map when the file is absent', () => {
    expect(readRecapMap(join(dir, 'nope.jsonl')).size).toBe(0)
  })
})

describe('recap hook install/merge', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-install-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const opts = (d: string) => ({
    projectDir: d,
    nodePath: '/usr/bin/node',
    scriptPath: '/app/recordSession.js',
    mapPath: '/u/map.jsonl'
  })

  it('installs idempotently + preserves a pre-existing unrelated hook', () => {
    const settings = join(dir, '.claude', 'settings.local.json')
    // pre-existing user hook
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo', args: ['hi'] }] }
          ]
        }
      })
    )
    installRecapHook(opts(dir))
    installRecapHook(opts(dir)) // idempotent
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const entries = cfg.hooks.SessionStart.flatMap((b: { hooks: unknown[] }) => b.hooks)
    expect(
      entries.filter((h: { args?: string[] }) => h.args?.includes('/app/recordSession.js'))
    ).toHaveLength(1)
    expect(entries.some((h: { command?: string }) => h.command === 'echo')).toBe(true)
    expect(isRecapHookInstalled(dir, '/app/recordSession.js')).toBe(true)
  })

  it('removes only our hook entry', () => {
    installRecapHook(opts(dir))
    removeRecapHook(dir, '/app/recordSession.js')
    expect(isRecapHookInstalled(dir, '/app/recordSession.js')).toBe(false)
  })
})
