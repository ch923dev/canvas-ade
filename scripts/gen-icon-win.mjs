// Generates build/icon.ico — the multi-resolution Windows icon.
//
// Why this exists: the Vanishing Point mark (build/icon.png) relies on thin
// perspective lines + a small central diamond. Those read beautifully at large
// sizes but VANISH below ~64px, so a single-source .ico (electron-builder's
// default, which just downscales the 1024 PNG) leaves the 16/32px taskbar icon an
// illegible dark speck. This assembles a proper multi-size .ico that swaps in a
// BOLD simplified variant (filled diamond + one horizon stroke) at the small sizes
// so the taskbar / Explorer icon stays readable, while keeping the full detailed
// mark at 256/128/64. PNG-compressed entries (Windows Vista+; Electron targets
// Win10+). electron-builder uses build/icon.ico verbatim for Windows when present.
//
//   node scripts/gen-icon-win.mjs    (needs the Playwright chromium browser:
//                                      `npx playwright install chromium` once)
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const srcPng = join(here, '..', 'build', 'icon.png')
const out = join(here, '..', 'build', 'icon.ico')

const DETAILED = [256, 128, 64] // full Vanishing Point mark (from build/icon.png)
const BOLD = [48, 32, 16] // simplified mark — legible at taskbar size

const detailedHtml = (size) => {
  const dataUrl = `data:image/png;base64,${readFileSync(srcPng).toString('base64')}`
  return `<body style="margin:0;background:transparent"><img src="${dataUrl}" width="${size}" height="${size}"/></body>`
}

// Bold variant: rounded dark tile + one accent horizon stroke + a large filled
// accent diamond — the brand's core motif, drawn heavy enough to survive 16px.
const boldHtml = (size) => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">` +
    `<rect x="0" y="0" width="256" height="256" rx="57" ry="57" fill="#0d0d0f"/>` +
    `<line x1="40" y1="132" x2="216" y2="132" stroke="#4f8cff" stroke-width="16" stroke-linecap="round"/>` +
    `<path d="M128 86 L172 132 L128 178 L84 132 Z" fill="#4f8cff"/>` +
    `</svg>`
  return `<body style="margin:0;background:transparent">${svg}</body>`
}

function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1 = icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  const bodies = []
  entries.forEach((e, i) => {
    const d = dir.subarray(i * 16, i * 16 + 16)
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0) // width (0 = 256)
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1) // height (0 = 256)
    d.writeUInt8(0, 2) // palette
    d.writeUInt8(0, 3) // reserved
    d.writeUInt16LE(1, 4) // color planes
    d.writeUInt16LE(32, 6) // bits per pixel
    d.writeUInt32LE(e.png.length, 8) // size of image data
    d.writeUInt32LE(offset, 12) // offset of image data
    offset += e.png.length
    bodies.push(e.png)
  })
  return Buffer.concat([header, dir, ...bodies])
}

const browser = await chromium.launch()
try {
  const entries = []
  for (const [sizes, html] of [
    [DETAILED, detailedHtml],
    [BOLD, boldHtml]
  ]) {
    for (const size of sizes) {
      const page = await browser.newPage({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1
      })
      await page.setContent(`<!doctype html><html>${html(size)}</html>`)
      const png = await page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: size, height: size }
      })
      entries.push({ size, png })
      await page.close()
    }
  }
  entries.sort((a, b) => b.size - a.size)
  writeFileSync(out, buildIco(entries))
  console.log('wrote', out, `(${entries.length} sizes: ${entries.map((e) => e.size).join(', ')})`)
} finally {
  await browser.close()
}
