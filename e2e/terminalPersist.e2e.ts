// e2e/terminalPersist.e2e.ts
//
// Phase 5 · S3 — persist terminal scrollback across restart. Covers the part the unit tests can't:
// the renderer→MAIN→disk boundary. Opens a throwaway project (so MAIN's getCurrentDir() is set),
// seeds a dead (`exit`) PTY, fills its buffer with stable markers, drives the REAL snapshot flush
// (`flushTerminalSnapshots` — the same registry path quit/close/switch take), then asserts the
// sidecar landed under `<project>/.canvas/terminal/<id>.snapshot` with every marker, reads it back
// through the real `terminal:readSnapshot` IPC, and confirms `terminal:deleteSnapshot` removes it.
// (The path/cap/round-trip logic is unit-tested in terminalSnapshot.test.ts; the registry
// skip-empty/best-effort logic in terminalSnapshotRegistry.test.ts. The restore-render — idle board
// shows the read-only buffer + "Session restored" bar — is a relaunch surface, covered by the
// mandatory manual dev check.)
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { apiCall, callE2E, evalIn, mainCall, pollCall, seed } from './helpers'

// Typed VALUE reader — the id crosses as a real argument (structured clone), never spliced into
// an eval'd code string (CodeQL js/bad-code-sanitization).
const readBuf = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })
// 120 lines with stable L### markers — comfortably more than one viewport (real scrollback).
// Built HERE and passed to `resetTerminalWrite` as an argument (it used to be a generator
// expression evaluated in the page — the same code-string sink the ids were).
const WRITE_LINES = Array.from(
  { length: 120 },
  (_, i) => 'L' + String(i).padStart(3, '0') + '=' + 'x'.repeat(40)
).join('\r\n')

/** Poll a predicate over the terminal buffer text — the comparison runs HERE in Node. Same
 *  boolean contract as `pollEval`. */
async function pollBuf(
  page: Page,
  id: string,
  pred: (b: string | null) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect.poll(async () => pred(await readBuf(page, id)), { timeout: timeoutMs }).toBe(true)
    return true
  } catch {
    return false
  }
}

test.describe('@terminal persist scrollback across restart (S3)', () => {
  test('flush writes the sidecar; read round-trips; delete removes it', async ({
    page,
    electronApp
  }) => {
    // A throwaway project so MAIN's getCurrentDir() resolves the `.canvas/terminal/` write target.
    const proj = await mainCall<string>(
      electronApp,
      'createTempProject',
      'canvas-e2e-persist-',
      'persist-e2e'
    )
    try {
      const id = await seed(page, 'terminal', { launchCommand: 'exit' })
      await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 8000)
      expect(
        await pollBuf(page, id, (b) => (b || '').includes('process exited'), 8000),
        'shell exited (PTY drained — no further output to race)'
      ).toBe(true)
      await callE2E(page, { m: 'resetTerminalWrite', a: [id, WRITE_LINES] })
      expect(
        await pollBuf(page, id, (b) => ((b ?? '').match(/L\d{3}/g) || []).length === 120, 6000),
        'buffer filled with 120 marker lines'
      ).toBe(true)

      // Drive the real flush (serialize → terminal:writeSnapshot → write-file-atomic under .canvas/).
      await evalIn(page, `window.__canvasE2E.flushTerminalSnapshots()`)

      const snapPath = await mainCall<string>(
        electronApp,
        'joinPath',
        proj,
        '.canvas',
        'terminal',
        `${id}.snapshot`
      )
      expect(await mainCall<boolean>(electronApp, 'fileExists', snapPath), 'sidecar written').toBe(
        true
      )
      const onDisk = await mainCall<string | null>(electronApp, 'readTextFile', snapPath)
      expect(onDisk, 'sidecar readable').not.toBeNull()
      expect(
        (onDisk!.match(/L\d{3}/g) || []).length,
        'every marker serialized to the sidecar'
      ).toBeGreaterThanOrEqual(120)
      expect(onDisk).toContain('L000=')
      expect(onDisk).toContain('L119=')

      // Read it back through the real preload → MAIN IPC (what the restore path uses on mount).
      const viaIpc = await apiCall<string | null>(page, 'terminal.readSnapshot', id)
      expect(viaIpc, 'readSnapshot returns the persisted buffer').not.toBeNull()
      expect((viaIpc!.match(/L\d{3}/g) || []).length).toBeGreaterThanOrEqual(120)

      // Delete (the board-removal path) drops the sidecar; a subsequent read is null.
      const deleted = await apiCall<boolean>(page, 'terminal.deleteSnapshot', id)
      expect(deleted, 'delete resolved ok').toBe(true)
      expect(await mainCall<boolean>(electronApp, 'fileExists', snapPath), 'sidecar removed').toBe(
        false
      )
      expect(
        await apiCall<string | null>(page, 'terminal.readSnapshot', id),
        'read after delete is null'
      ).toBeNull()
    } finally {
      await mainCall(electronApp, 'teardownProject', proj)
    }
  })
})
