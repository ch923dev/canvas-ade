/**
 * Lazy ELK singleton (Phase 1) — the ONLY module that touches elkjs, so the ~1.4 MB engine stays
 * out of the renderer's entry bundle: `elk-api` (a small promise shim) and the `elk-worker` chunk
 * (the full engine, Vite `?worker`) both load on the FIRST expanse-diagram layout, and the engine
 * itself runs OFF-THREAD in a plain renderer Web Worker — a 200-node graph never janks the canvas.
 * (This is a same-origin bundled worker under the app CSP — NOT the Mermaid hidden-window worker;
 * no unsafe-eval, no extra window, per the REVIEW §3.2 posture.)
 *
 * Kept apart from `specLayout.ts` so the pure mapping stays unit-testable without loading ELK.
 */
import type { ElkGraphIn, ElkNodeOut } from './specLayout'

type ElkInstance = { layout: (graph: ElkGraphIn) => Promise<ElkNodeOut> }

let elk: ElkInstance | null = null
let loading: Promise<ElkInstance> | null = null

async function ensureElk(): Promise<ElkInstance> {
  if (elk) return elk
  loading ??= (async () => {
    const [{ default: ELK }, { default: ElkWorker }] = await Promise.all([
      import('elkjs/lib/elk-api'),
      // Vite `?worker`: the engine file becomes a lazy same-origin worker chunk.
      import('elkjs/lib/elk-worker.min.js?worker')
    ])
    elk = new ELK({
      workerFactory: () => new ElkWorker()
    }) as unknown as ElkInstance
    return elk
  })().catch((e) => {
    loading = null // a failed chunk fetch retries on the next layout call
    throw e
  })
  return loading
}

/** Run one ELK layout off-thread. Serialization-safe input only (plain JSON graph). */
export async function elkLayout(graph: ElkGraphIn): Promise<ElkNodeOut> {
  const inst = await ensureElk()
  return inst.layout(graph)
}
