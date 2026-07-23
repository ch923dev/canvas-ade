import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Phase 3 — cloud TTS end to end against the REAL built app + a FAKE OpenAI speech vendor. Proves
 * the whole streaming path the unit tests exercise in pieces, wired together live: config
 * (ttsEngine:'cloud') → the env-key gate → voice:tts:start brokers a port (no local model needed) →
 * voice:tts:speak → ONE POST /v1/audio/speech → the vendor STREAMS pcm chunks → the cloudTtsEngine
 * base64-frames them onto voice:tts:port → the renderer playback schedules them (speaking flips
 * true = audio delivered). Plus the fail-visible path: a 401 surfaces a tts error on the port
 * (lastError set), no crash.
 *
 * ISOLATED app (own CANVAS_USERDATA + env), NOT the shared worker fixture: the cloud env
 * (OPENAI_API_KEY as the store-less gate fallback + CANVAS_VOICE_OPENAI_BASE) and ttsEngine:'cloud'
 * config must not leak into the local/stub voice specs sharing the worker.
 */
let app: ElectronApplication
let page: Page
let server: http.Server
let vendorHits = 0
let vendorMode: 'ok' | 'fail' = 'ok'

/** ~2 s of silent 24 kHz s16le mono PCM, streamed in chunks — enough airtime that `speaking`
 *  stays observable whether or not the AudioContext clock advances in the headless leg. */
const PCM_CHUNK = Buffer.alloc(24_000, 0) // 12000 samples = 0.5 s
const PCM_CHUNKS = 4

const ttsState = (): Promise<{
  sessionLive: boolean
  speaking: boolean
  lastError: string | null
}> => page.evaluate(() => (globalThis as any).__canvasE2E.ttsState())
const startTts = (): Promise<{ ok: boolean }> =>
  page.evaluate(() => (globalThis as any).api.voice.tts.start())
const speak = (text: string): Promise<{ ok: boolean; id?: number; error?: string }> =>
  page.evaluate((t) => (globalThis as any).api.voice.tts.speak(t), text)
const setTtsCloud = (): Promise<unknown> =>
  page.evaluate(() => (globalThis as any).api.voice.config.set({ ttsEngine: 'cloud' }))

/** Open a fresh TTS session and wait for the renderer to adopt the brokered chunk port. */
async function openSession(): Promise<void> {
  expect((await startTts()).ok).toBe(true)
  await expect.poll(async () => (await ttsState()).sessionLive, { timeout: 10_000 }).toBe(true)
}

test.describe.serial('@voice cloud TTS (fake OpenAI speech vendor)', () => {
  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.includes('/audio/speech')) {
        vendorHits++
        req.resume()
        req.on('end', () => {
          if (vendorMode === 'fail') {
            res.writeHead(401)
            res.end('unauthorized')
            return
          }
          res.writeHead(200, { 'Content-Type': 'audio/pcm' })
          let n = 0
          const iv = setInterval(() => {
            if (n++ >= PCM_CHUNKS) {
              clearInterval(iv)
              res.end()
              return
            }
            res.write(PCM_CHUNK)
          }, 40)
        })
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
        CANVAS_USERDATA: mkdtempSync(join(tmpdir(), 'canvas-ttscloud-')), // isolate config
        OPENAI_API_KEY: 'sk-e2e-devkey', // env fallback → the cloud gate is open (no key store needed)
        CANVAS_VOICE_OPENAI_BASE: `http://127.0.0.1:${port}/v1`
      }
    })
    page = await app.firstWindow()
    await expect
      .poll(() => page.evaluate(() => !!(globalThis as any).__canvasE2E), { timeout: 15_000 })
      .toBe(true)
    await page.evaluate(() => (globalThis as any).__canvasE2E.reset())
    await setTtsCloud()
  })

  test.afterAll(async () => {
    await app?.close()
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  })

  test('speak → one POST /v1/audio/speech → streamed pcm plays (speaking flips true)', async () => {
    vendorMode = 'ok'
    const before = vendorHits
    await openSession()
    const r = await speak('Hello, this is a cloud voice test.')
    expect(r.ok).toBe(true)
    expect(typeof r.id).toBe('number')

    // Chunks reaching the renderer flip `speaking` true (delivery). One vendor round-trip per speak.
    await expect.poll(async () => (await ttsState()).speaking, { timeout: 8_000 }).toBe(true)
    expect(vendorHits).toBe(before + 1)
    expect((await ttsState()).lastError).toBeNull()
  })

  test('a vendor 401 surfaces a fail-visible tts error on the port (no crash)', async () => {
    vendorMode = 'fail'
    const before = vendorHits
    await openSession() // a fresh start() clears the prior lastError
    const r = await speak('This synthesis will fail.')
    expect(r.ok).toBe(true) // the speak is ACCEPTED; the failure lands async on the port
    await expect.poll(async () => (await ttsState()).lastError, { timeout: 8_000 }).not.toBeNull()
    expect(vendorHits).toBe(before + 1) // the request WAS made — the failure is real, not skipped
  })
})
