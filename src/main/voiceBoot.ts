/**
 * Voice V5 — the boot-time voice hooks, extracted from index.ts for the max-lines
 * ratchet (main's index.ts sits effectively AT the 700-code-line cap after #293/#296,
 * so the voice wiring cannot live inline; see docs/contributing/file-size-doctrine.md).
 * Two hooks, both driven by index.ts at the exact lifecycle points order requires:
 *
 * - `applyVoiceBootEnv()` — MODULE-SCOPE (pre-app.ready, pre-single-instance-lock):
 *   the fake-media Chromium switches (CANVAS_FAKE_MEDIA — env-gated in MAIN, not
 *   Playwright launch args: playwright#16621), and the CANVAS_VOICE_SPIKE userData
 *   isolation — a spike run of the packaged .exe must not fight the user's REAL
 *   installed instance for the single-instance lock (same app identity → silent quit
 *   before the gate runs), nor touch real state, so its userData moves to a temp dir
 *   BEFORE the lock is keyed on it.
 *
 * - `runVoiceSpikeGate(log)` — INSIDE app.whenReady(): the V2/V5 packaged-validation
 *   gate. Forks the engine host, proves the sherpa-onnx addon loads in THIS layout
 *   (dev out/ vs packaged asar-unpacked; V5 adds the decoder worker_threads context via
 *   `workerOk`), prints a marker, exits — no window, no IPC. CANVAS_VOICE_SPIKE='1' →
 *   stdout marker only; any other value is treated as a file path that ALSO receives
 *   the JSON result (the packaged-.exe leg on Windows has no reliable console).
 *   Returns true when it handled the boot (caller returns immediately); false on a
 *   normal run. Never part of a normal boot.
 */
import { app } from 'electron'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyFakeMediaSwitches } from './voiceIpc'
import { runEngineSpike } from './voiceEngine'

export function applyVoiceBootEnv(): void {
  applyFakeMediaSwitches(process.env, app.commandLine)
  if (process.env.CANVAS_VOICE_SPIKE) {
    app.setPath('userData', mkdtempSync(join(tmpdir(), 'expanse-voice-spike-')))
  }
}

export async function runVoiceSpikeGate(log: (line: string) => void): Promise<boolean> {
  if (!process.env.CANVAS_VOICE_SPIKE) return false
  const spike = await runEngineSpike()
  if (process.env.CANVAS_VOICE_SPIKE !== '1') {
    try {
      writeFileSync(process.env.CANVAS_VOICE_SPIKE, JSON.stringify(spike))
    } catch (err) {
      console.error('voice spike: result-file write failed', err)
    }
  }
  log(
    spike.ok
      ? `VOICE_SPIKE_OK version=${spike.version} resolved=${spike.resolvedPath}`
      : `VOICE_SPIKE_FAIL ${spike.error}`
  )
  app.exit(spike.ok ? 0 : 1)
  return true
}
