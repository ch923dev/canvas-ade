/**
 * Env-gated MAIN test registry for the Playwright _electron harness (T4). Installed
 * ONLY when CANVAS_E2E is set; exposes the preview/pty internals the renderer hook
 * cannot see, plus the project/clipboard/input helpers the whiteboard slivers need.
 * Playwright reaches these via electronApp.evaluate(() => globalThis.__canvasE2EMain.*).
 *
 * This is a registry + an env flag — NOT a security change. sandbox / contextIsolation /
 * nodeIntegration are untouched; nothing here is reachable in a normal run.
 */
import { clipboard, nativeImage, type BrowserWindow } from 'electron'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugCaptureView, debugViewIds, debugViewWebContentsId } from './preview'
import { debugTerminalPid, debugWriteTerminal, disposeAllPtys } from './pty'
import { createProject, setCurrentDir } from './projectStore'

export interface E2EMain {
  terminalPid(id: string): number | null
  writeTerminal(id: string, data: string): boolean
  captureView(id: string): Promise<{ attached: boolean; empty: boolean }>
  viewIds(): string[]
  viewWebContentsId(id: string): number | null
  /** Real OS input through the live window (mouse/keyboard) — preserves transform hit-testing. */
  sendInput(evt: Parameters<BrowserWindow['webContents']['sendInputEvent']>[0]): void
  /** Mint a temp project dir + set it current (e2e has no project dir). Returns the path. */
  createTempProject(prefix: string, name: string): Promise<string>
  /** Clear the current dir + delete the temp project (best-effort). */
  teardownProject(tmp: string): void
  /** Put a w×h opaque-red RGBA bitmap on the system clipboard (for the paste sliver). */
  putRedBitmapOnClipboard(w: number, h: number): void
  /** True if an absolute path exists on disk (assert a pasted blob landed). */
  fileExists(absPath: string): boolean
  /** Join a temp-project path with a relative asset path (cross-platform). */
  joinPath(...parts: string[]): string
  /** The in-process local preview server URL — a deterministic page the browser probe seeds. */
  localUrl(): string
  /** Live descendant pids of `pid` (transitive). [] when the tree is fully reaped. */
  childPidsOf(pid: number): number[]
  /** Tear down EVERY pty session (live + parked) — the real MAIN kill path. */
  disposeAllPtys(): Promise<void>
}

/**
 * All (pid, ppid) pairs on the OS — Windows via PowerShell CIM, POSIX via `ps`.
 * Used only by the env-gated childPidsOf to assert a killed tree left no orphans.
 */
function listProcessParents(): Array<{ pid: number; ppid: number }> {
  let out = ''
  try {
    if (process.platform === 'win32') {
      out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
        ],
        { encoding: 'utf8' }
      )
    } else {
      out = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    }
  } catch {
    return []
  }
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2)
    .map(([a, b]) => ({ pid: Number(a), ppid: Number(b) }))
    .filter((p) => Number.isFinite(p.pid) && Number.isFinite(p.ppid))
}

/** Breadth-first transitive descendants of `root` from a (pid→ppid) snapshot. */
function descendantPids(root: number): number[] {
  const all = listProcessParents()
  const childrenOf = new Map<number, number[]>()
  for (const { pid, ppid } of all) {
    const arr = childrenOf.get(ppid) ?? []
    arr.push(pid)
    childrenOf.set(ppid, arr)
  }
  const out: number[] = []
  const queue = [...(childrenOf.get(root) ?? [])]
  while (queue.length) {
    const pid = queue.shift() as number
    out.push(pid)
    queue.push(...(childrenOf.get(pid) ?? []))
  }
  return out
}

declare global {
  // eslint-disable-next-line no-var
  var __canvasE2EMain: E2EMain | undefined
}

/** Install the registry. No-op unless CANVAS_E2E is set. Call once after the window exists. */
export function installE2EMain(win: BrowserWindow, localUrl: string): void {
  if (!process.env.CANVAS_E2E) return
  globalThis.__canvasE2EMain = {
    terminalPid: debugTerminalPid,
    writeTerminal: debugWriteTerminal,
    captureView: debugCaptureView,
    viewIds: debugViewIds,
    viewWebContentsId: debugViewWebContentsId,
    sendInput(evt) {
      win.webContents.sendInputEvent(evt)
    },
    async createTempProject(prefix, name) {
      const tmp = mkdtempSync(join(tmpdir(), prefix))
      await createProject(tmp, name, {})
      setCurrentDir(tmp)
      return tmp
    },
    teardownProject(tmp) {
      setCurrentDir(null)
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    },
    putRedBitmapOnClipboard(w, h) {
      const buf = Buffer.alloc(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = 255 // R
        buf[i * 4 + 3] = 255 // A (G/B stay 0 → opaque red)
      }
      clipboard.clear()
      clipboard.writeImage(nativeImage.createFromBitmap(buf, { width: w, height: h }))
    },
    fileExists(absPath) {
      return existsSync(absPath)
    },
    joinPath(...parts) {
      return join(...parts)
    },
    localUrl() {
      return localUrl
    },
    childPidsOf(pid) {
      return descendantPids(pid)
    },
    disposeAllPtys() {
      return disposeAllPtys()
    }
  }
}
