import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

/**
 * @mcp External MCP servers — the net-new "add external MCP server" feature, e2e.
 *
 * Two real round-trips (no hand-staged config, no mocks):
 *  - UI: open Settings → the MCP Servers manager → add an http server → it lists (the full
 *    UI → `window.api.mcpServers` IPC → encrypted store → masked list path).
 *  - On-disk: enable a server targeting `claude`, spawn a real `claude` terminal in a temp project,
 *    and assert its entry lands in that project's `.mcp.json`; then disable it and assert the entry
 *    is removed (the spawn-time writer + the onRegistryChanged cleanup).
 *
 * Keyring-independence: both use a server with NO secret value, so `save` never needs safeStorage
 * (unavailable on the headless Linux leg) — the encrypted-secret round-trip is covered by the unit
 * tests. 🔒 No secret value is ever written or asserted here.
 */

interface McpJson {
  mcpServers?: Record<string, { type?: string; url?: string }>
}

test('@chrome @mcp settings: add an external MCP server and see it listed', async ({
  page
}, testInfo) => {
  await page.click('[title="Settings"]')
  await expect(page.locator('[data-test="settings-panel"]')).toBeVisible()
  // The MCP section lives in the "Agents & AI" group tab.
  await page.click('[data-test="settings-tab-agents"]')

  const manager = page.locator('[data-test="mcp-servers-manager"]')
  await manager.scrollIntoViewIfNeeded()
  await expect(manager).toBeVisible()

  // Open the Add form, fill an http server (no secret). Screenshot the form (design check).
  await page.click('[data-test="mcp-add-server"]')
  await page.fill('[data-test="mcp-form-name"]', 'e2e-ui-server')
  await page.fill('[aria-label="Server URL"]', 'https://example.test/mcp')
  await expect(page.locator('[data-test="mcp-form-test"]')).toBeVisible()
  await page.locator('[data-test="settings-panel"]').screenshot({
    path: testInfo.outputPath('mcp-form.png')
  })
  await page.click('[data-test="mcp-form-save"]')

  // The new row appears in the manager list (the full IPC round-trip landed). Screenshot the list.
  await expect(page.locator('[data-test="mcp-row-e2e-ui-server"]')).toBeVisible()
  await page.locator('[data-test="settings-panel"]').screenshot({
    path: testInfo.outputPath('mcp-list.png')
  })

  // Clean up the global (userData) registry so the row doesn't leak into other specs.
  await evalIn(
    page,
    `window.api.mcpServers.list().then(l => Promise.all(l.filter(s=>s.name==='e2e-ui-server').map(s=>window.api.mcpServers.remove(s.id))))`
  )
})

test('@mcp on-disk: an enabled server is written into a spawned claude terminal, then removed on disable', async ({
  page,
  electronApp
}) => {
  test.slow()
  const tmp = await mainCall<string>(electronApp, 'createTempProject', 'mcpext-', 'mcpext')
  const mcpFile = await mainCall<string>(electronApp, 'joinPath', tmp, '.mcp.json')

  // Register an http server (no headers) targeting claude, enabled — over the real IPC.
  const saved = await evalIn<{ ok: boolean; id?: string }>(
    page,
    `window.api.mcpServers.save(${JSON.stringify({
      name: 'e2e-disk-server',
      enabled: true,
      transport: 'http',
      url: 'https://example.test/mcp',
      targets: ['claude']
    })})`
  )
  expect(saved.ok, 'save persisted').toBe(true)
  const id = saved.id as string

  try {
    // Spawn a real claude terminal whose cwd is the temp project — the synchronous spawn-time
    // external writer lays the config before the launch line.
    const board = await seed(page, 'terminal', { launchCommand: 'claude', cwd: tmp })
    await expect
      .poll(() => mainCall<number | null>(electronApp, 'terminalPid', board), { timeout: 12_000 })
      .not.toBeNull()

    // The server's entry is on disk in the project's .mcp.json.
    await expect
      .poll(() => mainCall<boolean>(electronApp, 'fileExists', mcpFile), { timeout: 8000 })
      .toBe(true)
    const raw = await mainCall<string | null>(electronApp, 'readTextFile', mcpFile)
    const parsed = JSON.parse(raw ?? '{}') as McpJson
    expect(parsed.mcpServers?.['e2e-disk-server']).toMatchObject({
      type: 'http',
      url: 'https://example.test/mcp'
    })

    // Disable it → the onRegistryChanged cleanup removes the entry from the tracked project dir.
    await evalIn(page, `window.api.mcpServers.setEnabled(${JSON.stringify(id)}, false)`)
    await expect
      .poll(
        async () => {
          const after = await mainCall<string | null>(electronApp, 'readTextFile', mcpFile)
          if (after === null) return false // file removed (it held only our entry)
          return !!(JSON.parse(after) as McpJson).mcpServers?.['e2e-disk-server']
        },
        { timeout: 8000 }
      )
      .toBe(false)
  } finally {
    await evalIn(page, `window.api.mcpServers.remove(${JSON.stringify(id)})`)
  }
})
