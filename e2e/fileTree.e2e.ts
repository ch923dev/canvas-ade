import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval } from './helpers'

/**
 * File-tree epic (S2) — the docked file tree end-to-end through the REAL stack:
 *   project:open → onProjectOpen → fileWatch.ts (chokidar) emits `file:treeEvent`
 *   FileTree.listDir (S1 IPC) → rows → openFileBoard (S1 action) → a File board.
 *
 * The panel auto-hides. Since SLICE-013 the FileTree is lazy and only MOUNTS once the panel has
 * been revealed at least once (its react-arborist/react-window chunk loads on first open, not at
 * boot), so each probe reveals the panel first (`revealSidePanel()`); after that the rows stay in
 * the DOM (laid out, just opacity:0) — so DOM queries + programmatic `el.click()` exercise the
 * wiring without driving real pointer occlusion (and they work through the recap-consent scrim,
 * which only blocks REAL pointer events). Lazy per-folder expansion + the immutable tree merges are
 * covered by the fileTreeData unit tests + the watcher mapping by fileWatch unit tests; here we
 * prove the live integration.
 */
test.describe('@chrome file tree side panel (S2)', () => {
  test('lists the project files and opens one as a File board', async ({ page, electronApp }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'filetree-', 'filetree')
    try {
      await mainCall(electronApp, 'writeProjectFile', tmp, 'README.md', '# hi\n')
      await mainCall(electronApp, 'writeProjectFile', tmp, 'alpha.ts', 'export {}\n')
      const res = await evalIn<{ status: string }>(
        page,
        `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
      )
      expect(res.status, 'project opened').toBe('open')
      // SLICE-013: the FileTree is lazy — reveal the panel so it mounts before we probe its rows.
      await evalIn(page, `window.__canvasE2E.revealSidePanel()`)

      const listed = await pollEval(
        page,
        `!!Array.from(document.querySelectorAll('.ca-ftree-row')).find((r) => r.title === 'README.md')`,
        4000
      )
      expect(listed, 'the tree lists the project files via api.file.listDir').toBe(true)

      // Programmatic click (fires the row's React onClick through the panel's hidden state).
      await evalIn(
        page,
        `(() => { const r = Array.from(document.querySelectorAll('.ca-ftree-row')).find((x) => x.title === 'README.md'); if (!r) throw new Error('README.md row not found'); r.click(); return true })()`
      )
      const paths = await evalIn<string[]>(
        page,
        `window.__canvasE2E.getBoards().filter((b) => b.type === 'file').map((b) => b.path)`
      )
      expect(paths, 'clicking a file opens it as a File board (S1 openFileBoard)').toContain(
        'README.md'
      )
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('reflects an external file create live (chokidar watch)', async ({ page, electronApp }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'filetree-live-',
      'ft-live'
    )
    try {
      await mainCall(electronApp, 'writeProjectFile', tmp, 'seed.txt', 'seed\n')
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      // SLICE-013: the FileTree is lazy — reveal the panel so it mounts before we probe its rows.
      await evalIn(page, `window.__canvasE2E.revealSidePanel()`)
      await pollEval(
        page,
        `!!Array.from(document.querySelectorAll('.ca-ftree-row')).find((r) => r.title === 'seed.txt')`,
        4000
      )

      // Create a file ON DISK after the watcher is live; it should surface in the tree.
      await mainCall(electronApp, 'writeProjectFile', tmp, 'LIVE_NEW.txt', 'created externally\n')
      const appeared = await pollEval(
        page,
        `!!Array.from(document.querySelectorAll('.ca-ftree-row')).find((r) => r.title === 'LIVE_NEW.txt')`,
        6000
      )
      expect(appeared, 'file:treeEvent → tree refresh surfaced the new file').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
