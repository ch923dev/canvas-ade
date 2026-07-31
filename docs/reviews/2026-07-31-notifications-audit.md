# 2026-07-31 — Notification-system audit (full pipeline, 17 findings)

Full audit of the desktop-notification pipeline (4 recon passes: MAIN pipeline · renderer
state/UI · chrome dock · cross-cutting quality; every claim file:line-verified against
`8e41c527`). 17 ranked findings: **3 P1 + 6 P2 fixed** in the `feat/notifications-audit` PR
(P1-1 dead OS-click recovery · P1-2 sticky-toast starvation · P1-3 `lifecycleNotifications`
zero-coverage · P2 deliver dedupe / dead-window queue+replay / unguarded `defaultOsNotify` /
stale-Focus feedback / `backgroundSessions` master-switch gate / shared `isHeadlessHarness`).
The bell notification-center (history store + unread badge in the camera cluster) ships as the
follow-up PR. This file is the **open P3 backlog** + the deliberate non-fixes, so the next audit
does not re-flag them.

## P3 backlog (open — none fixed in the audit PR)

1. **`commandFeed.onUnrendered` never passed in production** (`backgroundSessionsBoot.ts`
   constructs the feed with `{send, deliver}` only) — a feed push with no Command board to render
   it is silently swallowed, the exact failure class the disclosure hook was written for.
2. **`flushCommandFeed` has zero callers** (`commandFeed.ts`) — the documented quit-chain drain
   does not exist; up to 120 ms of coalesced pushes drop at quit (timers are `unref`'d).
   `setCommandFeed(null)` likewise never runs outside tests.
3. **attentionStore never reset on project switch** — stale `byId` marks for the previous
   project's boards persist and feed `boardStatusBucket` → the MCP `canvas://attention` mirror
   (only the Jarvis panel filters against live boards). The bell PR adds `clearAll()`; wiring a
   switch-time reset remains open.
4. **Two disconnected background-exit toggles** — `notifyBackgroundExit` (ptyHost config, its own
   Settings row) AND `enabled`+`onDone` (notifications config) both gate the tray background-exit
   notification; neither pane mentions the other, so turning one off makes the other look dead.
5. **`blocked` rides `onInput` undocumented in the UI** — NotificationsPane's `onInput` sub-copy
   does not say it also silences stalled/lost/failing-check workers (`workerAttention.ts` doc-only).
6. **Corrupt `notifications-config.json` fails OPEN** — `readNotificationsConfig` repairs to
   defaults, silently re-enabling notifications the user turned off, with no warning surface.
7. **Eviction OS-notify asymmetry** — switch-time cap eviction (`disposeLiveResources.ts`) raises
   no OS notification; the sweep-time path does. Same user outcome, different audibility.
8. **Three hand-synced vocabulary mirrors** — `LifecycleEvent` (main) / preload copy /
   `AttentionKind` (renderer) / `WorkerAttention` (main) are one concept in four declarations;
   the renderer's off-vocabulary fallback papers over drift rather than removing it.
9. **PTY `monitored` snapshot at spawn** (`pty.ts` spawn opts) — re-enabling `monitorActivity`
   mid-session never restores exit/idle notifications until respawn (the deliver gate direction
   is live; the PTY pre-filter is not).
10. **Dead `styles.tl` / `styles.proj` objects in AppChrome** — ProjectSwitcher-extraction
    leftovers, invisible to `no-unused-vars` (object properties).
11. **e2e `reset()` does not clear `attentionStore`** — cross-spec attention leakage is possible;
    `notifications.e2e.ts` is safe only because it seeds fresh board ids. (The bell PR adds the
    notification-center clear beside it.)
12. **Toast island paints over the Jarvis panel's bottom-right region** (z 10100 over z 70) — no
    adaptive shift exists for right-docked panels; only the minimap collision is handled.
13. **BoardAttention has no aria-live** — ring/badge changes are silent to a screen reader, and
    `blocked` vs `needs-input` differ only by badge glyph at identical `--warn` colour.
14. **`markAllRead` (bell PR) does not dismiss lingering sticky lifecycle toasts** — an id-prefix
    sweep over `lifecycle:*` would; deferred as polish.
15. **Session-only history** — the bell's `notificationCenterStore` is ephemeral by decision; a
    persisted userData history (capped JSONL) is a possible follow-up if restarts prove lossy in
    practice.

## Deliberate non-fixes (decisions, not gaps)

- **`ptyHost/bridge.ts` daemon-failure notifier stays OUTSIDE the notifications master switch** —
  an infrastructure fault must stay audible (D2: "the in-proc fallback must never be silent"). It
  now shares `isHeadlessHarness` for its mute; nothing else changed.
- **The renderer `project:bgLifecycle` push stays ungated** — "your project was closed to free
  memory" is a consequence report the user must see in-app; only the OS layer honors the master
  switch.
- **No new notifications-config key for dedupe** — a delivery invariant, not a preference (the
  `workerAttention` no-new-key rationale).
- **No agent-kind guard in `ptyLifecycleMonitor`** — the idle heuristic still serves non-Claude
  CLIs; the deliver-level dedupe is the general fix the SPEC names.
