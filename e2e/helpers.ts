import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * Evaluate an expression STRING in the renderer main world (the homegrown `ctx.evalIn`).
 *
 * ⚠️ **Do not splice runtime VALUES into `expr`.** The string is run through `eval`, so it is a
 * code-execution sink, and `JSON.stringify` is a JSON escaper — *not* a JS-code escaper (CodeQL
 * `js/bad-code-sanitization`). Anything computed at run time — a seeded board id, a measured
 * baseline, a size — goes through {@link callE2E} instead, which passes real arguments through
 * Playwright's structured clone: there is no code string, so there is nothing to escape and nothing
 * to get wrong.
 *
 * What legitimately stays here: self-contained probes whose text is fixed at author time — no
 * interpolation (`` evalIn(page, `window.__canvasE2E.getZoom()`) ``), or interpolation of a
 * module-level literal constant from the same source file (`` `…fontSize', '${PINNED}'` ``), which
 * is not a data flow at all.
 */
export function evalIn<T>(page: Page, expr: string): Promise<T> {
  // The expr is a self-contained JS expression string (often an IIFE), matching the
  // homegrown probes verbatim. Wrap so `return` value crosses the bridge.
  return page.evaluate((source) => {
    return (0, eval)(source)
  }, expr) as Promise<T>
}

/** One `window.__canvasE2E` method call: the method name plus its arguments. */
export interface E2ECall {
  m: string
  a?: unknown[]
}

/**
 * Call one or more `window.__canvasE2E` methods with REAL arguments — the eval-free counterpart to
 * {@link evalIn}, and the way to pass any value into the renderer.
 *
 * **A batch is ONE `page.evaluate`, i.e. one synchronous JS turn**, so nothing can interleave
 * between the calls. That property is load-bearing, not incidental: `dataFlow.e2e.ts` must seed and
 * then pin a board without the page's event loop running in between, or a real MAIN batch lands
 * through the still-unguarded handler and wipes the seed (PR #398). The multi-call form replaces the
 * `(() => { …; … })()` IIFE that used to buy that atomicity by string-splicing.
 *
 * Returns the LAST call's value, so a single-call batch reads like a plain function call.
 */
export function callE2E<T>(page: Page, ...calls: E2ECall[]): Promise<T> {
  return page.evaluate((batch) => {
    const api = (
      globalThis as unknown as { __canvasE2E: Record<string, (...a: unknown[]) => unknown> }
    ).__canvasE2E
    let last: unknown
    for (const c of batch) last = api[c.m](...(c.a ?? []))
    return last
  }, calls) as Promise<T>
}

/** {@link pollEval} for a {@link callE2E} batch — poll until the last call returns truthy, or the
 *  timeout elapses. Returns false instead of throwing, like `pollEval`. */
export async function pollCall(page: Page, calls: E2ECall[], timeoutMs: number): Promise<boolean> {
  try {
    await expect.poll(() => callE2E<unknown>(page, ...calls), { timeout: timeoutMs }).toBeTruthy()
    return true
  } catch {
    return false
  }
}

/** Call a MAIN registry method via electronApp.evaluate (the homegrown `ctx.dbg.*`). */
export function mainCall<T>(
  app: ElectronApplication,
  method: string,
  ...args: unknown[]
): Promise<T> {
  return app.evaluate(
    ({}, { method, args }) => (globalThis as any).__canvasE2EMain[method](...args),
    { method, args }
  ) as Promise<T>
}

/**
 * Call a `window.api.*` preload method with REAL arguments — the eval-free counterpart to the old
 * `` evalIn(page, `window.api.x.y(${JSON.stringify(v)})`) `` shape. `path` is dot-separated below
 * `window.api` (e.g. `'mcpServers.setEnabled'`); the method is invoked on its parent object so
 * `this` binding stays correct. Arguments cross by structured clone, never by code string.
 */
export function apiCall<T>(page: Page, path: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ path, args }) => {
      const segs = path.split('.')
      const name = segs.pop() as string
      let parent = (globalThis as { api?: unknown }).api as Record<string, unknown> | undefined
      for (const s of segs) parent = parent?.[s] as Record<string, unknown> | undefined
      const fn = parent?.[name]
      if (typeof fn !== 'function') throw new Error(`window.api.${path} is not a function`)
      return (fn as (...a: unknown[]) => unknown).apply(parent, args)
    },
    { path, args }
  ) as Promise<T>
}

/** Poll a renderer expression until it returns truthy or the timeout elapses. Same interpolation
 *  caveat as {@link evalIn} — for a data-bearing probe use {@link pollCall}, or read the value with
 *  {@link callE2E} and poll the comparison here in Node. */
export async function pollEval(page: Page, expr: string, timeoutMs: number): Promise<boolean> {
  try {
    await expect.poll(() => evalIn<unknown>(page, expr), { timeout: timeoutMs }).toBeTruthy()
    return true
  } catch {
    return false
  }
}

/** Seed a board through the real store; returns its id. */
export function seed(page: Page, type: string, patch?: Record<string, unknown>): Promise<string> {
  return callE2E<string>(page, { m: 'seedBoard', a: patch ? [type, patch] : [type] })
}

/** P5: select a board + normalize zoom so the Board Inspector (the one control home since the
 *  title-bar clusters were removed) reveals for it. */
export async function selectForInspector(page: Page, id: string): Promise<void> {
  await callE2E(page, { m: 'select', a: [id] }, { m: 'setZoom', a: [1] })
}

/** P5: expand a (possibly collapsed) Inspector section by its header label. Sections like
 *  Configuration / Linking / Developer start collapsed (`defaultOpen={false}`), so a spec must
 *  open them before clicking the controls inside. No-op when already expanded. */
export async function openInspectorSection(page: Page, label: string): Promise<void> {
  const hd = page
    .locator('[data-test="board-inspector"] .ca-inspector-section-hd')
    .filter({ hasText: label })
  await expect(hd).toBeVisible()
  if ((await hd.getAttribute('aria-expanded')) === 'false') await hd.click()
}

/** P5: clear the selection so the left-docked Inspector hides again — a fitView'd board can span
 *  the whole window, and a still-revealed Inspector would occlude board-content clicks. */
export async function deselectInspector(page: Page): Promise<void> {
  await callE2E(page, { m: 'select', a: [null] })
}

/**
 * Seed a terminal board and wait until its PTY actually EXISTS in MAIN. Returns `{ id, pid }`.
 *
 * Shared (lifted out of `projectBackgroundDialog.e2e.ts`) because everything that measures or
 * asserts against a resource-BEARING canvas needs the same precondition: `seedBoard('terminal')`
 * returns the instant the board is in the store, but `TerminalBoard`'s mount only *kicks off* an
 * async `pty:spawn`. A switch measured (or a keep policy asserted) against a board whose PTY has
 * not landed yet is measuring an empty canvas while claiming otherwise — `askOnSwitchInfo` would
 * count zero terminals and the dialog would never even appear.
 *
 * Polls MAIN's own pid registry rather than any renderer-side flag: the pid is the only evidence
 * that a real process exists.
 */
export async function seedLiveTerminal(
  page: Page,
  app: ElectronApplication,
  timeoutMs = 20_000
): Promise<{ id: string; pid: number }> {
  const id = await seed(page, 'terminal')
  await expect
    .poll(async () => ((await mainCall<number | null>(app, 'terminalPid', id)) ?? 0) > 0, {
      timeout: timeoutMs
    })
    .toBe(true)
  return { id, pid: (await mainCall<number | null>(app, 'terminalPid', id)) as number }
}
