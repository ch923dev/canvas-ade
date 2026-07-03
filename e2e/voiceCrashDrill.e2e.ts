import { execSync } from 'child_process'
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * MANUAL V5 crash drill — SKIPPED in every normal suite run (the guards below): it kills
 * real OS processes by pid (Windows-only) and needs real speech audio + the installed
 * Kroko model. Run it on demand:
 *   CANVAS_FAKE_MEDIA_WAV=<repo>/src/main/__fixtures__/voice-librispeech-16k.wav \
 *     pnpm test:e2e --grep @voicedrill
 *
 * Proves SPEC §3 `error` live against the REAL engine host + REAL model: kill the host
 * mid-dictation → MAIN re-brokers once transparently (capture re-arms, no error row, the
 * draft keeps growing through the NEW host); kill the respawned host → error row with
 * Restart, capture stopped, DRAFT PRESERVED; the Restart CTA dictates again.
 * PASSED 2026-07-03 (win-x64, fixture WAV → "after early nightfall…" across both kills).
 */

const voiceState = (
  page: Page
): Promise<{ capturing: boolean; framesSent: number; draft: string; partial: string }> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.voiceState())

function pwsh(cmd: string): string {
  return execSync(`powershell -NoProfile -Command "${cmd}"`, { encoding: 'utf8' })
}

/** electronApp.process().pid is a LAUNCHER on Windows — the Chromium browser process is
 *  its (single) electron child; utility processes hang off the browser. */
function browserPid(launcherPid: number): number {
  const out = pwsh(
    `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${launcherPid}').ProcessId`
  )
  const pid = parseInt(out.trim().split(/\r?\n/)[0], 10)
  if (!Number.isFinite(pid)) throw new Error(`no browser child under launcher ${launcherPid}`)
  return pid
}

/** Pids of the browser's Node utilityProcess children (the voice host is one of these —
 *  Chromium's audio/GPU/renderer children are excluded by the NodeService filter). */
function nodeServicePids(browser: number): number[] {
  const out = pwsh(
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${browser}' | Where-Object { $_.CommandLine -match 'node.mojom.NodeService' } | Select-Object -ExpandProperty ProcessId`
  )
  return out
    .split(/\r?\n/)
    .map((l) => parseInt(l.trim(), 10))
    .filter((n) => Number.isFinite(n))
}

test.describe('@voicedrill engine crash → restart once → error (real host, real model)', () => {
  // Manual-only: pid-kill is Windows-shaped and the assertions need REAL speech decode.
  // Without the WAV env the fake tone never yields transcript text — skip everywhere
  // except an explicit drill invocation.
  test.skip(
    process.platform !== 'win32' || !process.env.CANVAS_FAKE_MEDIA_WAV,
    'manual drill: win32 + CANVAS_FAKE_MEDIA_WAV + installed Kroko model required'
  )

  test('kill host twice: transparent restart, then error row with draft preserved', async ({
    electronApp,
    page
  }) => {
    test.setTimeout(120_000)
    const mainPid = browserPid(electronApp.process().pid!)
    const before = new Set(nodeServicePids(mainPid))

    // Start dictation via the API (the pill needs no click for the drill).
    const started = await page.evaluate(() => (globalThis as any).api.voice.start())
    test.skip(started.modelStatus !== 'ready', 'drill needs the installed Kroko model')
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 15_000 })
      .toBe(true)

    // The engine host spawned lazily on this first session — the one new child pid.
    let hostPid = 0
    await expect
      .poll(
        () => {
          const fresh = nodeServicePids(mainPid).filter((p) => !before.has(p))
          if (fresh.length >= 1) hostPid = fresh[0]
          return fresh.length
        },
        { timeout: 15_000 }
      )
      .toBeGreaterThanOrEqual(1)

    // Real decode from the looping fixture WAV: wait for actual transcript text.
    await expect
      .poll(
        async () => {
          const s = await voiceState(page)
          return (s.draft + s.partial).length
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(5)
    const textBeforeCrash = await voiceState(page).then((s) => (s.draft + ' ' + s.partial).trim())

    // ── Crash #1: transparent restart ────────────────────────────────────────────
    const known = new Set(nodeServicePids(mainPid))
    execSync(`taskkill /PID ${hostPid} /F`)
    // MAIN re-brokers: a NEW host child appears and the capture re-arms.
    let hostPid2 = 0
    await expect
      .poll(
        () => {
          const fresh = nodeServicePids(mainPid).filter((p) => !known.has(p))
          if (fresh.length >= 1) hostPid2 = fresh[0]
          return fresh.length
        },
        { timeout: 15_000 }
      )
      .toBeGreaterThanOrEqual(1)
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 15_000 })
      .toBe(true)
    await expect(page.locator('[data-test="voice-flyout-error"]')).toHaveCount(0)
    // The pre-crash text survived the port swap (tail folded into the draft).
    const afterRestart = await voiceState(page)
    expect(afterRestart.draft.length).toBeGreaterThan(0)

    // ── Crash #2: budget spent → error state ─────────────────────────────────────
    execSync(`taskkill /PID ${hostPid2} /F`)
    await expect(page.locator('[data-test="voice-flyout-error"]')).toBeVisible({
      timeout: 15_000
    })
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 15_000 })
      .toBe(false)
    const errored = await voiceState(page)
    expect(errored.draft.length).toBeGreaterThan(0) // DRAFT SURVIVES THE CRASH
    console.log(`[drill] draft before crash: "${textBeforeCrash}"`)
    console.log(`[drill] draft in error state: "${errored.draft}"`)

    // ── Restart CTA: dictation resumes ──────────────────────────────────────────
    await page.locator('[data-test="voice-flyout-restart"]').click()
    await expect(page.locator('[data-test="voice-flyout-error"]')).toHaveCount(0)
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 15_000 })
      .toBe(true)
    const resumed = await voiceState(page)
    expect(resumed.draft.length).toBeGreaterThan(0) // still preserved after restart

    await page.evaluate(() => (globalThis as any).api.voice.stop())
    await expect
      .poll(async () => (await voiceState(page)).capturing, { timeout: 15_000 })
      .toBe(false)
  })
})
