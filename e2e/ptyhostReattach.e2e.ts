import { _electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @terminal PTY-host reattach across an app relaunch (DESIGN.md PR 1, lane gate 6).
 *
 * The ONLY spec that relaunches the Electron app, so it manages its OWN instance on a
 * DEDICATED userData profile (CANVAS_USERDATA) instead of the shared worker fixture —
 * the per-checkout profile isolation (#334) lets it coexist with the worker's app.
 *
 * Flow: spawn a terminal → HARD-kill the app (crash path: before-quit never runs, so the
 * daemon keeps the shell — the same survival the update-install detach uses) → relaunch on
 * the same profile → the board must reattach to the SAME shell pid with the ring replay →
 * live duplex still works → a NORMAL close then kills the session (D5: close semantics
 * unchanged in PR 1) and the daemon idle-exits — the no-leak sweep is an ASSERTION here,
 * not just teardown.
 *
 * Windows-only: the staged-runtime daemon is win32-gated in PR 1 (config.ts).
 */
test.describe('@terminal @ptyhost daemon reattach across app relaunch', () => {
  test.skip(process.platform !== 'win32', 'PTY host is win32-only in PR 1')
  test.slow() // two full app boots + a daemon lifecycle

  let userData: string
  let projectDir: string
  let shellPid = 0

  const launch = async (): Promise<{ app: ElectronApplication; page: Page }> => {
    const app = await _electron.launch({
      args: ['out/main/index.js'],
      env: {
        ...process.env,
        CANVAS_E2E: '1',
        CANVAS_USERDATA: userData,
        CANVAS_PTYHOST: '1'
      }
    })
    const page = await app.firstWindow()
    await expect
      .poll(
        () =>
          page.evaluate(
            () => typeof (globalThis as { __canvasE2E?: unknown }).__canvasE2E !== 'undefined'
          ),
        { timeout: 15_000 }
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          app.evaluate(
            () =>
              typeof (globalThis as { __canvasE2EMain?: unknown }).__canvasE2EMain !== 'undefined'
          ),
        { timeout: 15_000 }
      )
      .toBe(true)
    return { app, page }
  }

  const openProject = async (page: Page): Promise<void> => {
    const r = await page.evaluate(
      (d) =>
        (
          globalThis as unknown as {
            __canvasE2E: { openProjectFromDisk(dir: string): Promise<{ status: string }> }
          }
        ).__canvasE2E.openProjectFromDisk(d),
      projectDir
    )
    expect(r.status).toBe('open')
  }

  const terminalPid = (app: ElectronApplication, id: string): Promise<number | null> =>
    app.evaluate(
      ({}, bid) =>
        (
          globalThis as unknown as {
            __canvasE2EMain: { terminalPid(id: string): number | null }
          }
        ).__canvasE2EMain.terminalPid(bid),
      id
    )

  const readTerm = (page: Page, id: string): Promise<string> =>
    page.evaluate(
      (bid) =>
        (
          globalThis as unknown as { __canvasE2E: { readTerminal(id: string): string | null } }
        ).__canvasE2E.readTerminal(bid) ?? '',
      id
    )

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  test.beforeAll(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhost-e2e-ud-'))
  })

  test.afterAll(() => {
    // Belt: if anything above failed mid-flight, never leak a daemon between runs (gate 6).
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(userData, 'ptyhost-state.json'), 'utf8')
      ) as { daemonPid?: number }
      if (state.daemonPid && alive(state.daemonPid)) process.kill(state.daemonPid)
    } catch {
      /* no state file / already gone — the green path */
    }
    if (shellPid && alive(shellPid)) {
      try {
        process.kill(shellPid)
      } catch {
        /* raced its own exit */
      }
    }
  })

  test('session survives a hard app kill, reattaches with replay + same pid, and dies clean on normal close', async () => {
    // ── App A: spawn a daemon-backed terminal and let it persist to canvas.json ──
    const a = await launch()
    // A REAL project scaffold (canvas.json + .canvas/) — a bare temp dir opens as 'error'.
    projectDir = await a.app.evaluate(
      ({}, args) =>
        (
          globalThis as unknown as {
            __canvasE2EMain: { createTempProject(prefix: string, name: string): Promise<string> }
          }
        ).__canvasE2EMain.createTempProject(args[0], args[1]),
      ['ptyhost-e2e-', 'ptyhost-reattach']
    )
    await openProject(a.page)
    const id = await a.page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvasE2E: { seedBoard(kind: string, patch?: Record<string, unknown>): string }
        }
      ).__canvasE2E.seedBoard('terminal', { launchCommand: 'echo PTYHOST-ALIVE-1' })
    )
    await expect
      .poll(async () => ((await terminalPid(a.app, id)) ?? 0) > 0, { timeout: 20_000 })
      .toBe(true)
    shellPid = (await terminalPid(a.app, id)) as number
    await expect.poll(() => readTerm(a.page, id), { timeout: 20_000 }).toContain('PTYHOST-ALIVE-1')
    // The relaunch can only restore the board from disk — wait for the autosave to land.
    const canvasJson = path.join(projectDir, '.canvas', 'canvas.json')
    await expect
      .poll(
        () => {
          try {
            return fs.readFileSync(canvasJson, 'utf8').includes(id)
          } catch {
            return false
          }
        },
        { timeout: 15_000 }
      )
      .toBe(true)

    // ── HARD kill (crash path — before-quit never runs) ──
    const procA = a.app.process()
    procA.kill()
    await expect.poll(() => procA.killed || procA.exitCode !== null, { timeout: 10_000 }).toBe(true)
    // The shell must have OUTLIVED its app: the daemon owns it, not MAIN.
    expect(alive(shellPid), 'shell survived the app kill (daemon-owned)').toBe(true)

    // ── App B: same profile → adopt-first mount reattaches ──
    const b = await launch()
    await openProject(b.page)
    // Same pid = the SAME live process (not a respawn) — the core reattach assertion.
    await expect.poll(async () => terminalPid(b.app, id), { timeout: 30_000 }).toBe(shellPid)
    // Ring replay repainted the pre-kill output.
    await expect.poll(() => readTerm(b.page, id), { timeout: 20_000 }).toContain('PTYHOST-ALIVE-1')
    // Live duplex still works post-reattach.
    await b.app.evaluate(
      ({}, arg) =>
        (
          globalThis as unknown as {
            __canvasE2EMain: { writeTerminal(id: string, data: string): boolean }
          }
        ).__canvasE2EMain.writeTerminal(arg.id, arg.data),
      { id, data: 'echo PTYHOST-ALIVE-2\r' }
    )
    await expect.poll(() => readTerm(b.page, id), { timeout: 20_000 }).toContain('PTYHOST-ALIVE-2')

    // ── Normal close: D5 keeps today's kill-everything semantics → daemon idle-exits ──
    const state = JSON.parse(
      fs.readFileSync(path.join(userData, 'ptyhost-state.json'), 'utf8')
    ) as { daemonPid: number }
    await b.app.close()
    await expect
      .poll(() => alive(shellPid), { timeout: 15_000, message: 'shell reaped on normal close' })
      .toBe(false)
    await expect
      .poll(() => alive(state.daemonPid), {
        timeout: 15_000,
        message: 'daemon idle-exited (no leak between runs)'
      })
      .toBe(false)
    shellPid = 0
  })
})
