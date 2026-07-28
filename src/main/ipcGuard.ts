import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

/**
 * The single IPC trust-boundary guard: TRUE when an invoke's sender is NOT the main window's
 * live main frame (foreign → the handler must deny). One source of truth, consumed by every
 * frame-guarded handler (preview/projectIpc/pty/llmIpc + audit/mcp). Was copy-pasted per file;
 * three of those copies resolved the frame in the caller (`getWin()?.webContents.mainFrame`),
 * which throws if the webContents is torn down mid-invoke — this canonical version takes `getWin`
 * and does the destroyed-window check itself so no caller touches a dead frame.
 *
 * Rules:
 * - No `senderFrame` → a synthetic/internal call (our own e2e harness / in-process invoke) → ALLOW.
 * - Window unresolved, destroyed, or its webContents destroyed → no trusted frame to match → DENY
 *   (and never touch `.webContents.mainFrame`, which throws on a torn-down window).
 * - Otherwise compare the sender frame against the live main frame.
 */
export function isForeignSender(
  e: Pick<IpcMainInvokeEvent, 'senderFrame'>,
  getWin: () => BrowserWindow | null
): boolean {
  if (!e.senderFrame) return false // synthetic/internal call — allow
  const win = getWin()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return true
  return e.senderFrame !== win.webContents.mainFrame
}

/** What `withProjectDir` needs to resolve the trusted frame and the current project. */
export interface ProjectDirDeps {
  getWin: () => BrowserWindow | null
  /** MAIN's authoritative current project dir (projectStore.getCurrentDir). */
  getDir: () => string | null
}

export interface ProjectDirOptions<A extends unknown[], R> {
  /** Channel name, used only in the rejection warning. */
  channel: string
  /**
   * Pulls the caller's `expectedDir` pin out of the handler's own argument list — the pin sits at
   * a different position on every channel (arg 1 for project:save/saveSession/terminal:
   * deleteSnapshot, arg 3 for terminal:writeSnapshot), so the wrapper is told where to look
   * rather than guessing. `undefined` = an unpinned legacy caller.
   */
  pickExpectedDir: (...args: A) => unknown
  /** The channel's own rejection value (`{ ok:false }` / `false` / …). Called per rejection. */
  reject: () => R
}

/**
 * SM-1 / audit R14: the ONE enforcement of the project-dir invariant for project-scoped WRITE
 * handlers. MAIN's module-level `currentDir` and the renderer's `useCanvasStore.project.dir` are
 * two independent "current project" values; BUG-009 is the class where they disagree and a write
 * that lost a switch race cross-writes one project's data into another's folder.
 *
 * The fix shipped as an ad-hoc `expectedDir` comparison hand-rolled into each write handler, which
 * works but has to be *remembered* by every new one. This wrapper is that guard, once:
 *
 *   foreign sender → reject · no project open → reject · pinned to a different dir → reject
 *
 * and only then calls the handler, passing the resolved `dir` so it cannot re-derive a different
 * one. Each channel keeps its own rejection shape (`reject`) — the renderer distinguishes a
 * non-error rejection from a write errno (C3), so unifying those would change the contract.
 *
 * `undefined` means "unpinned legacy caller" and is allowed; ANY other non-matching value is
 * rejected (fail closed), which is stricter than the old `typeof expectedDir === 'string'` form
 * in projectIpc — a non-string pin used to be silently ignored there.
 */
export function withProjectDir<A extends unknown[], R>(
  deps: ProjectDirDeps,
  opts: ProjectDirOptions<A, R>,
  handler: (dir: string, e: IpcMainInvokeEvent, ...args: A) => R | Promise<R>
): (e: IpcMainInvokeEvent, ...args: A) => R | Promise<R> {
  return (e, ...args) => {
    if (isForeignSender(e, deps.getWin)) return opts.reject()
    const dir = deps.getDir()
    if (!dir) return opts.reject()
    const expected = opts.pickExpectedDir(...args)
    if (expected !== undefined && expected !== dir) {
      console.warn(`[${opts.channel}] rejected: write is for`, expected, 'but current dir is', dir)
      return opts.reject()
    }
    return handler(dir, e, ...args)
  }
}
