import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @mcp Agent Orchestration Onboarding — the SHIPPED onboarding path (consent → provisioner), e2e.
 *
 * The connected-tier RELAY authority is proven in `mcp.e2e.ts` (the own-cable relay test). What
 * that test deliberately leaves to "P1/P3" is the umbrella's headline promise: a CONSENTED
 * terminal gets its CLI auto-configured to reach the loopback MCP server — with NO hand-staged
 * `.mcp.json`. This spec drives the REAL consent IPC (`window.api.orchestration.setConsent`) and
 * the REAL spawn-time provisioner hook (`pty.ts`) and asserts the on-disk artifact:
 *   - consent ON  + a `claude` terminal spawn → `.mcp.json` (loopback url + a Bearer header) and
 *     `.claude/settings.local.json` (`enabledMcpjsonServers` carries `canvas-ade`) are written;
 *   - revoking consent → those entries are removed (the unsync path);
 *   - consent OFF → nothing is written.
 *
 * 🔒 Token safety: the Authorization header is asserted by SHAPE only (`/^Bearer .+/`) — never the
 * value, never logged. The raw token never leaves MAIN; the renderer only ever sees a fixed mask.
 *
 * Isolation: explicit createTempProject + finally-teardown (the recap.e2e.ts pattern). The temp
 * dir becomes the current MAIN project, so `setConsent` and the spawn hook both resolve to it; the
 * terminal is seeded with `cwd: tmp` so the provisioner writes INSIDE the temp project (a board
 * with no cwd falls back to the home dir via `safeCwd`), and teardown removes the whole tree.
 */

const SERVER = 'canvas-ade'

interface McpJsonShape {
  mcpServers?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>
}
interface SettingsLocalShape {
  enabledMcpjsonServers?: string[]
}

/** Drive the real consent IPC and assert it persisted. */
async function setConsent(page: Page, decision: 'enabled' | 'declined'): Promise<void> {
  const r = await evalIn<{ ok: boolean }>(
    page,
    `window.api.orchestration.setConsent(${JSON.stringify(decision)})`
  )
  expect(r.ok, `setConsent(${decision}) persisted`).toBe(true)
}

test('@mcp consent ON: a spawned claude terminal auto-writes the MCP config; revoke removes it', async ({
  page,
  electronApp
}) => {
  test.slow()
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'orch-on-', 'orch-on')
  const mcpFile = await mainCall<string>(electronApp, 'joinPath', tmp, '.mcp.json')
  const settingsFile = await mainCall<string>(
    electronApp,
    'joinPath',
    tmp,
    '.claude',
    'settings.local.json'
  )
  try {
    // Clean slate: the provisioner has not run yet (no hand-staged config).
    expect(await mainCall<boolean>(electronApp, 'fileExists', mcpFile)).toBe(false)

    // Grant consent for THIS project over the real IPC, then spawn a real `claude` terminal whose
    // cwd is the temp project — the synchronous spawn-time hook writes the config before the launch.
    await setConsent(page, 'enabled')
    const id = await seed(page, 'terminal', { launchCommand: 'claude', cwd: tmp })

    // The PTY actually spawned (pid present) ⇒ the spawn handler — and the synchronous provisioner
    // hook within it — has run, so the config is already on disk.
    await expect
      .poll(() => mainCall<number | null>(electronApp, 'terminalPid', id), { timeout: 12_000 })
      .not.toBeNull()
    await expect
      .poll(() => mainCall<boolean>(electronApp, 'fileExists', mcpFile), { timeout: 8000 })
      .toBe(true)

    // `.mcp.json` carries our server entry pointing at the LIVE loopback endpoint + a bearer header.
    const info = await mainCall<{ port: number } | null>(electronApp, 'mcpInfo')
    expect(info, 'MCP server mounted in e2e').not.toBeNull()
    const mcpRaw = await mainCall<string | null>(electronApp, 'readTextFile', mcpFile)
    expect(mcpRaw).not.toBeNull()
    const entry = (JSON.parse(mcpRaw as string) as McpJsonShape).mcpServers?.[SERVER]
    expect(entry, 'canvas-ade server entry present').toBeTruthy()
    expect(entry?.type).toBe('http')
    expect(entry?.url).toBe(`http://127.0.0.1:${info?.port}/mcp`)
    // 🔒 SHAPE only — never assert (or log) the token value.
    expect(entry?.headers?.Authorization ?? '').toMatch(/^Bearer .+/)

    // `.claude/settings.local.json` enables our server id (the zero-prompt trust path).
    const setRaw = await mainCall<string | null>(electronApp, 'readTextFile', settingsFile)
    expect(setRaw, 'settings.local.json written').not.toBeNull()
    const settings = JSON.parse(setRaw as string) as SettingsLocalShape
    expect(settings.enabledMcpjsonServers ?? []).toContain(SERVER)

    // Revoke → the consent-change unsync removes our entry (the file held only ours → it is deleted).
    await setConsent(page, 'declined')
    await expect
      .poll(() => mainCall<boolean>(electronApp, 'fileExists', mcpFile), { timeout: 8000 })
      .toBe(false)
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})

test('@mcp consent OFF: a spawned claude terminal writes NO MCP config', async ({
  page,
  electronApp
}) => {
  test.slow()
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'orch-off-', 'orch-off')
  const mcpFile = await mainCall<string>(electronApp, 'joinPath', tmp, '.mcp.json')
  try {
    // Explicitly decline (a fresh project also defaults closed — assert the GATE, not the default).
    await setConsent(page, 'declined')
    const id = await seed(page, 'terminal', { launchCommand: 'claude', cwd: tmp })

    // Once the PTY is up, the synchronous spawn hook has already run — and, with no consent, it
    // must have skipped the write. No timer needed: the write (or skip) is done before pid is set.
    await expect
      .poll(() => mainCall<number | null>(electronApp, 'terminalPid', id), { timeout: 12_000 })
      .not.toBeNull()
    expect(await mainCall<boolean>(electronApp, 'fileExists', mcpFile)).toBe(false)
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})
