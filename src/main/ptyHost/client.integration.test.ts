/**
 * MAIN's PTY-host client against a FAKE daemon on a real named pipe. client.ts owns module-level
 * connection state and imports electron, so the pure-core suite (ptyHost.test.ts) cannot reach
 * it; here electron is stubbed, the state file points at a pipe this test serves, and the real
 * client code — handshake, routing, proxies, the socket decode — runs end to end.
 *
 * Windows-only: the pipe name is validated as `\\.\pipe\expanse-ptyhost-…` (state.ts), and the
 * daemon itself is win32-gated (config.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PROTOCOL_VERSION, encodeLine, type ClientMsg, type DaemonMsg } from './protocol'
import { pipeNameFor } from './state'

const env = vi.hoisted(() => ({ userData: '', spawns: 0 }))

vi.mock('electron', () => ({
  app: {
    getPath: () => env.userData,
    getVersion: () => '0.0.0-test',
    isPackaged: false
  }
}))
// Starting a daemon is the one thing these tests must be able to rule out.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => {
    env.spawns++
    throw new Error('test: client tried to start a daemon')
  }
}))

const TOKEN = 't'.repeat(64)

interface FakeDaemon {
  ops: ClientMsg[]
  /** Send one protocol message to the connected client. */
  send(msg: DaemonMsg): void
  /** Write raw bytes to the connected client (to choose where a read boundary falls). */
  raw(bytes: Buffer): void
  close(): Promise<void>
}

/** A daemon stand-in that follows the real contract: hello → hello, spawn → spawned, and a kill
 *  is answered with `killed` and NOTHING else (no `exit` for a killed session). */
async function startFakeDaemon(): Promise<FakeDaemon> {
  const pipe = pipeNameFor(env.userData, Math.random().toString(16).slice(2, 10))
  const ops: ClientMsg[] = []
  const conns = new Set<net.Socket>()
  const reply = (c: net.Socket, msg: DaemonMsg): void => void c.write(encodeLine(msg))
  const server = net.createServer((c) => {
    conns.add(c)
    c.on('close', () => conns.delete(c))
    c.on('error', () => undefined)
    let buf = ''
    c.setEncoding('utf8')
    c.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as ClientMsg
        buf = buf.slice(nl + 1)
        ops.push(msg)
        if (msg.op === 'hello') reply(c, { ev: 'hello', version: PROTOCOL_VERSION, pid: 1 })
        else if (msg.op === 'spawn') reply(c, { ev: 'spawned', id: msg.id, pid: 4000 + ops.length })
        else if (msg.op === 'kill') reply(c, { ev: 'killed', id: msg.id })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(pipe, resolve))
  fs.writeFileSync(
    path.join(env.userData, 'ptyhost-state.json'),
    JSON.stringify({ pipe, token: TOKEN, daemonPid: 1, protocolVersion: PROTOCOL_VERSION })
  )
  const only = (): net.Socket => {
    const c = [...conns][0]
    if (!c) throw new Error('no client connected')
    return c
  }
  return {
    ops,
    send: (msg) => reply(only(), msg),
    raw: (bytes) => void only().write(bytes),
    close: () =>
      new Promise((resolve) => {
        for (const c of conns) c.destroy()
        server.close(() => resolve())
      })
  }
}

const spawnOpts = (id: string): import('./client').DaemonSpawnOpts => ({
  id,
  shell: 'C:\\pwsh.exe',
  args: [],
  cwd: 'C:\\proj',
  cols: 80,
  rows: 24,
  env: {},
  meta: { projectDir: 'C:\\proj', cwd: 'C:\\proj', shell: 'C:\\pwsh.exe', monitored: true }
})

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe.skipIf(process.platform !== 'win32')('ptyHost client ⇄ a fake daemon pipe', () => {
  let client: typeof import('./client')
  let daemon: FakeDaemon | null = null

  beforeEach(async () => {
    env.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhost-client-'))
    env.spawns = 0
    vi.resetModules() // client.ts keeps its connection in module state — one fresh copy per test
    client = await import('./client')
  })

  afterEach(async () => {
    client.disconnectPtyHost()
    await daemon?.close()
    daemon = null
    fs.rmSync(env.userData, { recursive: true, force: true })
  })

  describe('a killed proxy is unhooked at once (instance identity under a reused id)', () => {
    it('🔒 stops counting as a live session — the daemon sends no exit for a killed session', async () => {
      daemon = await startFakeDaemon()
      client.setKeepSessionsOnQuit(true)
      const proxy = await client.spawnViaDaemon(spawnOpts('X'))
      expect(client.shouldKeepSessionsOnQuit()).toBe(true)
      proxy.kill()
      // Nothing else would ever remove it: a lingering entry made a quit with zero live sessions
      // take the keep/detach path, and pinned the dead session's handlers.
      expect(client.shouldKeepSessionsOnQuit()).toBe(false)
    })

    it('🔒 nothing addressed to the id reaches the killed proxy, and its replacement is untouched by a late second kill', async () => {
      daemon = await startFakeDaemon()
      client.setKeepSessionsOnQuit(true)
      const old = await client.spawnViaDaemon(spawnOpts('X'))
      const oldData: string[] = []
      const oldExits: number[] = []
      old.onData((d) => oldData.push(d))
      old.onExit((e) => oldExits.push(e.exitCode))
      old.kill() // Restart: kill …
      const fresh = await client.spawnViaDaemon(spawnOpts('X')) // … and respawn under the same id
      const freshData: string[] = []
      const freshExits: number[] = []
      fresh.onData((d) => freshData.push(d))
      fresh.onExit((e) => freshExits.push(e.exitCode))

      old.kill() // a second teardown of the OLD instance must not unhook the new one
      expect(client.shouldKeepSessionsOnQuit()).toBe(true)

      daemon.send({ ev: 'output', id: 'X', data: 'fresh-prompt> ' })
      await until(() => freshData.length > 0)
      expect(freshData).toEqual(['fresh-prompt> '])
      expect(oldData).toEqual([])

      daemon.send({ ev: 'exit', id: 'X', code: 7 }) // the replacement's OWN exit
      await until(() => freshExits.length > 0)
      expect(freshExits).toEqual([7])
      expect(oldExits).toEqual([])
    })

    // The daemon answers a kill with `killed` and no `exit`, so the proxy has to be dropped at
    // kill time. Left registered, it reads as a running session the next time the pipe closes —
    // which is every time the daemon idle-exits after its last session was killed.
    it('🔒 a kill with no respawn leaves nothing behind: the pipe closing later interrupts no session', async () => {
      daemon = await startFakeDaemon()
      const notes: string[] = []
      client.setPtyHostNotifier((m) => notes.push(m))
      const proxy = await client.spawnViaDaemon(spawnOpts('X'))
      const exits: number[] = []
      proxy.onExit((e) => exits.push(e.exitCode))
      proxy.kill()
      // An attach the fake daemon never answers: it settles only when the client has handled the
      // lost connection, so the assertions below cannot run early.
      const lost = client.attachDaemonSession('never-answered').catch((e: Error) => e.message)
      await until(() => daemon?.ops.some((m) => m.op === 'attach') ?? false)
      await daemon.close()
      daemon = null
      expect(await lost).toBe('PTY host connection lost')
      expect(notes).toEqual([])
      expect(exits).toEqual([])
    })

    it('a LIVE proxy is still told: one notification and an exit when the pipe closes', async () => {
      daemon = await startFakeDaemon()
      const notes: string[] = []
      client.setPtyHostNotifier((m) => notes.push(m))
      const proxy = await client.spawnViaDaemon(spawnOpts('X'))
      const exits: number[] = []
      proxy.onExit((e) => exits.push(e.exitCode))
      await daemon.close()
      daemon = null
      await until(() => exits.length > 0)
      expect(exits).toEqual([-1])
      expect(notes).toEqual(['Terminal host disconnected — running sessions were interrupted.'])
    })
  })

  it('🔒 a character split across two pipe reads reaches the terminal intact', async () => {
    daemon = await startFakeDaemon()
    const proxy = await client.spawnViaDaemon(spawnOpts('X'))
    const got: string[] = []
    proxy.onData((d) => got.push(d))
    const text = '┌──┐ 👩‍💻 ✅'
    const bytes = Buffer.from(encodeLine({ ev: 'output', id: 'X', data: text }), 'utf8')
    const cut = bytes.indexOf(Buffer.from('👩')) + 2 // two bytes into a four-byte character
    daemon.raw(bytes.subarray(0, cut))
    await new Promise((r) => setTimeout(r, 60)) // let the first half arrive as its own read
    expect(got).toEqual([]) // an incomplete line: nothing decoded yet
    daemon.raw(bytes.subarray(cut))
    await until(() => got.length > 0)
    expect(got).toEqual([text])
  })

  describe('shutdownPtyHostDaemon — stop a daemon, never start one', () => {
    it('🔒 with no daemon at all it does nothing (a quit must not boot a daemon to stop it)', async () => {
      await client.shutdownPtyHostDaemon()
      expect(env.spawns).toBe(0)
    })

    it('🔒 a state file that outlived its daemon is not a reason to start one either', async () => {
      fs.writeFileSync(
        path.join(env.userData, 'ptyhost-state.json'),
        JSON.stringify({
          pipe: pipeNameFor(env.userData, 'deadbeef'),
          token: TOKEN,
          daemonPid: 1,
          protocolVersion: PROTOCOL_VERSION
        })
      )
      await client.shutdownPtyHostDaemon()
      expect(env.spawns).toBe(0)
    })

    it('🔒 finds a running daemon this run never talked to and delivers `shutdown` before closing the pipe', async () => {
      // The un-adopted-survivor case: sessions kept by a previous run, no terminal opened in this
      // one, so MAIN holds no connection — the stop has to go and find the daemon.
      daemon = await startFakeDaemon()
      const stateFile = path.join(env.userData, 'ptyhost-state.json')
      await client.shutdownPtyHostDaemon()
      await until(() => daemon?.ops.some((m) => m.op === 'shutdown') ?? false)
      expect(daemon.ops.map((m) => m.op)).toEqual(['hello', 'shutdown'])
      expect(fs.existsSync(stateFile)).toBe(false) // the next run starts a fresh daemon
      expect(env.spawns).toBe(0)
    })

    it('with a live connection it acts in the caller’s tick (a crash sink exits right after)', async () => {
      daemon = await startFakeDaemon()
      client.setKeepSessionsOnQuit(true)
      await client.spawnViaDaemon(spawnOpts('X'))
      expect(client.shouldKeepSessionsOnQuit()).toBe(true)
      const stopped = client.shutdownPtyHostDaemon()
      // Synchronously: the line is written and the connection let go of — nothing awaited yet.
      expect(client.shouldKeepSessionsOnQuit()).toBe(false)
      await stopped
      await until(() => daemon?.ops.some((m) => m.op === 'shutdown') ?? false)
      expect(daemon.ops.map((m) => m.op)).toEqual(['hello', 'spawn', 'shutdown'])
    })
  })
})
