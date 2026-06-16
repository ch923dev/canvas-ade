import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

/**
 * File board (file-tree S3) - CodeMirror 6 viewer/editor.
 *
 * Tagged @core so it runs in every scoped pre-push subset (a board-render regression guard).
 * The CRITICAL acceptance: opening + editing the board produces ZERO CSP / unsafe-eval console
 * errors - the whole reason CM6 replaced Monaco (KICKOFF section 3). The edit->save path is
 * asserted by RE-READING the file from disk through the app's own `window.api.file.readText`,
 * which proves the atomic write actually hit disk.
 */
test.describe('@core file board (CodeMirror 6 viewer/editor)', () => {
  /** Real CSP VIOLATIONS only (not the app-wide benign "frame-ancestors ignored via <meta>"
   *  notice): an `unsafe-eval` rejection or any "Refused to ... Content Security Policy ..." /
   *  "violates the following Content Security Policy" message. */
  function watchCspErrors(page: import('@playwright/test').Page): string[] {
    const hits: string[] = []
    const re =
      /unsafe-eval|refused to [^]*content security policy|violates the following content security policy/i
    page.on('console', (m) => {
      if (m.type() === 'error' && re.test(m.text())) hits.push(m.text())
    })
    page.on('pageerror', (e) => {
      if (re.test(String(e))) hits.push(String(e))
    })
    return hits
  }

  test('highlights a code file, edits + saves to disk, with zero CSP/eval errors', async ({
    page,
    electronApp
  }) => {
    const csp = watchCspErrors(page)
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'file-s3-', 'FileS3')
    try {
      const src = 'export const greet = (name: string): string => `hi ${name}`\nconst answer = 42\n'
      await mainCall(electronApp, 'writeProjectFile', tmp, 'demo.ts', src)

      const id = await seed(page, 'file', { path: 'demo.ts' })
      await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)

      // 1) The static snapshot renders the file content AND is syntax-highlighted (the viewer).
      const snap = page.locator(`.react-flow__node[data-id="${id}"] [data-test="file-snapshot"]`)
      await expect(snap).toBeVisible({ timeout: 6000 })
      await expect(snap).toContainText('greet')
      const html = await snap.innerHTML()
      expect(html, 'snapshot is syntax-highlighted').toContain('<span style="color:')

      // 2) Font stepper: A+ in the title bar grows the viewer font (read the snapshot's inline
      //    font-size via a string eval — DOM globals aren't typed in the e2e tsconfig).
      const readFont = (): Promise<number> =>
        evalIn<number>(
          page,
          `parseFloat(document.querySelector('.react-flow__node[data-id="${id}"] [data-test="file-snapshot"]').style.fontSize)`
        )
      const fontBefore = await readFont()
      const incBtn = page.locator(
        `.react-flow__node[data-id="${id}"] button[aria-label="Increase font size"]`
      )
      await incBtn.click()
      await incBtn.click()
      const fontAfter = await readFont()
      expect(fontAfter, 'A+ increases the viewer font').toBeGreaterThan(fontBefore)

      // 3) Click to enter edit -> a live CodeMirror mounts; type + Ctrl+S.
      await snap.click()
      const editor = page.locator(
        `.react-flow__node[data-id="${id}"] [data-test="file-editor"] .cm-content`
      )
      await expect(editor).toBeVisible({ timeout: 5000 })
      await editor.click()
      const token = 'ZZ_S3_EDIT_TOKEN'
      await page.keyboard.type(`// ${token}\n`)
      await page.waitForTimeout(80)
      await page.keyboard.press('Control+s')

      // 3) Re-read from disk through the real IPC -> proves the atomic write landed.
      await expect
        .poll(() => evalIn<string>(page, `window.api.file.readText("demo.ts")`), { timeout: 6000 })
        .toContain(token)

      expect(csp, 'no CSP / unsafe-eval errors while editing CodeMirror 6').toEqual([])
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('right-click -> Copy path puts the relative path on the clipboard', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'file-s3copy-', 'Copy')
    try {
      await mainCall(electronApp, 'writeProjectFile', tmp, 'demo.ts', 'export const x = 1\n')
      const id = await seed(page, 'file', { path: 'demo.ts' })
      const snap = page.locator(`.react-flow__node[data-id="${id}"] [data-test="file-snapshot"]`)
      await expect(snap).toBeVisible({ timeout: 6000 })
      // Seed a sentinel so the assertion proves a real clipboard write, not a stale value.
      await mainCall(electronApp, 'putTextOnClipboard', 'SENTINEL')
      await snap.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Copy path' }).click()
      await expect
        .poll(() => mainCall<string>(electronApp, 'readClipboardText'), { timeout: 4000 })
        .toBe('demo.ts')
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('renders an image file as an <img>, not the editor', async ({ page, electronApp }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'file-s3img-', 'FileS3Img')
    try {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">' +
        '<rect width="48" height="48" fill="#4f8cff"/></svg>'
      await mainCall(electronApp, 'writeProjectFile', tmp, 'logo.svg', svg)

      const id = await seed(page, 'file', { path: 'logo.svg' })
      const img = page.locator(`.react-flow__node[data-id="${id}"] [data-test="file-image"]`)
      await expect(img).toBeVisible({ timeout: 6000 })
      // It rendered as an image, NOT the code editor/snapshot.
      await expect(
        page.locator(`.react-flow__node[data-id="${id}"] [data-test="file-snapshot"]`)
      ).toHaveCount(0)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
