import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn, mainCall, pollCall, pollEval, seed, selectForInspector } from './helpers'

const DL_NAME = 'canvas-e2e-download.txt'

/** The board's preview runtime, read as a VALUE (the id crosses as a real arg, never spliced). */
const runtimeOf = (page: Page, id: string): Promise<{ status: string } | null> =>
  callE2E<{ status: string } | null>(page, { m: 'getRuntime', a: [id] })

/** Poll until the runtime reaches `status` — the comparison runs HERE in Node, so neither the
 *  seeded id nor the wanted status ever enters page code. Same boolean contract as `pollEval`. */
async function pollStatus(
  page: Page,
  id: string,
  status: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(async () => (await runtimeOf(page, id))?.status === status, { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}
const pollNonBlank = (page: Page, id: string, timeoutMs: number): Promise<boolean> =>
  pollCall(page, [{ m: 'osrCanvasNonBlank', a: [id] }], timeoutMs)

/** Poll until a File board for `path` exists — the boards array is read as a VALUE via the bridge
 *  and the match runs HERE in Node (the path never enters page code). */
async function pollFileBoard(page: Page, path: string, timeoutMs: number): Promise<boolean> {
  const hasIt = async (): Promise<boolean> =>
    (await callE2E<Array<{ type: string; path?: string }>>(page, { m: 'getBoards' })).some(
      (b) => b.type === 'file' && b.path === path
    )
  try {
    await expect.poll(hasIt, { timeout: timeoutMs }).toBe(true)
    return true
  } catch {
    return false
  }
}

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
      const opened = await callE2E<{ status: string }>(page, {
        m: 'openProjectFromDisk',
        a: [tmp]
      })
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
      const fileBoardOpened = await pollFileBoard(page, '.canvas/downloads/' + DL_NAME, 5000)
      expect(fileBoardOpened, 'dragging a Library row to the canvas opens it as a File board').toBe(
        true
      )
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('a screenshot auto-refreshes the open Library (Assets tab)', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'library-shot-',
      'lib-shot'
    )
    try {
      await callE2E(page, { m: 'openProjectFromDisk', a: [tmp] })
      const url = await mainCall<string>(electronApp, 'localUrl')
      const id = await seed(page, 'browser', { url, viewport: 'desktop' })
      await page.waitForTimeout(150)
      await callE2E(page, { m: 'fitView', a: [id] })
      expect(await pollStatus(page, id, 'connected', 12_000), 'connected').toBe(true)
      expect(await pollNonBlank(page, id, 8000), 'OSR painted').toBe(true)

      // Open the Library on the Assets tab — empty before any screenshot. The open-state is the
      // panel's own (survives the prior test's reset), so open only if its reopen tab is present.
      await evalIn(
        page,
        `(() => { const b = document.querySelector('[data-test="library-open"]'); if (b) b.click(); })()`
      )
      await evalIn(page, `document.querySelector('[data-test="library-tab-assets"]').click()`)
      const before = await evalIn<number>(
        page,
        `document.querySelectorAll('[data-test="library-row"]').length`
      )
      expect(before, 'no assets before the screenshot').toBe(0)

      // Take a screenshot via the Inspector's Preview › Screenshot (P5 — the URL-bar camera is
      // gone; saves a PNG into .canvas/assets/). It must auto-refresh the OPEN panel via
      // requestRefresh — no manual ⟳. Programmatic click fires the React onClick through the
      // recap-consent scrim (which only blocks REAL pointer events).
      await selectForInspector(page, id)
      await evalIn(page, `document.querySelector('[data-test="inspector-screenshot"]').click()`)
      const shown = await pollEval(
        page,
        `document.querySelectorAll('[data-test="library-row"]').length > 0`,
        6000
      )
      expect(
        shown,
        'the screenshot asset appears in the open Library without a manual refresh'
      ).toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
