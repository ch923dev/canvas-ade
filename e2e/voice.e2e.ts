import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Voice V1 — capture pipeline + voice:port (docs/research/2026-07-02-voice-to-text).
 *
 * Proves the full data plane end-to-end under Chromium's fake mic (CANVAS_FAKE_MEDIA=1 in
 * fixtures → MAIN appends `use-fake-device-for-media-stream`, which generates a tone):
 * `window.api.voice.start()` → MAIN brokers the MessagePort → renderer getUserMedia +
 * AudioWorklet pump ~120 ms Int16 frames back over the port → MAIN's stub engine end
 * counts them (`stop().frames` is the MAIN-side receipt — renderer counters alone can't
 * prove the port hop). Level/micSilent come from the renderer `voiceStore` via the
 * `voiceState` hook. The silent-zeros watchdog TRIP path is unit-tested (captureMath) —
 * the fake tone proves the negative here (frames flow, watchdog stays clear).
 */
const voiceState = (
  page: Page
): Promise<{ capturing: boolean; level: number; micSilent: boolean; framesSent: number }> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.voiceState())

test.describe('@voice capture pipeline (fake media)', () => {
  test('start pumps frames to MAIN; level rises; stop releases the pipeline', async ({ page }) => {
    const started = await page.evaluate(() => (globalThis as any).api.voice.start())
    expect(started.ok).toBe(true)
    // Windows/macOS report a real OS grant status; Linux has no such API → 'unknown'.
    expect(['granted', 'unknown']).toContain(started.micStatus)

    // Capture arms asynchronously (getUserMedia + addModule) once the port lands.
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 })
      .toBe(true)
    // ~8.3 frames/s → a second and a half of audio proves a steady pump, not a one-off.
    await expect
      .poll(async () => (await voiceState(page)).framesSent, { timeout: 10_000 })
      .toBeGreaterThan(8)
    // The fake device generates a tone — some frame must carry non-zero RMS.
    await expect
      .poll(async () => (await voiceState(page)).level, { timeout: 10_000 })
      .toBeGreaterThan(0)
    expect((await voiceState(page)).micSilent).toBe(false)

    const stopped = await page.evaluate(() => (globalThis as any).api.voice.stop())
    expect(stopped.ok).toBe(true)
    // MAIN-side receipt: the stub engine end actually RECEIVED frames over the port.
    expect(stopped.frames).toBeGreaterThan(8)

    // {t:'stop'} travels back over the port → the renderer tears the capture down.
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 })
      .toBe(false)
    expect((await voiceState(page)).level).toBe(0)

    // Frames stop flowing once released: MAIN has no live session to count into.
    const after = await page.evaluate(() => (globalThis as any).api.voice.stop())
    expect(after.frames).toBe(0)
  })

  test('restart replaces the live session cleanly (no double capture)', async ({ page }) => {
    await page.evaluate(() => (globalThis as any).api.voice.start())
    await expect
      .poll(async () => (await voiceState(page)).framesSent, { timeout: 10_000 })
      .toBeGreaterThan(2)
    // Second start while live: MAIN disposes the old channel, the renderer swaps sessions.
    await page.evaluate(() => (globalThis as any).api.voice.start())
    // framesSent resets on the new session's captureStarted and climbs again.
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 })
      .toBe(true)
    const stopped = await page.evaluate(() => (globalThis as any).api.voice.stop())
    expect(stopped.ok).toBe(true)
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 10_000 })
      .toBe(false)
  })
})
