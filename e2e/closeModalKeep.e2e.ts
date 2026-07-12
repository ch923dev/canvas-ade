import { _electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
    await app.close()
  })
})
