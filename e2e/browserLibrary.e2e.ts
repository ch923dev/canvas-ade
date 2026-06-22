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
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
