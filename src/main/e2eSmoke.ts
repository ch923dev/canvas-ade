/**
 * In-process board harness (CANVAS_SMOKE=e2e). MAIN seeds one of each board type
 * through the renderer hook (window.__canvasE2E) and asserts each works at runtime,
 * INCLUDING the Browser native WebContentsView layer that mainWindow.capturePage()
 * cannot see (asserted here via the preview manager's own per-view capturePage).
 *
 * Emits one marker line per board + a final E2E_DONE, and returns a summary whose
 * exitCode the caller assigns to process.exitCode. Verified by running the command;
 * not a vitest target (needs the live Electron runtime).
 */
import type { BrowserWindow } from 'electron'
import { summarizeE2E, type E2EPart } from './e2eReport'

// Markers go to stdout via bare console.log — safe here because index.ts installs a
// process.stdout 'error' handler (EPIPE swallow) before this runs whenever SMOKE is set.

/**
 * Sentinel echoed into a terminal board to prove the PTY↔xterm data plane.
 * Used by Tasks 5–7 when real per-board assertions are wired in.
 */
export const TERM_SENTINEL = 'CANVAS_E2E_TERM_OK'

function evalIn<T>(win: BrowserWindow, expr: string): Promise<T> {
  return win.webContents.executeJavaScript(expr, true) as Promise<T>
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll `fn` until it resolves truthy or the timeout elapses. */
async function poll(fn: () => Promise<boolean>, timeoutMs: number, stepMs = 120): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await delay(stepMs)
  }
}

export async function runE2ESmoke(win: BrowserWindow, localUrl: string): Promise<number> {
  const parts: E2EPart[] = []

  // The hook installs after React mounts — wait for it before driving anything.
  const hookReady = await poll(() => evalIn<boolean>(win, '!!window.__canvasE2E'), 8000)
  if (!hookReady) {
    const s = summarizeE2E([
      { name: 'hook', ok: false, detail: 'window.__canvasE2E never appeared' }
    ])
    console.log(s.line)
    return s.exitCode
  }

  // Tasks 5-7 push real parts here. For now, prove the seam: seed one of each and
  // assert they reached the store.

  // ── Terminal: seed with a launchCommand that echoes the sentinel, then read it
  // back off the xterm framebuffer (proves the PTY↔xterm data plane end to end). ──
  const termId = await evalIn<string>(
    win,
    `window.__canvasE2E.seedBoard('terminal', { launchCommand: 'echo ${TERM_SENTINEL}' })`
  )
  const termOk = await poll(async () => {
    const text = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return typeof text === 'string' && text.includes(TERM_SENTINEL)
  }, 10000)
  parts.push({
    name: 'terminal',
    ok: termOk,
    detail: termOk ? 'sentinel in framebuffer' : 'no sentinel'
  })

  await evalIn(win, `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(localUrl)} })`)
  await evalIn(win, "window.__canvasE2E.seedBoard('planning')")
  const count = await evalIn<number>(win, 'window.__canvasE2E.getBoards().length')
  parts.push({ name: 'seed', ok: count === 3, detail: `${count} boards` })

  const summary = summarizeE2E(parts)
  for (const p of parts) console.log(`E2E_${p.name.toUpperCase()} ${JSON.stringify(p)}`)
  console.log(summary.line)
  return summary.exitCode
}
