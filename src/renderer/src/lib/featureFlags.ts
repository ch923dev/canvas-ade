/**
 * Renderer-side build-time feature flags (electron.vite.config.ts `renderer.define`).
 *
 * Each flag is read through a `typeof` guard so the module works in BOTH regimes:
 *  - a real Vite build replaces the identifier textually → the guard folds to a constant
 *    and Rollup dead-code-eliminates the gated subtree (the compile-gate contract);
 *  - vitest runs the source with NO defines → the identifier is undeclared, and without
 *    the guard the first read would throw ReferenceError. Tests that need the gated UI
 *    mock THIS module (vi.mock) instead of defining the global.
 */

declare const __TERMINAL_OPENROUTER__: boolean | undefined

/**
 * Maintainer-private OpenRouter terminal routing (New Terminal dialog section + spawn-env
 * injection). False in every distributed build — true only when the maintainer's own
 * build/dev run sets TERMINAL_OPENROUTER=1.
 */
export function isTerminalOpenRouterEnabled(): boolean {
  return typeof __TERMINAL_OPENROUTER__ !== 'undefined' && __TERMINAL_OPENROUTER__ === true
}
