import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

  test('focused board edits live + saves to disk, deselected shows a highlighted snapshot, zero CSP/eval errors', async ({
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
      const node = `.react-flow__node[data-id="${id}"]`

      // 1) A seeded board is SELECTED → the live CodeMirror editor mounts straight away (the locked
      //    "live editor on the focused board" behaviour — no click-to-edit step).
      const editor = page.locator(`${node} [data-test="file-editor"] .cm-content`)
      await expect(editor).toBeVisible({ timeout: 6000 })
      await expect(editor).toContainText('greet')

      // 2) Font stepper: A+ in the title bar grows the editor font (read --cm-font off the host;
      //    DOM globals aren't typed in the e2e tsconfig, so go through a string eval).
      const readFont = (): Promise<number> =>
        evalIn<number>(
          page,
          `parseFloat(getComputedStyle(document.querySelector('${node} [data-test="file-editor"]')).getPropertyValue('--cm-font'))`
        )
      const fontBefore = await readFont()
      const incBtn = page.locator(`${node} button[aria-label="Increase font size"]`)
      await incBtn.click()
      await incBtn.click()
      const fontAfter = await readFont()
      expect(fontAfter, 'A+ increases the editor font').toBeGreaterThan(fontBefore)

      // 3) Type + Ctrl+S, then re-read from disk through the real IPC → proves the atomic write landed.
      await editor.click()
      const token = 'ZZ_S3_EDIT_TOKEN'
      await page.keyboard.type(`// ${token}\n`)
      await page.waitForTimeout(80)
      await page.keyboard.press('Control+s')
      await expect
        .poll(() => evalIn<string>(page, `window.api.file.readText("demo.ts")`), { timeout: 6000 })
        .toContain(token)

      // 4) DESELECT → the live editor is replaced by the crisp static snapshot, and it's
      //    syntax-highlighted (the read-only viewer for off-focus boards).
      await evalIn(page, `window.__canvasE2E.select(null)`)
      const snap = page.locator(`${node} [data-test="file-snapshot"]`)
      await expect(snap).toBeVisible({ timeout: 4000 })
      await expect(snap).toContainText('greet')
      expect(await snap.innerHTML(), 'snapshot is syntax-highlighted').toContain(
        '<span style="color:'
      )

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
      // Deselect so the static snapshot (not the live editor) is the right-click target.
      await evalIn(page, `window.__canvasE2E.select(null)`)
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

  test('markdown opens in rendered preview; Split shows source + preview; Source is editor only', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'file-s3md-', 'Md')
    try {
      await mainCall(
        electronApp,
        'writeProjectFile',
        tmp,
        'doc.md',
        '# Title\n\nHello **world**.\n'
      )
      const id = await seed(page, 'file', { path: 'doc.md' })
      const node = `.react-flow__node[data-id="${id}"]`
      // Auto-recognition: a .md board opens straight into the rendered preview.
      const preview = page.locator(`${node} .cm-md-preview`)
      const editor = page.locator(`${node} [data-test="file-editor"]`)
      await expect(preview).toBeVisible({ timeout: 6000 })
      await expect(preview.locator('h1')).toHaveText('Title')
      await expect(preview.locator('strong')).toHaveText('world')

      // Split: source editor (left, board is selected) AND rendered preview (right) side-by-side.
      await page.getByRole('button', { name: 'Split', exact: true }).click()
      await expect(editor).toBeVisible({ timeout: 4000 })
      await expect(preview).toBeVisible()

      // Source: the editor fills the board; the rendered preview is gone.
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await expect(editor).toBeVisible({ timeout: 4000 })
      await expect(preview).toHaveCount(0)
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

  test('dropping a tree file-ref onto a File board rebinds it to that file', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'file-s3drop-', 'Drop')
    try {
      await mainCall(electronApp, 'writeProjectFile', tmp, 'a.ts', 'export const A_FILE = 1\n')
      await mainCall(electronApp, 'writeProjectFile', tmp, 'b.ts', 'export const B_FILE = 2\n')
      const id = await seed(page, 'file', { path: 'a.ts' })
      const node = `.react-flow__node[data-id="${id}"]`
      // Selected board → live editor showing a.ts.
      const editor = page.locator(`${node} [data-test="file-editor"] .cm-content`)
      await expect(editor).toContainText('A_FILE', { timeout: 6000 })

      // Dispatch a synthetic file-ref drop (the MIME the tree emits) onto the board content; the
      // board's onDrop should rebind its `path` to the dropped file.
      await evalIn(
        page,
        `(() => {
          const host = document.querySelector('${node} [data-test="file-editor"]')
            || document.querySelector('${node} [data-test="file-snapshot"]')
          const dt = new DataTransfer()
          dt.setData('application/x-canvas-ade-fileref', JSON.stringify({ path: 'b.ts', label: 'b.ts' }))
          host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        })()`
      )

      // Rebound to b.ts → the editor now shows b.ts content, read live from disk.
      await expect(editor).toContainText('B_FILE', { timeout: 6000 })
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  // Regression guard for the drag-SOURCE (the bug a synthetic-drop test can't catch): react-arborist
  // mounts react-dnd's HTML5Backend, whose window-level dragstart listener cancels any native drag
  // that is neither a react-dnd source nor a recognised native type. The tree row must therefore (a)
  // NOT attach arborist's dragHandle and (b) set a native type (text/plain) alongside the file-ref —
  // otherwise the drag-out is silently preventDefaulted and never starts. We dispatch a real
  // dragstart and assert it is not canceled and carries the payload.
  test('tree rows are native drag sources whose dragstart is not canceled', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'file-s3drag-', 'Drag')
    try {
      await mainCall(electronApp, 'writeProjectFile', tmp, 'alpha.ts', 'export const A = 1\n')
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      await expect
        .poll(() => evalIn<number>(page, `document.querySelectorAll('.ca-ftree-row').length`), {
          timeout: 6000
        })
        .toBeGreaterThan(0)
      const res = await evalIn<{ draggable: boolean; prevented: boolean; hasRef: boolean }>(
        page,
        `(() => {
          const rows = Array.from(document.querySelectorAll('.ca-ftree-row'))
          const el = rows.find((r) => (r.getAttribute('title') || '').endsWith('alpha.ts')) || rows[0]
          const dt = new DataTransfer()
          const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt })
          el.dispatchEvent(ev)
          return {
            draggable: el.draggable,
            prevented: ev.defaultPrevented,
            hasRef: !!dt.getData('application/x-canvas-ade-fileref')
          }
        })()`
      )
      expect(res.draggable, 'tree row is natively draggable').toBe(true)
      expect(res.prevented, 'react-dnd must NOT cancel the native dragstart').toBe(false)
      expect(res.hasRef, 'dragstart carries the file-ref payload').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('compact folders: a single-child folder chain renders as one "pkg / sub" row', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'file-s3compact-',
      'Compact'
    )
    try {
      // pkg → sub → leaf.ts is a single-folder chain; zzz.txt keeps the ROOT multi-child so the
      // chain is reached by expanding 'pkg' (deterministic, regardless of canvas.json at root).
      mkdirSync(join(tmp, 'pkg', 'sub'), { recursive: true })
      writeFileSync(join(tmp, 'pkg', 'sub', 'leaf.ts'), 'export const L = 1\n')
      writeFileSync(join(tmp, 'zzz.txt'), 'root sibling\n')
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      await expect
        .poll(() => evalIn<number>(page, `document.querySelectorAll('.ca-ftree-row').length`), {
          timeout: 6000
        })
        .toBeGreaterThan(0)
      // Expand the pkg row (programmatic click — rows live in the DOM even if the panel is collapsed).
      await evalIn(
        page,
        `(() => {
          const rows = Array.from(document.querySelectorAll('.ca-ftree-row'))
          const pkg = rows.find((r) => (r.getAttribute('title') || '').startsWith('pkg'))
          if (pkg) pkg.click()
        })()`
      )
      // pkg's sole sub-folder cascade-loads → the row compacts to a single "pkg / sub" label.
      await expect
        .poll(
          () =>
            evalIn<boolean>(
              page,
              `Array.from(document.querySelectorAll('.ca-ftree-name')).some((n) => n.textContent === 'pkg / sub')`
            ),
          { timeout: 6000 }
        )
        .toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
