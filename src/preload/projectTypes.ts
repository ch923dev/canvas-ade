/**
 * Project I/O types shared by the preload `project` namespace and the renderer (factored out of
 * preload/index.ts under the max-lines ratchet; index re-exports them so import sites are
 * unchanged). The doc crosses the bridge as `unknown` — the renderer deep-validates.
 */
export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}
export type ProjectResult =
  | {
      ok: true
      dir: string
      name: string
      doc: unknown
      session?: unknown
      /** MAIN-measured `project:open` duration (ms), for switch instrumentation. Optional: older
       *  MAIN builds and non-instrumented paths omit it. Mirrors `src/main/projectStore.ts`. */
      openMs?: number
    }
  | { ok: false; error: string }
