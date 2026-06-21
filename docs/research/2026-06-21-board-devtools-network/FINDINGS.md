# FINDINGS — Per-board DevTools (network + WebSocket) capture for Browser boards

**Date:** 2026-06-21 · **Engine:** OSR (offscreen `BrowserWindow` → DOM `<canvas>`, ADR 0002) ·
**Verified against:** Electron 42.3.3 / Chromium 148.0.7778.218 (live probe).

Research-first: the recommendation in §4 follows from §1–§3 and is hardened by the live verification in §5.

## 1. Option landscape

Five ways to observe network + WS from a board's offscreen `BrowserWindow`:

### A. CDP **Network domain** over the already-attached `wc.debugger`
The debugger is attached per board today (`previewOsr.ts:523`, for `Page`/`Runtime`/`DOM` widgets). Enabling
`Network` on the **same** attachment adds:
- **HTTP**: `requestWillBeSent` (method/url/headers/initiator/type; POST body only up to `maxPostDataSize`),
  `requestWillBeSentExtraInfo` (raw headers + cookies), `responseReceived` (status/headers/mime/timing/cache),
  `responseReceivedExtraInfo`, `dataReceived` (byte counts; inline chunk only if streaming armed),
  `loadingFinished`, `loadingFailed` (errorText/blockedReason/cors).
- **WebSocket**: `webSocketCreated`, `…WillSendHandshakeRequest`, `…HandshakeResponseReceived`,
  `webSocketFrameSent`, `webSocketFrameReceived`, `webSocketFrameError`, `webSocketClosed`. **Frame payloads ride
  inline** (`opcode`, `mask`, `payloadData`; binary base64).
- **Bodies NOT in events**: `getResponseBody(requestId)` after `loadingFinished` while buffered; POST via
  `getRequestPostData`; streaming via `streamResourceContent`. Memory via
  `Network.enable({maxTotalBufferSize, maxResourceBufferSize, maxPostDataSize})` + `configureDurableMessages`.
- **Fidelity: highest** (exactly what the DevTools Network panel consumes). **Limits:** body eviction on
  cross-process nav unless buffered/durable; sub-target (iframe/worker) partial without per-target attach; high
  event volume on chatty pages.

### B. Electron `session.webRequest` (per-board session already exists)
Metadata only (`onBeforeRequest/onSendHeaders/onHeadersReceived/onCompleted/onErrorOccurred`). **No response
bodies, no WS frames** (sees the `ws://` upgrade request, never the frames). Structurally can't deliver the two
headline features. Listeners are singular per session (would collide with future blocking use).

### C. In-page instrumentation (monkey-patch `fetch`/XHR/`WebSocket`/`EventSource`)
Inject via the existing `Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding` channel. App-level, lossy:
misses document/sub-resource/img/`sendBeacon`/worker traffic; JS-clock timing; **data originates in the
untrusted page world (forgeable) and the page can defeat the patch.** Fallback only.

### D. Proxy layer (`session.setProxy()` → local MITM)
Wire-level but blind to HTTPS without a generated CA (heavy, real security surface); re-implements WS framing;
duplicates what CDP gives free. Over-engineered for "inspect my localhost app."

### E. A second real CDP frontend (Electron DevTools / remote-debugging port)
**Hard conflict:** Electron enforces one debugger client per WebContents — opening DevTools **detaches our
programmatic debugger** (and vice versa), breaking IME/clipboard/widgets. Multi-client CDP exists in Chromium
≥63 but `webContents.debugger` doesn't expose it. Separate OS window, alien to the canvas. **Incompatible.**

| Option | Resp. bodies | WS frames | Sub-resources | Fidelity | Conflicts w/ current debugger | Effort |
|---|---|---|---|---|---|---|
| **A. CDP Network (shared attach)** | ✅ lazy | ✅ inline | ✅ | Highest | **None — same attachment** | Med |
| B. `webRequest` | ❌ | ❌ | ✅ meta | Metadata-only | None | Low (can't do the job) |
| C. In-page patch | ⚠️ partial | ⚠️ partial | ❌ | App-level, forgeable | None | Low–Med |
| D. Proxy | ⚠️ no-TLS-w/o-CA | ⚠️ | ✅ | Wire-level | None | High |
| E. Real DevTools | ✅ | ✅ | ✅ | Highest | **Detaches our debugger** | breaks invariants |

## 2. Analysis against this architecture + the hard problems

- **Shared attachment** — enabling more domains is not a second client; it's another `sendCommand` on the
  existing `wc.debugger`. The only thing it forecloses is opening native DevTools on that board (which we never
  do for an offscreen window). The widget message pump (`wc.debugger.on('message')`) is an `EventEmitter`, so a
  network module adds its own listener cleanly.
- **Per-board session** — events are scoped to the board's `wc`; the board `id` keys everything end-to-end, like
  `preview:osrFrame`/`Cursor` already do.
- **Trust boundary** — URLs/headers/bodies/WS payloads are page-controlled (the `MAX_TEXT` trust class). Cap in
  MAIN, render escaped, keep bytes opaque, re-validate renderer args in MAIN. New exfil surface (bodies may
  carry secrets) ⇒ lazy + user-initiated + capped.
- **Liveness/paint-gating** — CDP Network is independent of the paint pump; `stopPainting()` doesn't stop
  JS/network, so paint-gated live boards keep capturing (desirable). Eviction destroys the window → capture
  stops. Capture + storage live in MAIN; nothing crosses to the renderer unless a panel is subscribed (no
  per-frame IPC regression).
- **Hard problems** — *volume:* per-board ring buffer (drop-oldest + dropped marker), coalesced deltas while
  subscribed. *bodies/size:* lazy `getResponseBody` capped + truncation flag, `streamResourceContent` for SSE,
  `Network.enable` buffer caps. *untrusted:* cap + escape. *crash:* mark a boundary, re-enable defensively on the
  crash-ready gate; clear-on-nav with a preserve toggle.

## 3. How comparable tools solve it

- **Chrome DevTools Network panel** *is* the reference CDP-Network consumer: live metadata, **lazy body fetch on
  row click**, inline per-socket WS frames, clear-on-nav + "Preserve log", "reload to capture" caveat.
- **Puppeteer / Playwright / chrome-remote-interface** build on the same `Network`/`Fetch` domains; fetch bodies
  on demand; Playwright **spools HAR to disk** for big captures and documents the iframe/worker gap.
- **Borrow:** lazy body fetch; ring buffer + drop counter; clear-on-nav + preserve; inline per-socket WS view;
  disk-spool only if export added; HAR as the natural export format.

## 4. Recommendation

**Option A — CDP `Network` on the existing per-board debugger** as the sole capture path: metadata always-on for
live boards into a bounded MAIN ring buffer, **lazy** capped body fetch, **subscription-gated** IPC, and an
in-board React DOM inspector drawer. Reject B/D/E; keep C as a documented future fallback.

It is the only option delivering both headline features at full fidelity; it is **purely additive** to the
attachment we already pay for; it keeps board-`id` keying; and because capture is MAIN-side and only deltas flow
to a subscribed panel, it preserves both invariants — security caps at the boundary, **zero IPC when no
inspector is open** (no per-frame/camera regression; capture decoupled from paint).

(Integration sketch and capture policy → see `SPEC.md` §3–§10.)

## 5. Live verification (Electron 42.3.3 / Chromium 148) — risks resolved

A throwaway probe (deleted) mirrored `ensureOsr`'s debugger attach + `Page`/`Runtime`/`DOM` enables, drove real
HTTP + a hand-rolled RFC6455 WebSocket, and `SIGKILL`ed the renderer. Results:

- **Shared attachment CONFIRMED** — `Page` + `Runtime` + `Network` + WS events flowed on one client at once.
- **Risk #1 (crash/reload) RESOLVED, lower than feared** — after `SIGKILL` the debugger stayed attached
  (`isAttached=true`, no `detach`); reload **without** re-`Network.enable` re-emitted `requestWillBeSent×3 /
  responseReceived×3 / loadingFinished×3` + WS; the injected script re-ran (marker present). ⇒ re-enable is
  defensive, not required.
- **Risk #2 (bodies/buffer) RESOLVED with a tightened rule** — `configureDurableMessages` returned `ok` (exists
  in Chromium 148); `getResponseBody` returned the **full 4 MB body** despite `maxResourceBufferSize: 2 MB`. ⇒
  **CDP buffer params do NOT bound a single body — we must cap body size ourselves.**
- **WS payloads inline CONFIRMED** — `webSocketFrameReceived.response.payloadData === "pong-from-server"`.
- **Enable is cold-start-latent** — pre-navigation `sendCommand` *responses* lagged seconds but the commands took
  effect; mirror the existing `previewOsrWidgets.cdp()` **fire-and-forget** pattern (never `await` enables).

### Residual risks (verify during implementation)
- **#3** iframe/service-worker/worker sub-targets need `Target.setAutoAttach` flat-mode → v1 main-target-only,
  label the gap.
- **#4** event-volume ceiling: tune ring sizes + coalescing cadence vs an adversarial chatty page (the FIND-013
  "no per-event O(n) in MAIN" lesson).
- **#5** security sign-off on response bodies crossing MAIN→renderer at all (lazy+capped+user-initiated is the
  mitigation).

## Sources
- Electron 42 (Chromium 148): https://www.electronjs.org/blog/electron-42-0
- Electron Debugger API: https://www.electronjs.org/docs/latest/api/debugger
- Electron multi-client debugging #14540: https://github.com/electron/electron/issues/14540
- CDP Network domain: https://chromedevtools.github.io/devtools-protocol/tot/Network/
- getResponseBody eviction #44: https://github.com/ChromeDevTools/devtools-protocol/issues/44
- Playwright Network: https://playwright.dev/docs/network
- Playwright CDP iframe/body limits #21816: https://github.com/microsoft/playwright/issues/21816
