/**
 * PTY-host pure-core units (DESIGN.md PR 1): wire protocol codec + handshake gate, the daemon
 * ring's line-boundary replay trim, discovery-state repair, the rollout gate matrix, and the
 * runtime-stage plan/copy/sweep. Everything here imports ONLY electron-free modules (protocol/
 * ring/state/config/runtimeStage) — client.ts and daemonMain.ts are exercised by the live
 * protocol smoke + the @terminal e2e, not unit-imported (electron / Electron-ABI node-pty).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PROTOCOL_VERSION,
  createLineDecoder,
  encodeLine,
  verifyHello,
  type DaemonMsg
} from './protocol'
import { daemonRingReplay, pushDaemonRing, type DaemonRing } from './ring'
import { quitDrainCore } from './quitDrain'
import { pipeNameFor, repairState } from './state'
import { ptyHostEnabled, readPtyHostConfig, repairPtyHostConfig } from './config'
import { decideOnClose, normalizeCloseAnswer, type CloseDecisionInput } from './closeGuardCore'
import { buildTrayMenuModel, exitedIds, seedModelFromRows } from './trayResidencyCore'
import { formatSessionAge, type CloseSessionRow } from '../../shared/closeGuardTypes'
import type { SessionInfo } from './protocol'
import {
  DAEMON_JS,
  RUNTIME_FILES,
  STAGED_EXE,
  ensureStaged,
  planStage,
  sweepOldStages,
  wantNodePtyFile,
  type StageSources
} from './runtimeStage'

describe('protocol codec', () => {
  it('round-trips a message whose payload contains newlines and escapes', () => {
    const msg: DaemonMsg = {
      ev: 'output',
      id: 'b1',
      data: 'line1\r\nline2 "quoted" \\slash\x1b[0m'
    }
    const seen: DaemonMsg[] = []
    const feed = createLineDecoder<DaemonMsg>((m) => seen.push(m))
    feed(encodeLine(msg))
    expect(seen).toEqual([msg])
  })

  it('reassembles messages split across chunks and splits multiple per chunk', () => {
    const a = encodeLine({ ev: 'exit', id: 'x', code: 0 })
    const b = encodeLine({ ev: 'killed', id: 'y' })
    const seen: DaemonMsg[] = []
    const feed = createLineDecoder<DaemonMsg>((m) => seen.push(m))
    const joined = a + b
    feed(joined.slice(0, 5))
    feed(joined.slice(5, a.length + 3))
    feed(joined.slice(a.length + 3))
    expect(seen.map((m) => m.ev)).toEqual(['exit', 'killed'])
  })

  it('routes a malformed line to onBadLine instead of throwing', () => {
    const bad: string[] = []
    const seen: unknown[] = []
    const feed = createLineDecoder(
      (m) => seen.push(m),
      (l) => bad.push(l)
    )
    feed('{not json}\n{"ev":"killed","id":"z"}\n')
    expect(bad).toEqual(['{not json}'])
    expect(seen).toHaveLength(1)
  })
})

describe('verifyHello (token + version gate)', () => {
  const T = 't'.repeat(64)
  it('accepts the exact token at the exact protocol version', () => {
    expect(verifyHello({ op: 'hello', token: T, version: PROTOCOL_VERSION }, T)).toBe('ok')
  })
  it('rejects a wrong or missing token', () => {
    expect(verifyHello({ op: 'hello', token: 'nope', version: PROTOCOL_VERSION }, T)).toBe(
      'bad-token'
    )
    expect(verifyHello({ op: 'hello', version: PROTOCOL_VERSION }, T)).toBe('bad-token')
  })
  it('rejects a version mismatch and non-hello first lines', () => {
    expect(verifyHello({ op: 'hello', token: T, version: 999 }, T)).toBe('version-mismatch')
    expect(verifyHello({ op: 'spawn', token: T, version: PROTOCOL_VERSION }, T)).toBe('not-hello')
    expect(verifyHello(null, T)).toBe('not-hello')
  })
})

describe('daemon ring (line-boundary replay trim)', () => {
  const CAP = 32
  it('replays verbatim while under the cap', () => {
    const r: DaemonRing = { chunks: [], len: 0 }
    pushDaemonRing(r, 'abc\n', CAP)
    pushDaemonRing(r, 'def', CAP)
    expect(daemonRingReplay(r, CAP)).toBe('abc\ndef')
  })
  it('trims whole chunks from the head once over the cap', () => {
    const r: DaemonRing = { chunks: [], len: 0 }
    pushDaemonRing(r, 'x'.repeat(20) + '\n', CAP)
    pushDaemonRing(r, 'y'.repeat(20) + '\n', CAP)
    expect(r.len).toBeLessThanOrEqual(CAP)
    expect(r.chunks.join('')).not.toContain('x')
  })
  it('starts a wrapped replay after the first newline (no mid-escape head)', () => {
    const r: DaemonRing = { chunks: [], len: 0 }
    pushDaemonRing(r, 'partial-esc', CAP)
    pushDaemonRing(r, 'seq\nCLEAN-LINE-AFTER-WRAP', CAP)
    // force the wrapped state: len == cap after a single-chunk trim
    pushDaemonRing(r, 'z'.repeat(CAP), CAP)
    const replay = daemonRingReplay(r, CAP)
    expect(replay.length).toBeLessThanOrEqual(CAP)
    expect(replay).toBe('z'.repeat(CAP)) // one giant line — replayed as-is, not dropped
  })
  it('wrapped multi-line replay drops the torn first line', () => {
    const r: DaemonRing = { chunks: [], len: 0 }
    pushDaemonRing(r, 'A'.repeat(30) + '\n' + 'B'.repeat(10) + '\n' + 'C'.repeat(10), 40)
    const replay = daemonRingReplay(r, 40)
    expect(replay.startsWith('B')).toBe(true)
    expect(replay).toContain('C'.repeat(10))
  })
})

describe('discovery state', () => {
  it('derives a per-profile pipe name that changes with dir and suffix', () => {
    const a = pipeNameFor('C:\\ud\\one', 'aaaa')
    expect(a).toMatch(/^\\\\\.\\pipe\\expanse-ptyhost-[0-9a-f]{12}-aaaa$/)
    expect(pipeNameFor('C:\\ud\\one', 'aaaa')).toBe(a)
    expect(pipeNameFor('C:\\ud\\two', 'aaaa')).not.toBe(a)
    expect(pipeNameFor('C:\\ud\\one', 'bbbb')).not.toBe(a)
  })
  it('round-trips a valid state file and rejects every malformed shape', () => {
    const good = {
      pipe: pipeNameFor('C:\\ud', 'abc123'),
      token: 'f'.repeat(64),
      daemonPid: 4242,
      protocolVersion: PROTOCOL_VERSION
    }
    expect(repairState(good)).toEqual(good)
    expect(repairState(null)).toBeNull()
    expect(repairState({ ...good, pipe: '\\\\.\\pipe\\other-app-x' })).toBeNull()
    expect(repairState({ ...good, token: 'short' })).toBeNull()
    expect(repairState({ ...good, protocolVersion: PROTOCOL_VERSION + 1 })).toBeNull()
    expect(repairState({ ...good, daemonPid: 'x' })).toBeNull()
  })
})

describe('rollout gate (config × platform × env)', () => {
  const DEFAULTS = { surviveRestart: true, onCloseWithSessions: 'ask', notifyBackgroundExit: true }
  it('repairs any malformed config to the defaults, field by field', () => {
    expect(repairPtyHostConfig(null)).toEqual(DEFAULTS)
    expect(repairPtyHostConfig({ surviveRestart: 'yes' })).toEqual(DEFAULTS)
    expect(repairPtyHostConfig({ surviveRestart: false })).toEqual({
      ...DEFAULTS,
      surviveRestart: false
    })
    // PR-2 fields: valid values survive; garbage repairs per-field without touching siblings.
    expect(
      repairPtyHostConfig({ onCloseWithSessions: 'keep', notifyBackgroundExit: false })
    ).toEqual({ surviveRestart: true, onCloseWithSessions: 'keep', notifyBackgroundExit: false })
    expect(repairPtyHostConfig({ onCloseWithSessions: 'stop' }).onCloseWithSessions).toBe('stop')
    expect(repairPtyHostConfig({ onCloseWithSessions: 'maybe' }).onCloseWithSessions).toBe('ask')
    expect(repairPtyHostConfig({ notifyBackgroundExit: 'no' }).notifyBackgroundExit).toBe(true)
  })
  it('reads a missing/corrupt file as the default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhost-cfg-'))
    expect(readPtyHostConfig(dir)).toEqual(DEFAULTS)
    fs.writeFileSync(path.join(dir, 'ptyhost-config.json'), '{corrupt')
    expect(readPtyHostConfig(dir)).toEqual(DEFAULTS)
  })
  it('gates on platform, env override, then the setting', () => {
    const on = repairPtyHostConfig({ surviveRestart: true })
    const off = repairPtyHostConfig({ surviveRestart: false })
    expect(ptyHostEnabled(on, 'linux', {})).toBe(false)
    expect(ptyHostEnabled(on, 'darwin', {})).toBe(false)
    expect(ptyHostEnabled(on, 'win32', {})).toBe(true)
    expect(ptyHostEnabled(off, 'win32', {})).toBe(false)
    expect(ptyHostEnabled(on, 'win32', { CANVAS_PTYHOST: '0' })).toBe(false)
    expect(ptyHostEnabled(off, 'win32', { CANVAS_PTYHOST: '1' })).toBe(true)
  })
})

describe('runtime stage', () => {
  it('subsets node-pty to runtime files only', () => {
    expect(wantNodePtyFile('package.json')).toBe(true)
    expect(wantNodePtyFile('lib/index.js')).toBe(true)
    expect(wantNodePtyFile('lib/windowsPtyAgent.js')).toBe(true)
    expect(wantNodePtyFile('build/Release/conpty.node')).toBe(true)
    expect(wantNodePtyFile('build\\Release\\conpty_console_list.node')).toBe(true)
    expect(wantNodePtyFile('build/Release/conpty.pdb')).toBe(false)
    expect(wantNodePtyFile('build/Release/obj/conpty/x.node')).toBe(false)
    expect(wantNodePtyFile('src/win/conpty.cc')).toBe(false)
    expect(wantNodePtyFile('typings/node-pty.d.ts')).toBe(false)
  })

  function makeFixture(): { src: StageSources; root: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhost-stage-'))
    const runtimeDir = path.join(root, 'dist')
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(path.join(runtimeDir, 'app.exe'), 'EXE')
    for (const f of RUNTIME_FILES) fs.writeFileSync(path.join(runtimeDir, f), f)
    const daemonJs = path.join(root, 'out', 'ptyHostDaemon.js')
    fs.mkdirSync(path.dirname(daemonJs), { recursive: true })
    fs.writeFileSync(daemonJs, '// daemon')
    const nodePtyDir = path.join(root, 'node-pty')
    fs.mkdirSync(path.join(nodePtyDir, 'lib'), { recursive: true })
    fs.mkdirSync(path.join(nodePtyDir, 'build', 'Release', 'obj'), { recursive: true })
    fs.writeFileSync(path.join(nodePtyDir, 'package.json'), '{}')
    fs.writeFileSync(path.join(nodePtyDir, 'lib', 'index.js'), '//')
    fs.writeFileSync(path.join(nodePtyDir, 'build', 'Release', 'conpty.node'), 'N')
    fs.writeFileSync(path.join(nodePtyDir, 'build', 'Release', 'conpty.pdb'), 'P')
    fs.writeFileSync(path.join(nodePtyDir, 'build', 'Release', 'obj', 'junk.node'), 'J')
    return { src: { runtimeDir, exeName: 'app.exe', daemonJs, nodePtyDir }, root }
  }

  it('plans the 4-file runtime + daemon script + node-pty subset', () => {
    const { src, root } = makeFixture()
    const stageDir = path.join(root, 'stage', '1.0.0')
    const plan = planStage(src, stageDir)
    const dests = plan.map((s) => path.relative(stageDir, s.to).replace(/\\/g, '/'))
    expect(dests).toContain(STAGED_EXE)
    for (const f of RUNTIME_FILES) expect(dests).toContain(f)
    expect(dests).toContain(DAEMON_JS)
    expect(dests).toContain('node_modules/node-pty/build/Release/conpty.node')
    expect(dests.some((d) => d.endsWith('.pdb'))).toBe(false)
    expect(dests.some((d) => d.includes('/obj/'))).toBe(false)
  })

  it('stages once, skips when the marker exists, and sweeps old versions', () => {
    const { src, root } = makeFixture()
    const stageRoot = path.join(root, 'stage')
    const entry = ensureStaged(src, path.join(stageRoot, '2.0.0'))
    expect(fs.existsSync(entry.exe)).toBe(true)
    expect(fs.existsSync(entry.script)).toBe(true)
    // mutate the source; a second ensureStaged must NOT re-copy (marker present)
    fs.writeFileSync(path.join(src.runtimeDir, 'app.exe'), 'CHANGED')
    ensureStaged(src, path.join(stageRoot, '2.0.0'))
    expect(fs.readFileSync(entry.exe, 'utf8')).toBe('EXE')
    // an older version dir is swept; the current one survives
    fs.mkdirSync(path.join(stageRoot, '1.9.0'), { recursive: true })
    sweepOldStages(stageRoot, '2.0.0')
    expect(fs.existsSync(path.join(stageRoot, '1.9.0'))).toBe(false)
    expect(fs.existsSync(path.join(stageRoot, '2.0.0'))).toBe(true)
  })
})

describe('quit-path drain (D5 keep-vs-kill, mixed fleet)', () => {
  function mkDeps(keep: boolean): {
    deps: import('./quitDrain').QuitDrainDeps
    killed: unknown[]
    closed: string[]
    disposed: { v: boolean }
    disconnected: { v: boolean }
  } {
    const killed: unknown[] = []
    const closed: string[] = []
    const disposed = { v: false }
    const disconnected = { v: false }
    const mkSession = (id: string, proc: unknown) => ({
      proc,
      port: {
        close: () => {
          closed.push(id)
        }
      }
    })
    const daemonProc = { brand: 'daemon' }
    const inprocLive = { brand: 'inproc-live' }
    const inprocParked = { brand: 'inproc-parked' }
    const sessions = new Map([
      ['a', mkSession('a', daemonProc)],
      ['b', mkSession('b', inprocLive)]
    ])
    const parked = new Map([
      ['c', { proc: { brand: 'daemon' } }],
      ['e', { proc: inprocParked, timer: setTimeout(() => undefined, 60_000) }]
    ])
    const boardCwds = new Map([['a', 'C:/x']])
    return {
      deps: {
        keep,
        sessions,
        parked,
        boardCwds,
        isDaemonProxy: (p) => (p as { brand?: string }).brand === 'daemon',
        killTree: (p) => {
          killed.push(p)
          return Promise.resolve()
        },
        disposeAllPtys: () => {
          disposed.v = true
          return Promise.resolve()
        },
        disconnect: () => {
          disconnected.v = true
        }
      },
      killed,
      closed,
      disposed,
      disconnected
    }
  }

  it('keep=false routes to the classic kill-everything drain untouched', async () => {
    const { deps, killed, disposed, disconnected } = mkDeps(false)
    await quitDrainCore(deps)
    expect(disposed.v).toBe(true)
    expect(killed).toHaveLength(0) // disposeAllPtys owns the killing on this path
    expect(disconnected.v).toBe(false)
    expect(deps.sessions.size).toBe(2) // untouched — disposeAllPtys drains them itself
  })

  it('keep=true detaches daemon sessions and tree-kills ONLY the in-proc fleet members', async () => {
    const { deps, killed, closed, disposed, disconnected } = mkDeps(true)
    await quitDrainCore(deps)
    expect(disposed.v).toBe(false)
    // both live ports closed (detach), but only the in-proc procs killed — live AND parked
    expect(closed.sort()).toEqual(['a', 'b'])
    expect(killed.map((p) => (p as { brand: string }).brand).sort()).toEqual([
      'inproc-live',
      'inproc-parked'
    ])
    expect(deps.sessions.size).toBe(0)
    expect(deps.parked.size).toBe(0)
    expect(deps.boardCwds.size).toBe(0)
    expect(disconnected.v).toBe(true)
  })
})

describe('close-guard decision core (PR-2)', () => {
  const base: CloseDecisionInput = {
    quitting: false,
    bypass: false,
    resident: false,
    keepableCount: 2,
    mode: 'ask'
  }
  it('asks only for a user close with keepable sessions under mode=ask', () => {
    expect(decideOnClose(base)).toBe('ask')
  })
  it('NEVER intercepts once the quit path owns the close (update restart never prompts)', () => {
    expect(decideOnClose({ ...base, quitting: true })).toBe('proceed')
  })
  it('lets a guard-approved stop re-close and its own residency teardown through', () => {
    expect(decideOnClose({ ...base, bypass: true })).toBe('proceed')
    expect(decideOnClose({ ...base, resident: true })).toBe('proceed')
  })
  it('skips the modal when nothing would survive a keep (no daemon-backed sessions)', () => {
    expect(decideOnClose({ ...base, keepableCount: 0 })).toBe('proceed')
  })
  it('honors the always-keep / always-stop settings without a modal', () => {
    expect(decideOnClose({ ...base, mode: 'keep' })).toBe('keep')
    expect(decideOnClose({ ...base, mode: 'stop' })).toBe('proceed')
  })

  it('normalizes any malformed modal reply to cancel (fail-safe: nothing changes)', () => {
    expect(normalizeCloseAnswer({ action: 'keep', remember: true })).toEqual({
      action: 'keep',
      remember: true
    })
    expect(normalizeCloseAnswer({ action: 'stop' })).toEqual({ action: 'stop', remember: false })
    expect(normalizeCloseAnswer({ action: 'quit-now' })).toEqual({
      action: 'cancel',
      remember: false
    })
    expect(normalizeCloseAnswer(null)).toEqual({ action: 'cancel', remember: false })
    expect(normalizeCloseAnswer('keep')).toEqual({ action: 'cancel', remember: false })
    // remember must be an explicit boolean true — truthy garbage does not persist a setting
    expect(normalizeCloseAnswer({ action: 'stop', remember: 'yes' }).remember).toBe(false)
  })
})

describe('tray residency core (PR-2)', () => {
  const mkInfo = (id: string, meta: Partial<SessionInfo['meta']> = {}): SessionInfo => ({
    id,
    pid: 1,
    cols: 80,
    rows: 24,
    meta: {
      projectDir: null,
      cwd: 'C:\\proj\\storefront',
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      monitored: true,
      ...meta
    }
  })

  it('diffs exits between polls (order-independent, additions ignored)', () => {
    expect(exitedIds(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
    expect(exitedIds(['a'], ['a', 'new'])).toEqual([])
    expect(exitedIds([], ['x'])).toEqual([])
  })

  it('renders honest menu rows: launchCommand first, shell fallback, cwd locator, age', () => {
    const now = Date.now()
    const model = buildTrayMenuModel(
      [
        mkInfo('b', { launchCommand: 'pnpm dev', startedAt: now - 2 * 60 * 60_000 }),
        mkInfo('a', { startedAt: now - 24 * 60_000, cwd: 'C:\\proj\\api-server' })
      ],
      now
    )
    expect(model.header).toBe('Expanse — 2 sessions running')
    // sorted by id: shell-fallback row first (no launchCommand → 'pwsh', .exe stripped)
    expect(model.rows[0].label).toBe('pwsh · api-server · running 24m')
    expect(model.rows[1].label).toBe('pnpm dev · storefront · running 2h')
  })

  it('omits the age for a PR-1-era survivor (no startedAt) instead of inventing one', () => {
    const model = buildTrayMenuModel([mkInfo('a')], Date.now())
    expect(model.rows[0].label).toBe('pwsh · storefront')
    expect(buildTrayMenuModel([], Date.now()).header).toBe('Expanse — 0 sessions running')
  })

  it('seeds the menu from the close-modal snapshot (board title wins over cwd)', () => {
    const now = Date.now()
    const rows: CloseSessionRow[] = [
      {
        id: 'x',
        cmd: 'claude',
        title: 'API server',
        cwd: 'C:\\proj\\api',
        running: true,
        startedAt: now - 5 * 60_000,
        lastActivityAt: now
      }
    ]
    expect(seedModelFromRows(rows, now).rows[0].label).toBe('claude · API server · running 5m')
    expect(seedModelFromRows(rows, now).header).toBe('Expanse — 1 session running')
  })

  it('formats relative ages at minute/hour/day granularity, "now" under a minute', () => {
    const now = 10_000_000_000
    expect(formatSessionAge(now, now - 10_000)).toBe('now')
    expect(formatSessionAge(now, now - 41 * 60_000)).toBe('41m')
    expect(formatSessionAge(now, now - 3 * 60 * 60_000)).toBe('3h')
    expect(formatSessionAge(now, now - 49 * 60 * 60_000)).toBe('2d')
    expect(formatSessionAge(now, 0)).toBe('') // unknown epoch → no claim
    expect(formatSessionAge(now, now + 60_000)).toBe('') // future epoch → clock skew, no claim
  })
})
