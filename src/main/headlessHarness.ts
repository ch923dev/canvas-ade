/**
 * The ONE definition of "this run is a headless harness" (e2e or the smoke self-test), shared by
 * every OS-notification producer. Zero-dep leaf on purpose: lifecycleNotifications.ts (the previous
 * home) imports ./pty, so exporting from there would drag node-pty into the import graph of every
 * consumer's unit test (backgroundSessions.test.ts et al.).
 *
 * A real native OS notification is pure noise during an automated headless run. The e2e harness
 * (`CANVAS_E2E`) spawns real terminal boards whose idle-scan lifecycle events — plus any recap-map
 * appends — funnel through the SAME production `deliver` as at runtime, so WITHOUT this every e2e run
 * pops real Windows/macOS notifications onto the dev's desktop (the distraction this suppresses).
 * Under any headless harness (e2e, or the `CANVAS_SMOKE` self-test) the OS layer becomes a no-op; the
 * in-app toast + on-canvas attention still push to the renderer, and the dedicated notifications.e2e.ts
 * asserts the OS decision through its OWN recording spy (e2eMain's `createNotifyProbe`) — so muting the
 * REAL Notification here costs zero coverage. Dev (`pnpm dev`) sets neither var, so it is unaffected.
 */
export function isHeadlessHarness(): boolean {
  return !!process.env.CANVAS_E2E || !!process.env.CANVAS_SMOKE
}
