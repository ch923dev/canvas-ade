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
  | { ok: true; dir: string; name: string; doc: unknown }
  | { ok: false; error: string }
