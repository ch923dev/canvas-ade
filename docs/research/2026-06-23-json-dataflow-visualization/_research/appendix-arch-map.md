I have the complete picture. Here is the technical map.

---

# Canvas ADE — Per-Browser-Board DevTools Network Inspector: Exact Data Pipeline

The pipeline is a single linear flow: **CDP `wc.debugger` (MAIN) → ring buffer (MAIN) → `preview:osrNet` IPC → preload dispatch → `osrNetworkStore` (renderer) → `OsrNetworkPanel`/`OsrNetworkDetail` → `prettyBody` → `.bb-net-bodytext` `<pre>`**. Bodies travel out-of-band via a lazy, capped, user-initiated `preview:osrNetGetBody` round-trip.

---

## 1. CAPTURE — `src/main/previewOsrNetwork.ts` (MAIN-only, CDP over `wc.debugger`)

### Attachment model
- `attachOsrNetwork(wc, deps)` adds **ONE** `wc.debugger.on('message', …)` listener on the **already-attached** per-board debugger (the same client `previewOsrWidgets.ts` uses — no second CDP client). Then calls `armOsrNetwork`.
- `armOsrNetwork(wc)` (idempotent, fire-and-forget via `netCdp`, never awaited) sends:
  - `Network.enable` with `{maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000, maxPostDataSize: 65_536}` — CDP-side caps are generous; the real bound is `BODY_CAP` on the lazy fetch.
  - `Target.setAutoAttach {autoAttach:true, waitForDebuggerOnStart:false, flatten:true}` — **flat mode** brings WORKER/service-worker targets onto the same client, routed by `sessionId`. Iframes already ride the root session.
- `wireOsrNetwork(wc, state, send, id)` is the one-call entry from `ensureOsr`: builds `emit = (msg) => send('preview:osrNet', {id, ...msg})`, then wires nav handlers:
  - `did-start-navigation` → if `isMainFramePageNav(details)` (`isMainFrame && !isSameDocument`), **re-arm** (a real nav can swap the renderer process and drop the Network domain) and set `state.pendingNav = true` (clear is deferred to the new document request).
  - `did-finish-load` → re-arm again (belt-and-suspenders for SPA XHR floods).

### Event routing — `handleNetMessage` (switch on CDP method)
| CDP method | Mutation | Helper |
|---|---|---|
| `Network.requestWillBeSent` | new row, or redirect-hop finalize + re-key + fresh row, or same-id re-send | `recordFromRequest`, `applyRedirectResponse`+`reKeyRedirectHop`, `applyRedirect` |
| `Network.responseReceived` | status/timing/mime/cacheSource/remoteAddress/resHeaders | `applyResponse` |
| `Network.dataReceived` | accumulate `decodedLength` | `applyDataReceived` |
| `Network.requestServedFromCache` | `cacheSource='memory'`, `fromCache=true` | inline |
| `Network.loadingFinished` | `endTs`, `encodedDataLength`, `finishMono` | `applyFinished` |
| `Network.loadingFailed` | `failed{errorText,blockedReason,canceled}` | `applyFailed` |
| `Network.webSocketCreated` | pushes a `type:'websocket'` request row + `ensureWs` | inline |
| `Network.webSocketHandshakeResponseReceived` | status 101 + `reqHeaders`/`resHeaders` on the `WsRecord` | inline |
| `Network.webSocketFrame{Sent,Received}` | append capped `WsFrame` | `wsFrameFrom`, `pushWsFrame` |
| `Network.webSocketClosed` | `closedTs` + finalize row `endTs` | inline |
| `Target.attachedToTarget` | register child `sessionId`, `Network.enable` on it | inline |
| `Target.detachedFromTarget` | drop child session | inline |

Every mutation calls `markRecord`/`markWs` → `scheduleFlush` (a `FLUSH_MS=100` coalescing timer, **only while `state.subscribed`**).

### `NetRecord` fields (the HTTP/WS request row) — `OsrNetState` + mirrored in `preload/index.ts:124`
`requestId, url, method, type` (resourceType), `status, statusText, mimeType, fromCache, decodedLength` (summed from `dataReceived`), `cacheSource` (`'disk'|'memory'|'sw'|'prefetch'`), `remoteAddress` (`ip:port`), `referrerPolicy, reqHeaders[], resHeaders[]` (`NetHeader{name,value}`), `startTs, endTs, encodedDataLength` (wire/transfer bytes), `timing` (`NetTiming` ResourceTiming subset: `requestTime` + 9 ms-relative phase marks), `finishMono` (loadingFinished monotonic seconds → Content Download end), `failed{errorText,blockedReason?,canceled?}`, `initiator` (script url or CDP type word, or literal `'Redirect'`), `loaderId, preserved, navBoundary, sessionId, frameId, crossOrigin`.

### `WsRecord` / `WsFrame` fields
- `WsRecord`: `requestId, url, createdTs, closedTs?, reqHeaders?, resHeaders?, frames[]`.
- `WsFrame`: `dir:'sent'|'recv', opcode, ts, length` (pre-cap byte length via `wsFrameByteLength`), `payload` (capped `WS_PAYLOAD_CAP`), `truncated`.

### Body fetch — lazy, capped, user-initiated (the ONLY body egress)
**No body is ever buffered during capture.** `preview:osrNetGetBody` (handler in `registerOsrNetworkIpc`) runs `Network.getResponseBody` or `Network.getRequestPostData` on the record's own `sessionId`, then `capBody(raw, base64)`:
- `BODY_CAP = 5 * 1024 * 1024` (5 MB). Over cap → `body.slice(0, max)` + `truncated:true`.
- Returns `NetBody{body, base64, truncated}` or `{error}`. `base64Encoded === true` (binary) flows through untouched (never re-parsed).

### Secret/size handling at the trust boundary (all in MAIN, BEFORE buffering)
Every captured string is page-controlled, so it is capped *before* it enters the ring:
- `URL_CAP=2048`, `HEADER_VALUE_CAP=4096`, `HEADER_COUNT_CAP=100`, `WS_PAYLOAD_CAP=16KB`, method 16, type 32, statusText 256, mimeType 128, requestId 256.
- `capText(v, max)` collapses non-strings to `''`; `capHeaders` normalizes `{name:value}` → bounded `NetHeader[]`.
- Ring caps: `MAX_RECORDS=1000`/board (drop-oldest, `ringPushRecord`, `dropped++`), `MAX_WS_FRAMES=500`/socket, `MAX_SOCKETS=32`/board.
- **No secret scrubbing/redaction** — headers like `Authorization`/`Cookie` are captured verbatim (capped only). Cookies/auth surface in the Headers/Cookies tabs as-is.

---

## 2. TRANSPORT — IPC + preload surface + renderer store

### IPC channels (`registerOsrNetworkIpc`, all `isForeignSender`-guarded, args re-validated against live MAIN state)
| Channel | Direction | Guard / behavior |
|---|---|---|
| `preview:osrNetSubscribe` | R→M invoke | sets `subscribed=true`, emits `snapshotNet` (full `replay`) once |
| `preview:osrNetUnsubscribe` | R→M invoke | `subscribed=false` + `stopNetFlush` → **zero further IPC** |
| `preview:osrNetClear` | R→M invoke | `clearNet` + emit `{kind:'cleared'}` |
| `preview:osrNetSetPreserve` | R→M invoke | sets `state.preserve` |
| `preview:osrNetGetBody` | R→M invoke | lazy body fetch (see §1); requestId must match a live record |
| `preview:osrNet` | M→R send | id-stamped `OsrNetMsg` batches (`replay`/`delta`/`cleared`) |

### Preload surface — `src/preload/index.ts`
- Types mirrored verbatim (`NetHeader`/`NetTiming`/`NetRecord`/`WsFrame`/`WsRecord`/`OsrNetMessage`/`OsrNetBody`, lines 108-185). Note `OsrNetMessage` carries `id` (renderer-side); MAIN's `OsrNetMsg` does not (`id` is injected by `emit`).
- `api.subscribeOsrNet/unsubscribeOsrNet/clearOsrNet/setOsrNetPreserve/getOsrNetBody` wrap the invokes.
- `onPreviewOsrNet(id, listener)`: one shared `ipcRenderer.on('preview:osrNet')` (`ensureOsrNetListener`) dispatches by `m.id` to a per-board handler in `osrNetHandlers` Map. Returns an unsubscribe.

### Subscription lifecycle — `useOsrNetwork(boardId)`
Subscribes ONLY while `byBoard[id].open`. On open: registers the handler → `subscribeOsrNet` (replay + deltas). On close/unmount: `off()` + `unsubscribeOsrNet`. A second effect calls `clearBoard(id)` on unmount (FIND-011: state dies with the board).

### Store shape — `src/renderer/src/store/osrNetworkStore.ts` (Zustand, ephemeral, never serialized)
- `byBoard: Record<string, BoardNet>` where `BoardNet = {records[], ws[], dropped, open, dock:'bottom'|'right', tab:'network', preserve, selected?, size?:{bottom?,right?}}`.
- `apply(id, msg)`: `replay` **replaces** records/ws/dropped/preserve; `cleared` **empties** + clears `selected`; `delta` **upserts by `requestId`** (`upsert` replaces-in-place or appends) then **tail-caps** (`capTail` to `MAX_RECORDS=1000`/`MAX_SOCKETS=32`, mirroring MAIN's ring since deltas carry no eviction signal).
- Actions: `setOpen, setDock, setTab, setSize(id,dock,frac), setPreserve, select(id,requestId?), clearBoard(id)`.

---

## 3. RENDER — `OsrNetworkPanel.tsx` + `OsrNetworkDetail.tsx` + `osrNetFormat.ts`

### Panel shell (`OsrNetworkPanel`)
Reads `byBoard[boardId]`; returns `null` unless `board.open`. Renders `<div className="bb-net bb-net-{dock} nowheel nodrag">` with an inline `width`/`height` fraction override (`sizeStyle`). Structure:
- Header: Network tab + dock-switch (`▤/▥`) + close.
- Toolbar (`.bb-net-tools`): Clear · Preserve checkbox · filter `<input>` · regex `.*` toggle · Invert · Full-view.
- Type pills (`NET_TYPE_PILLS`, `onPill` single/Ctrl-multi).
- Meta line (`rows/total requests`, `N dropped`), `paused` banner.
- **Request list** `.bb-net-list` → `<table className="bb-net-rows">`: `applyNetFilter` → `sortRecords` → per-row `<Row>` (`urlName`, `statusLabel`, `sizeLabel`, `initiatorLabel`, `formatDuration`, `waterfallBar`).
- **Waterfall**: per row, `waterfallBar(rec, wfWin)` → `{leftPct, widthPct, waitPct}` rendered as `.net-wf-bar`/`.net-wf-wait` absolute spans over a shared `waterfallWindow(rows)`.
- **Details pane** `.bb-net-details`: subtabs from `tabsFor(selected)`; body `.bb-net-dbody` dispatches to `<WsDetail>` (websocket) or `<HttpDetail>`.
- Summary footer (`summaryStats`).

### Detail tabs (`OsrNetworkDetail.tsx`)
`tabsFor(rec)`: websocket → `['frames','headers']`; else `['headers', (payload?), 'preview', 'response', 'initiator', 'timing', (cookies?)]`. Tab dispatch in `HttpDetail`:
- **Headers** — `.bb-net-general` (URL/method/status/remote/referrer) + two `<HeaderList>` (`<dl><dt>{name}</dt><dd>{value}</dd>`, parsed/source toggle).
- **Payload** — `<KVTable>` of `queryParams(url)` + `<BodyBar kind="request">`.
- **Response** — `<BodyBar kind="response">`.
- **Preview** — `<PreviewTab>`: raster image → `<img src="data:...base64">`; else the JSON/text `<pre>`.
- **Timing** — `<TimingTab>` (`timingPhases` → phase bars).
- **Cookies** — `requestCookies`/`responseCookies` tables.

### THE EXACT CURRENT JSON PATH
1. User clicks **Load body** → `OsrNetworkPanel.loadBody(rec, kind)` → `window.api.getOsrNetBody(boardId, requestId, kind)` → stores result in the `bodies` cache keyed `` `${requestId}:${kind}` ``.
2. The body string reaches the render via `BodyState{body, base64, truncated}`.
3. **`prettyBody(body, mime, base64)`** — `osrNetFormat.ts:577`:
   - `base64` → returns body unchanged (binary).
   - `looksJson = mime.includes('json') || /^\s*[{[]/.test(body)` → `JSON.stringify(JSON.parse(body), null, 2)` (2-space indent), else raw on parse failure.
4. Output rendered as **plain React text inside `<pre className="bb-net-bodytext">`** (`white-space: pre-wrap; word-break: break-all; font: var(--mono) 11px; color: var(--text-2)`).

**Three call sites reuse `prettyBody` into `.bb-net-bodytext`:**
- `BodyBar` (`OsrNetworkDetail.tsx:106-110`) → serves the **Response** tab and the request-payload sub-section of **Payload**.
- `PreviewTab` (`OsrNetworkDetail.tsx:249-252`) → the non-image **Preview** branch.
- (Payload's request body routes through `BodyBar kind="request"`, same `<pre>`.)

So Response, Payload (request body), and Preview all converge on the single `prettyBody → <pre className="bb-net-bodytext">` rendering. There is **no syntax highlighting, no collapsible tree, no virtualization** — just indented monospace text.

---

## 4. CONSTRAINTS / INVARIANTS (binding on any new JSON viewer / data-flow view)

1. **React text-escaping ONLY — never `dangerouslySetInnerHTML`.** Every captured string is page-controlled (header doc at `OsrNetworkDetail.tsx:1-7`, `OsrNetworkPanel.tsx:6`). A JSON tree viewer must build DOM via React elements, not innerHTML. This is the single hardest security rule.
2. **5 MB body cap** (`BODY_CAP`, MAIN). Bodies arrive already truncated with a `truncated` flag; the viewer must render `…(truncated)` and cannot assume valid/complete JSON. A pretty-printer/tree-builder must tolerate a JSON string cut mid-token (current `prettyBody` falls back to raw on parse failure — preserve that).
3. **Ephemeral schema** — `osrNetworkStore` is **never serialized** (no `schemaVersion` touch, no migration). Adding a `dataflow` view or aggregate state here needs **no schema bump** and won't break persistence. Body cache lives in React component state (`bodies`), dropped on the records→empty transition (CDP reuses requestIds across reloads).
4. **`.bb-stage` clipping / dock model** — the panel is a **flex SIBLING** inside `.bb-stage` (not an overlay), so it clips/rounds/z-orders with the board (the ADR 0002 occlusion fix). `.bb-stage` becomes `flex-direction: row` (right dock) or `column` (bottom dock) only while open (`BrowserBoard.tsx:494-509`). Any new view must live inside `.bb-net` and respect the two docks; the right dock hides wide columns (`.bb-net-right .net-col-* {display:none}`) and the panel is drag-resizable (`netPanelResizeFraction`, `[0.15, 0.85]` of stage cross-axis).
5. **No-heavy-deps doctrine** — the whole feature ships zero new npm deps; `prettyBody` uses only `JSON.parse`/`stringify`. A JSON viewer should stay vendored/hand-rolled (consistent with the vendored-perfect-freehand / vendored-Mermaid precedent). No react-json-view / monaco-style libs.
6. **File-size lint caps** (`eslint.config.mjs:262`) — default **`max-lines: 700`** (skipBlankLines + skipComments) on `src/**/*.{ts,tsx}`. Current headroom: `osrNetFormat.ts` = 588 physical lines (heavily commented, well under the non-blank/non-comment cap), `OsrNetworkDetail.tsx` = 423, `OsrNetworkPanel.tsx` = 596. **A non-trivial JSON tree component must be a NEW file** (e.g. `osr/JsonView.tsx`), not bolted onto Detail/Panel, to avoid blowing the cap. Pure formatting logic belongs in `lib/*.ts` (the "table math → unit-tested lib" doctrine stated atop `osrNetFormat.ts`).
7. **No-IPC-when-closed invariant** — capture is always-on in MAIN, but deltas cross to the renderer only while subscribed (`useOsrNetwork`). A data-flow view that needs the stream must keep the panel `open`/subscribed.
8. **Design tokens** — `tokens.css`: one accent `--accent: #4f8cff`, `--accent-wash`, status `--ok/--warn/--err`, surfaces `--surface*/--inset`, `--mono` (Geist Mono) for all data, `--fs-meta: 11px`. No new colors; JSON syntax coloring must map onto existing tokens (e.g. keys `--text-3`, strings `--text-2`, the one accent for highlights) — the calm one-accent rule forbids a rainbow palette.

---

## 5. EXTENSION POINTS for a new JSON viewer / data-flow view

### A. JSON viewer — slots into the body `<pre>` sites
The minimal-blast-radius insertion is to replace the `prettyBody(...) ` content inside the two `<pre className="bb-net-bodytext">` blocks with a new `<JsonView>` component:
- **`OsrNetworkDetail.tsx:106-110`** — `BodyBar`'s `<pre>` (Response + Payload request body).
- **`OsrNetworkDetail.tsx:248-253`** — `PreviewTab`'s non-image `<pre>`.

A new `JsonView({ text, mime, base64 })` component (own file under `canvas/boards/osr/`, to respect the line cap) would:
- Reuse the existing `looksJson` gate from `prettyBody` (extract it to `lib/osrNetFormat.ts` so both share one detector).
- For valid JSON, render a collapsible React-element tree (text-escaped); for non-JSON or truncated/base64, fall back to today's `<pre>` exactly.
- Pure tree/format helpers (path building, value formatting, the JSON parse-or-null) go in `lib/osrNetFormat.ts` (unit-tested) — the component stays presentational.

The body string already arrives as `BodyState` (`{body, base64, truncated, error}`) via the `bodies` cache, so **no new IPC or capture is needed** for a JSON viewer.

### B. Data-flow view — aggregate data ALREADY in the store (zero new capture)
A "data-flow" view can be built entirely from `osrNetworkStore.byBoard[id].records` (and `.ws`) with no new CDP plumbing. Available per `NetRecord` without any body fetch:
- **Endpoint graph / grouping**: `url` (+ `urlName`, `hostOf`, `schemeOf`, `queryParams` in `osrNetFormat.ts`), `method`, `type`, `domain` matching (`matchDomain`).
- **Causality / origin edges**: `initiator` (script url or type word — the request that triggered this one → directed edges), `loaderId` (document grouping), `frameId`, `sessionId`/`crossOrigin` (worker sub-target provenance), `navBoundary`/`preserved` (navigation epochs).
- **Timing / sequencing**: `startTs`, `endTs`, `finishMono`, `timing` (full ResourceTiming), `waterfallWindow`/`waterfallBar`, `ttfbMs`, `timingPhases` — a temporal flow axis is already computed.
- **Volume / status**: `encodedDataLength` (transfer), `decodedLength` (resource), `status`/`failed`/`statusLabel`/`isErrorRow`, `cacheSource`, `summaryStats` (aggregate transferred/resources/finish over a row set).
- **WebSocket flow**: `WsRecord.frames[]` with `dir`/`opcode`/`length`/`ts` — a sent/recv message timeline per socket.

The cleanest mount is to **extend `NetTab`** (currently the single-member union `'network'` in `osrNetworkStore.ts:15`) to `'network' | 'dataflow'`, add a `<TabBtn>` in `OsrNetworkPanel`'s header (`OsrNetworkPanel.tsx:175`), and render a new `<DataFlowView records={board.records} ws={board.ws} />` gated on `tab === 'dataflow'` (parallel to the existing `tab === 'network'` block at `OsrNetworkPanel.tsx:204`). The store comment at line 12-15 explicitly notes the one-member union was "kept… so the store shape + the header tab affordance stay intact" — i.e. the tab scaffold is pre-built for exactly this kind of second view. This needs **no schema bump** (ephemeral store) and **no new IPC/capture** (consumes the existing mirror).

### Key file:symbol anchors
- JSON formatter to reuse/extract: `osrNetFormat.ts:prettyBody` (line 577).
- Body `<pre>` render sites: `OsrNetworkDetail.tsx:BodyBar` (106), `OsrNetworkDetail.tsx:PreviewTab` (248).
- Tab scaffold to extend: `osrNetworkStore.ts:NetTab` (15) + `OsrNetworkPanel.tsx:TabBtn` (175) + the `tab === 'network'` gate (204).
- Aggregate data source: `osrNetworkStore.ts:BoardNet.records/ws` (17-29).
- CSS to mirror: `.bb-net-bodytext`/`.bb-net-dbody` (`browser-devtools.css:807`, 675); tokens in `tokens.css`.