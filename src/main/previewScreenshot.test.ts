import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  registerPreviewScreenshotHandler,
  saveScreenshot,
  screenshotFileName,
  type ScreenshotDeps
} from './previewScreenshot'
import { foreignEvent, mainWin } from './ipcTestHarness'
import { listLibrary } from './projectLibrary'
import { assetsDirOf, createProject, readProject, sweepOrphanAssets } from './projectStore'

// Minimal ipcMain capture (mirrors clipboardIpc.test.ts style).
function makeIpc(): {
  ipc: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => void }
  invoke: (ch: string, e: unknown, ...a: unknown[]) => unknown
} {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  return {
    ipc: { handle: (ch, fn) => handlers.set(ch, fn) },
    invoke: (ch, e, ...a) => handlers.get(ch)!(e, ...a)
  }
}

const PNG = Buffer.from([1, 2, 3])
function deps(over: Partial<ScreenshotDeps> = {}): ScreenshotDeps {
  return {
    capture: vi.fn(async () => PNG),
    writeImage: vi.fn(),
    currentDir: vi.fn(() => '/proj'),
    saveShot: vi.fn(async () => ({ relPath: 'downloads/screenshot-x.png' })),
    ...over
  }
}

// No senderFrame -> isForeignSender returns false (internal/allowed), like the e2e harness.
// (See ipcGuard.ts: `if (!e.senderFrame) return false`)
const validEvent = {}

describe('preview:screenshot', () => {
  it('copies to clipboard AND saves a file when a project is open', async () => {
    const m = makeIpc()
    const d = deps()
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).toHaveBeenCalledWith(PNG)
    expect(d.saveShot).toHaveBeenCalledWith('/proj', PNG)
    expect(res).toEqual({ ok: true, relPath: 'downloads/screenshot-x.png', clipboardOk: true })
  })

  it('copies to clipboard only when no project is open', async () => {
    const m = makeIpc()
    const d = deps({ currentDir: () => null })
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).toHaveBeenCalled()
    expect(d.saveShot).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, relPath: null, clipboardOk: true })
  })

  it('returns not-live when the view is detached/off-screen (capture null)', async () => {
    const m = makeIpc()
    const d = deps({ capture: async () => null })
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: false, reason: 'not-live' })
  })

  it('still reports success (relPath null) when the file write fails', async () => {
    const m = makeIpc()
    const d = deps({
      saveShot: async () => {
        throw new Error('ENOSPC')
      }
    })
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.writeImage).toHaveBeenCalled()
    expect(res).toEqual({ ok: true, relPath: null, clipboardOk: true })
  })

  it('still saves the file when the clipboard write throws (headless)', async () => {
    const m = makeIpc()
    const d = deps({
      writeImage: () => {
        throw new Error('clipboard unavailable')
      }
    })
    registerPreviewScreenshotHandler(m.ipc as never, mainWin, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(res).toEqual({ ok: true, relPath: 'downloads/screenshot-x.png', clipboardOk: false })
  })

  // BUG-028 regression: clipboard write throws AND nothing can be saved (no project
  // open) — the result must NOT read as "copied to clipboard" (the old shape had no
  // way to convey the clipboard failure, so a total failure surfaced as success).
  it('reports clipboardOk:false when the clipboard write throws and no project is open', async () => {
    const m = makeIpc()
    const d = deps({
      writeImage: () => {
        throw new Error('clipboard unavailable')
      },
      currentDir: () => null
    })
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(d.saveShot).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, relPath: null, clipboardOk: false })
  })

  // BUG-028 regression: clipboard threw and the file save ALSO failed — both flags
  // must reflect the total failure (the old catch comment asserted "the clipboard
  // copy already succeeded", which was false).
  it('reports clipboardOk:false with assetId null when both clipboard and save fail', async () => {
    const m = makeIpc()
    const d = deps({
      writeImage: () => {
        throw new Error('clipboard unavailable')
      },
      saveShot: async () => {
        throw new Error('ENOSPC')
      }
    })
    registerPreviewScreenshotHandler(m.ipc as never, () => null, d)
    const res = await m.invoke('preview:screenshot', validEvent, 'b1')
    expect(res).toEqual({ ok: true, relPath: null, clipboardOk: false })
  })

  it('rejects a foreign sender (no capture, no clipboard)', async () => {
    // Uses mainWin + foreignEvent from ipcTestHarness: mainWin returns a live window
    // (isDestroyed: false, webContents.isDestroyed: false) so isForeignSender reaches
    // the `senderFrame !== win.webContents.mainFrame` comparison (not the !win branch).
    // foreignEvent.senderFrame ({ id: 'preview-board-frame' }) !== mainFrame
    // ({ id: 'main-frame' }) → returns true for the RIGHT reason (frame mismatch).
    const m = makeIpc()
    const d = deps()
    registerPreviewScreenshotHandler(m.ipc as never, mainWin, d)
    const res = await m.invoke('preview:screenshot', foreignEvent, 'b1')
    expect(d.capture).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: false, reason: 'forbidden' })
  })
})

// The defect this pins: a Browser-board screenshot used to be content-addressed into
// `.canvas/assets/`, but NO document ever stores a screenshot's id — so the mark-and-sweep that
// runs on every project open (`sweepOrphanAssets` over the docs' live set) quarantined it into
// `assets/.trash/` and it vanished from the Project Library after one quit + relaunch.
describe('saveScreenshot — survives the project-open asset sweep', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-shot-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is still on disk and listed in the Library after the open-time GC', async () => {
    await createProject(dir, 'shots', {})
    const bytes = Buffer.from('not-really-a-png')
    const { relPath } = await saveScreenshot(dir, bytes)

    // What `project:open` / `project:current` do next launch: the one open-time sweep, against
    // every id canvas.json ∪ .bak ∪ session.json reference. A screenshot is referenced by
    // nothing, by design.
    const opened = readProject(dir)
    if (!opened.ok) throw new Error('fixture project failed to open')
    sweepOrphanAssets(dir, opened.doc, opened.session)

    const abs = join(dir, '.canvas', relPath)
    expect(existsSync(abs), `screenshot still at .canvas/${relPath}`).toBe(true)
    expect(readFileSync(abs).equals(bytes)).toBe(true)
    const lib = listLibrary(dir)
    expect([...lib.downloads, ...lib.assets].map((i) => i.relPath)).toContain(relPath)
    expect(existsSync(join(assetsDirOf(dir), '.trash')), 'nothing was quarantined').toBe(false)
  })

  it('writes downloads/screenshot-<local timestamp>.png, creating the dir on first use', async () => {
    const at = new Date(2026, 10, 5, 9, 3, 7) // local time; single-digit fields get zero-padded
    expect(screenshotFileName(at)).toBe('screenshot-2026-11-05-090307.png')
    expect(existsSync(join(dir, '.canvas', 'downloads'))).toBe(false)
    const { relPath } = await saveScreenshot(dir, Buffer.from('a'), at)
    expect(relPath).toBe('downloads/screenshot-2026-11-05-090307.png')
    expect(readFileSync(join(dir, '.canvas', relPath), 'utf8')).toBe('a')
  })

  it('never overwrites: same-second captures, even concurrent ones, each keep a file', async () => {
    const at = new Date(2026, 10, 5, 9, 3, 7)
    // Fired together, NOT awaited in turn: both would pick the same free name if the
    // pick-then-write were not serialized, and the second rename would replace the first file.
    const [a, b] = await Promise.all([
      saveScreenshot(dir, Buffer.from('first'), at),
      saveScreenshot(dir, Buffer.from('second'), at)
    ])
    const c = await saveScreenshot(dir, Buffer.from('third'), at)
    expect([a.relPath, b.relPath, c.relPath]).toEqual([
      'downloads/screenshot-2026-11-05-090307.png',
      'downloads/screenshot-2026-11-05-090307 (1).png',
      'downloads/screenshot-2026-11-05-090307 (2).png'
    ])
    expect(readFileSync(join(dir, '.canvas', a.relPath), 'utf8')).toBe('first')
    expect(readFileSync(join(dir, '.canvas', b.relPath), 'utf8')).toBe('second')
    expect(readdirSync(join(dir, '.canvas', 'downloads'))).toHaveLength(3)
  })

  it('a failed save rejects without wedging the next one', async () => {
    // A FILE where the project dir should be: mkdir of `.canvas/downloads` under it fails.
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'x')
    await expect(saveScreenshot(blocked, Buffer.from('a'))).rejects.toThrow()
    const ok = await saveScreenshot(dir, Buffer.from('b'))
    expect(existsSync(join(dir, '.canvas', ok.relPath))).toBe(true)
  })
})
