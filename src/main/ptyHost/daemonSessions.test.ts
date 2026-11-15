/**
 * The daemon's session table (daemonSessions.ts) driven with a fake pty + fake connections.
 *
 * The contract under test is INSTANCE identity: a board id is reused (Restart kills and respawns
 * under the same id immediately), so nothing a dead instance does — its late exit, its dying
 * output — may be attributed to the instance that now owns the id.
 */
import { describe, it, expect } from 'vitest'
import { createDaemonSessions, type DaemonConnLike, type DaemonPtyLike } from './daemonSessions'
import type { ClientMsg, DaemonMsg } from './protocol'

interface FakePty extends DaemonPtyLike {
  written: string[]
  kills: number
  emitData(d: string): void
  emitExit(code: number): void
}

function fakePty(pid: number): FakePty {
  const onData: Array<(d: string) => void> = []
  const onExit: Array<(e: { exitCode: number }) => void> = []
  const p: FakePty = {
    pid,
    written: [],
    kills: 0,
    onData: (l) => onData.push(l),
    onExit: (l) => onExit.push(l),
    write: (d) => {
      p.written.push(d)
    },
    resize: () => undefined,
    kill: () => {
      p.kills++
    },
    pause: () => undefined,
    resume: () => undefined,
    emitData: (d) => onData.forEach((l) => l(d)),
    emitExit: (code) => onExit.forEach((l) => l({ exitCode: code }))
  }
  return p
}

interface FakeConn extends DaemonConnLike {
  msgs(): DaemonMsg[]
  of<E extends DaemonMsg['ev']>(ev: E): Extract<DaemonMsg, { ev: E }>[]
}

function fakeConn(): FakeConn {
  const lines: string[] = []
  const msgs = (): DaemonMsg[] => lines.map((l) => JSON.parse(l) as DaemonMsg)
  return {
    destroyed: false,
    write: (d) => lines.push(d),
    msgs,
    of: (ev) => msgs().filter((m) => m.ev === ev) as never
  }
}

/** Output is coalesced per tick (flowControl.ts) — let the immediate fire. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function mk(): {
  table: ReturnType<typeof createDaemonSessions>
  conn: FakeConn
  ptys: FakePty[]
  /** Settle every tree-kill issued so far (the daemon's taskkill finishing). */
  finishKills: () => Promise<void>
  ended: { n: number }
  shutdowns: { n: number }
} {
  const ptys: FakePty[] = []
  const pendingKills: Array<() => void> = []
  const ended = { n: 0 }
  const shutdowns = { n: 0 }
  const table = createDaemonSessions({
    spawnPty: () => {
      const p = fakePty(1000 + ptys.length)
      ptys.push(p)
      return p
    },
    killTree: () => new Promise<void>((r) => pendingKills.push(r)),
    log: () => undefined,
    onActive: () => undefined,
    onSessionEnded: () => {
      ended.n++
    },
    onShutdownComplete: () => {
      shutdowns.n++
    },
    ringCap: 256 * 1024
  })
  return {
    table,
    conn: fakeConn(),
    ptys,
    finishKills: async () => {
      pendingKills.splice(0).forEach((r) => r())
      await Promise.resolve()
      await Promise.resolve()
    },
    ended,
    shutdowns
  }
}

const spawnMsg = (id: string): ClientMsg => ({
  op: 'spawn',
  id,
  shell: 'pwsh.exe',
  args: [],
  cwd: 'C:\\proj',
  cols: 80,
  rows: 24,
  env: {},
  meta: { projectDir: 'C:\\proj', cwd: 'C:\\proj', shell: 'pwsh.exe', monitored: true }
})

const listed = (conn: FakeConn): Array<{ id: string; pid: number }> =>
  (conn.of('sessions').at(-1)?.list ?? []).map((s) => ({ id: s.id, pid: s.pid }))

describe('daemon session table — instance identity under a reused id', () => {
  it('🔒 kill → same-id respawn → the OLD pty exiting late leaves the replacement registered and reports no exit', async () => {
    // Restart: MAIN kills the board's session and respawns under the SAME id straight away. The old
    // pty's exit only fires once its tree is dead (taskkill, then node-pty's conout close) — i.e.
    // AFTER the replacement is registered. Reproduced on the real daemon: `exit` for the id arrived
    // ~1.1 s after the respawn's `spawned` and the daemon's list came back empty.
    const { table, conn, ptys, finishKills } = mk()
    table.handle(conn, spawnMsg('X'))
    table.handle(conn, { op: 'kill', id: 'X' })
    table.handle(conn, spawnMsg('X'))
    expect(ptys).toHaveLength(2)
    await finishKills()
    expect(conn.of('killed')).toHaveLength(1)

    ptys[0].emitExit(1) // the killed instance's exit, landing late

    expect(conn.of('exit')).toEqual([]) // nothing told the client that X exited
    table.handle(conn, { op: 'list' })
    expect(listed(conn)).toEqual([{ id: 'X', pid: ptys[1].pid }]) // the replacement is still tracked
    table.handle(conn, { op: 'input', id: 'X', data: 'still-here\r' })
    expect(ptys[1].written).toEqual(['still-here\r']) // …and still reachable by id
    expect(ptys[0].written).toEqual([])

    // The replacement's OWN exit is still reported, exactly once, and frees the id.
    ptys[1].emitExit(0)
    expect(conn.of('exit')).toEqual([{ ev: 'exit', id: 'X', code: 0 }])
    table.handle(conn, { op: 'list' })
    expect(listed(conn)).toEqual([])
  })

  it('🔒 a killed instance’s dying output never travels under the id its replacement owns', async () => {
    // node-pty keeps draining a killed process's output for up to ~1 s. Sent as `output` for the
    // id, those bytes would paint into the freshly restarted terminal.
    const { table, conn, ptys } = mk()
    table.handle(conn, spawnMsg('X'))
    table.handle(conn, { op: 'kill', id: 'X' })
    table.handle(conn, spawnMsg('X'))

    ptys[0].emitData('OLD-DYING-BYTES')
    ptys[1].emitData('fresh-prompt> ')
    await tick()

    expect(conn.of('output').map((m) => m.data)).toEqual(['fresh-prompt> '])
    // A reattach replay is built from the replacement's ring only.
    const second = fakeConn()
    table.handle(second, { op: 'attach', id: 'X' })
    expect(second.of('replay')[0]?.data).toBe('fresh-prompt> ')
  })

  it('🔒 `killed` is a killed session’s last word — no exit follows, even with no replacement', async () => {
    const { table, conn, ptys, finishKills, ended } = mk()
    table.handle(conn, spawnMsg('X'))
    table.handle(conn, { op: 'kill', id: 'X' })
    await finishKills()
    ptys[0].emitExit(1)
    expect(conn.msgs().map((m) => m.ev)).toEqual(['spawned', 'killed'])
    expect(ptys[0].kills).toBe(1) // ConPTY handle disposed after the tree-kill
    expect(ended.n).toBe(1) // idleness re-checked once (by the kill), not again by the late exit
  })

  it('a session that exits on its own reports its last output, then exit, and frees the id', async () => {
    const { table, conn, ptys, ended } = mk()
    table.handle(conn, spawnMsg('X'))
    ptys[0].emitData('bye')
    ptys[0].emitExit(3) // same tick as the output: the coalesced chunk must still go first
    // (`pid`: ConPTY reports 0 at spawn, so the real pid is pushed with the first output.)
    expect(conn.msgs().map((m) => m.ev)).toEqual(['spawned', 'pid', 'output', 'exit'])
    expect(conn.of('exit')).toEqual([{ ev: 'exit', id: 'X', code: 3 }])
    expect(ended.n).toBe(1)
    table.handle(conn, spawnMsg('X')) // the id is free again
    expect(conn.of('spawned')).toHaveLength(2)
    expect(conn.of('error')).toEqual([])
  })

  it('a kill for an unknown id is acked so the client’s kill promise settles', () => {
    const { table, conn } = mk()
    table.handle(conn, { op: 'kill', id: 'gone' })
    expect(conn.msgs()).toEqual([{ ev: 'killed', id: 'gone' }])
  })

  it('shutdown tree-kills every session, reports completion once, and their late exits stay silent', async () => {
    const { table, conn, ptys, finishKills, shutdowns } = mk()
    table.handle(conn, spawnMsg('A'))
    table.handle(conn, spawnMsg('B'))
    table.handle(conn, { op: 'shutdown' })
    expect(table.size()).toBe(0)
    expect(shutdowns.n).toBe(0) // not before the trees are reaped
    await finishKills()
    expect(shutdowns.n).toBe(1)
    expect(ptys.map((p) => p.kills)).toEqual([1, 1])
    ptys[0].emitExit(1)
    ptys[1].emitExit(1)
    expect(conn.of('exit')).toEqual([])
  })

  it('a second spawn under a LIVE id is refused (the id is only reusable after a kill or exit)', () => {
    const { table, conn, ptys } = mk()
    table.handle(conn, spawnMsg('X'))
    table.handle(conn, spawnMsg('X'))
    expect(ptys).toHaveLength(1)
    expect(conn.of('error')).toEqual([
      { ev: 'error', id: 'X', message: 'session X already exists' }
    ])
  })

  it('a disconnected client stops receiving a session’s events; the session keeps running', async () => {
    const { table, conn, ptys } = mk()
    table.handle(conn, spawnMsg('X'))
    table.disconnect(conn)
    ptys[0].emitData('headless output')
    await tick()
    expect(conn.of('output')).toEqual([])
    expect(table.size()).toBe(1)
    const back = fakeConn()
    table.handle(back, { op: 'attach', id: 'X' })
    expect(back.of('replay')[0]?.data).toBe('headless output')
  })
})
