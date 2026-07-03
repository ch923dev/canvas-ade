import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * @terminal Background project sessions (Phase 2) — switching projects with "keep running"
 * PARKS the outgoing project's PTYs (same processes, output buffering) and a switch-back
 * live-reattaches them through the adopt-first terminal mount. Drives the REAL pipeline
 * (store/projectSwitch.performProjectSwitch) via the `switchProjectFromDisk` hook with an
 * explicit keep flag, so the spec is independent of the EXPANSE_BG_SESSIONS env flag.
 *
 * Project juggling: `createTempProject` sets MAIN's currentDir as a side effect, and
 * `project:open` only approves a dir that is current or in recents — so every temp project is
 * minted FIRST, then renderer-opened once (which puts it in recents), ending on the project
 * the test starts from.
 *
 * Probes: PTY lifecycle is asserted MAIN-side (terminalPid / ptySessionCounts) — the renderer
 * `terminalLive` flag is the render-liveness gate (visibility), NOT "the PTY is running".
 */

type MainGlobal = {
  __canvasE2EMain: {
    createTempProject(prefix: string, name: string): Promise<string>
    teardownProject(tmp: string): void
    terminalPid(id: string): number | null
    writeTerminal(id: string, data: string): boolean
    ptySessionCounts(): { live: number; parked: number }
    pidsAlive(pids: number[]): number[]
    writeProjectFile(tmp: string, name: string, contents: string): void
  }
}

type RendererGlobal = {
  __canvasE2E: {
    seedBoard(type: string, patch?: Record<string, unknown>): string
    terminalMounted(id: string): boolean
    readTerminal(id: string): string | null
    serializeDoc(): string
    openProjectFromDisk(dir: string): Promise<{ status: string }>
    switchProjectFromDisk(
      dir: string,
      keep: boolean
    ): Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
  }
}

function mintProject(electronApp: ElectronApplication, prefix: string, name: string) {
  return electronApp.evaluate(
    ({}, arg) =>
      (globalThis as unknown as MainGlobal).__canvasE2EMain.createTempProject(arg.prefix, arg.name),
    { prefix, name }
  )
}

function teardownProjects(electronApp: ElectronApplication, dirs: string[]) {
  return electronApp.evaluate(({}, ds) => {
    const m = (globalThis as unknown as MainGlobal).__canvasE2EMain
    for (const d of ds) m.teardownProject(d)
  }, dirs)
}

async function openFromDisk(page: Page, dir: string): Promise<void> {
  const r = await page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.openProjectFromDisk(d),
    dir
  )
  if (r.status !== 'open') throw new Error(`openProjectFromDisk(${dir}) settled '${r.status}'`)
}

function switchTo(page: Page, dir: string) {
  return page.evaluate(
    (d) => (globalThis as unknown as RendererGlobal).__canvasE2E.switchProjectFromDisk(d, true),
    dir
  )
}

function pidOf(electronApp: ElectronApplication, id: string) {
  return electronApp.evaluate(
    ({}, bid) => (globalThis as unknown as MainGlobal).__canvasE2EMain.terminalPid(bid),
    id
  )
}

function sessionCounts(electronApp: ElectronApplication) {
  return electronApp.evaluate(({}) =>
    (globalThis as unknown as MainGlobal).__canvasE2EMain.ptySessionCounts()
  )
}

function readTerm(page: Page, id: string) {
  return page.evaluate(
    (bid) => (globalThis as unknown as RendererGlobal).__canvasE2E.readTerminal(bid) ?? '',
    id
  )
}

/** Seed a terminal board and wait for its PTY to actually spawn; returns { id, pid }. */
async function seedLiveTerminal(
  page: Page,
  electronApp: ElectronApplication
): Promise<{ id: string; pid: number }> {
  const id = await page.evaluate(() =>
    (globalThis as unknown as RendererGlobal).__canvasE2E.seedBoard('terminal')
  )
  // Poll for a POSITIVE pid: ConPTY (node-pty beta) exposes pid 0 until the agent process
  // actually starts, so a non-null check races the spawn.
  await expect
    .poll(async () => ((await pidOf(electronApp, id)) ?? 0) > 0, { timeout: 20_000 })
    .toBe(true)
  const pid = (await pidOf(electronApp, id)) as number
  expect(pid).toBeGreaterThan(0)
  return { id, pid }
}

test.describe('@terminal background project sessions — keep-running switch', () => {
  test('switch away + back live-reattaches the SAME pid with output produced while backgrounded', async ({
    page,
    electronApp
  }) => {
    // Mint B first, A last (createTempProject flips currentDir; open order re-approves both).
    // Mint→open interleaved: project:open only approves the CURRENT dir (or recents),
    // and createTempProject flips currentDir — so each project is opened right after
    // its mint (which also lands it in recents for the later switches).
    const dirB = await mintProject(electronApp, 'canvas-e2e-bg-b-', 'bg-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-bg-a-', 'bg-a')
    try {
      await openFromDisk(page, dirA)
      const { id, pid } = await seedLiveTerminal(page, electronApp)

      // A marker that keeps producing output while backgrounded (pwsh/powershell/bash all
      // accept their platform's variant).
      const loop =
        process.platform === 'win32'
          ? 'foreach ($i in 1..20) { echo BGTICK-$i; sleep 1 }\r'
          : 'for i in $(seq 1 20); do echo BGTICK-$i; sleep 1; done\r'
      await electronApp.evaluate(
        ({}, arg) =>
          (globalThis as unknown as MainGlobal).__canvasE2EMain.writeTerminal(arg.id, arg.loop),
        { id, loop }
      )
      // First tick lands before the switch (proves the loop started).
      await expect.poll(() => readTerm(page, id), { timeout: 20_000 }).toContain('BGTICK-1')

      // Switch to B with keep — the proc must survive, parked.
      const toB = await switchTo(page, dirB)
      expect(toB.outcome).toBe('switched')
      expect(toB.dir).toBe(dirB)
      await expect.poll(() => sessionCounts(electronApp)).toEqual({ live: 0, parked: 1 })
      expect(await pidOf(electronApp, id)).toBe(pid)
      const alive = await electronApp.evaluate(
        ({}, pids) => (globalThis as unknown as MainGlobal).__canvasE2EMain.pidsAlive(pids),
        [pid]
      )
      expect(alive).toEqual([pid])

      // Let a few background ticks accumulate in the ring.
      await page.waitForTimeout(3_500)

      // Switch back to A with keep — the terminal mount adopts the SAME process.
      const toA = await switchTo(page, dirA)
      expect(toA.outcome).toBe('switched')
      expect(toA.dir).toBe(dirA)
      await expect
        .poll(() => sessionCounts(electronApp), { timeout: 20_000 })
        .toEqual({ live: 1, parked: 0 })
      expect(await pidOf(electronApp, id)).toBe(pid) // live reattach — same process, no respawn

      // Output produced WHILE backgrounded was ring-replayed into the remounted xterm:
      // BGTICK-4+ can only have been emitted after the switch away (ticks are 1/second and
      // the switch happened right after BGTICK-1).
      await expect
        .poll(() => readTerm(page, id), { timeout: 20_000 })
        .toMatch(/BGTICK-[4-9]|BGTICK-1[0-9]/)

      // No "Session restored — read-only" bar: this is a LIVE reattach, not a dead-snapshot
      // restore (M-1 applies to disk restores only).
      await expect(page.locator('text=Session restored')).toHaveCount(0)
    } finally {
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })

  test('a terminal that exits while backgrounded comes back idle with the restored bar', async ({
    page,
    electronApp
  }) => {
    // Mint→open interleaved: project:open only approves the CURRENT dir (or recents),
    // and createTempProject flips currentDir — so each project is opened right after
    // its mint (which also lands it in recents for the later switches).
    const dirB = await mintProject(electronApp, 'canvas-e2e-bgexit-b-', 'bgexit-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-bgexit-a-', 'bgexit-a')
    try {
      await openFromDisk(page, dirA)
      const { id, pid } = await seedLiveTerminal(page, electronApp)

      // Emit a marker (so the switch-time snapshot has content), then arrange the shell's
      // exit ~2s out — it dies while parked. `sleep` = Start-Sleep alias on pwsh/powershell.
      await electronApp.evaluate(
        ({}, arg) =>
          (globalThis as unknown as MainGlobal).__canvasE2EMain.writeTerminal(
            arg.id,
            'echo BGEXIT-MARKER; sleep 2; exit\r'
          ),
        { id }
      )
      await expect.poll(() => readTerm(page, id), { timeout: 20_000 }).toContain('BGEXIT-MARKER')

      const toB = await switchTo(page, dirB)
      expect(toB.outcome).toBe('switched')

      // The proc exits in the background; MAIN drops the parked entry + the OS pid.
      await expect.poll(() => pidOf(electronApp, id), { timeout: 20_000 }).toBe(null)
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              ({}, pids) => (globalThis as unknown as MainGlobal).__canvasE2EMain.pidsAlive(pids),
              [pid]
            ),
          { timeout: 20_000 }
        )
        .toEqual([])

      // Switch back: adopt finds nothing → idle + the read-only restored bar (M-1), showing
      // the switch-time snapshot content. Phase 5 (R6 residue UX): the bar now REPORTS the
      // background death — "Exited in background (code N)" — instead of the plain restored
      // label, so the user learns their agent died rather than blaming a stale snapshot.
      const toA = await switchTo(page, dirA)
      expect(toA.outcome).toBe('switched')
      await expect
        .poll(
          () =>
            page.evaluate(
              (bid) => (globalThis as unknown as RendererGlobal).__canvasE2E.terminalMounted(bid),
              id
            ),
          { timeout: 20_000 }
        )
        .toBe(true)
      await expect(page.locator('text=Exited in background')).toHaveCount(1, { timeout: 20_000 })
      await expect(page.locator('[data-test="terminal-restored-bar"]')).toHaveCount(1)
      await expect.poll(() => readTerm(page, id), { timeout: 20_000 }).toContain('BGEXIT-MARKER')
    } finally {
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })

  test('rapid A→B→A→B→A switching leaves zero orphan sessions and the same live pid', async ({
    page,
    electronApp
  }) => {
    // Mint→open interleaved: project:open only approves the CURRENT dir (or recents),
    // and createTempProject flips currentDir — so each project is opened right after
    // its mint (which also lands it in recents for the later switches).
    const dirB = await mintProject(electronApp, 'canvas-e2e-bgrapid-b-', 'bgrapid-b')
    await openFromDisk(page, dirB)
    const dirA = await mintProject(electronApp, 'canvas-e2e-bgrapid-a-', 'bgrapid-a')
    try {
      await openFromDisk(page, dirA)
      const { id, pid } = await seedLiveTerminal(page, electronApp)

      // Four back-to-back keep-switches. performProjectSwitch serializes via the shared
      // switch lock; the race being stressed is the MAIN park/adopt churn underneath
      // (a mount-time adopt landing after the next switch's park — the R4 re-park path).
      for (const d of [dirB, dirA, dirB, dirA]) {
        const r = await switchTo(page, d)
        expect(r.outcome).toBe('switched')
      }

      // Settled on A: exactly one session total, live, SAME pid — nothing orphaned outside
      // the maps, nothing duplicated, nothing killed.
      await expect
        .poll(() => sessionCounts(electronApp), { timeout: 20_000 })
        .toEqual({ live: 1, parked: 0 })
      expect(await pidOf(electronApp, id)).toBe(pid)
    } finally {
      await teardownProjects(electronApp, [dirA, dirB])
    }
  })

  test('a cloned project sharing board UUIDs must NOT adopt the original project’s session', async ({
    page,
    electronApp
  }) => {
    // Mint clone C first, A last (currentDir ordering — see module doc).
    // Mint→open interleaved: project:open only approves the CURRENT dir (or recents),
    // and createTempProject flips currentDir — so each project is opened right after
    // its mint (which also lands it in recents for the later switches).
    const dirC = await mintProject(electronApp, 'canvas-e2e-bgclone-c-', 'bgclone-c')
    await openFromDisk(page, dirC)
    const dirA = await mintProject(electronApp, 'canvas-e2e-bgclone-a-', 'bgclone-a')
    try {
      await openFromDisk(page, dirA)
      const { id, pid } = await seedLiveTerminal(page, electronApp)

      // Clone A's canvas (same board UUIDs) into C — the git-clone/copy scenario.
      const doc = await page.evaluate(() =>
        (globalThis as unknown as RendererGlobal).__canvasE2E.serializeDoc()
      )
      await electronApp.evaluate(
        ({}, arg) =>
          (globalThis as unknown as MainGlobal).__canvasE2EMain.writeProjectFile(
            arg.dir,
            '.canvas/canvas.json',
            arg.doc
          ),
        { dir: dirC, doc }
      )

      // Background A, land on the clone. Its identical terminal board mounts and tries to
      // adopt — the owner check must refuse (A's agent shell must never surface in C).
      const toC = await switchTo(page, dirC)
      expect(toC.outcome).toBe('switched')
      expect(toC.boardCount).toBeGreaterThan(0)
      await expect
        .poll(
          () =>
            page.evaluate(
              (bid) => (globalThis as unknown as RendererGlobal).__canvasE2E.terminalMounted(bid),
              id
            ),
          { timeout: 20_000 }
        )
        .toBe(true)
      // Give a raced adopt a beat to (incorrectly) land, then assert A's session is STILL
      // parked and nothing went live for the clone's identical board id.
      await page.waitForTimeout(1_000)
      expect(await sessionCounts(electronApp)).toEqual({ live: 0, parked: 1 })
      expect(await pidOf(electronApp, id)).toBe(pid) // the parked original, untouched

      // Switch back — the true owner adopts the SAME process.
      const toA = await switchTo(page, dirA)
      expect(toA.outcome).toBe('switched')
      await expect
        .poll(() => sessionCounts(electronApp), { timeout: 20_000 })
        .toEqual({ live: 1, parked: 0 })
      expect(await pidOf(electronApp, id)).toBe(pid)
    } finally {
      await teardownProjects(electronApp, [dirA, dirC])
    }
  })
})
