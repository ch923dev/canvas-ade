// Generates build/icon.png (1024x1024) — the single source icon electron-builder
// uses to derive every platform format (.ico for Windows, .icns for macOS, the
// PNG for the Linux AppImage). Re-run after any brand-mark change:
//
//   node scripts/gen-icon.mjs        (needs the Playwright chromium browser:
//                                      `npx playwright install chromium` once)
//
// The mark is the app's brand glyph — the OUTLINE diamond (Icon.tsx `diamond`,
// drawn as a stroke in EmptyState/AppChrome) — in the one accent (--accent
// #4f8cff) over the --surface (#141416) tile. Flat, one accent, no gradient/glow,
// per the design contract (DESIGN.md §1).
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SIZE = 1024
const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'build', 'icon.png')

// viewBox 0..1024; rounded-rect tile + centered outline diamond (≈59% of the tile).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="224" ry="224" fill="#141416"/>
  <path d="M512 176 L848 512 L512 848 L176 512 Z"
        fill="rgba(79,140,255,0.10)" stroke="#4f8cff" stroke-width="72" stroke-linejoin="round"/>
</svg>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1
  })
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`
  )
  await page.locator('svg').screenshot({ path: out, omitBackground: true })
  console.log('wrote', out)
} finally {
  await browser.close()
}
