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
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const readBuf = (id: string): string => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
// 120 lines with stable L### markers — comfortably more than one viewport (real scrollback).
const WRITE_LINES = `Array.from({length: 120}, (_, i) => 'L' + String(i).padStart(3,'0') + '=' + 'x'.repeat(40)).join('\\r\\n')`

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
      const viaIpc = await evalIn<string | null>(
        page,
        `window.api.terminal.readSnapshot(${JSON.stringify(id)})`
      )
      expect(viaIpc, 'readSnapshot returns the persisted buffer').not.toBeNull()
      expect((viaIpc!.match(/L\d{3}/g) || []).length).toBeGreaterThanOrEqual(120)

      // Delete (the board-removal path) drops the sidecar; a subsequent read is null.
      const deleted = await evalIn<boolean>(
        page,
        `window.api.terminal.deleteSnapshot(${JSON.stringify(id)})`
      )
      expect(deleted, 'delete resolved ok').toBe(true)
      expect(await mainCall<boolean>(electronApp, 'fileExists', snapPath), 'sidecar removed').toBe(
        false
      )
      expect(
        await evalIn<string | null>(
          page,
          `window.api.terminal.readSnapshot(${JSON.stringify(id)})`
        ),
        'read after delete is null'
      ).toBeNull()
    } finally {
      await mainCall(electronApp, 'teardownProject', proj)
    }
  })
})
