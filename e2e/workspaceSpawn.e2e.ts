import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, mainCall, seed } from './helpers'

/**
 * Project Workspaces — WS-3 spawn path (docs/research/2026-11-02-project-workspaces §4.2), through
 * the REAL renderer → `pty:spawn` → MAIN → node-pty chain:
 *  - a workspace terminal starts in its workspace root and carries CANVAS_WORKSPACE_*; a
 *    project-level terminal in the same project starts in the project dir and carries none;
 *  - a workspace whose folder is gone gets a VISIBLE spawn error naming the folder, and no process
 *    at all — never the silent `$HOME` fallback a project-level board keeps.
 *
 * The probe is `node -e` (shell-agnostic: pwsh / powershell / cmd / bash all pass one double-quoted
 * arg through, and the script has no `$` / `!` to expand). It compares REALPATHS inside the PTY, so
 * an 8.3 / junction temp dir can't fake a mismatch, and prints one short marker the framebuffer read
 * can match even on a narrow board.
 */

const readTerm = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })

async function termIncludes(page: Page, id: string, needle: string, timeout: number) {
  let last: string | null = null
  try {
    await expect
      .poll(
        async () => {
          last = await readTerm(page, id)
          return last?.includes(needle) ?? false
        },
        { timeout }
      )
      .toBe(true)
  } catch {
    // Surface what the board DID show — the difference between "wrong cwd" and "never ran".
    throw new Error(`framebuffer never showed ${needle}:\n${last ?? '(none)'}`)
  }
}

/** A one-line `node -e` that prints `<tag>=<cwd matches want>/<CANVAS_WORKSPACE_ID or none>`. */
function cwdProbe(tag: string, want: string): string {
  const w = want.replace(/\\/g, '/')
  const js =
    `const f=require('fs');const r=p=>f.realpathSync.native(p).toLowerCase();` +
    `console.log('${tag}='+(r(process.cwd())===r('${w}'))+'/'+(process.env.CANVAS_WORKSPACE_ID||'none'))`
  return `node -e "${js}"`
}

test.describe('@terminal project workspaces — spawn path (WS-3)', () => {
  let tmp = ''

  test.beforeEach(async ({ page, electronApp }) => {
    tmp = await mainCall<string>(electronApp, 'createTempProject', 'ws3-', 'ws3-spawn')
    const opened = await callE2E<{ status: string }>(page, { m: 'openProjectFromDisk', a: [tmp] })
    expect(opened.status, 'fresh temp project opens clean').toBe('open')
  })

  test.afterEach(async ({ electronApp }) => {
    // Kill the shells first: on Windows a live shell's cwd pins its folder against the rm below.
    await mainCall(electronApp, 'disposeAllPtys')
    await mainCall(electronApp, 'teardownProject', tmp)
  })

  test('a workspace terminal starts in its root with CANVAS_WORKSPACE_*; a project one does not', async ({
    page
  }) => {
    const apiDir = path.join(tmp, 'api')
    fs.mkdirSync(apiDir)
    const wsId = await callE2E<string | null>(page, {
      m: 'createWorkspace',
      a: [{ name: 'API', goal: 'build auth', root: 'api' }]
    })
    expect(wsId, 'workspace created').not.toBeNull()

    // Seeded in the SAME turn as the workspace: MAIN's mirror (150ms publish debounce) may not know
    // the id yet when the spawn lands — the settle-wait in resolveSpawnCwd covers that gesture.
    const wsTerm = await seed(page, 'terminal', {
      workspaceId: wsId,
      w: 760,
      launchCommand: cwdProbe('WSPROBE', apiDir)
    })
    const projTerm = await seed(page, 'terminal', {
      w: 760,
      launchCommand: cwdProbe('PJPROBE', tmp)
    })

    // Frame each board before reading it: an off-screen board HOLDS its PTY bytes until it is live,
    // and where the seed cursor lands depends on what ran earlier in this worker.
    await callE2E(page, { m: 'fitView', a: [wsTerm] })
    await termIncludes(page, wsTerm, `WSPROBE=true/${wsId}`, 30_000)
    await callE2E(page, { m: 'fitView', a: [projTerm] })
    await termIncludes(page, projTerm, 'PJPROBE=true/none', 30_000)
  })

  test('a deleted workspace folder is a visible spawn error — no process, never $HOME', async ({
    page,
    electronApp
  }) => {
    const wsId = await callE2E<string | null>(page, {
      m: 'createWorkspace',
      a: [{ name: 'API', goal: '', root: 'api' }] // api/ never exists on disk
    })
    const id = await seed(page, 'terminal', { workspaceId: wsId, w: 760 })
    await callE2E(page, { m: 'fitView', a: [id] })

    await termIncludes(page, id, 'spawn failed:', 30_000)
    const text = (await readTerm(page, id)) ?? ''
    // The sentence may wrap in the framebuffer; match its parts, not one long line.
    expect(text).toContain('Workspace "API" folder is missing')
    expect(text).toContain('(api/)')
    expect(await mainCall<number | null>(electronApp, 'terminalPid', id), 'no PTY spawned').toBe(
      null
    )
  })
})
