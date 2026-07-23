import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Phase 2 — cloud STT end to end against the REAL built app + a FAKE OpenAI vendor. Proves the
 * whole batch path the unit tests exercise in pieces, wired together live: config → cloud → the
 * env-key gate → fake-media mic capture → CloudSttEngine buffers frames → {t:'eos'} → 16k WAV →
 * ONE POST /v1/audio/transcriptions → the `transcribing` state (no partials — cloud is batch) →
 * the final delivered OUT-OF-BAND on voice:transcript (the session port is already closed) →
 * folded into the draft. Plus the fail-visible path: a vendor error surfaces a cloud-error note,
 * the draft untouched.
 *
 * ISOLATED app (own CANVAS_USERDATA + env), NOT the shared worker fixture: the cloud env
 * (OPENAI_API_KEY as the store-less gate fallback + CANVAS_VOICE_OPENAI_BASE) and engine:'cloud'
 * config must not leak into the local/stub voice specs sharing the worker. The vendor delays its
 * response so the transient `transcribing` state is observable before the final lands.
 */
const TRANSCRIPT = 'refactor the preview cap and message port'
const VENDOR_DELAY_MS = 2500 // hold the response so the transient transcribing state is observable

let app: ElectronApplication
let page: Page
let server: http.Server
let vendorHits = 0
let vendorMode: 'ok' | 'fail' = 'ok'

const voiceState = (): Promise<{ capturing: boolean; framesSent: number; draft: string }> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.voiceState())
const start = (): Promise<{ ok: boolean }> =>
  page.evaluate(() => (globalThis as any).api.voice.start())
const stop = (): Promise<unknown> => page.evaluate(() => (globalThis as any).api.voice.stop())
const setEngineCloud = (): Promise<unknown> =>
  page.evaluate(() => (globalThis as any).api.voice.config.set({ engine: 'cloud' }))

/** Arm a FRESH capture, pump real frames, release. Gates on capturing===true FIRST — that reset
 *  framesSent to 0 (captureStarted), so the subsequent framesSent>6 can't false-pass on a prior
 *  session's stale count and release before this capture ever armed. */
async function holdAndRelease(): Promise<void> {
  expect((await start()).ok).toBe(true)
  await expect.poll(async () => (await voiceState()).capturing, { timeout: 10_000 }).toBe(true)
  await expect
    .poll(async () => (await voiceState()).framesSent, { timeout: 10_000 })
    .toBeGreaterThan(6)
  await stop()
  await expect.poll(async () => (await voiceState()).capturing, { timeout: 10_000 }).toBe(false)
}

test.describe.serial('@voice cloud STT (fake OpenAI vendor)', () => {
  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.includes('/audio/transcriptions')) {
        vendorHits++
        req.resume()
        req.on('end', () =>
          setTimeout(() => {
            if (vendorMode === 'fail') {
              res.writeHead(401)
              res.end('unauthorized')
              return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ text: TRANSCRIPT }))
          }, VENDOR_DELAY_MS)
        )
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const args = ['out/main/index.js']
    if (process.env.CI && process.platform === 'linux') {
      args.push('--no-sandbox', '--disable-dev-shm-usage')
    }
    app = await _electron.launch({
      args,
      env: {
        ...process.env,
        CANVAS_E2E: '1',
        CANVAS_FAKE_MEDIA: '1',
        CANVAS_USERDATA: mkdtempSync(join(tmpdir(), 'canvas-voicecloud-')), // isolate config
        OPENAI_API_KEY: 'sk-e2e-devkey', // env fallback → the cloud gate is open (no key store needed)
        CANVAS_VOICE_OPENAI_BASE: `http://127.0.0.1:${port}/v1`
      }
    })
    page = await app.firstWindow()
    await expect
      .poll(() => page.evaluate(() => !!(globalThis as any).__canvasE2E), { timeout: 15_000 })
      .toBe(true)
    await page.evaluate(() => (globalThis as any).__canvasE2E.reset())
    await setEngineCloud()
  })

  test.afterAll(async () => {
    await app?.close()
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  })

  // Success FIRST (fresh app, vendor ok), then the failure path — that ordering both matches the
  // vendor mode progression and leaves the draft holding the transcript so the failure test can
  // assert it stays UNCHANGED (draft preserved), the semantics that matter.
  test('listening → transcribing → final folds into the draft (out-of-band side-channel)', async () => {
    vendorMode = 'ok'
    const before = vendorHits
    await holdAndRelease()

    // The batch gap: cloud emits no partials, so the transcribing affordance fills it (pill wave +
    // flyout indicator). The vendor's delay keeps it on screen long enough to observe.
    await expect(page.locator('[data-test="voice-flyout-transcribing"]')).toBeVisible({
      timeout: 8_000
    })
    await expect(page.locator('.voice-pill.transcribing')).toHaveCount(1)

    // The final arrives out-of-band and folds into the draft; transcribing clears.
    await expect.poll(async () => (await voiceState()).draft, { timeout: 8_000 }).toBe(TRANSCRIPT)
    await expect(page.locator('[data-test="voice-flyout-input"]')).toHaveValue(TRANSCRIPT)
    await expect(page.locator('[data-test="voice-flyout-transcribing"]')).toHaveCount(0)
    expect(vendorHits).toBe(before + 1) // exactly one OpenAI round-trip per release (batch, not streaming)
  })

  test('a vendor failure surfaces a fail-visible cloud error; the draft is preserved', async () => {
    vendorMode = 'fail'
    const before = vendorHits
    await holdAndRelease() // a fresh capture also clears the prior transcribing state (draft kept)
    await expect(page.locator('[data-test="voice-flyout-cloud-error"]')).toBeVisible({
      timeout: 8_000
    })
    expect(vendorHits).toBe(before + 1) // the request WAS made — the failure is real, not skipped
    // The prior success's draft is untouched by the failure (the "draft preserved" contract).
    expect((await voiceState()).draft).toBe(TRANSCRIPT)
    await expect(page.locator('[data-test="voice-flyout-transcribing"]')).toHaveCount(0)
  })
})
