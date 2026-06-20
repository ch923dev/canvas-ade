// Generates build/icon-mac.png — the macOS variant of build/icon.png.
//
// macOS app icons are NOT full-bleed: Apple's app-icon grid puts the rounded-rect
// body in an 824x824 area centered in the 1024 canvas (≈100px transparent margin
// per side), so a Dock/Finder icon matches the size of every native app. The shared
// build/icon.png is full-bleed — correct for the Windows .ico / Linux PNG, but it
// looks oversized under the macOS template. This derives the padded variant FROM
// the committed icon.png (so it always tracks the real brand mark) and the mac
// target points at it (electron-builder.yml › mac.icon). Re-run after the brand mark
// changes:
//
//   node scripts/gen-icon-mac.mjs    (needs the Playwright chromium browser:
//                                      `npx playwright install chromium` once)
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const SIZE = 1024
const BODY = 824 // Apple macOS app-icon body within the 1024 grid (≈100px margin/side)
const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'build', 'icon.png')
const out = join(here, '..', 'build', 'icon-mac.png')

const dataUrl = `data:image/png;base64,${readFileSync(src).toString('base64')}`
const margin = (SIZE - BODY) / 2

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1
  })
  await page.setContent(
    `<!doctype html><html><body style="margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent">` +
      `<img src="${dataUrl}" width="${BODY}" height="${BODY}" ` +
      `style="position:absolute;left:${margin}px;top:${margin}px"/></body></html>`
  )
  await page.screenshot({
    path: out,
    omitBackground: true,
    clip: { x: 0, y: 0, width: SIZE, height: SIZE }
  })
  console.log('wrote', out)
} finally {
  await browser.close()
}
