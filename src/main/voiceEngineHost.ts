/**
 * Voice V2 — engine host (utilityProcess entry; SPIKE stage).
 *
 * Runs in a full-Node utilityProcess forked by MAIN (`voiceEngine.ts`) so the sherpa-onnx
 * native addon (+ the onnxruntime shared libs beside it) loads OUTSIDE main — crash-
 * isolated, and never anywhere near the renderer. This file is its own electron-vite
 * main-bundle entry (`out/main/voiceEngineHost.js`).
 *
 * SPIKE stage (the V2 gate from IMPLEMENTATION-PLAN.md): the host's only job is to prove
 * sherpa-onnx-node loads inside a utilityProcess under dev AND from a packaged pack:dir
 * layout (asarUnpack → app.asar.unpacked — the loading concern behind sherpa issues
 * #3108/#2622). On boot it requires the addon and posts a single `{t:'spike:result'}` to
 * the parent. The streaming-recognizer loop replaces this body in V2 proper behind the
 * same entry + message contract.
 */

export interface SpikeResult {
  t: 'spike:result'
  ok: boolean
  version?: string
  /** Where `sherpa-onnx-node` actually resolved (proves the asar-unpacked path when packaged). */
  resolvedPath?: string
  error?: string
}

function loadAddon(): SpikeResult {
  try {
    // Dynamic require so a load failure becomes a reportable result instead of a fork-time
    // crash. sherpa-onnx-node is CJS + externalized (the main bundle itself is CJS).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sherpa = require('sherpa-onnx-node')
    return {
      t: 'spike:result',
      ok: typeof sherpa?.OnlineRecognizer === 'function',
      version: String(sherpa?.version ?? 'unknown'),
      resolvedPath: require.resolve('sherpa-onnx-node')
    }
  } catch (err) {
    return {
      t: 'spike:result',
      ok: false,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err)
    }
  }
}

process.parentPort.postMessage(loadAddon())
