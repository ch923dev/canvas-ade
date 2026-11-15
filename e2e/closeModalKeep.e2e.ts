import { _electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeElectronApp } from './closeApp'

/**
 * @terminal PR-2 background sessions: the close modal's KEEP path (mock 1 → mock 2 → mock 3).
 *
 * Own-app-instance spec on a dedicated userData profile (the ptyhostReattach.e2e.ts
 * precedent) because it drives a real window close + tray residency + window recreation —
 * none of which may touch the shared worker app. Sets CANVAS_E2E_CLOSEGUARD=1: under a
 * plain harness the guard stands down (spec teardowns close the app programmatically with
 * live terminals), so this spec opts its instance in.
 *
 * Flow: spawn a daemon-backed terminal → USER-style window close → the close modal lists
 * the session → "Keep running in background" → window dies, MAIN stays tray-resident, the
 * shell OUTLIVES the window → trayReopen probe (Playwright can't click the OS tray) → the
 * board reattaches to the SAME pid with replay + live duplex → a config-'stop' close then
 * kills everything and the daemon idle-exits (the no-leak sweep is an assertion).
 *
 * Windows-only: the PTY-host daemon is win32-gated.
 */
test.describe('@terminal @ptyhost close modal keep → tray residency → reattach', () => {
  test.skip(process.platform !== 'win32', 'PTY host is win32-only')
  test.slow() // full app boot + residency round trip + daemon lifecycle

  let userData: string
  let projectDir: string
  let shellPid = 0

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  test.beforeAll(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'closeguard-e2e-ud-'))
  })

  test.afterAll(() => {
    // Belt: never leak a daemon (or its shell) between runs, even on a mid-flight failure.
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

  const waitForHooks = async (app: ElectronApplication, page: Page): Promise<void> => {
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

  const trayResident = (app: ElectronApplication): Promise<boolean> =>
    app.evaluate(() =>
      (
        globalThis as unknown as { __canvasE2EMain: { trayResident(): boolean } }
      ).__canvasE2EMain.trayResident()
    )

  test('sessions survive a MODAL-approved close, reattach on tray reopen, die on stop-configured close', async () => {
    const app = await _electron.launch({
      args: ['out/main/index.js'],
      env: {
        ...process.env,
        CANVAS_E2E: '1',
        CANVAS_USERDATA: userData,
        CANVAS_PTYHOST: '1',
        CANVAS_E2E_CLOSEGUARD: '1' // opt this instance into the guard (harness-bypassed otherwise)
      }
    })
    const page = await app.firstWindow()
    await waitForHooks(app, page)

    // ── Spawn a daemon-backed terminal in a real project and let the autosave land ──
    projectDir = await app.evaluate(
      ({}, args) =>
        (
          globalThis as unknown as {
            __canvasE2EMain: { createTempProject(prefix: string, name: string): Promise<string> }
          }
        ).__canvasE2EMain.createTempProject(args[0], args[1]),
      ['closeguard-e2e-', 'close-modal-keep']
    )
    await openProject(page)
    const id = await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvasE2E: { seedBoard(kind: string, patch?: Record<string, unknown>): string }
        }
      ).__canvasE2E.seedBoard('terminal', { launchCommand: 'echo CLOSEGUARD-ALIVE-1' })
    )
    await expect
      .poll(async () => ((await terminalPid(app, id)) ?? 0) > 0, { timeout: 20_000 })
      .toBe(true)
    shellPid = (await terminalPid(app, id)) as number
    await expect.poll(() => readTerm(page, id), { timeout: 20_000 }).toContain('CLOSEGUARD-ALIVE-1')
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

    // ── USER-style close → the guard intercepts and the modal lists the session ──
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect(page.getByTestId('close-modal')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('close-modal-session')).toHaveCount(1)

    // ── Keep running in background → window dies, MAIN stays alive as a tray resident ──
    await page.getByTestId('close-modal-keep').click()
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), {
        timeout: 15_000
      })
      .toBe(0)
    await expect.poll(() => trayResident(app), { timeout: 15_000 }).toBe(true)
    // The shell OUTLIVED its window: the daemon owns it, the app main only carries the tray.
    expect(alive(shellPid), 'shell survived the modal-approved close').toBe(true)

    // ── Reopen (the tray click, driven via the probe) → adopt-first reattach, same pid ──
    await app.evaluate(() =>
      (
        globalThis as unknown as { __canvasE2EMain: { trayReopen(): Promise<void> } }
      ).__canvasE2EMain.trayReopen()
    )
    const page2 = await app.firstWindow()
    await waitForHooks(app, page2)
    expect(await trayResident(app)).toBe(false) // icon exists ONLY while resident
    await openProject(page2)
    await expect.poll(async () => terminalPid(app, id), { timeout: 30_000 }).toBe(shellPid)
    await expect
      .poll(() => readTerm(page2, id), { timeout: 20_000 })
      .toContain('CLOSEGUARD-ALIVE-1') // ring replay repainted the pre-close output
    await app.evaluate(
      ({}, arg) =>
        (
          globalThis as unknown as {
            __canvasE2EMain: { writeTerminal(id: string, data: string): boolean }
          }
        ).__canvasE2EMain.writeTerminal(arg.id, arg.data),
      { id, data: 'echo CLOSEGUARD-ALIVE-2\r' }
    )
    await expect
      .poll(() => readTerm(page2, id), { timeout: 20_000 })
      .toContain('CLOSEGUARD-ALIVE-2') // live duplex post-reattach

    // ── Always-stop close: config says 'stop' → no modal, kill-everything, daemon idle-exit ──
    fs.writeFileSync(
      path.join(userData, 'ptyhost-config.json'),
      JSON.stringify({
        surviveRestart: true,
        onCloseWithSessions: 'stop',
        notifyBackgroundExit: true
      })
    )
    const state = JSON.parse(
      fs.readFileSync(path.join(userData, 'ptyhost-state.json'), 'utf8')
    ) as { daemonPid: number }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect
      .poll(() => alive(shellPid), { timeout: 15_000, message: 'shell reaped on stop close' })
      .toBe(false)
    await expect
      .poll(() => alive(state.daemonPid), {
        timeout: 15_000,
        message: 'daemon idle-exited (no leak between runs)'
      })
      .toBe(false)
    shellPid = 0
    await closeElectronApp(app)
  })

  /**
   * The un-adopted survivor: a session a previous run left in the daemon that NO board of this run
   * re-attaches (here: the relaunched app never opens its project — the stand-in for "project B's
   * agents, while this run only opened project A"). MAIN holds no proxy for it, so it used to be
   * missing from the close modal — with no other session the modal did not open at all — and
   * "Stop all & close" quit the app while the process kept running headless, with no window and
   * no tray. Now: it is listed, and stopping kills it and the daemon.
   */
  test('a survivor no board re-adopted is listed in the close modal and dies on "Stop all & close"', async () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'closeguard-e2e-survivor-ud-'))
    const env = {
      ...process.env,
      CANVAS_E2E: '1',
      CANVAS_USERDATA: ud,
      CANVAS_PTYHOST: '1',
      CANVAS_E2E_CLOSEGUARD: '1'
    }
    let survivorPid = 0
    let daemonPid = 0
    try {
      // ── Run 1: a daemon-backed terminal, then a HARD kill (before-quit never runs → kept) ──
      const a = await _electron.launch({ args: ['out/main/index.js'], env })
      const pageA = await a.firstWindow()
      await waitForHooks(a, pageA)
      projectDir = await a.evaluate(
        ({}, args) =>
          (
            globalThis as unknown as {
              __canvasE2EMain: { createTempProject(prefix: string, name: string): Promise<string> }
            }
          ).__canvasE2EMain.createTempProject(args[0], args[1]),
        ['closeguard-e2e-', 'close-modal-survivor']
      )
      await openProject(pageA)
      const id = await pageA.evaluate(() =>
        (
          globalThis as unknown as {
            __canvasE2E: { seedBoard(kind: string, patch?: Record<string, unknown>): string }
          }
        ).__canvasE2E.seedBoard('terminal', { launchCommand: 'echo SURVIVOR-ALIVE' })
      )
      await expect
        .poll(async () => ((await terminalPid(a, id)) ?? 0) > 0, { timeout: 20_000 })
        .toBe(true)
      survivorPid = (await terminalPid(a, id)) as number
      await expect.poll(() => readTerm(pageA, id), { timeout: 20_000 }).toContain('SURVIVOR-ALIVE')
      daemonPid = (
        JSON.parse(fs.readFileSync(path.join(ud, 'ptyhost-state.json'), 'utf8')) as {
          daemonPid: number
        }
      ).daemonPid
      const procA = a.process()
      procA.kill()
      await expect
        .poll(() => procA.killed || procA.exitCode !== null, { timeout: 10_000 })
        .toBe(true)
      expect(alive(survivorPid), 'shell survived the app kill (daemon-owned)').toBe(true)

      // ── Run 2: same profile, the project is NEVER opened → nothing re-adopts the session ──
      const b = await _electron.launch({ args: ['out/main/index.js'], env })
      const pageB = await b.firstWindow()
      await waitForHooks(b, pageB)
      await expect
        .poll(
          () =>
            b.evaluate(() =>
              (
                globalThis as unknown as { __canvasE2EMain: { hasUnadoptedSurvivors(): boolean } }
              ).__canvasE2EMain.hasUnadoptedSurvivors()
            ),
          { timeout: 15_000 }
        )
        .toBe(true)
      expect(await terminalPid(b, id), 'MAIN holds no session for it').toBeNull()
      expect(alive(survivorPid)).toBe(true)

      // ── USER-style close: the modal opens FOR the survivor and names it ──
      await b.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
      await expect(pageB.getByTestId('close-modal')).toBeVisible({ timeout: 10_000 })
      await expect(pageB.getByTestId('close-modal-session')).toHaveCount(1)
      await expect(pageB.getByTestId('close-modal-session')).toContainText('echo SURVIVOR-ALIVE')

      // ── Stop all & close: the app quits AND the never-adopted session is gone ──
      const procB = b.process()
      await pageB.getByTestId('close-modal-stop').click()
      await expect
        .poll(() => procB.exitCode !== null || procB.signalCode !== null, { timeout: 20_000 })
        .toBe(true)
      await expect
        .poll(() => alive(survivorPid), { timeout: 15_000, message: 'survivor reaped on stop' })
        .toBe(false)
      await expect
        .poll(() => alive(daemonPid), { timeout: 15_000, message: 'daemon stopped (no leak)' })
        .toBe(false)
      survivorPid = 0
      // The app has already quit on its own (asserted above) — just let Playwright settle.
      await b.close().catch(() => undefined)
    } finally {
      for (const pid of [daemonPid, survivorPid]) {
        if (pid && alive(pid)) {
          try {
            process.kill(pid)
          } catch {
            /* raced its own exit */
          }
        }
      }
      // Best-effort, like the sibling spec's profile (never removed): Chromium can still hold a
      // profile file for a moment after the process exits, and a cleanup error must never
      // replace the real verdict.
      try {
        fs.rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        /* the e2e temp sweep collects it */
      }
    }
  })
})
