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
import { pipeNameFor, repairState } from './state'
import { ptyHostEnabled, readPtyHostConfig, repairPtyHostConfig } from './config'
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
  it('repairs any malformed config to the default-ON', () => {
    expect(repairPtyHostConfig(null)).toEqual({ surviveRestart: true })
    expect(repairPtyHostConfig({ surviveRestart: 'yes' })).toEqual({ surviveRestart: true })
    expect(repairPtyHostConfig({ surviveRestart: false })).toEqual({ surviveRestart: false })
  })
  it('reads a missing/corrupt file as the default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhost-cfg-'))
    expect(readPtyHostConfig(dir)).toEqual({ surviveRestart: true })
    fs.writeFileSync(path.join(dir, 'ptyhost-config.json'), '{corrupt')
    expect(readPtyHostConfig(dir)).toEqual({ surviveRestart: true })
  })
  it('gates on platform, env override, then the setting', () => {
    const on = { surviveRestart: true }
    const off = { surviveRestart: false }
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
