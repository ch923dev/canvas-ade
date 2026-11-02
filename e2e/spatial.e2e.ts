import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn, mainCall } from './helpers'

/**
 * Spatial-awareness I2 — the screen-aware + role-aware tidy against the REAL running app (SPEC §5:
 * "the same seeded canvas tidied at two window sizes yields different arrangements, both readable
 * at ≥ 0.4, no overlaps, groups contiguous"; ROLE-LAYOUT S3 / S4 / S13).
 *
 * Every tidy goes through the real Tidy picker (the `t`-key / palette / picker share one engine,
 * `store/spatialTidy.runTidy`), and the window is resized for real (`setContentSize`), so the pane
 * the engine reads is the one the user would see. The window is restored after each test — the app
 * is worker-shared.
 */

interface Rect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

interface SeedBoard {
  key: string
  type: 'terminal' | 'browser' | 'planning'
  x: number
  y: number
  title: string
  /** Terminal: mark it an agent (metadata only — nothing is typed into the shell). */
  agent?: boolean
  /** Browser: the seed key of the terminal it previews (S3's nearest link). */
  previews?: string
  /** Terminal: the dev-server port it "printed" — makes it a `server` (C9 `ports`). */
  serves?: number
}

const WIDE = { w: 1500, h: 820 }
const TALL = { w: 680, h: 960 }
const ULTRAWIDE = { w: 1500, h: 620 }
const READABLE_ZOOM = 0.4
/** A terminal line break as a PTY emits it. */
const NL = String.fromCharCode(13, 10)

/** The tidy picker's trigger + one preset by its visible label. */
async function pickPreset(page: Page, label: 'By role' | 'Fit to screen'): Promise<void> {
  await page.locator('button[title="Tidy layout (T)"]').click()
  await page.locator('.ca-tidy-preset', { hasText: label }).click()
}

/**
 * The board ⋯ menu's "Make main board" on one board — framed first so its title bar (and the ⋯
 * trigger) is on screen, then the real menu row is clicked.
 */
async function makeMainFromMenu(page: Page, id: string): Promise<void> {
  await callE2E(page, { m: 'fitView', a: [id] })
  const more = page.locator(`.react-flow__node[data-id="${id}"] button[title="More"]`)
  await expect(more).toBeVisible() // framed past the LOD threshold: the full chrome is mounted
  await page.waitForTimeout(300) // the camera tween lands before the click
  const before = await cameraKey(page)
  await more.click()
  await page.getByRole('menuitem', { name: /Make main board/ }).click()
  // The arrangement frames the camera: wait for it to leave the pre-click view, so the settle
  // that follows measures the new frame (a stable pre-tween read would pass for "settled").
  await expect.poll(() => cameraKey(page), { timeout: 5_000 }).not.toBe(before)
}

/** The camera as one comparable string. */
const cameraKey = (page: Page): Promise<string> =>
  evalIn<{ x: number; y: number; zoom: number }>(page, `window.__canvasE2E.getViewport()`).then(
    (v) => `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.zoom.toFixed(4)}`
  )

/** The driven window's state calls (Electron `BrowserWindow`, typed locally — no main imports). */
interface WinState {
  isMinimized(): boolean
  restore(): void
  isMaximized(): boolean
  unmaximize(): void
  setContentSize(w: number, h: number): void
  getContentSize(): number[]
}

/** Resize the driven window's CONTENT and wait for the canvas pane to follow (+ the view settle). */
async function resizeTo(
  electronApp: ElectronApplication,
  page: Page,
  size: { w: number; h: number }
): Promise<void> {
  const win = await electronApp.browserWindow(page)
  const apply = (): Promise<void> =>
    win.evaluate((w, s) => {
      const bw = w as unknown as WinState
      // A minimized window ignores setContentSize (and reads 0 × 0) — the desktop the e2e runs
      // on can minimize it under us; a maximized one would snap back.
      if (bw.isMinimized()) bw.restore()
      if (bw.isMaximized()) bw.unmaximize()
      bw.setContentSize(s.w, s.h)
    }, size)
  const want = `${size.w}x${size.h}`
  await apply()
  await expect
    .poll(
      async () => {
        const now = await evalIn<string>(page, `[window.innerWidth, window.innerHeight].join('x')`)
        if (now !== want) await apply() // the OS can drop a resize while the window is busy
        return now
      },
      { timeout: 8_000 }
    )
    .toBe(want)
  await page.waitForTimeout(400) // canvasViewStore settles the pane after VIEW_SETTLE_MS
}

async function contentSize(
  electronApp: ElectronApplication,
  page: Page
): Promise<{ w: number; h: number }> {
  const win = await electronApp.browserWindow(page)
  const [w, h] = await win.evaluate((w) => {
    const bw = w as unknown as WinState
    if (bw.isMinimized()) bw.restore() // a minimized window reads 0 × 0
    return bw.getContentSize()
  })
  return { w, h }
}

/** Seed the boards (scattered far apart), returning seed key → board id. */
async function seedCanvas(
  page: Page,
  boards: readonly SeedBoard[],
  groups: ReadonlyArray<{ name: string; keys: string[] }>
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const b of boards) {
    const id = await callE2E<string>(page, {
      m: 'seedBoard',
      // Seeded side by side near the origin (on screen, so every terminal mounts and spawns its
      // PTY); `rescatter` moves them to their scattered spots before each tidy.
      a: [b.type, { title: b.title, ...(b.agent ? { agentKind: 'claude' } : {}) }]
    })
    ids.set(b.key, id)
  }
  for (const b of boards) {
    if (b.previews) {
      await callE2E(page, {
        m: 'patchBoard',
        a: [ids.get(b.key), { previewSourceId: ids.get(b.previews) }]
      })
    }
  }
  for (const g of groups) {
    await callE2E(page, { m: 'addGroup', a: [g.name, g.keys.map((k) => ids.get(k))] })
  }
  await callE2E(page, { m: 'setSelection', a: [[]] }, { m: 'fitView' }) // selection picks the stage (§1)
  return ids
}

/**
 * Give each `serves` terminal its server role through the REAL detect path: seed its live PTY
 * output ring with a dev server's banner, then run `detectTerminalPorts` (MAIN parses the ring).
 */
async function serve(
  electronApp: ElectronApplication,
  page: Page,
  boards: readonly SeedBoard[],
  ids: Map<string, string>
): Promise<void> {
  for (const b of boards) {
    if (b.serves === undefined) continue
    const id = ids.get(b.key)!
    await expect
      .poll(() => mainCall<boolean>(electronApp, 'mcpSeedOutput', id, NL), { timeout: 20_000 })
      .toBe(true) // the PTY exists in MAIN
    const banner = [NL, '  VITE ready', NL, `  Local:   http://localhost:${b.serves}/`, NL].join('')
    await mainCall<boolean>(electronApp, 'mcpSeedOutput', id, banner)
    await expect
      .poll(() => callE2E<number[]>(page, { m: 'detectPorts', a: [id] }), { timeout: 5_000 })
      .toContain(b.serves)
  }
}

/** Put every seeded board back where it was seeded — "the same canvas" before each tidy. */
async function rescatter(
  page: Page,
  boards: readonly SeedBoard[],
  ids: Map<string, string>
): Promise<void> {
  for (const b of boards) {
    await callE2E(page, { m: 'patchBoard', a: [ids.get(b.key), { x: b.x, y: b.y }] })
  }
}

async function rects(page: Page): Promise<Map<string, Rect>> {
  const list = await page.evaluate(() => {
    const hook = (
      globalThis as unknown as {
        __canvasE2E: {
          getBoards(): Array<{ id: string; x: number; y: number; w: number; h: number }>
        }
      }
    ).__canvasE2E
    return hook.getBoards().map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }))
  })
  return new Map(list.map((r) => [r.id, r]))
}

/** The camera once its tween has landed (two equal reads 150 ms apart). */
async function settledZoom(page: Page): Promise<number> {
  const read = (): Promise<string> =>
    evalIn<{ x: number; y: number; zoom: number }>(page, `window.__canvasE2E.getViewport()`).then(
      (v) => `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.zoom.toFixed(4)}`
    )
  let prev = ''
  await expect
    .poll(
      async () => {
        const now = await read()
        const same = now === prev
        prev = now
        return same
      },
      { timeout: 6_000, intervals: [150] }
    )
    .toBe(true)
  return Number(prev.split(',')[2])
}

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function expectNoOverlaps(all: Map<string, Rect>): void {
  const list = [...all.values()]
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      expect(intersects(list[i], list[j]), `${list[i].id} overlaps ${list[j].id}`).toBe(false)
    }
  }
}

/** A group is contiguous when no non-member board sits inside its members' bounding box. */
function expectContiguous(all: Map<string, Rect>, memberIds: readonly string[]): void {
  const ms = memberIds.map((id) => all.get(id)!)
  const x = Math.min(...ms.map((r) => r.x))
  const y = Math.min(...ms.map((r) => r.y))
  const box: Rect = {
    id: 'box',
    x,
    y,
    w: Math.max(...ms.map((r) => r.x + r.w)) - x,
    h: Math.max(...ms.map((r) => r.y + r.h)) - y
  }
  for (const r of all.values()) {
    if (memberIds.includes(r.id)) continue
    expect(intersects(box, r), `${r.id} sits inside a group's box`).toBe(false)
  }
}

/** Positions relative to the arrangement's top-left — comparable across two tidies. */
function shape(all: Map<string, Rect>): string {
  const list = [...all.values()].sort((a, b) => a.id.localeCompare(b.id))
  const x0 = Math.min(...list.map((r) => r.x))
  const y0 = Math.min(...list.map((r) => r.y))
  return list.map((r) => `${r.x - x0},${r.y - y0},${r.w},${r.h}`).join(' ')
}

/** S3 · browser + web server + api server, linked by a Named Group (+ the browser's preview). */
const S3: SeedBoard[] = [
  { key: 'b', type: 'browser', x: 0, y: 0, title: 'App', previews: 'web' },
  { key: 'web', type: 'terminal', x: 9000, y: 4000, title: 'web', serves: 5173 },
  { key: 'api', type: 'terminal', x: -7000, y: 6000, title: 'api', serves: 3000 }
]

/** S4 · agent + browser + web + api. */
const S4: SeedBoard[] = [
  { key: 'agent', type: 'terminal', x: 3000, y: -5000, title: 'agent', agent: true },
  { key: 'b4', type: 'browser', x: -9000, y: -2000, title: 'App 4', previews: 'web4' },
  { key: 'web4', type: 'terminal', x: 12000, y: 9000, title: 'web4', serves: 5174 },
  { key: 'api4', type: 'terminal', x: 6000, y: 12000, title: 'api4', serves: 3001 }
]

/** Main + sidebar · the browser + two servers + an agent + a rigid planning board, no groups. */
const MAIN: SeedBoard[] = [
  ...S3,
  { key: 'agent', type: 'terminal', x: 4000, y: -9000, title: 'agent', agent: true },
  { key: 'notes', type: 'planning', x: -15000, y: 8000, title: 'Notes' }
]

test.describe('@spatial screen-aware + role-aware tidy (I2)', () => {
  test.slow() // real PTYs + offscreen browsers + four window resizes

  let original: { w: number; h: number } | null = null
  test.beforeEach(async ({ electronApp, page }) => {
    original = await contentSize(electronApp, page)
  })
  test.afterEach(async ({ electronApp, page }) => {
    if (original) await resizeTo(electronApp, page, original)
  })

  test('Fit to screen: the same canvas at two window sizes → different, readable, no overlaps, groups contiguous', async ({
    electronApp,
    page
  }) => {
    const boards: SeedBoard[] = [
      ...S3,
      { key: 'p1', type: 'planning', x: 15000, y: -8000, title: 'Notes' },
      { key: 'p2', type: 'planning', x: -12000, y: 14000, title: 'Docs' },
      { key: 'p3', type: 'planning', x: 20000, y: 20000, title: 'Loose' }
    ]
    const ids = await seedCanvas(page, boards, [
      { name: 'Dev stack', keys: ['b', 'web', 'api'] },
      { name: 'Docs', keys: ['p1', 'p2'] }
    ])
    const stack = ['b', 'web', 'api'].map((k) => ids.get(k)!)
    const docs = ['p1', 'p2'].map((k) => ids.get(k)!)

    const shapes: string[] = []
    for (const size of [WIDE, TALL]) {
      await resizeTo(electronApp, page, size)
      await rescatter(page, boards, ids)
      const before = await rects(page)
      await pickPreset(page, 'Fit to screen')
      const zoom = await settledZoom(page)
      const all = await rects(page)
      expect(zoom, `fit at ${size.w}×${size.h} reads at ≥ ${READABLE_ZOOM}`).toBeGreaterThanOrEqual(
        READABLE_ZOOM
      )
      expectNoOverlaps(all)
      expectContiguous(all, stack)
      expectContiguous(all, docs)
      // Fit never resizes (positions only, D7 / C4).
      for (const [id, r] of all) expect([r.w, r.h]).toEqual([before.get(id)!.w, before.get(id)!.h])
      shapes.push(shape(all))
    }
    expect(shapes[0], 'a wide and a tall window pack differently').not.toBe(shapes[1])

    // Undo reverts the last tidy in ONE step (back to the scattered seed).
    await callE2E(page, { m: 'undo' })
    const back = await rects(page)
    expect(back.get(ids.get('p3')!)!.x).toBe(20000)
  })

  test('By role (S3 + S13): the browser is the hero; wide → its servers beside it, tall → below', async ({
    electronApp,
    page
  }) => {
    const ids = await seedCanvas(page, S3, [{ name: 'Dev stack', keys: ['b', 'web', 'api'] }])
    await serve(electronApp, page, S3, ids)
    const [b, web, api] = ['b', 'web', 'api'].map((k) => ids.get(k)!)

    await resizeTo(electronApp, page, WIDE)
    await rescatter(page, S3, ids)
    await pickPreset(page, 'By role')
    expect(await settledZoom(page)).toBeGreaterThanOrEqual(READABLE_ZOOM)
    let all = await rects(page)
    expectNoOverlaps(all)
    for (const t of [web, api]) {
      expect(all.get(b)!.w * all.get(b)!.h).toBeGreaterThan(all.get(t)!.w * all.get(t)!.h)
      expect(all.get(t)!.x).toBeGreaterThanOrEqual(all.get(b)!.x + all.get(b)!.w) // the rail
    }
    const wide = shape(all)

    await resizeTo(electronApp, page, TALL)
    await rescatter(page, S3, ids)
    await pickPreset(page, 'By role')
    expect(await settledZoom(page)).toBeGreaterThanOrEqual(READABLE_ZOOM)
    all = await rects(page)
    expectNoOverlaps(all)
    for (const t of [web, api]) {
      expect(all.get(t)!.y).toBeGreaterThanOrEqual(all.get(b)!.y + all.get(b)!.h) // the strip
    }
    expect(shape(all)).not.toBe(wide)
  })

  test('By role (S4 + S13): agent + browser co-heroes; wide → web / api strip below, ultrawide → rail beside', async ({
    electronApp,
    page
  }) => {
    const ids = await seedCanvas(page, S4, [
      { name: 'Agent stack', keys: ['agent', 'b4', 'web4', 'api4'] }
    ])
    await serve(electronApp, page, S4, ids)
    const [agent, b, web, api] = ['agent', 'b4', 'web4', 'api4'].map((k) => ids.get(k)!)

    const shapes: string[] = []
    for (const size of [WIDE, ULTRAWIDE]) {
      await resizeTo(electronApp, page, size)
      await rescatter(page, S4, ids)
      await pickPreset(page, 'By role')
      expect(await settledZoom(page)).toBeGreaterThanOrEqual(READABLE_ZOOM)
      const all = await rects(page)
      expectNoOverlaps(all)
      const r = (id: string): Rect => all.get(id)!
      const area = (id: string): number => r(id).w * r(id).h
      for (const hero of [agent, b]) {
        for (const strip of [web, api]) expect(area(hero)).toBeGreaterThan(area(strip))
      }
      for (const strip of [web, api]) {
        if (size === WIDE) {
          // S4: the strip runs under both co-heroes.
          expect(r(strip).y).toBeGreaterThanOrEqual(
            Math.max(r(agent).y + r(agent).h, r(b).y + r(b).h)
          )
        } else {
          // S13 ultrawide: AGENT | BROWSER | web / api rail.
          expect(r(agent).x + r(agent).w).toBeLessThanOrEqual(r(b).x)
          expect(r(strip).x).toBeGreaterThanOrEqual(r(b).x + r(b).w)
        }
      }
      shapes.push(shape(all))
    }
    expect(shapes[0]).not.toBe(shapes[1])
  })

  test('Make main board (⋯ menu): the main board fills the main area, the sidebar splits evenly; wide → beside it, tall → below', async ({
    electronApp,
    page
  }) => {
    const ids = await seedCanvas(page, MAIN, [])
    const main = ids.get('b')!
    const notes = ids.get('notes')!
    const others = ['web', 'api', 'agent', 'notes'].map((k) => ids.get(k)!)
    // The dev-check canvas (2026-11-02): a planning board far bigger than a sidebar slot. Main +
    // sidebar resizes EVERY board in it (user decision) — By role / Fit still never would (D7).
    const BIG_NOTES = { w: 1471, h: 764 }

    const shapes: string[] = []
    for (const size of [WIDE, TALL]) {
      await resizeTo(electronApp, page, size)
      await rescatter(page, MAIN, ids)
      await callE2E(page, { m: 'patchBoard', a: [notes, BIG_NOTES] })
      await makeMainFromMenu(page, main)
      const zoom = await settledZoom(page)
      expect(
        zoom,
        `main + sidebar at ${size.w}×${size.h} reads at ≥ ${READABLE_ZOOM}`
      ).toBeGreaterThanOrEqual(READABLE_ZOOM)
      const all = await rects(page)
      expectNoOverlaps(all)
      const m = all.get(main)!
      const side = others.map((id) => all.get(id)!)
      for (const r of side) {
        expect(m.w * m.h, 'the main board is the biggest').toBeGreaterThan(r.w * r.h)
        if (size === WIDE)
          expect(r.x).toBeGreaterThanOrEqual(m.x + m.w) // sidebar on the right
        else expect(r.y).toBeGreaterThanOrEqual(m.y + m.h) // sidebar below
      }
      // The main board STRETCHES across the whole main area: the sidebar's full height (wide)
      // or full width (tall) — never a browser parked at its own aspect with a gap under it.
      if (size === WIDE) {
        expect(m.y).toBe(Math.min(...side.map((r) => r.y)))
        expect(m.y + m.h).toBe(Math.max(...side.map((r) => r.y + r.h)))
      } else {
        expect(m.x).toBe(Math.min(...side.map((r) => r.x)))
        expect(m.x + m.w).toBe(Math.max(...side.map((r) => r.x + r.w)))
      }
      // The big planning board shrank to its sidebar slot.
      expect(all.get(notes)!.w).toBeLessThan(BIG_NOTES.w)
      shapes.push(shape(all))
    }
    expect(shapes[0], 'a wide and a tall window arrange differently').not.toBe(shapes[1])

    // ONE undo step reverts the last arrangement — positions AND sizes.
    await callE2E(page, { m: 'undo' })
    const back = (await rects(page)).get(notes)!
    expect([back.x, back.w, back.h]).toEqual([-15000, BIG_NOTES.w, BIG_NOTES.h])
  })
})
