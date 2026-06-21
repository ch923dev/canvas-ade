# SPEC — Per-board DevTools (Network + WebSocket) for Browser boards

| | |
|---|---|
| **Status** | Mocks done; dock + scope + body-security decisions LOCKED (2026-06-21). Dock = both/toggle/default-bottom · sub-targets IN scope · body fetch approved. Ready for **S4** on explicit pixel OK. |
| **Branch** | `feat/board-devtools-network` |
| **Author** | session 2026-06-21 |
| **Predecessor** | findings report (this folder's research; recommendation = Option A, CDP `Network` on the shared debugger) |
| **Scope (v1)** | HTTP requests/responses + WebSocket frames, **including sub-targets** (cross-origin iframes + service/web workers via `Target.setAutoAttach` flat-mode). Console/Storage are explicitly out of v1 but the design is the foundation for them. |

> **Design-artifact gate (CLAUDE.md).** This spec adds UI, so the implementation plan is **not** finalized
> until the design artifact is signed off. The ASCII wireframe in §9 is the structure/flow artifact; a
> **token-accurate throwaway HTML mock (rendered + screenshotted)** is the pixel-sign-off gate and must be
> approved **before** any panel code lands. No UI lands code-first.

---

## 1. Goal & non-goals

**Goal.** Give each Browser board an opt-in inspector that surfaces its page's live network activity —
HTTP request/response metadata + bodies (lazy) and WebSocket frames — without weakening the security or
performance character of the OSR preview engine.

**Non-goals (v1).**
- Console, Storage, Performance, Elements panels (future; same shared-attachment + buffer + subscribe pattern).
- ~~Sub-target traffic out of scope~~ — **now IN scope** (decided 2026-06-21): v1 attaches to cross-origin iframes + service/web workers via `Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:false, flatten:true})` and merges their `Network.*` events into the board's record set, tagged + origin-badged by target/frame. See §3 (sub-target capture) + §12 risk #3 (the one CDP behavior the 2026-06-21 probe did NOT cover → S1 re-probes flat-mode first).
- Request blocking / mocking / throttling (the `Fetch` domain / `Network.emulateNetworkConditions`) — read-only inspector only.
- Persisting captured data to `canvas.json` or disk (HAR export is a future add; §11).

## 2. Verified facts (live probe, Electron 42.3.3 / Chromium 148.0.7778.218)

These drive the design and are **confirmed against a running build**, not assumed (throwaway probe, deleted):

1. **Shared attachment works.** `Page` + `Runtime` + `Network` + WebSocket events all flowed on **one**
   `wc.debugger` client simultaneously. Enabling `Network` alongside today's widget domains needs **no second
   attach** and doesn't disturb IME/clipboard/widgets.
2. **Capture survives crash+reload without re-enabling.** After `SIGKILL` of the renderer, the debugger stayed
   attached (`isAttached === true`, no `detach`), and a reload re-emitted `requestWillBeSent/responseReceived/
   loadingFinished` + WS events **with no `Network.enable` re-issue**; the `addScriptToEvaluateOnNewDocument`
   hook also re-injected (marker present). ⇒ Re-enabling on crash is **defensive, not required**.
3. **`Network.configureDurableMessages` exists** in Chromium 148 (`ok`, not "method not found") — durable
   bodies across cross-process navigation are available.
4. **`getResponseBody` returns full multi-MB bodies** even with `maxResourceBufferSize: 2 MB` (got the full
   4 MB body back). ⇒ **CDP buffer params do NOT bound a single body; we MUST cap body size ourselves.**
5. **WS frame payloads ride inline** in `webSocketFrameSent/Received` (`payloadData`) — no separate fetch.
6. **Enable must be fire-and-forget.** Pre-navigation `sendCommand` *responses* are cold-start-latent (seconds);
   the commands still take effect. Mirror the existing `previewOsrWidgets.cdp()` helper (`void
   Promise.resolve(sendCommand(...)).catch(...)`) — never `await` enables in a blocking path.

## 3. Architecture & data flow

```
 page (untrusted, in offscreen renderer)
   │  HTTP / WS activity
   ▼
 wc.debugger 'message'  (Network.* / WS events)            [MAIN, per board]
   │  normalize + CAP at the trust boundary
   ▼
 per-board ring buffer (capped)  ── lives in MAIN, always-on for LIVE boards ──
   │  ONLY when a panel is subscribed: coalesced deltas (rAF/timer-batched)
   ▼  preview:osrNet  (id-dispatched, like preview:osrFrame)
 osrNetworkStore (renderer, ephemeral, per board)
   │
   ▼
 OsrNetworkPanel  (React DOM in .bb-stage — clips/rounds, no occlusion)
   │  user selects a row → lazy body fetch
   ▼  preview:osrNetGetBody → Network.getResponseBody (capped) → back to panel
```

**Key invariants preserved.**
- **No new per-frame/camera IPC.** Capture + storage are MAIN-side; the renderer receives data **only while a
  panel is open and subscribed**. Closed inspector ⇒ zero IPC (mirrors the frame-subscription model).
- **Security caps at the boundary.** Every page-controlled string (URL, header, body, WS payload) is
  size-capped in MAIN before it is buffered or sent, exactly like `MAX_TEXT` for dialogs today.
- **Capture is decoupled from the paint pump.** `stopPainting()` does not stop JS/network, so a paint-gated
  off-screen-but-live board keeps capturing — which is desirable (you want background traffic).

**Sub-target capture (flat mode).** `Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:false,
flatten:true})` on the board's session makes child targets (cross-origin iframes, service/web/shared workers)
surface as `Target.attachedToTarget` on the **same** `wc.debugger` client — flat mode = one connection,
`sessionId`-routed, no nested sockets. We fire-and-forget `Network.enable` on each child session as it attaches
and tag its records with the originating `targetId`/`frameId` (+ a `crossOrigin` flag → origin badge in the row).
`Target.detachedFromTarget` prunes that target's in-flight records. **This is the one CDP behavior the
2026-06-21 probe did NOT exercise** (it proved main-target attach/crash/bodies/WS) → **S1 re-probes flat-mode
auto-attach on Electron 42 / Chromium 148 before building on it**, and watches worker/iframe chatter against the
event-volume ceiling (risk #4).

## 4. Capture policy (resolves the open questions)

| Board state | Window | Capture | Notes |
|---|---|---|---|
| On-screen, painting | open | ✅ metadata + WS into ring buffer | normal |
| Off-screen / below-LOD, **paint-gated** (live ≤4) | open | ✅ still captures | network independent of paint (fact #2 logic) |
| **Evicted** (over `MAX_LIVE`) | destroyed | ⛔ stops; buffer frozen/dropped | debugger detaches with the window; panel shows "capture paused — board evicted" |
| Crashed | persists | buffer marks a crash boundary; resumes on reload | re-enable defensively in the crash-ready gate |

- **Always-on metadata for live boards** (cheap — events are small), into a **fixed-size ring buffer**
  (drop-oldest + a visible "N dropped" marker). This makes "reload to capture earlier requests" unnecessary
  for live boards (a DevTools pain point we can beat).
- **Bodies are never eager.** `getResponseBody`/`getRequestPostData` only on user selection, **capped**
  (default 5 MB, truncation flagged). `Network.streamResourceContent` for SSE/streaming responses.
- **Sub-targets**: each attached child target gets its own fire-and-forget `Network.enable`; its records merge
  into the board's ring buffer tagged by `targetId`/`frameId` and shown with a small cross-origin badge; a
  `detachedFromTarget` (closed iframe / stopped worker) prunes that target's still-pending records.
- **WS frames**: inline + cheap to receive, but high-volume ⇒ per-socket ring buffer + per-frame payload cap.
- **Clear-on-main-frame-navigation by default**, with a "Preserve log" toggle (DevTools parity).
- **`Network.enable`** issued fire-and-forget with `maxTotalBufferSize`/`maxResourceBufferSize`/`maxPostDataSize`
  + `configureDurableMessages` (bounds CDP-side memory; our own body cap is the real bound — fact #4).

## 5. Security model

- **New IPC channels are `isForeignSender`-guarded** (every one), same as all `preview:osr*` handlers.
- **Renderer-supplied args re-validated in MAIN**: `requestId` must match a live record for that board; body
  fetch capped server-side; unknown ids → no-op.
- **All captured strings are untrusted** (page-controlled). Cap in MAIN (URL ≤2 KB, header value ≤4 KB,
  header count ≤100, WS payload ≤16 KB stored, body ≤5 MB on fetch). Render as **escaped text** in React —
  never `innerHTML`, never `eval`, never auto-navigate/auto-open a captured URL.
- **New exfil surface — APPROVED 2026-06-21 (§12 risk #5).** Response bodies may carry tokens/PII. Approved
  mitigation: **lazy + user-initiated + 5 MB cap + truncation flag + scoped to the board's own session**. Bodies
  already conceptually leave MAIN as the page bitmap; this raises the signal but stays bounded. A sub-target
  body fetch uses **that child target's `sessionId`** (still the board's preview session) under the same caps.
- No weakening of `sandbox`/`contextIsolation`/`nodeIntegration`/deny-all-permissions/nav-allowlist.

## 6. IPC contract (new `preview:osrNet*` channels)

Renderer → MAIN (all `isForeignSender`-guarded; exposed in preload, id-dispatched like `onPreviewOsrFrame`):

| Channel | Args | Returns | Purpose |
|---|---|---|---|
| `preview:osrNetSubscribe` | `id` | `true` | start sending deltas for this board; replays current ring buffer once |
| `preview:osrNetUnsubscribe` | `id` | `true` | stop deltas (panel closed) → zero IPC |
| `preview:osrNetGetBody` | `{id, requestId, kind:'response'|'request'}` | `{body, base64, truncated}` or `{error}` | lazy, capped body fetch |
| `preview:osrNetClear` | `id` | `true` | clear this board's ring buffer |
| `preview:osrNetSetPreserve` | `{id, preserve}` | `true` | preserve-log-on-nav toggle |

MAIN → renderer:

| Channel | Payload | Notes |
|---|---|---|
| `preview:osrNet` | `{id, kind:'replay'|'delta'|'cleared'|'crash', records?, dropped?}` | coalesced batches, id-dispatched in preload |

## 7. Data model (renderer + MAIN ring buffer)

```ts
type NetRecord = {
  requestId: string
  url: string            // capped 2KB
  method: string
  type: string           // resourceType: fetch|xhr|document|script|ws|eventsource|...
  status?: number
  statusText?: string
  mimeType?: string
  fromCache?: boolean
  targetId?: string      // sub-target (iframe/worker) source; absent = main target
  frameId?: string
  crossOrigin?: boolean  // → small origin badge in the row
  reqHeaders?: Header[]   // count≤100, value≤4KB
  resHeaders?: Header[]
  startTs: number
  endTs?: number
  encodedDataLength?: number
  failed?: { errorText: string; blockedReason?: string; canceled?: boolean }
  // bodies NOT stored here; fetched lazily on selection
}
type WsRecord = {
  requestId: string; url: string; createdTs: number; closedTs?: number
  frames: { dir: 'sent'|'recv'; opcode: number; ts: number; payload: string /* capped 16KB */; truncated: boolean }[]  // ring, per socket
}
```

Ring sizes (initial; tune under §12 risk #4): **≤1000** `NetRecord` per board, **≤500** WS frames per socket,
**≤32** sockets per board. Over-cap ⇒ drop-oldest + increment `dropped`.

## 8. Where the panel lives (UX rationale)

The page renders into `.bb-live` (a `<canvas>` inside `.bb-frame`); `.bb-frame` is the **device viewport**
(390/834/1280, letterboxed within `.bb-stage` by `deviceFitScale`). Overlaying a panel *inside* `.bb-frame`
would break the responsive-viewport metaphor and cover the page. So the inspector is a **DOM panel inside
`.bb-stage`** (same overlay class family as `OsrWidgetLayer` — clips/rounds with the board, no occlusion),
toggled from a new **URL-bar icon button** beside mute/screenshot.

**Two dock positions, user-selectable (decided 2026-06-21).** A `▤ bottom ⇆ ▥ right` switch in the panel
header flips the layout; the choice is **remembered per board** (default = **bottom**):
- **Bottom drawer** — slides up over the lower stage (Chrome's "dock to bottom"); full-width request table,
  page above. Best for wide/short boards.
- **Right dock** — sits beside the page (page keeps painting, unobstructed); narrow single-line rows + stacked
  details. Best for tall boards & full-view.

Both share **one** `OsrNetworkPanel` with identical internals — only the flex axis + row density differ off a
`dock: 'bottom' | 'right'` prop (no duplicated logic). For serious inspection the board's existing **full-view**
(camera-fit) gives either dock real room — recommend (don't force) full-view when opening the inspector.
Signed-off artifacts: `mock/inspector-mock.png` (bottom + states) · `mock/inspector-mock-sidebyside.png` (right
dock + dock switch).

## 9. Design artifact — wireframe (sign-off gate)

Tokens: `--surface #141416` · `--surface-raised #1a1a1d` · `--surface-overlay #1e1e22` · `--border
rgba(255,255,255,.1)` · `--text #ededee` · `--text-2 #9b9ba1` · `--text-3 #7b7b81` · `--accent #4f8cff` ·
`--accent-wash`. One accent, functional only. No gradients/glow.

**(a) URL bar — collapsed (new toggle, far right beside mute/screenshot/open-external):**
```
┌───────────────────────────────────────────────────────────────────────────┐
│ ● connected  ◀ ▶ ⟳   http://localhost:5173/            390×844  🔉 ⤓ ⧉ [≣] │   ← [≣] = inspector toggle
└───────────────────────────────────────────────────────────────────────────┘
   accent when active ───────────────────────────────────────────────────┘
```

**(b) Inspector open — bottom drawer over `.bb-stage` (Network tab):**
```
┌──────────────────────── .bb-frame (page canvas, upper) ─────────────────────┐
│                          (page keeps painting above)                         │
├──────────────────────────────────────────────────────────────────────────── │ ← drag handle (resize)
│ Network │ Console·soon │ Storage·soon        ⟳clear  ⦿Preserve  🔎filter… ⤢  │ ← tabs + toolbar (⤢=full-view)
│ ───────                                                          24 reqs ·3⤓ │ ← drop counter
│ Name                     Method  Status  Type    Size     Time               │
│ small                    GET     200     fetch   35 B     4 ms               │
│ ▸ api/big                GET     200     xhr     4.0 MB   18 ms   ◀ selected  │
│ /ws  (websocket)         GET     101     ws      —        live    ⇅ 12       │
│ analytics.js             GET     (failed) script  —       —    ⚠ ERR_BLOCKED │
│ …                                                                            │
├───────────────────────── details pane (when a row is selected) ─────────────┤
│ Headers │ Payload │ Response │ Timing                                        │
│  Request URL: http://localhost:5173/api/big                                  │
│  Status: 200 · Type: application/octet-stream · From cache: no               │
│  ▸ Response Headers (7)     ▸ Request Headers (9)                            │
│  [ Response ] 4.0 MB — [ Load body ]   (lazy; capped 5 MB · truncation flag) │
└──────────────────────────────────────────────────────────────────────────── ┘
```

**(c) WebSocket selected — frames sub-view in the details pane:**
```
│ Frames │ Headers                                                             │
│  ▲ sent   text   hello-from-page                              12:31:04.221   │
│  ▼ recv   text   pong-from-server                            12:31:04.235   │
│  ▼ recv   binary <16 KB shown · truncated>                    12:31:05.010   │
```

**(d) States:**
```
empty   :  "Recording network activity…"  (live boards capture from open — no reload needed)
evicted :  "Capture paused — board off-screen (evicted). Bring it on-screen to resume."
crashed :  "— renderer crashed —"  divider in the log; capture resumes after Reload
dropped :  "24 reqs · 3 dropped (buffer full)"  in the toolbar
```

> **DONE (2026-06-21):** token-accurate HTML mocks built + screenshotted → `mock/inspector-mock.html`/`.png`
> (bottom drawer, states b–d) and `mock/inspector-mock-sidebyside.html`/`.png` (right dock + the `▤/▥` dock
> switch + a when-to-use legend). Dock model signed off = **both, toggle, default bottom** (§8). Final pixel
> sign-off pending explicit user OK before S4.

## 10. Touchpoints (integration sketch — file by file)

- **`src/main/previewOsrNetwork.ts`** *(new; mirrors `previewOsrWidgets.ts`)* — `attachOsrNetwork(wc, {emit,
  getEntry})`: fire-and-forget `Network.enable(...)` + `configureDurableMessages` on the main session **and**
  `Target.setAutoAttach({autoAttach,waitForDebuggerOnStart:false,flatten:true})`; its **own**
  `wc.debugger.on('message')` filtering `Network.*`/WS/`Target.*` and **routing by `sessionId`** (enable
  `Network` on each `attachedToTarget`, prune on `detachedFromTarget`); pure helpers (`normalizeRequest`,
  `capHeaders`, `ringPush`, `parseWsFrame`, `capBody`, `targetTag`) — all unit-tested. Body fetch +
  `streamResourceContent` carry the record's `sessionId` so sub-target bodies resolve.
- **`src/main/previewOsr.ts`** — in `ensureOsr`, after `attachOsrWidgets(...)`, call `attachOsrNetwork(...)`;
  extend `OsrEntry` with `net` (ring buffer + `subscribed` + `preserve`); re-enable defensively in
  `registerCrashReadyGate.onReady` (where `applyZoom` already re-applies); clear-on-nav via the existing
  `did-start-navigation` main-frame path unless `preserve`; `disposeOsr` drops the buffer; register the 5 new
  `preview:osrNet*` handlers (frame-guarded) — likely delegated to `registerOsrNetworkIpc(...)` in the new file
  to keep `previewOsr.ts` under its max-lines budget.
- **`src/preload/index.ts`** — expose `subscribeOsrNet/unsubscribeOsrNet/getOsrNetBody/clearOsrNet/
  setOsrNetPreserve` + `onPreviewOsrNet(id, listener)` **id-dispatched** like `onPreviewOsrFrame` (one
  `ipcRenderer.on('preview:osrNet')` fan-out map — avoids the N-listener pattern the widget events use).
- **`useOffscreenLiveness`** — no behavior change; **document** that capture follows window existence (live ≤4),
  not paint state. Optionally drop the renderer subscription when a board is evicted.
- **`useOffscreenInput.ts`** — untouched (input-only). Panel is a sibling.
- **Renderer (new):** `store/osrNetworkStore.ts` (ephemeral, per board, **cleared on unmount** — heed
  **FIND-011**: wire cleanup from the start); `canvas/boards/osr/useOsrNetwork.ts` (subscribes only while panel
  open); `canvas/boards/osr/OsrNetworkPanel.tsx` (drawer); a toggle button in `BrowserBoard.tsx`'s `.bb-urlbar`.
- **`pure libs`** for the table (sort/filter/format size+time) → unit-tested.

## 11. Persistence / schema

- **Captured data is ephemeral** (like `previewStore`) — never written to `canvas.json`.
- **Small per-board UI prefs ARE persisted** so the panel is "remembered per board" (the §8 dock decision): an
  **additive optional** `devtools?: { open?: boolean; dock?: 'bottom' | 'right' }` on the board → **writer-only**
  schema bump under ADR 0007 (no `minReaderVersion` move; older apps ignore the field). Defaults (closed, bottom)
  make an absent field read identically to today — zero migration.
- *Fallback if we want v1 strictly zero-schema:* hold `{open, dock}` in the ephemeral per-board store
  (remembered for the session only). **Recommend the additive persist** — cheap, ADR-0007-sanctioned, and the
  honest reading of "remembered per board."

## 12. Open risks / decisions needed

- **#3 sub-target coverage** (iframes/workers) — **IN scope** (decided 2026-06-21): flat-mode
  `Target.setAutoAttach`. **Action: S1 re-probes flat-mode auto-attach** on Electron 42 / Chromium 148 (the one
  CDP behavior the 2026-06-21 probe did NOT cover) before building; per-target detach/prune lifecycle + extra
  crash surface land in S6; watch worker/iframe chatter against risk #4.
- **#4 event-volume ceiling** — validate ring sizes + delta-coalescing cadence against an adversarial chatty page
  **(now incl. busy workers/iframes from the #3 expansion)** so MAIN CPU stays flat (the `FIND-013` "no
  per-event O(n) in MAIN" lesson). Verify during impl.
- **#5 security sign-off** — **RESOLVED / APPROVED (2026-06-21)**: response bodies cross MAIN→renderer lazy +
  user-initiated + 5 MB cap + truncation flag + same-(preview)-session scope; sub-target bodies use that
  target's `sessionId` under the same caps.
- **Panel home** — RESOLVED (2026-06-21): ship **both** dock positions (bottom drawer + right dock) with a
  per-board, remembered toggle, default bottom (§8); full-view available for either. Mocks signed off.

## 13. Testing

- **Unit** (vitest): all pure helpers (`normalizeRequest`, `capHeaders`, `capBody`, `parseWsFrame`, ring
  eviction, table sort/filter/format). This is where the bulk of coverage lives (Trophy model).
- **e2e** (`@preview` tag, `scripts/e2e-scope.mjs`): open a board against the local test server, open the
  inspector, assert a request row appears, select it, load a body, assert WS frames; assert a **sub-target**
  request (page embeds a cross-origin iframe + registers a worker that fetches) shows up origin-badged; assert
  zero IPC when the panel is closed (spy on the channel). Crash+reload capture-resume as a probe.
- **Manual dev check** (CLAUDE.md): `CANVAS_DEV_TITLE='PR#NN board-devtools-network' pnpm dev`, verify the title
  stamp, exercise the panel live.

## 14. Build sequence (slices, each runnable + committed)

1. **S1 — MAIN capture core + sub-target attach**: first re-probe `Target.setAutoAttach` flat-mode (the one
   unverified CDP piece), then `previewOsrNetwork.ts` (main + per-child `Network.enable`, `sessionId`-routed
   message listener, ring buffer + caps, target/frame tagging), wired in `ensureOsr`; no UI. Unit tests for
   helpers. (Console-log verify via a temp probe.)
2. **S2 — IPC + preload**: 5 `preview:osrNet*` handlers + id-dispatched preload + `onPreviewOsrNet`. Subscribe
   replay/delta. Frame-guard tests.
3. **S3 — Design mock**: ✅ token-accurate HTML mocks (bottom + right dock) → screenshots → sign-off.
   `mock/inspector-mock*.html`. Dock model = both / toggle / default-bottom.
4. **S4 — Renderer store + panel**: `osrNetworkStore`, `useOsrNetwork`, `OsrNetworkPanel` (renders BOTH docks
   off a `dock` prop), URL-bar toggle + the `▤/▥` dock switch, persisted `devtools?` pref (§11).
   FIND-011-correct unmount cleanup.
5. **S5 — Bodies + WS detail + clear/preserve**: lazy body fetch (capped), WS frames sub-view, clear + preserve.
6. **S6 — Sub-target lifecycle + liveness/crash polish + e2e**: per-target attach/detach prune, cross-origin
   origin badges on rows, eviction "paused" state, crash-resume, `@preview` e2e (incl. an iframe + a worker
   fixture from the local test server), full matrix.

---

*This is a draft for sign-off. Nothing in `src/**` changes until the §9 design artifact (HTML mock) is approved.*
