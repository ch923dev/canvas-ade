// e2e/terminalSave.e2e.ts
//
// Phase 5 · S1 — save terminal output to a .txt file. Covers the part the unit tests can't:
// the renderer→MAIN boundary. Reads the live buffer (readTerminal), hands it to the real
// `terminal:saveOutput` IPC with only the native OS save dialog stubbed MAIN-side, then
// reads the written file back (the __canvasE2EMain registry) and asserts every seeded line
// survived. (The serialize / filename / toast logic is unit-tested in
// terminalSaveOutput.test.ts.) Uses an `exit`-launched (dead) PTY so the live shell can't
// race the buffer.
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const readBuf = (id: string): string => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
const save = (text: string, name: string): string =>
  `window.api.terminal.saveOutput(${JSON.stringify({ text, suggestedName: name })})`
// 120 lines with stable L### markers — comfortably more than one viewport (real scrollback).
const WRITE_LINES = `Array.from({length: 120}, (_, i) => 'L' + String(i).padStart(3,'0') + '=' + 'x'.repeat(40)).join('\\r\\n')`

interface SaveResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

test.describe('@terminal save output to file (S1)', () => {
  test('writes the full buffer to the chosen path; cancel is a silent no-op', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'exit' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    expect(
      await pollEval(page, `(${readBuf(id)} || '').includes('process exited')`, 8000),
      'shell exited (PTY drained — no further output to race)'
    ).toBe(true)
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, ${WRITE_LINES})`
    )
    expect(
      await pollEval(page, `(${readBuf(id)}.match(/L\\d{3}/g) || []).length === 120`, 6000),
      'buffer filled with 120 marker lines'
    ).toBe(true)

    // A writable temp target + a stubbed save dialog that "confirms" it (the renderer never
    // sees a path — MAIN owns the dialog; we only replace its result).
    const tempDir = await electronApp.evaluate(({ app }) => app.getPath('temp'))
    const tmpPath = await mainCall<string>(
      electronApp,
      'joinPath',
      tempDir,
      'canvas-e2e-termsave.txt'
    )
    await electronApp.evaluate(({ dialog }, p) => {
      const d = dialog as unknown as { showSaveDialog: unknown; __orig?: unknown }
      d.__orig ??= d.showSaveDialog
      d.showSaveDialog = async () => ({ canceled: false, filePath: p })
    }, tmpPath)

    const text = await evalIn<string>(page, readBuf(id))
    const res = await evalIn<SaveResult>(page, save(text, 'e2e-save.txt'))
    expect(res.ok, 'save resolved ok').toBe(true)
    expect(res.path).toBe(tmpPath)

    const content = await mainCall<string | null>(electronApp, 'readTextFile', tmpPath)
    expect(content, 'file was written').not.toBeNull()
    expect((content!.match(/L\d{3}/g) || []).length, 'every marker written').toBeGreaterThanOrEqual(
      120
    )
    expect(content).toContain('L000=')
    expect(content).toContain('L119=')

    // Cancel → the dialog reports canceled; the result is a silent no-op (no throw, no write).
    await electronApp.evaluate(({ dialog }) => {
      ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
        canceled: true,
        filePath: undefined
      })
    })
    const canceled = await evalIn<SaveResult>(page, save(text, 'e2e-save.txt'))
    expect(canceled.ok, 'cancel is not ok').toBe(false)
    expect(canceled.canceled, 'cancel flagged').toBe(true)

    // Restore the real dialog so the stub can't leak to another spec in this worker.
    await electronApp.evaluate(({ dialog }) => {
      const d = dialog as unknown as { showSaveDialog: unknown; __orig?: unknown }
      if (d.__orig) d.showSaveDialog = d.__orig
    })
  })
})
