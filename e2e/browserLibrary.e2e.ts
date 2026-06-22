import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const DL_NAME = 'canvas-e2e-download.txt'

/**
 * @preview — Project Library + the download relocation, end-to-end through the real stack:
 * with a project open, a Browser board hitting the local server's `/download` (Content-Disposition:
 * attachment) saves into `<project>/.canvas/downloads/` (ADR 0009) — NOT the OS Downloads folder —
 * and the file then shows up in the project-level Library panel (opened from its chrome tab).
 */
test.describe('@preview Project Library (downloads → .canvas/downloads)', () => {
  test('a Browser-board download lands in .canvas/downloads and appears in the Library panel', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'library-', 'lib-test')
    try {
      // Open the project so MAIN's current dir → tmp (downloads now target tmp/.canvas/downloads).
      const opened = await evalIn<{ status: string }>(
        page,
        `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
      )
      expect(opened.status, 'project opened').toBe('open')

      // The Library panel is closed at rest — only its reopen tab is present.
      await expect(page.locator('[data-test="library-panel"]')).toHaveAttribute(
        'data-open',
        'false'
      )

      // A Browser board pointed at the attachment URL triggers the OSR download path.
      const url = await mainCall<string>(electronApp, 'localUrl')
      await seed(page, 'browser', { url: `${url}download` })

      // The file is written into the project's .canvas/downloads (api.library.list reads it off disk).
      const landed = await pollEval(
        page,
        `window.api.library.list().then((l) => !!l && l.downloads.some((d) => d.name === ${JSON.stringify(DL_NAME)}))`,
        10_000
      )
      expect(landed, 'download saved under <project>/.canvas/downloads').toBe(true)

      // The footer reports the canonical save dir (.canvas/downloads).
      const listing = await evalIn<{ downloadsDir: string }>(page, `window.api.library.list()`)
      expect(listing.downloadsDir.replace(/\\/g, '/')).toContain('/.canvas/downloads')

      // Open the panel from its chrome tab. Programmatic click (fires the React onClick through the
      // recap-consent scrim, which only blocks REAL pointer events — the fileTree e2e pattern).
      await evalIn(page, `document.querySelector('[data-test="library-open"]').click()`)
      const rowShown = await pollEval(
        page,
        `(() => {
          const panel = document.querySelector('[data-test="library-panel"]');
          if (!panel || panel.getAttribute('data-open') !== 'true') return false;
          return Array.from(document.querySelectorAll('[data-test="library-row"]'))
            .some((r) => r.textContent && r.textContent.includes(${JSON.stringify(DL_NAME)}));
        })()`,
        5000
      )
      expect(rowShown, 'the download appears as a Library row in the open panel').toBe(true)
      const foot = await evalIn<string>(
        page,
        `(document.querySelector('.lib-foot') || {}).textContent || ''`
      )
      expect(foot).toContain('.canvas')

      // The row is draggable and its dragstart carries the fileref payload (root-relative .canvas path).
      const draggable = await evalIn<boolean>(
        page,
        `document.querySelector('[data-test="library-row"]').draggable === true`
      )
      expect(draggable, 'library rows are draggable').toBe(true)

      // Drag onto the canvas → opens the file as a File board (synthetic DnD: capture the row's
      // dragstart payload, then dispatch a matching drop on the RF pane — bypasses the recap scrim).
      await evalIn(
        page,
        `(() => {
          const FILEREF = 'application/x-canvas-ade-fileref';
          const row = document.querySelector('[data-test="library-row"]');
          const dt = new DataTransfer();
          row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          const payload = dt.getData(FILEREF);
          if (!payload || !payload.includes('.canvas/downloads/')) throw new Error('bad payload: ' + payload);
          const dt2 = new DataTransfer();
          dt2.setData(FILEREF, payload);
          // The onDrop handler lives on the pane wrapper (parent of .react-flow); dispatch there so
          // RF's inner .react-flow__pane can't swallow the drag event before it reaches the handler.
          const flow = document.querySelector('.react-flow');
          const pane = (flow && flow.parentElement) || flow;
          const r = pane.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const opts = { bubbles: true, cancelable: true, dataTransfer: dt2, clientX: x, clientY: y };
          pane.dispatchEvent(new DragEvent('dragover', opts));
          pane.dispatchEvent(new DragEvent('drop', opts));
        })()`
      )
      const fileBoardOpened = await pollEval(
        page,
        `window.__canvasE2E.getBoards().some((b) => b.type === 'file' && b.path === ${JSON.stringify('.canvas/downloads/' + DL_NAME)})`,
        5000
      )
      expect(fileBoardOpened, 'dragging a Library row to the canvas opens it as a File board').toBe(
        true
      )
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
