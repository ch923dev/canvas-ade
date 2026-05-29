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
import { debugCaptureView } from './preview'

// Markers go to stdout via bare console.log — safe here because index.ts installs a
// process.stdout 'error' handler (EPIPE swallow) before this runs whenever SMOKE is set.

/** Sentinel echoed into a terminal board to prove the PTY↔xterm data plane. */
export const TERM_SENTINEL = 'CANVAS_E2E_TERM_OK'

/** Second sentinel — proves a respawned (config-changed) session is live (fix #1). */
export const TERM_SENTINEL2 = 'CANVAS_E2E_RESPAWN_OK'

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

  // Seed + assert one of each board type, plus a final 3-board count check. Each
  // block pushes its E2EPart; the summary decides the overall pass/fail + exit code.

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

  // ── Browser: seed pointing at the in-process localServer (deterministic), fit the
  // camera to it (forces zoom ≥ LOD so the native view attaches), wait for the
  // connected status, then assert a NON-BLANK per-view capturePage (the gap). ──
  const browserId = await evalIn<string>(
    win,
    `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(localUrl)} })`
  )
  await delay(150) // let React Flow mount + measure the new node before fitView
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
  const connected = await poll(async () => {
    const rt = await evalIn<{ status: string; live: boolean } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.status === 'connected' && rt.live === true
  }, 10000)
  let capDetail = 'not connected'
  let browserOk = false
  if (connected) {
    // Brief pause after connected: the view needs at least one paint before
    // capturePage yields non-blank pixels.
    await delay(300)
    const cap = await debugCaptureView(browserId)
    browserOk = cap.attached && !cap.empty
    capDetail = `attached=${cap.attached} empty=${cap.empty}`
  }
  parts.push({ name: 'browser', ok: browserOk, detail: capDetail })

  // ── Planning: seed, add a checklist element, assert it persisted on the board AND
  // that the whole canvas round-trips through the schema (persistence-readiness). ──
  const planId = await evalIn<string>(win, "window.__canvasE2E.seedBoard('planning')")
  await evalIn(win, `window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`)
  const planProbe = await evalIn<{ kinds: string[]; roundTrip: boolean }>(
    win,
    `(() => {
       const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)});
       const kinds = b && b.type === 'planning' ? b.elements.map((e) => e.kind) : [];
       return { kinds, roundTrip: window.__canvasE2E.roundTripOk() };
     })()`
  )
  const planOk = planProbe.kinds.includes('checklist') && planProbe.roundTrip
  parts.push({
    name: 'planning',
    ok: planOk,
    detail: `elements=[${planProbe.kinds.join(',')}] roundTrip=${planProbe.roundTrip}`
  })

  // ── Fix #2 (LOD-survival): zooming below LOD must NOT unmount the terminal and
  // kill its PTY. e2eTerminals registration tracks the xterm mount, so the board
  // staying mounted across LOD proves the session survives (pre-fix BoardNode
  // early-returned a LOD card → TerminalBoard unmounted → registration dropped). ──
  await evalIn(win, 'window.__canvasE2E.setZoom(0.2)') // < LOD_ZOOM (0.4)
  const lodAlive = await poll(
    () => evalIn<boolean>(win, `window.__canvasE2E.terminalMounted(${JSON.stringify(termId)})`),
    3000
  )
  parts.push({
    name: 'terminal-lod',
    ok: lodAlive,
    detail: lodAlive ? 'mounted across LOD (session alive)' : 'unmounted at LOD (PTY killed)'
  })

  // ── Fix #1 (restart/config respawn): changing launchCommand tears the old PTY
  // down and spawns a new one under the SAME board id — the path that raced. The
  // new session must come up and echo a fresh sentinel (a stale old-process onExit
  // must not reap it). Restore zoom first so xterm relayouts before reading. ──
  await evalIn(win, 'window.__canvasE2E.setZoom(1)')
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(termId)}, { launchCommand: 'echo ${TERM_SENTINEL2}' })`
  )
  const respawnOk = await poll(async () => {
    const text = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return typeof text === 'string' && text.includes(TERM_SENTINEL2)
  }, 10000)
  parts.push({
    name: 'terminal-respawn',
    ok: respawnOk,
    detail: respawnOk ? 'new session echoed after respawn' : 'respawned session not alive'
  })

  // ── Fix #4 (dead-URL status): a refused connection must end as 'load-failed',
  // NOT 'connected' (Chromium's error-page did-finish-load previously clobbered the
  // failure). Seed a browser at a closed port and assert the runtime status. ──
  const deadUrl = 'http://127.0.0.1:59999/' // nothing listens → connection refused
  const deadId = await evalIn<string>(
    win,
    `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(deadUrl)} })`
  )
  await delay(150)
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(deadId)})`)
  const failedOk = await poll(async () => {
    const rt = await evalIn<{ status: string; live: boolean } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(deadId)})`
    )
    return rt?.status === 'load-failed'
  }, 12000)
  parts.push({
    name: 'browser-deadurl',
    ok: failedOk,
    detail: failedOk ? 'refused URL → load-failed' : `did not reach load-failed`
  })

  const count = await evalIn<number>(win, 'window.__canvasE2E.getBoards().length')
  parts.push({ name: 'seed', ok: count === 4, detail: `${count} boards` })

  const summary = summarizeE2E(parts)
  for (const p of parts) console.log(`E2E_${p.name.toUpperCase()} ${JSON.stringify(p)}`)
  console.log(summary.line)
  return summary.exitCode
}
