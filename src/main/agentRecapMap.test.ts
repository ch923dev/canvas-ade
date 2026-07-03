import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  installRecapHook,
  removeRecapHook,
  isRecapHookInstalled,
  findNodeExecutable,
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
      source: 'startup',
      hook_event_name: 'SessionStart'
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
      source: 'startup',
      hookEvent: 'SessionStart',
      // F2: the eager SessionStart path — the transcript does not exist yet.
      transcriptExists: false
    })
    expect(typeof rec.ts).toBe('number')
  })

  it('F2: records transcriptExists:true once the transcript file is real (UserPromptSubmit shape)', () => {
    const map = join(dir, 'map.jsonl')
    const transcript = join(dir, 'sess-2.jsonl')
    writeFileSync(transcript, '{"sessionId":"sess-2"}\n')
    const stdin = JSON.stringify({
      session_id: 'sess-2',
      transcript_path: transcript,
      cwd: '/repo',
      hook_event_name: 'UserPromptSubmit'
    })
    execFileSync(process.execPath, ['src/main/hooks/recordSession.js', map], {
      input: stdin,
      env: { ...process.env, CANVAS_RECAP_BOARD: 'board-9' }
    })
    const rec = JSON.parse(readFileSync(map, 'utf8').trim())
    expect(rec).toMatchObject({
      sessionId: 'sess-2',
      hookEvent: 'UserPromptSubmit',
      transcriptExists: true
    })
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
    // Recap-refresh fix A4: the hook's `ts` now survives the parse (the eager-capture clock).
    expect(m.get('b1')).toEqual({ sessionId: 's2', transcriptPath: '/t/s2.jsonl', ts: 2 })
    expect(m.has('')).toBe(false)
  })
  it('returns an empty map when the file is absent', () => {
    expect(readRecapMap(join(dir, 'nope.jsonl')).size).toBe(0)
  })

  it('F2: keeps the latest CONFIRMED capture while the top-level fields stay the latest line', () => {
    const map = join(dir, 'map.jsonl')
    writeFileSync(
      map,
      [
        // real conversation confirmed at a prompt…
        JSON.stringify({
          boardId: 'b1',
          sessionId: 's1',
          transcriptPath: '/t/s1.jsonl',
          transcriptExists: true,
          ts: 1
        }),
        // …then a NEW session's eager SessionStart (no transcript yet)
        JSON.stringify({
          boardId: 'b1',
          sessionId: 's2',
          transcriptPath: '/t/s2.jsonl',
          transcriptExists: false,
          ts: 2
        })
      ].join('\n')
    )
    const m = readRecapMap(map)
    expect(m.get('b1')).toEqual({
      sessionId: 's2', // latest line — recap display freshness + the A4 eager-capture grace
      transcriptPath: '/t/s2.jsonl',
      ts: 2,
      confirmed: { sessionId: 's1', transcriptPath: '/t/s1.jsonl', ts: 1 } // resume-grade
    })
  })

  it('F2: an embedded confirmed object round-trips the consent-decline prune rewrite', () => {
    const map = join(dir, 'map.jsonl')
    const entry = {
      boardId: 'b1',
      sessionId: 's2',
      transcriptPath: '/t/s2.jsonl',
      ts: 2,
      confirmed: { sessionId: 's1', transcriptPath: '/t/s1.jsonl', ts: 1 }
    }
    // What index.ts's decline prune writes for a SURVIVING board: JSON.stringify({boardId, ...entry}).
    writeFileSync(map, JSON.stringify(entry) + '\n')
    const m = readRecapMap(map)
    expect(m.get('b1')?.confirmed).toEqual({
      sessionId: 's1',
      transcriptPath: '/t/s1.jsonl',
      ts: 1
    })
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
    command: '/usr/bin/node',
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

  it('F2: installs the SAME exec-form hook under all three events; remove clears all three', () => {
    installRecapHook(opts(dir))
    const settings = join(dir, '.claude', 'settings.local.json')
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    for (const event of ['SessionStart', 'UserPromptSubmit', 'SessionEnd']) {
      const entries = (cfg.hooks[event] ?? []).flatMap((b: { hooks: unknown[] }) => b.hooks)
      expect(
        entries.filter((h: { args?: string[] }) => h.args?.includes('/app/recordSession.js')),
        `event ${event}`
      ).toHaveLength(1)
    }
    removeRecapHook(dir, '/app/recordSession.js')
    const after = JSON.parse(readFileSync(settings, 'utf8'))
    expect(after.hooks).toBeUndefined()
  })

  it('F2: a pre-F2 settings file (SessionStart only) reads as NOT installed → re-ensure upgrades it', () => {
    const settings = join(dir, '.claude', 'settings.local.json')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: '/usr/bin/node',
                  args: ['/app/recordSession.js', '/u/map.jsonl']
                }
              ]
            }
          ]
        }
      })
    )
    expect(isRecapHookInstalled(dir, '/app/recordSession.js')).toBe(false)
    installRecapHook(opts(dir))
    expect(isRecapHookInstalled(dir, '/app/recordSession.js')).toBe(true)
    // The upgrade did not stack a second SessionStart entry.
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const ss = cfg.hooks.SessionStart.flatMap((b: { hooks: unknown[] }) => b.hooks)
    expect(
      ss.filter((h: { args?: string[] }) => h.args?.includes('/app/recordSession.js'))
    ).toHaveLength(1)
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
              hooks: [
                {
                  type: 'command',
                  command: '/usr/bin/node',
                  args: ['/app/recordSession.js', '/u/map.jsonl']
                }
              ]
            }
          ]
        }
      })
    )
    removeRecapHook(dir, '/app/recordSession.js')
    expect(isRecapHookInstalled(dir, '/app/recordSession.js')).toBe(false)
  })
})

describe('installRecapHook: exec-form hook + self-healing', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-exec-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a Claude EXEC-form hook (command + separate args, no shell, no env) — spaced paths cannot be mangled', () => {
    // Reproduces the failing-build shape: a runner exe AND paths with spaces. The fix keeps them
    // as separate argv elements, never folded into a `cmd.exe /c set …&& "exe"` shell string
    // whose embedded quotes cmd.exe mangles into `'"…\Expanse.exe"' is not recognized`.
    installRecapHook({
      projectDir: dir,
      command: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\App\\out\\main\\hooks\\recordSession.js',
      mapPath: 'C:\\Users\\a b\\recap\\session-map.jsonl'
    })
    const settings = join(dir, '.claude', 'settings.local.json')
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const hooks = cfg.hooks.SessionStart.flatMap((b: { hooks: unknown[] }) => b.hooks) as {
      type: string
      command: string
      args?: string[]
      env?: unknown
    }[]
    expect(hooks).toHaveLength(1)
    const h = hooks[0]
    expect(h.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(h.args).toEqual([
      'C:\\App\\out\\main\\hooks\\recordSession.js',
      'C:\\Users\\a b\\recap\\session-map.jsonl'
    ])
    // No shell wrapper, no (unsupported) env field.
    expect(h.command).not.toBe('cmd.exe')
    expect(h.command).not.toBe('/bin/sh')
    expect(h.env).toBeUndefined()
    expect(isRecapHookInstalled(dir, 'C:\\App\\out\\main\\hooks\\recordSession.js')).toBe(true)
  })

  it('self-heals: re-installing with a DIFFERENT runner/script path REPLACES the stale entry (no stacking)', () => {
    installRecapHook({
      projectDir: dir,
      command: '/old/node',
      scriptPath: '/old/build/out/main/hooks/recordSession.js',
      mapPath: '/u/map.jsonl'
    })
    installRecapHook({
      projectDir: dir,
      command: '/new/node',
      scriptPath: '/new/build/out/main/hooks/recordSession.js',
      mapPath: '/u/map.jsonl'
    })
    const settings = join(dir, '.claude', 'settings.local.json')
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const recap = cfg.hooks.SessionStart.flatMap(
      (b: { hooks: { command?: string; args?: string[] }[] }) => b.hooks
    ).filter((h: { args?: string[] }) => h.args?.some((a) => a.includes('recordSession.js')))
    expect(recap).toHaveLength(1)
    expect(recap[0].command).toBe('/new/node')
    expect(recap[0].args).toEqual(['/new/build/out/main/hooks/recordSession.js', '/u/map.jsonl'])
  })

  it('strips stale recap entries from prior builds while preserving unrelated hooks + sibling config', () => {
    const settings = join(dir, '.claude', 'settings.local.json')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      settings,
      JSON.stringify({
        enabledMcpjsonServers: ['canvas-ade'],
        hooks: {
          SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo', args: ['hi'] }] },
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: '/stale/node',
                  args: ['/stale/out/main/hooks/recordSession.js', '/u/map.jsonl']
                }
              ]
            }
          ]
        }
      })
    )
    installRecapHook({
      projectDir: dir,
      command: '/fresh/node',
      scriptPath: '/fresh/out/main/hooks/recordSession.js',
      mapPath: '/u/map.jsonl'
    })
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const all = cfg.hooks.SessionStart.flatMap(
      (b: { hooks: { command?: string; args?: string[] }[] }) => b.hooks
    )
    expect(all.some((h: { command?: string }) => h.command === 'echo')).toBe(true)
    const recap = all.filter((h: { args?: string[] }) =>
      h.args?.some((a: string) => a.includes('recordSession.js'))
    )
    expect(recap).toHaveLength(1)
    expect(recap[0].command).toBe('/fresh/node')
    expect(cfg.enabledMcpjsonServers).toEqual(['canvas-ade'])
  })

  it('does nothing when command is empty (no runner resolved)', () => {
    installRecapHook({
      projectDir: dir,
      command: '',
      scriptPath: '/a/recordSession.js',
      mapPath: '/u/map.jsonl'
    })
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false)
  })

  it('does NOT strip an unrelated hook whose path only CONTAINS recordSession.js as a substring', () => {
    // basename match, not substring: a user hook at `…/recordSession.js.bak` must survive self-heal.
    const settings = join(dir, '.claude', 'settings.local.json')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'node', args: ['/u/recordSession.js.bak', '/x'] }]
            }
          ]
        }
      })
    )
    installRecapHook({
      projectDir: dir,
      command: '/fresh/node',
      scriptPath: '/fresh/out/main/hooks/recordSession.js',
      mapPath: '/u/map.jsonl'
    })
    const cfg = JSON.parse(readFileSync(settings, 'utf8'))
    const all = cfg.hooks.SessionStart.flatMap((b: { hooks: { args?: string[] }[] }) => b.hooks)
    // the user's .bak hook survives untouched
    expect(all.some((h: { args?: string[] }) => h.args?.includes('/u/recordSession.js.bak'))).toBe(
      true
    )
    // ...and exactly one real recap hook (basename === recordSession.js) is present — ours
    const recap = all.filter((h: { args?: string[] }) =>
      h.args?.some((a: string) => a.split(/[\\/]/).pop() === 'recordSession.js')
    )
    expect(recap).toHaveLength(1)
  })
})

describe('findNodeExecutable', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recap-noderes-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when no node is on PATH, and the path once a node exe appears', () => {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    const orig = process.env.PATH
    try {
      process.env.PATH = dir
      expect(findNodeExecutable()).toBeNull()
      writeFileSync(join(dir, exe), '')
      expect(findNodeExecutable()).toBe(join(dir, exe))
    } finally {
      process.env.PATH = orig
    }
  })

  it('skips a DIRECTORY named like node (isFile guard, not existsSync)', () => {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    const orig = process.env.PATH
    try {
      mkdirSync(join(dir, exe)) // a directory, not a runnable file
      process.env.PATH = dir
      expect(findNodeExecutable()).toBeNull()
    } finally {
      process.env.PATH = orig
    }
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
