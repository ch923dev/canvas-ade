import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { E2EProbe } from '../types'

/**
 * M-brain T-B2: the key store + status.hasKey round-trip, and the security invariant that
 * no key material lands in plaintext. Drives the real preload bridge (window.api.llm) to set
 * a sentinel key, then asserts MAIN-side (the probe runs in MAIN) that the on-disk store under
 * the temp e2e dir (CANVAS_E2E_LLM_DIR) holds CIPHERTEXT — the sentinel appears in NO file as
 * plaintext, and llm-config.json stays key-free. Then clears and confirms hasKey flips false.
 * On a host without encryption (safeStorage unavailable) setKey refuses cleanly; the probe
 * accepts that branch too (nothing is written, so the no-leak invariant still holds).
 */
const SENTINEL = 'E2E-KEY-DO-NOT-LEAK-9173'

export const settings: E2EProbe = {
  name: 'context-keystore',
  async run(ctx) {
    const dir = process.env.CANVAS_E2E_LLM_DIR
    if (!dir || !existsSync(dir)) {
      return {
        name: 'context-keystore',
        ok: false,
        detail: `CANVAS_E2E_LLM_DIR not set or missing (got ${dir ?? 'undefined'}) — key-store wiring broken`
      }
    }
    const setRaw = await ctx.evalIn<string>(
      `window.api.llm.setKey({ provider: 'openrouter', key: '${SENTINEL}' }).then((r) => JSON.stringify(r))`
    )
    const statusRaw = await ctx.evalIn<string>(
      'window.api.llm.status().then((s) => JSON.stringify(s))'
    )
    const set = JSON.parse(setRaw) as { ok: boolean; reason?: string }
    const status = JSON.parse(statusRaw) as { hasKey: boolean } & Record<string, unknown>

    // MAIN-side disk assertions against the temp e2e key dir.
    let noLeak = true
    let configClean = true
    let encryptedPresent = false
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue
      if (readFileSync(join(dir, f.name)).includes(SENTINEL)) noLeak = false
    }
    const keyFile = join(dir, 'llm-keys.json')
    encryptedPresent = existsSync(keyFile) && !readFileSync(keyFile, 'utf8').includes(SENTINEL)
    const cfg = join(dir, 'llm-config.json')
    configClean = !existsSync(cfg) || !readFileSync(cfg, 'utf8').includes(SENTINEL)

    // Key is never returned to the renderer.
    const keyNotLeakedToRenderer = !Object.values(status).includes(SENTINEL)

    // Clear path.
    await ctx.evalIn<string>(
      "window.api.llm.clearKey({ provider: 'openrouter' }).then((r) => JSON.stringify(r))"
    )
    const afterRaw = await ctx.evalIn<string>(
      'window.api.llm.status().then((s) => JSON.stringify(s))'
    )
    const after = JSON.parse(afterRaw) as { hasKey: boolean }

    const encryptionAvailable = set.ok === true
    const happy =
      encryptionAvailable && status.hasKey === true && encryptedPresent && after.hasKey === false
    // Refuse-persist host: setKey failed cleanly, nothing written, hasKey stayed false.
    const refused =
      !encryptionAvailable && set.reason === 'encryption-unavailable' && status.hasKey === false

    const ok = noLeak && configClean && keyNotLeakedToRenderer && (happy || refused)
    return {
      name: 'context-keystore',
      ok,
      detail: `set.ok=${set.ok} hasKey=${status.hasKey} enc=${encryptedPresent} noLeak=${noLeak} cfgClean=${configClean} noRendererLeak=${keyNotLeakedToRenderer} cleared=${after.hasKey === false}`
    }
  }
}
