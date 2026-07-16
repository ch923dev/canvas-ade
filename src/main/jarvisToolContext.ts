/**
 * Jarvis J4 — the tool-call origin marker. The confirm gates Jarvis rides live DEEP inside
 * the orchestrator (kanban gate, dispatch gate, visualize gate) and are invoked through the
 * registry's `confirm` binding — threading an "this confirm belongs to the Jarvis panel"
 * flag through every gate signature would smear the J4 concern across files that must not
 * know about it. AsyncLocalStorage carries the marker through the await chain instead:
 * `runAsJarvisToolCall` wraps the orchestrator call, `isJarvisToolCall()` reads it inside
 * `requestConfirm` when it posts to the renderer.
 *
 * 🔒 Scope note: the marker changes WHERE a confirm renders (panel turn-act card vs the
 * center modal), never WHETHER it happens — every degenerate renderer path still fails
 * closed in mcpConfirm.ts, and a non-Jarvis confirm can never acquire the marker (the ALS
 * store exists only inside `runAsJarvisToolCall`'s async context).
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage<{ jarvis: true }>()

/** Run `fn` (an orchestrator/tool call) with the Jarvis origin marker set. */
export function runAsJarvisToolCall<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({ jarvis: true }, fn)
}

/** True inside a `runAsJarvisToolCall` async context (read by requestConfirm). */
export function isJarvisToolCall(): boolean {
  return als.getStore()?.jarvis === true
}
