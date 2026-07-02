/**
 * Voice V2 — engine-host lifecycle (MAIN side).
 *
 * Owns fork/kill of the sherpa-onnx utilityProcess (`voiceEngineHost.js`, a sibling
 * main-bundle entry) and, at the SPIKE stage, the one-shot load-proof runner that the
 * CANVAS_VOICE_SPIKE gate in index.ts drives (dev leg AND packaged pack:dir leg). V2
 * proper grows this into the VoiceEngine interface (spawn/restart + the voice:port
 * engine end replacing voiceIpc's logger stub).
 */
import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { join } from 'path'
import type { SpikeResult } from './voiceEngineHost'

export function spawnEngineHost(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'voiceEngineHost.js'), [], {
    serviceName: 'voice-engine',
    stdio: 'pipe'
  })
  // Surface host output in MAIN's console — the addon's own load errors print here.
  child.stdout?.on('data', (d) => console.log(`[voice-engine] ${String(d).trimEnd()}`))
  child.stderr?.on('data', (d) => console.error(`[voice-engine] ${String(d).trimEnd()}`))
  return child
}

export type SpikeOutcome = Omit<SpikeResult, 't'>

/**
 * Fork the host, await its boot-time `{t:'spike:result'}`, kill the host. Resolves —
 * never rejects — so the index.ts gate can print/exit on a plain result. A host that
 * dies before posting (e.g. the addon crashes the process outright) resolves as a
 * failure via the 'exit' listener; a wedged host trips the timeout.
 */
export function runEngineSpike(timeoutMs = 15000): Promise<SpikeOutcome> {
  return new Promise((resolve) => {
    const child = spawnEngineHost()
    let settled = false
    const settle = (r: SpikeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(r)
    }
    const timer = setTimeout(
      () => settle({ ok: false, error: `spike timeout after ${timeoutMs}ms` }),
      timeoutMs
    )
    child.on('message', (m: unknown) => {
      const r = m as SpikeResult | null
      if (r?.t === 'spike:result') settle({ ...r })
    })
    child.on('exit', (code) => settle({ ok: false, error: `host exited (${code}) before result` }))
  })
}
