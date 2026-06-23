I'll write the report body directly. The six investigation outputs give me everything I need; my job is synthesis into a decision-grade document.

## 1. Executive summary

Canvas ADE's Browser-board Network inspector captures rich per-request traffic but renders every JSON response through a single expression — `JSON.stringify(JSON.parse(body), null, 2)` (`prettyBody`, `osrNetFormat.ts:577`) — dropped verbatim into one flat, monochrome `<pre className="bb-net-bodytext">` with `word-break: break-all`, no syntax color, no folding, no virtualization, and no search; it re-parses on every render and is viewed through a 40%/120px-min slit. The result is unreadable for any non-trivial payload and, worse, the inspector is *per-body-in-isolation* — it never aggregates the API surface a developer is actually exercising. This report proposes a two-part answer: **(A) "the fix"** — replace the `<pre>` with a small, vendored, in-repo React tree viewer (flat-row model + custom virtualizer + accent-on-keys coloring + in-body search/path-copy) that honors every security invariant; and **(B) "the vision"** — a **Data Flow** view that aggregates the traffic already in the store into a navigable map of the app's endpoints, inferred schemas, and id-lineage, rendered on the existing React Flow canvas.

## 2. Current state — the capture→render pipeline

The inspector is a single linear pipeline, all of it grounded in existing files:

**Capture (MAIN-only, CDP).** `src/main/previewOsrNetwork.ts` attaches one `wc.debugger.on('message')` listener to the already-attached per-board debugger and arms `Network.enable` + flat `Target.setAutoAttach`. `handleNetMessage` switches on CDP method (`requestWillBeSent`, `responseReceived`, `dataReceived`, `loadingFinished/Failed`, the `webSocket*` family, `Target.attached/detached`) and mutates a bounded ring buffer (`MAX_RECORDS=1000`/board, `MAX_WS_FRAMES=500`/socket, `MAX_SOCKETS=32`). Every page-controlled string is capped *before* it enters the ring (`URL_CAP=2048`, `HEADER_VALUE_CAP=4096`, `WS_PAYLOAD_CAP=16KB`, …). Mutations coalesce through a `FLUSH_MS=100` timer, **only while subscribed**.

**Bodies are never buffered.** The single body egress is the lazy, user-initiated `preview:osrNetGetBody` IPC → `Network.getResponseBody`/`getRequestPostData` on the record's own `sessionId`, then `capBody` (`BODY_CAP = 5 MB`, sets `truncated:true`). Binary flows through base64 untouched.

**Transport.** Six `isForeignSender`-guarded channels in `registerOsrNetworkIpc`; M→R deltas on `preview:osrNet`. Preload (`src/preload/index.ts`) mirrors the types verbatim and fans out one shared `ipcRenderer.on` by board `id` to per-board handlers. `useOsrNetwork(boardId)` subscribes only while the panel is `open` (replay-then-deltas), unsubscribes + `clearBoard` on close/unmount.

**Store.** `src/renderer/src/store/osrNetworkStore.ts` — Zustand, **ephemeral, never serialized** (no `schemaVersion`, no migration). `byBoard[id]: BoardNet = {records[], ws[], dropped, open, dock, tab, preserve, selected?, size?}`. `apply` handles `replay` (replace), `cleared` (empty), `delta` (upsert-by-`requestId` + tail-cap to mirror MAIN's ring). Note `NetTab` is a deliberate single-member union `'network'` "kept so the store shape + the header tab affordance stay intact" — pre-built scaffolding for a second view.

**Render.** `OsrNetworkPanel.tsx` is a flex *sibling* inside `.bb-stage` (not an overlay) so it clips/rounds/z-orders with the board (the ADR 0002 occlusion fix); two docks (`bottom`/`right`), drag-resizable `[0.15, 0.85]`, with the right dock hiding wide columns as a real responsive state. The request list → details pane dispatches subtabs via `tabsFor(selected)` in `OsrNetworkDetail.tsx`.

**The exact JSON path.** User clicks **Load body** → `loadBody` → `getOsrNetBody` → cached in `bodies` keyed `` `${requestId}:${kind}` ``. The body string hits `prettyBody(body, mime, base64)` (`osrNetFormat.ts:577`): base64 → unchanged; `looksJson = mime.includes('json') || /^\s*[{[]/.test(body)` → `JSON.stringify(JSON.parse(body), null, 2)`, else raw on parse failure. The output is rendered as plain React text inside `<pre className="bb-net-bodytext">` at **two converging call sites**: `BodyBar` (Response + request-payload, `OsrNetworkDetail.tsx:108`), and `PreviewTab`'s non-image branch (`:250`). No highlighting, no tree, no virtualization. *(Corrected from the draft's "three" per the feasibility review — see §8.1/C1.)*

## 3. Why the formatted-`<pre>` is an eyesore

Ranked by impact (full audit IDs preserved for traceability):

**HIGH — the core eyesore:**
- **H1 — Zero syntax differentiation.** Keys, strings, numbers, booleans, `null`, punctuation, brackets all render in `--text-2` at mono 11px. The reader must parse the JSON in their head to tell a key from a value — the single largest legibility loss vs. any real viewer.
- **H2 — No collapse/expand/fold.** A static string; a 400-line response forces a full scroll to skip one nested array. (The Headers tab uses real `<details>` disclosure; the body has none.)
- **H3 — `word-break: break-all` mangles every long token.** It breaks *inside* URLs, JWTs, UUIDs, hashes at arbitrary chars, and re-flowing wrapped values back to the left margin destroys the indent ladder — the *only* structural cue present.
- **H4 — Tiny pane.** `.bb-net-details` is 40% height / min 120px; a multi-KB body is viewed through a ~120–200px keyhole with no maximize/pop-out.
- **H5 — No virtualization.** The whole formatted body (up to 5 MB) is one `<pre>` text node, laid out with the most expensive wrapping mode (`pre-wrap` + `break-all`). A real jank/freeze risk under existing OSR frame pressure.
- **H6 — Re-parse on every render.** `prettyBody` runs `JSON.parse`+`JSON.stringify` *inside render*, uncached, on every tab switch/selection/resize; the body is also held twice (raw + pretty), doubling a 5 MB footprint.
- **H7 — No in-body search.** The powerful row filter never reaches inside a body; finding a field is pure scroll-and-eyeball.

**MEDIUM — absent expected affordances:** M1 no copy-value/copy-path/copy-as; M2 no path breadcrumb; M3 no line numbers/indent guides; M4 no type badges or array/object counts; M5 no nested-JSON-in-string detection; M6 NDJSON/SSE/GraphQL/form/XML all fall back to raw; M7 binary/base64 is a dead-end label; M8 the lossy `/^\s*[{[]/` heuristic gives no pretty⇄raw toggle and no "couldn't format" notice; **M9 — truncated 5 MB bodies fail `JSON.parse` → silently lose ALL formatting** (the bodies that most need structure are guaranteed to lose it).

**LOW — polish:** L1 no URL/timestamp/color affordances; L2 no response diff; L3 no key-filter; L4 no body-level raw/parsed/wrap toggle (Headers has one); L5 body numbers don't use `tabular-nums`.

**The big-picture gap (G1)** frames the whole report: every body is an island. The row table aggregates *metadata* (status/size/timing) but the *payload semantics* — the data the user actually cares about — are never aggregated, compared, or related. That is what Part B targets.

## 4. Design Part A — The JSON viewer ("the fix")

### The component

A new, vendored, dependency-light component `JsonView` lives under `src/renderer/src/canvas/boards/osr/JsonView.tsx`, with all pure logic in `src/renderer/src/lib/osrJson.ts` (unit-tested, no React — the "table-math → lib" doctrine atop `osrNetFormat.ts`). It is a **new file** by necessity: the `max-lines: 700` lint cap leaves no room to bolt a non-trivial tree onto `OsrNetworkDetail.tsx` (423) or `OsrNetworkPanel.tsx` (596).

**The architectural spine — flat-row model (the load-bearing insight from jless / virtual-json-viewer / Firefox):** parse the body once, pre-walk into a single linear array `rows: {id, depth, keyOrIndex, kind, value, parentId, childCount, closeId}[]`. Collapse/expand never deletes rows — it flips an id in a `collapsedSet` and `visibleRows` jumps past a collapsed span via `closeId` (O(1) fold). Everything below hangs off this model; adopt it first. This directly retires H2, H5, H6 (parse once, memoize on `[rows, collapsedSet, arrayWindows]`).

### Feature set — staged

**MUST-HAVE (P0/P1):**
- Flat-row model + memoized `visibleRows`; single-line uniform rows (ellipsize long strings → "show more", never wrap) — this kills H3 and enables the virtualizer.
- **Custom uniform-height virtualizer** (~80 lines vendored; uniform row height makes `react-window` unnecessary): measure container, `start = floor(scrollTop/rowH)`, render `start … start+count+overscan` between top/bottom spacers. Live DOM stays ~10–50 rows regardless of total. Retires H5.
- **Default-collapse by depth** (expand 1–2 levels; auto-collapse containers with `childCount > ~99`) + **size badges** (`{12}` / `[480]`) — retires H4's "huge body in a keyhole" framing and M4.
- **Array windowing** — emit first ~100 children + a synthetic "▸ 49,900 more" row that raises the window in chunks. Caps rows hard.
- **Type coloring** (see palette below) — retires H1.
- **In-body search** + highlight + next/prev (`Ctrl/Cmd+G`), auto-expanding ancestors of a match before scrolling — retires H7.
- **Copy property-path** (`data.users[3].name`) + copy-value + copy-subtree — retires M1.
- **Raw mode** — re-indent from the original source string (not a re-`stringify`, preserving big-number fidelity), with a pretty⇄raw toggle that also resolves M8.
- **Big-number safety** — flag any integer literal with >15–16 significant digits and display the **raw source substring** (`JSON.parse` silently corrupts `>2^53`); never display from a round-tripped Number.
- **Truncation-tolerance (M9 fix)** — the tree builder must tolerate JSON cut mid-token: on parse failure, fall back to the Raw view (preserving today's raw fallback) and render the `…(truncated)` marker, rather than losing all structure.
- **URL values → `shell.openExternal`** (never in-app nav; matches the security contract).
- **ARIA tree** — `role="tree"/"treeitem"`, `aria-level/expanded/setsize/posinset`, the WAI-ARIA arrow-key contract, and `aria-activedescendant` focus (roving tabindex breaks under virtualization when the focused row unmounts).

**NICE-TO-HAVE (P1+):** sticky path breadcrumb; filter-to-matching-keys (prune subtrees with zero matches — the Firefox model, best for a small viewport); nested-JSON-in-string "parse as JSON ⤵" (lazy); timestamp humanization (gated on `*_at`/`ts` key hints); key sorting (non-destructive, in the flatten step); response diff (P3-adjacent); JSONPath-lite query; worker parsing gated on size.

### Syntax-color resolution (pick ONE)

**Ship Option A — monochrome + accent-on-keys — as the default.** Of the three candidates the design-system pass weighed:
- **A (accent-on-keys):** keys → `--accent` mono; values (all types) → `--text` bright mono; punctuation `{}[],:` → `--text-3`; null → `--text-3` italic; structural guides (indent rails, carets, line numbers) → `--text-faint`/`--border-subtle`.
- **B (low-chroma derived tints per value type):** best raw readability, but it's the only option that **repurposes status hues** (`--ok`/`--warn`/`--err`) decoratively — risking semantic collision with a real `--ok` status dot or `--warn` paused badge. Rejected as default.
- **C (weight/italic only, no value hues):** strictest, but too-subtle type discrimination for a data-flow viewer whose whole point is reading values fast.

**Justification:** A is the only option with **zero tension** against the locked one-accent rule — it spends the single accent on *structure* (keys, the highest-value JSON discriminator) and leaves all status semantics untouched. It mirrors the closest in-app precedent: `.bb-net-kv` already marks the "name" with accent and keeps a dim-key/bright-value hierarchy. If user testing shows the monochrome tree is hard to scan, expose **B as an opt-in "syntax tint" toggle only**, with mixes pulled ≥45% toward `--text-2` and tinted values kept out of any region that also shows status dots/badges. Full-saturation `--ok/--warn/--err` is never used for value types.

### Large-payload / perf strategy

- **Thresholds:** <~1,000 visible rows → naive render is fine; ~1,000–5,000 → jank without windowing; ≥10,000 → mandatory. The general figure: 100k naive DOM nodes ≈ 3–8s to mount; virtual-json-viewer measured 100MB/~10k objects ≈ 4s *un*-virtualized. The rule: >100 items = virtualization candidate, >1,000 = mandatory.
- **Plan:** virtualize from the start (uniform single-line rows make it cheap); lazy-flatten collapsed subtrees on first expand; hard-cap total materialized rows (~200k) with a "result truncated" banner; `React.memo` each `Row` by `id`; keep `collapsedSet` in a ref so toggling one node doesn't re-render all.
- **Never auto-pretty-print an unbounded body** — this is the #1 correctness rule from the competitive teardown (Postman's synchronous formatter freezes for ~25s on 15MB and white-screens above ~50–100MB; the official "workaround" is *switch to Raw*). Our body arrives only on an explicit **Load body** click and is already 5 MB-capped, so the gate exists — but the viewer must still default the *tree build* behind that click and stay virtualized.

### Search / path-copy / modes UX

Reuse the existing panel vocabulary verbatim: **Raw / Tree** as `.bb-net-subtab` peers (active = `--text` + `border-bottom-color: var(--accent)`); the per-section `.bb-net-srctoggle` accent-text-button idiom for "expand all / raw"; the search box styled like the existing filter `<input>` in `--inset`; selection/match highlight via `--accent-wash` + the `.bb-net-sel` `box-shadow: inset 2px 0 0 var(--accent)` rail. The scroll body inherits `.bb-net-dbody` (`padding:10px 13px`, thin scrollbar `--border-strong`). Add a **maximize / full-view** affordance for H4 (the panel already has a full-view control). Offer **both** copy modes (DevTools "copy property path" + per-node copy-value/subtree), since the property-path is the highest-leverage affordance for an *AI* canvas — paste `data.items[3].id` straight into a Terminal-board agent prompt.

### How it preserves every security invariant

1. **Tokenize-to-React-elements, never `dangerouslySetInnerHTML`.** The flat-row model builds DOM as React elements; each token (key/string/number/punctuation) is a `<span className=…>` with the value passed as a **child text node** (React-escaped), never as `innerHTML`. Syntax color is class-based CSS, not injected markup. This is the single hardest rule and the flat-row model satisfies it natively (no HTML string ever constructed).
2. **5 MB cap honored + truncation-tolerant.** The viewer consumes the already-capped `BodyState{body, base64, truncated}` and renders `…(truncated)`; the tree builder tolerates a JSON string cut mid-token (parse-fail → Raw fallback, per M9).
3. **Lazy / user-initiated.** No new IPC, no new capture — the viewer renders the existing `bodies` cache populated only on the user's **Load body** click. Renderer never touches Node/native; data still arrives over the `isForeignSender`-guarded `getOsrNetBody`.
4. **Ephemeral.** No store schema change; view state (collapsedSet, search, mode) lives in React component state, dropped on the records→empty transition like the body cache today.
5. **No heavy deps.** Vendored ~80-line virtualizer + hand-rolled flat-row walker + (optional) JSONPath-lite — consistent with vendored perfect-freehand / Mermaid. Avoid `react-json-view` (unmaintained, recursive-render, no big-number safety) and `jq-wasm` (CSP friction). Read `react18-json-view` for its prop model only.

### Files to add / change

- **Add:** `src/renderer/src/canvas/boards/osr/JsonView.tsx` (presentational tree + virtualizer); `src/renderer/src/lib/osrJson.ts` (flat-row walk, path build, big-number flag, source re-indent — unit-tested); `src/renderer/src/lib/osrJson.test.ts`.
- **Change:** `OsrNetworkDetail.tsx` — replace the `prettyBody(...)` content in `BodyBar` (`:106`) and `PreviewTab`'s non-image branch (`:249`) with `<JsonView text mime base64 truncated />`; extract the `looksJson` gate out of `prettyBody` into `osrJson.ts` so both share one detector. `src/renderer/src/styles/boards/browser-devtools.css` — add `.bb-net-json*` classes mirroring `.bb-net-bodytext` (mono 11px, `--text-2` base) + the token color classes.

## 5. Design Part B — The "Data Flow" view ("the vision")

### What it consumes — zero new capture (where possible)

The entire endpoint inventory + call graph is buildable from `osrNetworkStore.byBoard[id].records` (and `.ws`) **with no new CDP plumbing**, because every needed field already rides each `NetRecord` *without a body fetch*: `url`/`method`/`type`/`status`, `initiator` (the triggering request → directed edges), `loaderId`/`frameId`/`navBoundary` (document/page grouping), `startTs`/`endTs`/`timing` (sequence axis), `encodedDataLength`/`decodedLength` (volume), `cacheSource`/`failed` (health), and `WsRecord.frames[]` (sent/recv timeline). The **one** thing that needs bodies is *response-shape* inference (schema/ER/id-lineage) — and that is the privacy-gated tier (below).

### The four inference engines (pure `lib/` modules, the shared substrate)

1. **Endpoint inventory — route-template collapsing.** Group by `method + normalize(pathname)`, collapsing variable segments (numeric→`{id}`, UUID→`{uuid}`, opaque→`{id}`, value-variance→`{param}`), keeping an editable per-template example set. Extend the existing `urlName()` (`osrNetFormat.ts`) to a `routeTemplate()` pure fn. **This is the single most important legibility trick** (Akita's parameter coalescing): without it an observed surface explodes into thousands of per-UUID rows.
2. **Schema inference (monoid merge, JSONoid model).** Fold each JSON sample associatively: type→union (`string|null`), required-iff-present-in-every-sample, arrays→merged `items`, format hints (date-time/uuid/email/uri), capped examples. Result per endpoint = an inferred JSON Schema renderable as a type tree, OpenAPI fragment, or TS interface. **Needs bodies → gated.**
3. **Entity + ER inference.** A repeated object shape with an identity field; PK candidate = `id`/`*Id`/`uuid` short, non-null, high-distinct-ratio; FK = `<entity>Id` whose values overlap another entity's PK (inclusion-dependency test). Output = entities + typed relationships (`User 1—* Order`).
4. **Data-flow / id-lineage (the novel pass).** An id in call A's *response* later appearing in call B's *URL/request* ⇒ directed edge `A ⊳ B` ("A's id drove B"). This is what Postman Flows makes you *wire by hand* — here it's *discovered*. **Needs bodies → gated.**

### Recommended surface (pick + justify)

**Stage the surface to match value/effort — but the recommended flagship surface is a dedicated React Flow board, reached via a panel-tab stepping stone:**

- **First mount = a panel tab** (extend `NetTab` to `'network' | 'dataflow'`, add a `.bb-net-tab` in the header, render `<DataFlowView records ws />` gated on `tab==='dataflow'`). The store comment explicitly notes the one-member union was kept "so the store shape + the header tab affordance stay intact" — the scaffold is pre-built for exactly this. No schema bump (ephemeral store), no new IPC/capture. This ships the **API Inventory** (engine 1, body-free) immediately — "see every endpoint, its statuses, p95, and lazily its shape." It reuses the panel's dock/resize/full-view/clipping for free and respects both docks.
- **Flagship = a dedicated Data-Flow board on React Flow v12** — the canvas-native payoff. Pages/endpoints/entities are RF nodes; calls and id-propagation are edges; auto-laid-out (dagre/elkjs). It sits *on the same infinite canvas as the running Browser board*, so the user can draw their own arrows from a Planning note to an endpoint node and lean on Named Board Groups / grouped-focus for legibility. **Lean into RF** — the engine, custom-node pattern, edges, and pan/zoom already exist; this is the genuine white space no competitor occupies (every tool is either per-request like DevTools or author-it-yourself like Postman Flows). Cost: a new board type = a schema bump per ADR 0007 (register in `boardSchema.ts`/`elementRegistry`) + dagre dep + the body-sampling/privacy path.

**Justification for the order:** the panel tab proves the inference libs on data you already have, body-free, at low effort; the RF board is the high-ceiling flagship but carries the schema bump + body-sampling cost, so it lands last. A **third, cheap surface** — a one-shot **"Sketch the data model" export into a Planning board** (Mermaid `erDiagram` via the existing `makeDiagram`/`materializePlanningOps`, or notes+arrows) — slots between them as the strongest *agent-context* tie-in: the inferred ER becomes durable `.canvas/memory/` the Terminal agent reads. **Critical anti-patterns to obey:** never "draw the whole surface" (GraphQL Voyager / Postman Flows both rot into spaghetti) — default the graph to a **focused subgraph** (focus-on-node + filter); regenerate **idempotently and diff-highlight** changes (Optic) rather than dumping a static map.

### Privacy / scrubbing (design first, not last)

- **Bodies-off by default.** Inventory + call graph need *no* bodies — ship them with zero body access. Schema/ER/lineage gate behind an explicit per-board **"Infer data shapes (reads response bodies)"** opt-in (mirrors the Context subsystem's consent-gated egress + `canvasMemory.setCommitOptIn`).
- **Shape, not values.** Inferred schema stores types/field-names/presence-counts/format-hints — never raw values by default. Example values are a separate deeper opt-in with a PII warning (the JSONoid example-bag is the leak vector). Field *names* (`email`) are kept (schema); values are dropped.
- **Scrub on aggregate/export.** Reuse the Context secret-scrubber on any export; redact `Authorization`/`Cookie`/`Set-Cookie` and any field whose name/format matches a secret/PII pattern.
- **MAIN-side enforcement.** Body sampling/merge happens in MAIN behind the same `isForeignSender` guard as `getOsrNetBody`, capped; the renderer only ever receives merged *schemas*, never raw bodies, unless the user opens one row. Ephemeral by default; export is the consent moment (and inherits `.canvas/` git-ignore-by-default for body-derived data).

### ASCII layout sketch

API Inventory tab (panel surface, body-free, ships first):

```
┌─ Network · Inventory · Data Flow ───────────────────[▤][▥][⤢][x]┐
│ 12 endpoints · 247 calls · 3 with errors        🔒 bodies off ▸ │
├──────────────────────────────────────────────────────────────────┤
│ METHOD  ROUTE TEMPLATE              CALLS  STATUS    p95    SCHEMA │
│ ▾ GET   /api/users/{id}              63    200·404   88ms   {9}   │
│      id        string·uuid   ●required                            │
│      email     string·email  ●required   ⚠ PII  [reveal]         │
│      avatarUrl string|null    optional (41/61)                    │
│      roleId    string·uuid   ●required   →FK Role                │
│ ▸ POST  /api/orders                  9     201·422   120ms  {7}   │
│ ▸ WS    /ws/notifications            1     101      live   ~frames│
├──────────────────────────────────────────────────────────────────┤
│ [Export OpenAPI ▾] [→ Planning board] [→ Agent context]          │
└──────────────────────────────────────────────────────────────────┘
```

Data-Flow board (React Flow flagship), graph layout, focus-defaulted:

```
   ┌──────────────┐   calls   ┌────────────────────┐  returns   ┌──────────┐
   │ PAGE /login  │─────────▶ │ POST /api/session  │──────────▶ │ ◇ Session│
   └──────────────┘           └─────────┬──────────┘            └────┬─────┘
                                token ⊳ (id propagated)              │ FK
                                         ▼                           ▼
   ┌──────────────┐  calls   ┌────────────────┐   returns    ◇ User ──*──◇ Order
   │ PAGE /home   │────────▶ │ GET /api/users │────────────▶          │
   └──────────────┘          └────────────────┘                       └─*─◇ Item
   ── ─── calls   ━━━ returns-entity   ┄┄ id-propagation (lineage)
   [Layout: ⟲ graph | ⇉ sequence | ∿ sankey]   [focus: GET /api/users ▾]
```

## 6. Phased roadmap

### P0 — Viewer fix (smallest shippable `<pre>` replacement)
- **Scope:** flat-row model + memoized `visibleRows` + single-line uniform rows + **Option-A accent-on-keys coloring** + default-collapse-to-depth-2 + size badges + Raw⇄Tree toggle + truncation-tolerant parse-fail fallback (M9). No virtualization yet (correct under the existing 5 MB cap + Load-body gate for typical bodies), no search. Directly retires H1, H2, H3, H4, H6, M4, M8, M9.
- **Files:** add `JsonView.tsx`, `lib/osrJson.ts` (+ test); change `OsrNetworkDetail.tsx` (two call sites), `browser-devtools.css`.
- **Effort:** **M.** **Risk:** Low (no new IPC/capture/schema; isolated swap).
- **Acceptance:** a 200-key nested JSON response renders as a collapsible, accent-keyed tree that folds a large array in one click, with no `dangerouslySetInnerHTML` anywhere in the component (assert via a unit test on the rendered element tree + manual dev check with the PR-stamped title).

### P1 — Viewer enrichments
- **Scope:** custom uniform-height virtualizer + array windowing + hard row cap; in-body search + highlight + next/prev (auto-expand ancestors); copy property-path / value / subtree; big-number raw-source display; URL→`shell.openExternal`; ARIA tree + keymap + `aria-activedescendant`; type affordances. Retires H5, H7, M1, plus a11y.
- **Files:** extend `JsonView.tsx` + `lib/osrJson.ts`; add `lib/virtualizer.ts` (vendored ~80 lines) + test.
- **Effort:** **M–L.** **Risk:** Medium (virtualization + ARIA-under-virtualization focus correctness is the trickiest piece).
- **Acceptance:** a 50k-element array opens instantly with the live DOM holding ≤~50 rows (assert node count via the Playwright `_electron` harness), and `Ctrl/Cmd+G` jumps to a match inside a collapsed subtree after auto-expanding its ancestors.

### P2 — Data Flow inventory + schema
- **Scope:** the four `lib/` inference passes (route-template, monoid schema-merge, entity/PK-FK, prep for lineage); the **API Inventory panel tab** (extend `NetTab`, body-free inventory + lazy per-row schema fill); the **bodies-off-by-default opt-in toggle** + MAIN-side capped sampling behind `isForeignSender`; shape-not-values + scrub.
- **Files:** add `lib/routeTemplate.ts`, `lib/schemaInfer.ts`, `lib/entityInfer.ts` (+ tests), `osr/DataFlowView.tsx`; change `osrNetworkStore.ts` (`NetTab` union), `OsrNetworkPanel.tsx` (tab + gate), `previewOsrNetwork.ts` (opt-in sampling path), `osrNetFormat.ts` (`urlName`→`routeTemplate`).
- **Effort:** **L.** **Risk:** Medium-High (the body-sampling path is the new architecture + the privacy surface; route-template over/under-collapse needs the editable-example escape hatch).
- **Acceptance:** with the opt-in on, repeated calls to `/api/users/{id}` collapse to one inventory row whose expanded schema correctly marks an always-present field `required` and a sometimes-missing field `optional`, with `Authorization`/`Cookie` header values and example values absent from the rendered shape.

### P3 — Data Flow graph + canvas/agent integration
- **Scope:** the id-lineage pass; the **dedicated Data-Flow board** on React Flow (graph layout via dagre, focus-on-node default, sequence layout as a second tab); the **"Sketch the data model" → Planning/Mermaid export**; the **agent-context export into `.canvas/memory/`** with scrub-on-export consent.
- **Files:** add the board-type registration (`boardSchema.ts`/`elementRegistry`, **schema bump per ADR 0007 two-tier**), `osr/DataFlowBoard.tsx`, `lib/lineage.ts`, a Mermaid `erDiagram` serializer; integrate `makeDiagram`/`materializePlanningOps`; add dagre.
- **Effort:** **L.** **Risk:** High (schema bump + new board type + new dep + the lineage pass leans hardest on the privacy work).
- **Acceptance:** clicking through a login→home flow in a Browser board produces a focus-defaulted RF graph where an id returned by `POST /api/session` shows a dashed id-propagation edge to the subsequent request that consumed it, and "→ Planning board" materializes the inferred ER as an editable Mermaid diagram element.

## 7. Open decisions needing user sign-off

1. **Syntax palette (the one-accent tension).** Recommendation: ship **Option A (monochrome + accent-on-keys)** as the default; reserve **Option B (low-chroma derived tints)** as an opt-in toggle only (mixes ≥45% toward `--text-2`, never co-located with status dots), never as default. **Decision needed:** approve A-as-default, and approve/defer B-as-toggle. (Per CLAUDE.md, this UI choice needs a *visible design artifact* — a token-accurate static mock of A vs. B, screenshotted via the Playwright `_electron` harness — before P0 code lands.)
2. **Data-Flow surface.** Recommendation: **panel tab first (P2) → dedicated React Flow board flagship (P3)**, with the Planning/Mermaid export as the agent-context bridge between them. **Decision needed:** confirm the panel-tab-first sequencing and confirm the flagship is a **new board type** (accepting the ADR 0007 schema bump) rather than a permanent panel-only view.
3. **Scope of P0.** Recommendation: P0 ships the tree + folding + accent-keys + Raw toggle + truncation-tolerance **without** virtualization or search (deferred to P1), because the 5 MB cap + explicit Load-body gate make naive render acceptable for typical bodies and this keeps the first PR small and low-risk. **Decision needed:** accept the no-virtualization-in-P0 line, or require virtualization in the first shippable cut (folds P1's hardest item into P0, raising effort to L and risk to Medium).