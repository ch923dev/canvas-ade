import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'

/** Evaluate an expression in the renderer main world (the homegrown `ctx.evalIn`). */
export function evalIn<T>(page: Page, expr: string): Promise<T> {
  // The expr is a self-contained JS expression string (often an IIFE), matching the
  // homegrown probes verbatim. Wrap so `return` value crosses the bridge.
  return page.evaluate((source) => {
    // eslint-disable-next-line no-eval
    return (0, eval)(source)
  }, expr) as Promise<T>
}

/** Call a MAIN registry method via electronApp.evaluate (the homegrown `ctx.dbg.*`). */
export function mainCall<T>(app: ElectronApplication, method: string, ...args: unknown[]): Promise<T> {
  return app.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({}, { method, args }) => (globalThis as any).__canvasE2EMain[method](...args),
    { method, args }
  ) as Promise<T>
}

/** Poll a renderer expression until it returns truthy or the timeout elapses. */
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
  const patchArg = patch ? `, ${JSON.stringify(patch)}` : ''
  return evalIn<string>(page, `window.__canvasE2E.seedBoard(${JSON.stringify(type)}${patchArg})`)
}
