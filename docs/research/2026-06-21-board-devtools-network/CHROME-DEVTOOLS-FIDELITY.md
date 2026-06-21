# Chrome DevTools Network — behavior reference & fidelity audit

This document is the single authoritative reference for the Canvas ADE "board DevTools — Network" feature. Our goal is to match Chrome DevTools' Network panel behavior closely enough that an engineer who knows Chrome feels at home in our per-board inspector. Part 1 turns the canonical Chrome behavior into an implementable contract (the "how DevTools works" plan). Part 2 is a severity-sorted fidelity audit of the current OSR Network implementation against that contract. Part 3 names the exact root cause of the user-reported 172→1 request collapse. Part 4 is a prioritized, sliceable fix plan.

---

## Part 1 — How the Chrome DevTools Network panel works

### 1.1 Log lifecycle, clearing & Preserve log

The log is a per-target singleton; recording is tied to DevTools being open, not to the panel being visible.

- **Recording window:** DevTools records requests only while it is open (and the Network panel has been shown at least once to activate the listener). There is **no retroactive history** — opening DevTools mid-session starts with an empty table. The count "X requests" counts only since DevTools opened.
- **Panel switching is lossless:** the `NetworkLog` is a singleton on the target, not the panel. Switching to another DevTools panel and back loses nothing (absent a navigation); the panel rebuilds its view from the singleton.
- **No ring buffer / no hard cap:** requests are stored in plain arrays/sets with no `MAX_REQUESTS`, no eviction, no ring buffer. Growth is unbounded in practice; 172 entries is trivially within bounds.
- **Hard (cross-document) navigation, Preserve log OFF → clears.** Fires `PrimaryPageChanged(type=NAVIGATION)` → `onPrimaryPageChanged()` snapshots old requests, resets all internal structures, dispatches `Events.Reset {clearIfPreserved:true}`. Table goes empty, then the new document request (+ a handful of bootstrap requests) appears.
- **SPA soft navigation does NOT clear.** `history.pushState` / `replaceState` / hash-only changes do **not** fire `PrimaryPageChanged`; the log is untouched and all prior rows survive (the critical YouTube video→video case).
- **Reload (F5 / Ctrl+R), Preserve log OFF → clears.** Fires `WillReloadPage` → `willReloadPage()` → `reset(true)`. The table is empty **before** the first reload request arrives.
- **Clear (trash) button clears unconditionally.** Action `network.clear` → `reset(true)` (`clearIfPreserved=true`) — the only way to clear while Preserve log is ON.
- **Preserve log ON → log survives navigation, with a boundary marker.** `onPrimaryPageChanged()` dispatches `Events.Reset {clearIfPreserved:false}`; old requests are re-added to the new log with `request.preserved=true`. The new main-document request is rendered with CSS class **`network-navigation-row`** (color `--network-grid-navigation-color`, a light blue, `ref-palette-blue90`) as the visible boundary where the new navigation began. There is no separate "Navigated to…" text row — the navigation document request itself is the marker.
- **Preserved (cross-navigation) requests show `(unknown)`.** Requests carried across the navigation render `(unknown)` in **both** the Status and Time columns, with tooltip `UIStrings.unknownExplanation`: *"The request status cannot be shown here because the page that issued it unloaded while the request was in flight. You can use chrome://net-export to capture a network log and see all request details."*
- **In-flight requests at a hard nav:** requests matching the **new** frame's `loaderId` (the document fetch + redirect chain) are re-added to the new log. Old-loaderId in-flight requests are dropped when Preserve is OFF, or kept with `preserved=true` + `(unknown)` when ON.
- **`PrimaryPageChangeType.ACTIVATION` bypasses the loaderId filter** (tab foregrounded, prerender activation, BFCache restore) — all old requests are kept regardless, so an activation never wipes already-loaded content.
- **Service-worker requests** follow a secondary keep rule across navigation (kept if a same-URL request with an issue time ≤ the SW request's already exists in the rebuild set).
- **Model removal** (sub-frame/iframe target destroyed) also respects Preserve log — only resets if Preserve is off.
- **The Preserve log control:** label exactly **`Preserve log`**; tooltip/aria **`Do not clear log on page reload / navigation`**; setting key `network-log.preserve-log`, a boolean persisted across DevTools reopen.
- **Event dividers are not navigation rows:** the waterfall's `network-frame-divider` (first paint), `network-dcl-divider` (DOMContentLoaded, blue), `network-load-divider` (load, red) are per-column timestamp overlays, not boundary rows.

### 1.2 Row & column model (Name / Status / Type / Initiator / Size / Time / Waterfall)

The default table is 7 columns. Compact rows show one value per cell; "Use large request rows" reveals a second line.

- **Name** = path tail (last path segment + query string), not the full URL. `…/api/v2/users?page=1` → `users?page=1`; `/` paths → hostname; trailing slash preserved (`/v1/items/` → `items/`); query appended (`/search?q=foo` → `search?q=foo`). A 16×16 favicon/MIME icon sits to the left (grayed/absent for failed). Hover tooltip shows the **complete URL**.
- **Status** = numeric code as primary text + reason phrase as subdued secondary (`200 OK`, `304 Not Modified`, `404 Not Found`, `500 Internal Server Error`). Special states (parenthesized): `(pending)` while in-flight; `(failed)` network-level failure (specific `net::ERR_*` shown in Name area/tooltip); `(canceled)`; `(blocked:cors)` (+ sub-reason in tooltip, e.g. MissingAllowOriginHeader); `(blocked:csp)`; `(blocked:mixed-content)`; `(blocked:coep)`; `(blocked:origin)`.
- **Type** = lowercase human label (table column): `document`, `script`, `stylesheet`, `font`, `image`, `media`, `fetch`, `xhr`, `websocket`, `wasm`, `manifest`, `ping`, `preflight`, `other`. `xhr` and `fetch` are distinct. (The filter bar uses capitalized grouped labels — see §1.3.)
- **Initiator** = `Parser` (HTML parser, with `file.html:line`), script `filename.js:line` (clickable → Sources), `Redirect`, `Preload`, `Other` (navigation/address bar). Hover shows the full JS call stack (`fn @ file:line:col` per frame). Shift+hover colors initiators green and dependencies red across the table.
- **Size** = two stacked values: transferred (wire, top — compressed body + response header bytes) and decoded/resource size (bottom). Cache/SW labels replace the top value: `(disk cache)`, `(memory cache)`, `(ServiceWorker)`, `(prefetch cache)`. 204/304 show `0 B` decoded. Size **sorts by the transferred value**.
- **Time** = total elapsed (top, request start → last byte) and TTFB/latency (bottom, request sent → first byte; large-rows only).
- **Waterfall** = shared-timeline horizontal bar per request, subdivided into phase segments with canonical colors: Queueing (light gray), Stalled (gray), DNS Lookup (teal), Initial Connection (orange), SSL (deeper orange), Request Sent (green), Waiting/TTFB (dark green/teal), Content Download (blue); SW phases purple/lavender. Blue (DOMContentLoaded) and red (Load) vertical marker lines cross all cells. Hover tooltip lists per-phase ms + "Started at" + "Duration". The Waterfall header is a **dropdown** sorting by Start Time / Response Time / End Time / Total Duration / Latency.
- **Sorting:** all non-Waterfall columns sort ascending on first header click, descending on second, single active sort with an up/down triangle.
- **Redirects** = one **stacked row per hop** (301/302/303/307/308). Each hop is independent (own Name path-tail, Size, Time, Waterfall); the destination row's Initiator is `Redirect`. All hops are visible and counted.
- **Row coloring:** HTTP 4xx/5xx **and** all network failures/canceled/blocked render the **entire row** text in red.
- **Live updates:** `(pending)` rows update Size/Time/waterfall in place without reordering; Status transitions atomically to the final value. SSE/long-poll stay `(pending)` for their lifetime. WebSocket handshake = a single row, Status `101`, Type `websocket`; frames live in the detail Messages tab.

### 1.3 Filter bar & resource-type pills

- **Fixed 12-pill order:** `All · Fetch/XHR · JS · CSS · Img · Media · Font · Doc · WS · Wasm · Manifest · Other`. Exact labels (`Fetch/XHR`, `Img`, `Doc`, `WS`, `Wasm`). All is default-selected.
- **Pill → resourceType:** Fetch/XHR={fetch,xhr}; JS={script}; CSS={stylesheet}; Img={image}; Media={media}; Font={font}; Doc={document}; WS={websocket}; Wasm={wasm}; Manifest={manifest}; Other=catch-all for anything unclaimed.
- **Selection model:** clicking a non-All pill deselects All and activates only it; clicking All clears all. **Ctrl/Cmd-click** toggles additional pills into the active set (no limit). Active pills are **OR'd** with each other, then **AND'd** with the text filter. Right-click → "Show only this type of requests".
- **Text filter (no prefix):** case-insensitive substring against the **full URL only** (scheme/host/path/query). Leading `-` negates (`-main.css` hides matches). Space-separated tokens are **AND'd**; there is no OR operator.
- **Property filters (`key:value`, no spaces around the colon):** `domain` (host only; `*.example.com` wildcard), `url`, `method` (exact, case-insensitive), `scheme` (http/https/ws/wss), `status-code` (substring; excludes pending), `mime-type` (Content-Type before `;`), `resource-type` (the only way to split fetch vs xhr), `larger-than` (bytes or `k` suffix; numeric on transfer size), `has-response-header`, `set-cookie-name/value/domain`, `cookie-name/value/domain/path`, `response-header-set-cookie`, `priority`, `mixed-content` (all/displayed), `has-overrides` (yes/no/content/headers), `is` (`is:running`, `is:from-cache`, `is:service-worker-intercepted`). Negate any with leading `-`. Unknown keys fall back to a plain URL substring token. Values autocomplete from the current recording.
- **Regex toggle (`.*`):** interprets the whole text box as one JS regex against the URL; invalid regex → red error highlight; does not apply to `key:` tokens.
- **Invert checkbox:** flips the entire combined result (pills + text + property tokens) — show iff NOT matching. Session-persistent.
- **More filters dropdown:** Hide data URLs, Hide extension URLs, Blocked response cookies, Blocked requests, 3rd-party requests.
- **Status bar:** when filtered, shows `X / Y requests` (visible / total); unfiltered shows only the total. Empty result → red/pink filter-input highlight + `0 / Y`.

### 1.4 Selected-request detail tabs

- **Tab strip (HTTP):** `Headers · Payload · Preview · Response · Initiator · Timing · Cookies`. Payload is **conditional** (present only when there is a query string and/or request body). Headers is default and selected first. The last-selected tab **persists** across request selections.
- **WebSocket tab set:** `Headers · Messages · Initiator · Timing` (no Preview/Response/Cookies). WS Headers shows the upgrade headers (`Sec-WebSocket-Key/Accept/Protocol/Extensions`, `Upgrade`, `Connection`).
- **EventStream tab:** appears for `text/event-stream` (EventSource/Fetch/XHR streaming) — filterable real-time event list + Clear button.
- **Headers — General (exactly 5 fields):** Request URL, Request Method, Status Code (code + reason phrase, color-coded dot, + CORS/blocked annotation), Remote Address (`IP:port`), Referrer Policy.
- **Headers — sections:** order is General → **Response Headers → Request Headers**. Each header section has its own independent **`view source` / `view parsed`** toggle; parsed mode sorts alphabetically, source mode shows wire order. `Provisional headers are shown…` warning when sent headers are unavailable. `Early Hints Headers` section for 103 responses. Inline Response-Header edit (local overrides) — out of scope for a read-only inspector. Optional `Filter Headers` input.
- **Payload:** `Query String Parameters` (decoded table), `Form Data` (when `application/x-www-form-urlencoded`), `Request Payload` (JSON/other; raw + parsed tree) — multiple can coexist; each with view-source / view-decoded / view-URL-encoded toggles.
- **Preview:** human-friendly render — images as `<img>`, JSON as a collapsible tree, HTML as a basic rendered page; blank when no previewable body.
- **Response:** raw response body text + a **`Format`** button for minified content; truncation notice for large bodies.
- **Initiator:** `Request call stack` (JS frames) + `Request initiator chain` (tree of triggering requests).
- **Timing:** phase bars with exact labels — `Queueing`, `Stalled`, `DNS Lookup`, `Initial connection`, `SSL` (HTTPS only, overlaps connection), `Request sent`, `Waiting (TTFB)`, `Content Download`, plus `Proxy negotiation` / `ServiceWorker Preparation` / `Request to ServiceWorker` when applicable; durations on the right; total row at the bottom.
- **Cookies:** `Request Cookies` + `Response Cookies` sub-tables (Name, Value, Domain, Path, Expires/Max-Age, Size, HttpOnly, Secure, SameSite, Partition Key, Priority); blocked-cookie warning icons. Always present for HTTP; empty when none.
- **Close:** X button, click elsewhere, or **Escape** closes the pane and deselects.

### 1.5 WebSocket frames, sub-targets & the summary footer

- **WS row:** single row, Status `101` ("Switching Protocols"), Type `websocket`, persists after close (status stays 101; only `is:running` distinguishes open/closed). Time = total connection duration.
- **Messages tab columns:** direction icon | `Data` | `Length` | `Time` (`HH:MM:SS.mmm`). Direction: ↑ outgoing (green row), ↓ incoming (white row). Control/opcode frames light-yellow, error frames light-red.
- **Frame data display:** binary (0x2) → literal `Binary Message` (Length still shows bytes); control opcodes by name — `Ping Frame` (0x9), `Pong Frame` (0xA), `Connection Close Frame` (0x8), `Continuation Frame` (0x0), `Binary Frame` (0x2).
- **Limit:** last **100** messages displayed per connection (older drop from view); a text filter (substring + regex) hides non-matching rows without affecting the buffer.
- **Sub-targets:** iframes, dedicated/shared/service workers all flow into the **same flat log** (CDP Network enabled on each sub-target). Attribution via Initiator. Optional "Group by frame" toggle (OFF by default) nests rows under collapsible per-frame headers. SW-intercepted requests show `(ServiceWorker)` in Size + SW timing phases.
- **Summary footer:** `X requests | X transferred | X resources | Finish: X.XXs | DOMContentLoaded: X.XXs | Load: X.XXs`. transferred = compressed over-the-wire incl. headers; resources = decoded body bytes; cache hits contribute 0 transferred. DCL is **blue**, Load is **red** (matching the waterfall marker lines). Finish = time until the last network activity completed (independent of, and possibly later than, Load). Filter-aware (`X of Y`).
- **Disable cache** checkbox (toolbar, OFF default; `Network.setCacheDisabled`); **throttling** dropdown (No throttling / Fast 4G / Slow 4G / Slow 3G / Offline) with a ⚠ on the Network tab when active — both **out of scope** for our read-only inspector.

---

## Part 2 — Fidelity audit of the current implementation

All gaps across the four facets, sorted by severity (blocker → high → medium → low). "matches" rows are summarized in the "Already matches" list below the table.

| Severity | Facet | Gap | Chrome (expected) | Current | Evidence |
|---|---|---|---|---|---|
| **blocker** | filter | No property-filter syntax (`key:value`) at all | `domain:`, `method:`, `scheme:`, `status-code:`, `mime-type:`, `resource-type:`, `larger-than:`, `has-response-header:`, `is:`, etc., key-specific semantics | Filter is a single substring; none of the keys exist anywhere | `osrNetFormat.ts:44-51` |
| **high** | rows | No Waterfall column at all | Phase-segmented bars on a shared timeline + DCL/Load markers + header sort dropdown | Six columns only; `response.timing` never read; NetRecord has only `startTs/endTs` | `OsrNetworkPanel.tsx:207-214`; `previewOsrNetwork.ts:182-192,40-60` |
| **high** | rows | No column sorting (all columns + waterfall) | Click-to-sort asc/desc with triangle; Size sorts by wire bytes | Plain `<th>`, no handlers; rows always insertion order | `OsrNetworkPanel.tsx:206-215`; `osrNetFormat.ts:101-105` |
| **high** | rows | Status never shows `(pending)` | `(pending)` for in-flight, live | `statusLabel` returns `—` for any record with no status | `osrNetFormat.ts:38-41` |
| **high** | rows | Blocked statuses collapse to `(failed)` | `(blocked:cors/csp/mixed-content/coep/origin)` distinct, red | `blockedReason` captured but `statusLabel` ignores it | `previewOsrNetwork.ts:201-208`; `osrNetFormat.ts:38-41` |
| **high** | rows | Redirect hops collapse into one row | One stacked row per hop; destination Initiator `Redirect`; all counted | `applyRedirect` overwrites url/method on the same record; `redirectResponse` never captured | `previewOsrNetwork.ts:406-413,171-179` |
| **high** | rows | 4xx/5xx rows not red; red only on name/status cells | Entire row red for HTTP errors and failures | `.bb-net-fail` only when `rec.failed`; status≥400 unstyled; red on `.net-name/.net-status` only | `OsrNetworkPanel.tsx:297-300`; `index.css:1569-1572` |
| **high** | details | Tab strip missing Preview, Initiator, Cookies (4 of 7) | 7 standard tabs | Hard-coded `['headers','payload','response','timing']` | `OsrNetworkPanel.tsx:23,240` |
| **high** | details | Headers General missing Request Method, Remote Address, Referrer Policy | 5 fields | Only Request URL + a combined Status line; `remoteAddress`/`referrerPolicy` never captured | `OsrNetworkPanel.tsx:438-451`; `previewOsrNetwork.ts:182-192` |
| **high** | details | Payload tab does not parse Query String / Form Data / Request Payload | Parsed sections + toggles | Generic raw `<pre>` body dump; no query-string parse, no JSON tree | `OsrNetworkPanel.tsx:413-421,350-391` |
| **high** | details | No Preview tab (image/JSON-tree/HTML) | Images render, JSON tree, HTML preview | None; binary shown as base64 text | `OsrNetworkPanel.tsx:23,240,364-368` |
| **high** | details | No Initiator tab (call stack + chain) | Call stack + initiator-chain tree | Initiator captured only as one flattened string for the column | `previewOsrNetwork.ts:164-169`; `OsrNetworkPanel.tsx:240` |
| **high** | details | Timing tab shows only Duration/Transferred/From-cache | 8 phase bars + total | `response.timing` never captured | `OsrNetworkPanel.tsx:422-435`; `previewOsrNetwork.ts:182-192` |
| **high** | filter | Pill order/set differs; Manifest pill missing | Fixed 12 in order; Manifest present | 11 pills, reordered (Doc·CSS·JS…), no Manifest (swept into Other) | `osrNetFormat.ts:66-78` |
| **high** | filter | No multi-select of pills (Ctrl/Cmd-click) | OR'd multi-select, no limit | Single `NetTypeKey`; click replaces selection | `OsrNetworkPanel.tsx:50,184`; `osrNetFormat.ts:94-105` |
| **high** | filter | No negation (leading `-`) | `-token` hides matches; tokens AND'd | Whole string is one `includes()`; `-` treated literally | `osrNetFormat.ts:44-51` |
| **high** | filter | No regex toggle (`.*`) | Whole box as one JS regex; error highlight | No toggle, no regex path | `OsrNetworkPanel.tsx:153-163`; `osrNetFormat.ts:44-51` |
| **high** | filter | No Invert checkbox | Flips the combined result | No Invert control; filter always returns matches | `OsrNetworkPanel.tsx:134-174`; `osrNetFormat.ts:101-105` |
| **high** | filter | `mime-type:`/`has-response-header:`/`method:`/`scheme:`/`status-code:` absent despite captured data | Five property filters over already-captured fields | None implemented; fields exist (mimeType/resHeaders/method/url/status) | `osrNetFormat.ts:44-51`; `previewOsrNetwork.ts:151,184,186,190-191` |
| **high** | filter | Multiple space-separated tokens AND'd absent | AND over tokens | Whole string is one substring; spaces literal | `osrNetFormat.ts:44-51` |
| **high** | ws-summary | Messages tab missing Length and Time columns | direction \| Data \| Length \| Time | Only direction \| type \| Data; `ts` captured but unused | `OsrNetworkPanel.tsx:470-496`; `preload/index.ts:132-138` |
| **high** | ws-summary | Control opcodes (ping/pong/close/continuation) not named | Named control frames, light-yellow | Only opcode 0x2 special-cased; others rendered as text; control events not turned into rows | `OsrNetworkPanel.tsx:483-489`; `previewOsrNetwork.ts:466-483` |
| **high** | ws-summary | No summary footer (transferred/resources/Finish/DCL/Load) | Full footer line, DCL blue / Load red | Only a `N requests` meta line; no Page lifecycle capture | `OsrNetworkPanel.tsx:191-194`; `previewOsrNetwork.ts:404-500` |
| **high** | lifecycle | Preserve ON: no navigation-row boundary marker; old requests not re-tagged preserved | `network-navigation-row` boundary; `request.preserved=true` | Preserve skips clear (rows survive) but no boundary, no preserved flag | `previewOsrNetwork.ts:372`; `index.css:1556-1576`; `preload/index.ts:112-131` |
| **medium** | rows | Status omits reason phrase (`200 OK`) | code + reason phrase | Bare number; `statusText` captured but shown only in detail | `osrNetFormat.ts:38-41`; `OsrNetworkPanel.tsx:312` |
| **medium** | rows | Size single value; no decoded/resource line | transferred + decoded stacked | Only `encodedDataLength`; decoded never captured | `previewOsrNetwork.ts:53,195-198` |
| **medium** | rows | Size never shows cache labels | `(disk cache)`/`(memory cache)`/`(ServiceWorker)`/`(prefetch cache)` | `fromCache` bool only, shown in detail; not in Size cell | `previewOsrNetwork.ts:187-189`; `OsrNetworkPanel.tsx:318` |
| **medium** | rows | Time shows only total; no TTFB line | total + TTFB | TTFB never captured (no timing) | `OsrNetworkPanel.tsx:320`; `previewOsrNetwork.ts:136-139,195-198` |
| **medium** | rows | Name drops the query string | `users?page=1` | `urlName` returns last segment only; `u.search` ignored | `osrNetFormat.ts:24-35` |
| **medium** | rows | Initiator loses line:column; Parser/Preload not capitalized; no `Redirect` | `file.js:line`; `Parser`/`Preload`/`Other`; `Redirect` | bare url or lowercase CDP word; no line; no Redirect branch | `previewOsrNetwork.ts:164-169`; `osrNetFormat.ts:107-111` |
| **medium** | filter | WS pill label `Socket` not `WS` | `WS` | `{ key:'ws', label:'Socket' }` | `osrNetFormat.ts:75` |
| **medium** | filter | Text filter matches method/type/status, not URL-only | URL-only for plain tokens | haystack = url+method+type+status | `osrNetFormat.ts:44-51` |
| **medium** | filter | Can't represent multi-active pill highlight | All unselected, multiple highlighted | Single-select only | `OsrNetworkPanel.tsx:181-184` |
| **medium** | filter | No "More filters" (Hide data/extension URLs, Blocked, 3rd-party) | dropdown | none | `OsrNetworkPanel.tsx:134-188` |
| **medium** | filter | Status bar lacks `X / Y` when filtered | `X / Y requests` | always total | `OsrNetworkPanel.tsx:190-194` |
| **medium** | filter | `resource-type:` can't split fetch vs xhr | token splits them | no token; data exists | `osrNetFormat.ts:44-51`; `previewOsrNetwork.ts:153` |
| **medium** | filter | `domain:` wildcard/host-only absent | host substring + `*.` wildcard | literal substring against full haystack | `osrNetFormat.ts:44-51` |
| **medium** | filter | `larger-than:` numeric/kB threshold absent | numeric on transfer size | literal substring | `osrNetFormat.ts:44-51`; `previewOsrNetwork.ts:195-198` |
| **medium** | filter | `is:running/from-cache/sw-intercepted` absent | `is:` keywords | none; `fromCache`/ws-closed data exists | `osrNetFormat.ts:44-51`; `previewOsrNetwork.ts:186-189,476-483` |
| **medium** | details | Status omits reason-phrase join, color dot, CORS/blocked annotation | `200 OK` + dot + `(blocked:…)` | bare number; statusText appended separately; blockedReason unrendered | `osrNetFormat.ts:38-41`; `OsrNetworkPanel.tsx:444-447` |
| **medium** | details | Header sections lack view source/parsed + alpha sort | per-section toggle, alpha default | capture-order, no toggle | `OsrNetworkPanel.tsx:325-348` |
| **medium** | details | Payload tab always shown (not conditional) | present only when query/body | always in the tab array | `OsrNetworkPanel.tsx:240` |
| **medium** | details | Response tab lacks Format/pretty-print | `Format` button | raw `<pre>` only | `OsrNetworkPanel.tsx:362-389` |
| **medium** | details | No Cookies tab | Request/Response cookie tables | none; cookies only in raw headers | `OsrNetworkPanel.tsx:240` |
| **medium** | details | No EventStream tab for SSE | filterable event list + Clear | no SSE handling | `previewOsrNetwork.ts:404-501`; `OsrNetworkPanel.tsx:240` |
| **medium** | details | Detail pane: no Escape close; last tab not persisted (force-reset to headers) | persist tab; X / canvas / Escape close | `onSelect` resets `detailTab` each click; no Escape; no deselect action | `OsrNetworkPanel.tsx:85-88,235` |
| **medium** | ws-summary | WS row missing `101`/`Switching Protocols` statusText; Type label `ws` not `websocket` | `101` + `websocket` | status only if handshake fires; `statusText` never set; `ws` pill | `previewOsrNetwork.ts:439-465`; `OsrNetworkPanel.tsx:313` |
| **medium** | ws-summary | WS frame raw byte length not captured | byte length | only string `.length` proxy, lost on truncation | `previewOsrNetwork.ts:61-67,211-225`; `OsrNetworkPanel.tsx:486` |
| **medium** | ws-summary | No frame row color coding (green/white/yellow/red) | row-background scheme | only arrow glyph tinted | `OsrNetworkPanel.tsx:479-489`; `index.css:1809-1814` |
| **medium** | ws-summary | Messages doesn't enforce 100-message display limit | last 100 | renders up to 500-ring | `previewOsrNetwork.ts:26,263-267`; `OsrNetworkPanel.tsx:478` |
| **medium** | ws-summary | No Messages filter bar | substring + regex | none | `OsrNetworkPanel.tsx:455-497` |
| **medium** | ws-summary | No EventStream tab for `eventsource` rows | EventStream tab | routed to HttpDetail; no SSE capture | `previewOsrNetwork.ts:404-500`; `OsrNetworkPanel.tsx:71-73,238-256` |
| **medium** | ws-summary | Footer count is unfiltered total; no `X of Y` | filter-aware | `total=records.length`, ignores filter | `OsrNetworkPanel.tsx:66,75,191-194` |
| **medium** | ws-summary | WS detail tabs missing Initiator/Timing; order/label differ; WS Headers omit `Sec-WebSocket-*` | Headers·Messages·Initiator·Timing + upgrade headers | `['frames','headers']`, Frames-first, no upgrade headers | `OsrNetworkPanel.tsx:238-240,455-468`; `previewOsrNetwork.ts:439-465` |
| **medium** | ws-summary | WS Size shows non-Chrome `live` badge; Time never finalizes (endTs unset) | Size `—`; Time = duration | `live` badge; `closedTs` set on `WsRecord` not `NetRecord.endTs` | `OsrNetworkPanel.tsx:318,320`; `previewOsrNetwork.ts:476-483` |
| **medium** | rows | In-flight pre-nav requests dropped wholesale (no loaderId preservation) | loaderId carry-over + SW keep + preserved | `clearNet` wipes everything; no loaderId on NetRecord | `previewOsrNetwork.ts:270-278,405-411` |
| **medium** | lifecycle | Preserved cross-nav requests don't show `(unknown)` + tooltip | `(unknown)` in Status & Time | no `preserved` concept; pending → `—` | `osrNetFormat.ts:17-21,38-41`; `preload NetRecord 112-131` |
| **low** | rows | Type column keeps CDP capitalization (`Document`/`XHR`) | lowercase (`document`/`xhr`) | raw `capText(params.type)` rendered verbatim | `previewOsrNetwork.ts:152`; `OsrNetworkPanel.tsx:313` |
| **low** | rows | Name favicon/MIME icon missing | 16×16 type icon | none (only `⊕` cross-origin badge) | `OsrNetworkPanel.tsx:304-311` |
| **low** | rows | No "Use large request rows" setting | toggle reveals secondary lines | none; 26px fixed | `index.css:1526-1535`; `OsrNetworkPanel.tsx:135-174` |
| **low** | rows | No ACTIVATION exception (prerender/BFCache would wrongly clear) | activation preserves log | binary `isSameDocument` only | `previewOsrNetwork.ts:389-391` |
| **low** | rows | Bounded ring (MAX 1000, drop-oldest) vs unbounded | unbounded | hard cap + `N dropped` (intentional; not 172→1 cause) | `previewOsrNetwork.ts:25,228-239` |
| **low** | rows | Name trailing-slash not preserved | `items/` | `filter(Boolean)` strips it | `osrNetFormat.ts:27-29` |
| **low** | rows | Initiator call-chain hover tooltip missing | full stack tooltip | `title` = single capped string | `OsrNetworkPanel.tsx:314`; `previewOsrNetwork.ts:164-169` |
| **low** | rows | Shift+hover initiator/dependency highlight missing | green/red overlay | no graph, no shift tracking | `OsrNetworkPanel.tsx:296-322` |
| **low** | rows | WS row Time stays `—` after close; `live` badge in Size | total duration | `endTs` never mirrored from `closedTs` | `OsrNetworkPanel.tsx:318,320`; `previewOsrNetwork.ts:476-483` |
| **low** | rows | 204/304 no-body Size not special-cased | `0 B` / `(disk cache)` | falls out of decoded-size + cache fixes | `previewOsrNetwork.ts:195-198` |
| **low** | rows | Waterfall hover tooltip / phase breakdown missing | per-phase ms | no waterfall | `OsrNetworkPanel.tsx:422-435` |
| **low** | rows | Right-click context menu (filter/copy/sources) missing | quick-filter menu | no `onContextMenu` | `OsrNetworkPanel.tsx:296-322` |
| **low** | rows | Preflight OPTIONS initiator-sharing not handled | shares triggering initiator | own CDP initiator | `previewOsrNetwork.ts:164-169` |
| **low** | rows | DCL/Load marker lines missing | blue/red verticals | no Page lifecycle capture | `previewOsrNetwork.ts:404-500` |
| **low** | filter | No right-click pill context menu | "Show only this type" | plain `<button>` | `OsrNetworkPanel.tsx:178-187` |
| **low** | filter | No filter-input error/empty-result red state | red highlight on 0 results / bad regex | "No matches" row only | `OsrNetworkPanel.tsx:153-163,217-221` |
| **low** | filter | No autocomplete for property values | dynamic suggestions | bare `<input>` | `OsrNetworkPanel.tsx:154-162` |
| **low** | filter | Cookie/priority/mixed-content/has-overrides filters absent (data partly uncaptured) | full key set | cookies parseable from headers; priority/mixed-content/overrides not captured | `previewOsrNetwork.ts:190-191,182-192` |
| **low** | details | No "Provisional headers are shown…" warning | exact string | section omitted when empty | `OsrNetworkPanel.tsx:332` |
| **low** | details | No Early Hints Headers section | 103 section | `responseReceivedEarlyHints` unhandled | `previewOsrNetwork.ts:404-501` |
| **low** | details | No inline response-header edit | local-override Edit button | static text (out of scope — read-only) | `OsrNetworkPanel.tsx:339-344` |
| **low** | details | Response body is manual lazy-load (intentional) | auto-shown | "Load body" button (approved exfil mitigation) | `OsrNetworkPanel.tsx:379-385` |
| **low** | details | No "Filter Headers" input in Headers tab | live header filter | none | `OsrNetworkPanel.tsx:325-348` |
| **low** | details | Bodyless responses show Load-body affordance, not blank | blank panel for 204/HEAD | always shows BodyBar | `OsrNetworkPanel.tsx:372-388` |
| **low** | ws-summary | Binary frame shows `‹binary NB›` not `Binary Message` | exact `Binary Message` | length embedded in Data | `OsrNetworkPanel.tsx:485-487` |
| **low** | ws-summary | Arrow colors reversed from Chrome emphasis | green-emphasis on sent | sent muted, recv accent | `OsrNetworkPanel.tsx:481`; `index.css:1809-1814` |
| **low** | ws-summary | `is:running` keyword absent | open WS/SSE only | no keyword parsing | `osrNetFormat.ts:43-51` |
| **low** | ws-summary | No "Group by frame" toggle | per-frame collapsible groups | always flat (frameId captured) | `OsrNetworkPanel.tsx:204-232`; `previewOsrNetwork.ts:156-159` |
| **low** | ws-summary | SW-intercepted not attributed (`(ServiceWorker)` / SW phases) | distinct badge + phases | folded into `fromCache` | `previewOsrNetwork.ts:187-189`; `OsrNetworkPanel.tsx:317-319` |
| **low** | ws-summary | No "Disable cache" checkbox | `Network.setCacheDisabled` | none (read-only scope) | `OsrNetworkPanel.tsx:134-174` |
| **low** | ws-summary | No throttling dropdown / ⚠ | network conditions | none (explicit non-goal) | `previewOsrNetwork.ts` (no `emulateNetworkConditions`) |
| **low** | ws-summary | WS Type cell `ws` not `websocket` | `websocket` | compact pill (intentional) | `OsrNetworkPanel.tsx:313` |
| **low** | lifecycle | Preserve label `Preserve` not `Preserve log`; no tooltip; ephemeral (not persisted) | `Preserve log` + tooltip; persisted | truncated label, no title; per-board ephemeral | `OsrNetworkPanel.tsx:144-152`; `osrNetworkStore.ts:18-19` |
| **low** | lifecycle | Always-on capture even with panel closed (intentional superset) | records only while DevTools open | always-on ring + replay on subscribe | `previewOsrNetwork.ts:15-16,586-593` |

### Already matches (correct behaviors — do not regress)

- **Lifecycle:** SPA soft nav (pushState/replaceState/hash) does **not** clear; reload (preserve OFF) clears before new requests arrive; the Clear button clears unconditionally; the buffer survives panel close and replays on re-subscribe (singleton-equivalent property). The 172→1 collapse on a real cross-document nav is **correct** Chrome behavior (see Part 3).
- **Rows:** Name tooltip shows the full URL; `(canceled)` status + red; `(failed)` generic case + red (error text in detail); WS one-row model; live updates without reordering; type filter pills AND with the text filter (single-pill case); type-pill→resourceType mapping (the 10 mapped pills).
- **WS / sub-targets:** WS rows persist after close; sub-targets (iframes/workers/SW) flow into one flat log with `⊕` attribution; worker requests attributed by initiator; **Messages live-refresh while another row is selected** (a strict improvement over Chrome, which requires a re-click).
- **Details:** Response-Headers-before-Request-Headers section order; response-body truncation surfaced; lazy body load is the approved security mitigation.

---

## Part 3 — Root cause of the 172→1 request collapse

**Verdict: the 172→1 collapse the user observed is correct Chrome behavior. The real defect was a *frozen* log stuck at 172, and that defect is already fixed.**

The headline repro was `localhost:5173 → youtube.com` — a cross-host, cross-document, cross-process navigation, i.e. a **hard navigation**. With Preserve log OFF, Chrome wipes the log on a hard nav and shows only the new document's request(s) — exactly the "1 request" the user saw. Our implementation matches: on `did-start-navigation` for a main-frame, non-same-document nav with Preserve OFF, it re-arms Network capture then calls `clearNet(state)` and emits `{kind:'cleared'}`.

- Clear path: `src/main/previewOsrNetwork.ts:369-378`
- Main-frame-nav predicate: `src/main/previewOsrNetwork.ts:389-391` (`isMainFramePageNav = !!details?.isMainFrame && !details.isSameDocument`)

**The actual bug (now fixed)** was the *opposite* symptom — a log **frozen at 172** that never cleared and stopped capturing after the first page. The cause was a stale signature: the handler read positional args while Electron passes a single navigation-details **object** (`{isMainFrame, isSameDocument, …}`), so `isMainFrame` was always `undefined`, `isMainFramePageNav` always returned `false`, the re-arm/clear path **never fired**, and the Network domain was lost across the renderer-process swap — leaving the table stuck at the last pre-nav count (172) with capture dead. This is documented in commit `88182189` ("isMainFrame was always undefined → clear-on-nav NEVER fired") and locked behind the pure unit-tested predicate at `previewOsrNetwork.ts:389-391` (`previewOsrNetwork.test.ts:163-168`).

**What remains for true Chrome parity** is not the collapse itself but the surrounding semantics, tracked as the lifecycle gaps in Part 2 and slices in Part 4:

1. **No loaderId-selective preservation:** `clearNet` wipes the entire buffer with no loaderId awareness (`previewOsrNetwork.ts:270-278`), so the navigation's own document/redirect chain isn't carried across, and a CDP/Electron ordering race could drop the very first document request (making the log *even emptier* than Chrome's). Fix: defer the clear until the new main-document `requestWillBeSent` arrives, capture its `loaderId`, and clear only records whose `loaderId != new loaderId`.
2. **No ACTIVATION exception:** a BFCache/prerender activation (surfaced as `isSameDocument:false`) would wrongly clear. The deferred-clear above also fixes this (an activation re-emits no fresh document fetch).
3. **Preserve-ON has no boundary marker / no `(unknown)` re-tagging** (`previewOsrNetwork.ts:372`).

No fix is needed for the collapse magnitude. The recommended hardening is a thin unit/e2e harness around the `wireOsrNetwork` side effect (only the pure predicate is tested today), so a future regression to the clear/re-arm path is caught.

---

## Part 4 — Prioritized fix plan

Each item is one mergeable, independently pushable slice. P0 = the foundational refactor the filter facet blocks on; P1 = high-value parity with low capture cost; P2 = capture-heavy subsystems; P3 = polish/deferred. Most renderer-only slices pay the `@preview`-scoped Windows e2e leg; capture changes in `src/main` trigger the full matrix at the pre-merge gate.

### P0 — Filter token engine (blocker; unblocks the whole filter facet)

- **P0.1 — Tokenizer + AND/negation/URL-only base.** Replace `filterRecords` with a whitespace tokenizer: each token strips a leading `-` (negation); plain tokens match `rec.url` only (not method/type/status); a row passes iff every positive token matches AND no negated token matches. Files: `src/renderer/src/lib/osrNetFormat.ts`. Test (unit): `-main.css` hides matches; `-foo bar` = NOT foo AND bar; plain `get` no longer matches GET-by-method.
- **P0.2 — Property-filter parser (captured-field keys).** On top of P0.1, dispatch `key:value` tokens: `url`, `method` (exact, ci), `scheme` (from `new URL().protocol`, incl. ws/wss), `status-code` (substring on `String(status)`, exclude pending), `mime-type` (`mimeType.split(';')[0]`), `resource-type` (substring on `rec.type` → splits fetch/xhr), `domain` (hostname, `*.` wildcard), `larger-than` (numeric + `k`/`m`), `has-response-header` (presence in `resHeaders`), `is:from-cache`/`is:running`. Unknown keys → plain URL token. Files: `osrNetFormat.ts`. Test (unit): each key over a seeded record set; `mime-type:image/gif larger-than:1k` AND composition; `resource-type:fetch` excludes xhr.
- **P0.3 — Regex toggle + Invert + filter-aware count.** Add `.*` toggle (compile whole non-property box as `RegExp(input,'i')`, error class on `SyntaxError`), an Invert checkbox (negates the final per-row boolean), and `X / Y requests` in the meta when filtered. Files: `OsrNetworkPanel.tsx`, `osrNetFormat.ts`, `index.css`. Test (e2e `@preview`): toggle regex, type `\.js$`, assert only scripts; check Invert hides the matched set; bad regex shows error class.

### P1 — High-value parity, low/zero capture cost (mostly renderer-only)

- **P1.1 — `(pending)` + reason phrase + blocked-status mapping + 4xx/5xx red.** In `statusLabel`: return `(pending)` for in-flight; append `statusText` (`200 OK`) as a secondary span; map `failed.blockedReason` → `(blocked:csp/coep/…)`. Add a `status>=400` class and broaden red to the whole row. Files: `osrNetFormat.ts`, `OsrNetworkPanel.tsx`, `index.css`. Test (unit): pending → `(pending)`, blocked → mapped string; (e2e): a 404 row renders red across all cells.
- **P1.2 — Name path-tail: query string + trailing slash.** `urlName` appends `u.search` and preserves a trailing slash. Files: `osrNetFormat.ts`. Test (unit): `/api/v2/users?page=1` → `users?page=1`; `/v1/items/` → `items/`.
- **P1.3 — Pill set parity: order, Manifest, `WS` label, multi-select.** Reorder to the fixed 12; add `manifest` key + `TYPE_MATCH`; rename `Socket`→`WS`; change panel state to `Set<NetTypeKey>`, plain-click sets one, Ctrl/Cmd-click toggles, OR across the active set AND'd with text. Files: `osrNetFormat.ts`, `OsrNetworkPanel.tsx`. Test (unit): manifest matches; multi-set OR; (e2e): Ctrl-click two pills shows both types.
- **P1.4 — Detail-pane UX: persist last tab + Escape/close.** Stop resetting `detailTab` on select (only fall back when the tab is unavailable for the new request type); add an X on the pane and an Escape keydown calling `select(boardId, undefined)`. Files: `OsrNetworkPanel.tsx`. Test (e2e): select request A on Timing, select B → still Timing; Escape clears selection.
- **P1.5 — Headers General 5 fields + view source/parsed + Status detail.** Render Request Method (`rec.method`), and capture + show Remote Address (`res.remoteIPAddress:remotePort`) and Referrer Policy (from `requestWillBeSent`). Add per-section `view source`/`view parsed` toggle with alpha sort default. Join `status + statusText` with a color dot. Files: `previewOsrNetwork.ts`, `preload/index.ts`, `OsrNetworkPanel.tsx`. Test (unit): record carries remoteAddress/referrerPolicy; (e2e): General shows all 5.
- **P1.6 — WS row + frame columns + control opcodes + finalize.** Set `statusText`='Switching Protocols' on handshake; add `length` to `WsFrame` (pre-truncation bytes); render Length + Time columns; opcode→name map + light-yellow rows; `Binary Message` literal; on `webSocketClosed` set the `NetRecord.endTs`; replace the `live` Size badge with `—`; capture upgrade headers. Files: `previewOsrNetwork.ts`, `preload/index.ts`, `OsrNetworkPanel.tsx`, `index.css`. Test (unit): closed WS record has endTs; (e2e): WS row shows 101 + duration; frames show Length/Time.

### P2 — Capture-heavy subsystems (`src/main`; full matrix at merge)

- **P2.1 — Timing capture → Timing tab.** In `applyResponse` capture `response.timing` (`requestTime`, dns/connect/ssl/send start-end, `receiveHeadersEnd`) into a `timing` field; render the 8 phase bars with exact labels + total; populate Time-cell TTFB. Files: `previewOsrNetwork.ts`, `preload/index.ts`, `OsrNetworkPanel.tsx`. Test (unit): timing parsed into phase ms; (e2e): Timing tab shows DNS/Connect/Waiting (TTFB)/Content Download.
- **P2.2 — Waterfall column.** Build on P2.1: a Waterfall `<th>/<td>` rendering phase-segmented bars on a shared timeline (min startTs across visible rows), the header sort dropdown (Start/Response/End/Total/Latency), and DCL/Load marker lines (capture `Page.domContentEventFired`/`loadEventFired`). Files: `previewOsrNetwork.ts`, `OsrNetworkPanel.tsx`, `index.css`. Test (e2e): bars render; DCL/Load lines present.
- **P2.3 — Column sorting (non-waterfall).** Sort state `{col,dir}`, header buttons + triangle, comparator after filtering; Size key = `encodedDataLength`, Time = `endTs-startTs`. Keep store insertion order (sort a displayed copy). Files: `OsrNetworkPanel.tsx`, `osrNetFormat.ts`. Test (unit): comparator asc/desc per column; (e2e): click Size header reorders.
- **P2.4 — Size: decoded size + cache/SW labels.** Accumulate `Network.dataReceived.dataLength` for decoded size; split `fromServiceWorker` out of `fromCache`; subscribe `Network.requestServedFromCache` for memory-cache; render `(disk cache)`/`(memory cache)`/`(ServiceWorker)`/`(prefetch cache)`. Files: `previewOsrNetwork.ts`, `preload/index.ts`, `OsrNetworkPanel.tsx`. Test (unit): cacheSource enum → label; decoded > transferred under compression.
- **P2.5 — Redirect hops as stacked rows.** On `requestWillBeSent` with `redirectResponse`: finalize the existing record as a completed hop (status/headers/size/endTs from `redirectResponse`) and push a new record for the new URL with `initiator='Redirect'`; add `loaderId` to NetRecord. Files: `previewOsrNetwork.ts`. Test (unit): a 3-hop chain → 3 records, intermediate 3xx preserved, destination initiator `Redirect`.
- **P2.6 — loaderId-selective clear + Preserve-ON boundary/`(unknown)`.** Defer the nav clear until the new main-document `requestWillBeSent`; clear only `loaderId != new`; on Preserve ON stamp survivors `preserved=true` and mark the next document record `navBoundary=true` (render `.bb-net-navigation-row`, light-blue); `(unknown)` Status/Time + tooltip for preserved pending. Also resolves the ACTIVATION exception. Files: `previewOsrNetwork.ts`, `preload/index.ts`, `osrNetFormat.ts`, `OsrNetworkPanel.tsx`, `index.css`. Test (e2e): hard nav with Preserve ON keeps rows + shows boundary; with OFF clears.
- **P2.7 — Summary footer.** Footer line: transferred (Σ encodedDataLength), resources (Σ decoded), Finish (last activity), DOMContentLoaded (blue), Load (red) from Page lifecycle events; filter-aware `X of Y`. Files: `previewOsrNetwork.ts`, `OsrNetworkPanel.tsx`, `index.css`. Test (e2e): footer shows all fields; DCL blue / Load red.
- **P2.8 — Payload / Preview / Initiator / Cookies tabs.** Conditional Payload (Query String Parameters table from `searchParams` + Form Data vs Request Payload by Content-Type + JSON tree); Preview (image `<img>` / JSON tree / HTML) reusing the lazy body fetch; Initiator (capture `initiator.stack` frames + chain); Cookies (parse Cookie/Set-Cookie tables). Files: `previewOsrNetwork.ts`, `preload/index.ts`, `OsrNetworkPanel.tsx`. Test (e2e): each tab appears + renders for a seeded request; Payload absent for bodyless GET.

### P3 — Polish / deferred (nice-to-have; many are explicit non-goals)

- **P3.1** — Type cell lowercase (`document`/`xhr`); Initiator `file:line` + capitalized `Parser`/`Preload`/`Other`; Name favicon/MIME icon. (renderer + tiny capture)
- **P3.2** — "Use large request rows" toggle (reveals decoded Size / TTFB / reason-phrase secondary lines). (renderer)
- **P3.3** — "More filters" dropdown (Hide data URLs, Hide extension URLs, Blocked requests, 3rd-party) using already-captured fields. (renderer + main-origin compare)
- **P3.4** — Filter-input error/empty-result red state; property-value autocomplete; pill right-click "Show only this type". (renderer)
- **P3.5** — EventStream tab + SSE capture (`Network.eventSourceMessageReceived` / `streamResourceContent`); `is:running`; "Group by frame"; Messages filter bar; 100-message display slice. (deferred to v2 per spec)
- **P3.6** — Provisional-headers warning; Early Hints section; Response Format button; Filter-Headers input; Response `Format` pretty-print. (renderer + small capture)
- **Out of scope (document as non-goals):** Disable cache, network throttling, inline response-header local overrides, `has-overrides` filter — incompatible with the read-only inspector contract.