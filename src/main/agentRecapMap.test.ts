import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  installRecapHook,
  removeRecapHook,
  isRecapHookInstalled,
  readRecapMap,
  watchRecapMap,
  type RecapMapEntry
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

  it('prunes empty containers when our hook was the only one', () => {
    installRecapHook(opts(dir)) // creates hooks.SessionStart with just our entry
    removeRecapHook(dir, '/app/recordSession.js')
    const cfg = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))
    // No dangling `{ hooks: { SessionStart: [] } }` — both keys are pruned.
    expect(cfg.hooks).toBeUndefined()
  })
})

describe('removeRecapHook BUG-032: tolerates malformed settings.local.json', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-malformed-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not throw when SessionStart block has a non-array hooks field', () => {
    const settings = join(dir, '.claude', 'settings.local.json')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '', hooks: 'not-an-array' } // malformed: hooks is a string, not array
          ]
        }
      })
    )
    expect(() => removeRecapHook(dir, '/app/recordSession.js')).not.toThrow()
  })

  it('does not throw when SessionStart is not an array', () => {
    const settings = join(dir, '.claude', 'settings.local.json')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: 'not-an-array' // malformed: should be an array of blocks
        }
      })
    )
    expect(() => removeRecapHook(dir, '/app/recordSession.js')).not.toThrow()
  })

  it('still removes a valid hook when valid blocks coexist with malformed ones', () => {
    const settings = join(dir, '.claude', 'settings.local.json')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '', hooks: 'not-an-array' }, // malformed block
            {
              matcher: '',
              hooks: [{ type: 'command', command: '/usr/bin/node', args: ['/app/recordSession.js', '/u/map.jsonl'] }]
            }
          ]
        }
      })
    )
    removeRecapHook(dir, '/app/recordSession.js')
    expect(isRecapHookInstalled(dir, '/app/recordSession.js')).toBe(false)
  })
})

describe('installRecapHook BUG-003: env field', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-env-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes env into the hook command block when provided', () => {
    installRecapHook({
      projectDir: dir,
      nodePath: '/usr/bin/node',
      scriptPath: '/app/recordSession.js',
      mapPath: '/u/map.jsonl',
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    const settings = join(dir, '.claude', 'settings.local.json')
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const blocks = cfg.hooks.SessionStart
    const hook = blocks.flatMap((b: { hooks: unknown[] }) => b.hooks).find(
      (h: { args?: string[] }) => h.args?.includes('/app/recordSession.js')
    ) as { env?: Record<string, string> }
    expect(hook?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('omits env from the hook command block when not provided', () => {
    installRecapHook({
      projectDir: dir,
      nodePath: '/usr/bin/node',
      scriptPath: '/app/recordSession.js',
      mapPath: '/u/map.jsonl'
    })
    const settings = join(dir, '.claude', 'settings.local.json')
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const blocks = cfg.hooks.SessionStart
    const hook = blocks.flatMap((b: { hooks: unknown[] }) => b.hooks).find(
      (h: { args?: string[] }) => h.args?.includes('/app/recordSession.js')
    ) as { env?: Record<string, string> }
    expect(hook?.env).toBeUndefined()
  })
})

describe('watchRecapMap (first-session discovery)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-watch-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Regression: the watcher must fire when the map file is CREATED after it starts. The hook's
  // first appendFileSync creates the file lazily, so watching the (missing) file directly used to
  // silently miss the very first session after enabling recaps (no event until an app restart).
  it('fires onChange when the map file is created after the watcher arms', async () => {
    const map = join(dir, 'recap', 'session-map.jsonl') // parent dir does not exist yet
    let dispose: () => void = () => {}
    const seen = new Promise<Map<string, RecapMapEntry>>((resolve) => {
      dispose = watchRecapMap(
        map,
        (m) => {
          if (m.has('b1')) resolve(m)
        },
        20
      )
      // Create the file AFTER the watcher is armed — what recordSession.js does on first session.
      setTimeout(() => {
        writeFileSync(
          map,
          JSON.stringify({ boardId: 'b1', sessionId: 's1', transcriptPath: '/t/s1.jsonl' }) + '\n'
        )
      }, 50)
    })
    const m = await seen
    dispose()
    expect(m.get('b1')).toEqual({ sessionId: 's1', transcriptPath: '/t/s1.jsonl' })
  }, 6000)
})
