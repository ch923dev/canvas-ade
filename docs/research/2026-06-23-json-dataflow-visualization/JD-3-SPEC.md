# JD-3 — Data Flow inventory + schema (implementation spec)

> **Slice:** JD-3 of the [JD umbrella](./EPIC.md) · **maps to** REPORT §6 P2 · **Effort:** L · **Risk:** Med-High
> **Goal:** add a **Data Flow** tab to the Network inspector that infers an API's **endpoint inventory +
> response schemas + entities** from already-captured traffic — body-free by default, opt-in for shapes,
> and graceful on flat APIs (zero fabricated edges).
> **Design artifact (sign-off gate satisfied):** [`jd-3-inventory-tab-mock.png`](./jd-3-inventory-tab-mock.png)
> (3 states: bodies-off gate · bodies-on schema+inspector · flat-API degradation).
> **Privacy ADR (gate satisfied):** [`../../decisions/0010-data-shape-inference-sampling.md`](../../decisions/0010-data-shape-inference-sampling.md).
> **Sign-off decisions (2026-06-23):** (1) JD-3 ships a **two-column inventory + inspector**; the **visual
> graph + id-lineage are JD-4**. (2) Entity/FK detection is **structural name+type only** (no values cross
> IPC). (3) Sampling caps = **20 samples / 8 MB per pass / response-only**.

## 1. What ships (and what does NOT)

**In scope (P2):**
- Three pure `lib/` passes: **route-template collapsing**, **monoid schema-merge** (over value-less shape
  skeletons), **entity/PK-FK detection** (name+type structural).
- The **API Inventory panel tab** (extend `NetTab` → `'network' | 'dataflow'`): a body-free endpoint
  inventory (route templates, call counts, status-mix, p50/p95) that renders immediately, + a right-rail
  **entity/shape inspector** stating relationships textually.
- The **bodies-off-by-default opt-in** ("Infer data shapes (reads response bodies)") + a **MAIN-side
  capped sampling IPC** behind `isForeignSender`, returning **value-less shape skeletons** (never raw
  bodies). Schema fill is **lazy per expanded template**.
- **Graceful degradation:** flat/unrelated APIs show inventory + schemas + island shapes and draw **zero**
  entity→entity relationships ("None detected").

**Explicitly OUT (→ JD-4):** the visual node/edge **graph**, **id-lineage** (needs structured-initiator
capture), the dedicated React-Flow **Data-Flow board**, **dagre**, the **Mermaid/agent-context export**.
**Out (deeper opt-in, later):** **example values**, value-overlap FK confirmation, request-payload
inference, NDJSON/SSE/GraphQL-op grouping beyond the basic guardrail.

**No persisted state → no schema bump.** Inventory + schemas are ephemeral React/Zustand state.

## 2. Current state (what JD-3 builds on)

- **Capture (MAIN).** `src/main/previewOsrNetwork.ts` keeps a bounded ring of `NetRecord` per board
  (every page string pre-capped). Bodies are **not** buffered; the sole egress is the lazy, user-clicked
  `preview:osrNetGetBody` → `Network.getResponseBody` → `capBody` (`BODY_CAP = 5 MB`). IPC handlers are
  registered in `registerOsrNetworkIpc(ipcMain, getWin, getEntry, emit)`, each `isForeignSender`-guarded
  and re-validating the board id + `requestId` against live state.
- **Store.** `src/renderer/src/store/osrNetworkStore.ts` — ephemeral, never serialized. `NetTab` is the
  single-member union `'network'` (a vestige; extending it is mechanically free — no schema bump).
  `byBoard[id]: BoardNet` holds `records[]`, `ws[]`, `tab`, `selected`, etc.
- **Panel.** `src/renderer/src/canvas/boards/osr/OsrNetworkPanel.tsx` renders the header tabs (`TabBtn`),
  the Network toolbar/list/summary. `urlName(url)` (`osrNetFormat.ts:28`) gives the row name.
- **JD-1 lib.** `src/renderer/src/lib/osrJson.ts` already owns `stripBom`, `looksJson`, `detectBodyKind`,
  and a lenient tokenizer. JD-3 **reuses** `looksJson`/`detectBodyKind`; it does **not** touch `osrJson.ts`
  (Lane A territory) — the MAIN shape extractor is separate (§5).
- **Scrubber.** `redactSecrets(text)` (`src/main/summaryLoop.ts:93`) — the shared secret pattern set.

## 3. New `lib/` module — `src/renderer/src/lib/routeTemplate.ts` (+ test)

Pure, no React. Collapses captured URLs into stable route templates so an observed surface doesn't
explode into thousands of per-id rows (the single most important legibility trick — REPORT engine 1).

```ts
export type SegKind = 'static' | 'id' | 'uuid' | 'param'
export interface RouteTemplate {
  method: string            // GET/POST/… (WS → 'WS')
  origin: string            // scheme://host[:port] — kept so /api/v1 vs a different host never merge
  template: string          // e.g. /api/v2/users/{id}
  segKinds: SegKind[]       // per-path-segment classification (for the accent-on-dynamic render)
}
export interface TemplateGroup {
  key: string               // `${method} ${origin}${template}` — the inventory row identity
  tpl: RouteTemplate
  records: NetRecord[]      // every captured call that collapsed here (newest last)
  examples: string[]        // distinct concrete paths (capped ~5) — the editable escape hatch
  calls: number
  statusMix: { c2xx: number; c3xx: number; c4xx: number; c5xx: number; other: number }
  p50Ms?: number; p95Ms?: number
}

export function routeTemplate(url: string, method: string): RouteTemplate
//  classify each path segment:
//   - 36-char 8-4-4-4-12 hex/dashes → 'uuid'  → {uuid}
//   - all-digits, OR a long opaque token (≥16 chars, mixed alnum, not a known word) → 'id' → {id}
//   - same position varies across calls but is short/wordy → 'param' (resolved in groupByTemplate) → {param}
//   - else 'static' (kept verbatim)
//  Guardrails: numeric API-version segments (/v1, /v2) are ALWAYS 'static' (never collapse v1↔v2);
//  the FIRST one/two segments under a known api prefix stay static unless clearly an id.

export function groupByTemplate(records: NetRecord[]): TemplateGroup[]
//  two-pass: (1) per-record routeTemplate; (2) a position-variance pass promotes a 'static' segment to
//  'param' iff that position takes many distinct short values across the group (catches /sort/asc style).
//  Sort groups by calls desc. WS records group by url path (no method). Compute statusMix + p50/p95 from
//  records' timing (reuse durationMs from osrNetFormat).
```

**`osrNetFormat.ts` rebase (the `△` shared file, JD-1 already landed `looksJson`):** keep `urlName` for
the **Network** tab row name; **add** a thin re-export or have the Data Flow tab call `routeTemplate`
directly. Do **not** rewrite `urlName`'s behavior (the Network tab depends on it). The "rename" in the
EPIC = *introduce* `routeTemplate` alongside, not replace `urlName`.

**Tests:** `/api/v2/users/123` + `/api/v2/users/456` → one `/api/v2/users/{id}` (2 calls). UUID → `{uuid}`.
`/api/v1/x` vs `/api/v2/x` → **two** groups (version guardrail). 1000 distinct ids → one template +
≤5 examples. A single-segment opaque token → `{id}`. Different origins never merge.

## 4. New `lib/` module — `src/renderer/src/lib/schemaInfer.ts` (+ test)

Pure monoid merge over the **value-less shape skeletons** MAIN returns (§5). Associative → a sample is
representative; truncated samples are shape-only.

```ts
export type ShapeType = 'string' | 'number' | 'bool' | 'null' | 'object' | 'array' | 'unknown'
export type FormatHint = 'uuid' | 'date-time' | 'email' | 'uri' | 'int64'   // class label, NEVER a value
/** One node of a captured body's SHAPE — emitted by MAIN with all values dropped. */
export interface ShapeNode {
  types: ShapeType[]                       // usually one; union after merge
  format?: FormatHint
  children?: Record<string, ShapeNode>     // object members (insertion order preserved)
  elem?: ShapeNode                         // array element (merged across elements)
}
export interface ShapeSample { root: ShapeNode; complete: boolean }  // complete=false ⇒ truncated/clipped

export interface InferredField {
  key: string
  types: ShapeType[]
  format?: FormatHint
  presentIn: number          // # of COMPLETE samples containing this key
  sampleCount: number        // # of COMPLETE samples at this level
  required: boolean          // presentIn === sampleCount && sampleCount > 0
  pii?: boolean              // key matches a PII/secret NAME pattern (value never shown)
  children?: InferredField[] // object
  elem?: InferredField | null// array element (a synthetic field keyed '[]')
}
export interface InferredSchema {
  root: InferredField        // the merged tree (root.key = '' )
  rootKind: 'object' | 'array' | 'scalar'
  sampleCount: number; truncatedCount: number
}

export function mergeShapes(samples: ShapeSample[]): InferredSchema
//  fold node-by-node: types = union; format kept iff all agree; per child key, presentIn counts COMPLETE
//  samples that had it (a key absent in some complete sample ⇒ optional); arrays merge `elem` across all
//  elements of all samples. Truncated samples contribute TYPES but are excluded from the presence
//  denominator (a clipped trailing field must not read as optional — REPORT B3).

export function isPiiName(key: string): boolean
//  /^(e?mail|ssn|phone|tel|password|passwd|secret|token|api[_-]?key|authorization|cookie|cc|card|cvv|iban)$/i
//  plus *_email / *Token / *Secret suffixes. Drives the ⚠ PII chip (no value is ever present to leak).
```

**Tests:** present-in-every → `required`; present-in-some → `optional` with the right `presentIn/sampleCount`;
`string|null` union; a truncated sample doesn't flip a real field to optional; `email`/`ssn` → `pii:true`;
nested object + array-of-object merge; empty sample set → `sampleCount:0`, nothing required.

## 5. MAIN — the capped sampling path (`previewOsrNetwork.ts` + IPC)

### 5.1 Pure value-stripping extractor (MAIN, unit-tested)
```ts
export const SCHEMA_SAMPLE_CAP = 20          // bodies sampled per pass
export const SCHEMA_BYTES_CAP = 8 * 1024 * 1024  // total decoded bytes read per pass
export function extractShape(body: string): ShapeSampleWire | null
//  JSON.parse the (≤BODY_CAP) body; walk the value → ShapeNode, DROPPING every value: keep type, detect
//  format by PATTERN on the value (uuid/iso-date/email/uri/int64) then discard it. Object key insertion
//  order preserved. On parse-fail → null (skip; counted). The body string is freed after the walk.
//  Mirror the ShapeSample wire shape exactly (see preload mirror, §7).
```
`extractShape` lives in MAIN (the renderer never sees the value). It does **not** import the renderer's
`osrJson.ts`. Format detection reads the value only to classify it; `redactSecrets` is applied defensively
to any string before classification (belt-and-suspenders — no value is emitted regardless).

### 5.2 New IPC `preview:osrNetSampleSchema` (in `registerOsrNetworkIpc`)
```ts
ipcMain.handle('preview:osrNetSampleSchema', async (ev, args: { id: string; requestIds: string[] }) => {
  if (isForeignSender(ev, getWin)) return { error: 'forbidden' }
  const e = getEntry(args?.id); if (!e) return { error: 'no board' }
  const ids = Array.isArray(args?.requestIds) ? args.requestIds.slice(0, SCHEMA_SAMPLE_CAP) : []
  const samples: ShapeSampleWire[] = []
  let bytes = 0, requested = ids.length, sampled = 0
  for (const rid of ids) {
    const rec = e.net.byId.get(String(rid))
    if (!rec || rec.type === 'websocket') continue        // re-validate; responses only
    if (bytes >= SCHEMA_BYTES_CAP) break                  // hard byte ceiling per pass
    try {
      const res = await e.osrWin.webContents.debugger.sendCommand(
        'Network.getResponseBody', { requestId: rec.requestId }, rec.sessionId)
      const capped = capBody(res.body, res.base64Encoded === true)   // reuse the 5 MB cap
      if (capped.base64) continue                          // binary → not inferable
      bytes += capped.body.length
      const shape = extractShape(capped.body)
      if (shape) { shape.complete = !capped.truncated; samples.push(shape); sampled++ }
    } catch { /* body evicted / target gone — skip */ }
  }
  return { samples, requested, sampled }                   // VALUE-LESS skeletons only
})
```
- **Frame-guarded, re-validated, capped, response-only, value-free** — every ADR 0010 guard.
- Wired exactly like the other handlers; registered from `index.ts` where `registerOsrNetworkIpc` is
  called (no new registration site needed — add the handler inside it).

## 6. Store changes — `store/osrNetworkStore.ts` (ephemeral, no schema bump)

```ts
export type NetTab = 'network' | 'dataflow'              // extend the union (mechanical)
// add to BoardNet:
interface DataFlowState {
  inferShapes: boolean                                   // the per-board opt-in (default false)
  expanded: string[]                                     // template keys whose schema is shown
  schemas: Record<string, InferredSchema | { loading: true } | { error: string } | { sampled: number; requested: number; schema: InferredSchema }>
}
// actions: setInferShapes(id, on), toggleTemplate(id, key), setSchema(id, key, result)
```
`inferShapes`, `expanded`, `schemas` reset on `clearBoard` / records→empty (they're derived from bodies).
Default `inferShapes:false` in `EMPTY`. **No** new persisted field, **no** `schemaVersion`.

## 7. Preload mirror — `preload/index.ts` + `main/index.ts`

- **Mirror types** verbatim (process boundary, no shared import — same discipline as `OsrNetMessage`):
  `ShapeType`, `FormatHint`, `ShapeNode`, `ShapeSampleWire`, and the result
  `OsrNetSchemaResult = { samples: ShapeSampleWire[]; requested: number; sampled: number } | { error: string }`.
- **Expose:** `sampleOsrNetSchema: (id: string, requestIds: string[]) => Promise<OsrNetSchemaResult>` →
  `ipcRenderer.invoke('preview:osrNetSampleSchema', { id, requestIds })` (next to `getOsrNetBody`).
- **`main/index.ts`:** no new wiring beyond the handler living inside `registerOsrNetworkIpc` (already
  invoked there). Confirm the channel name is allow-listed if any channel allowlist exists.

## 8. New component — `canvas/boards/osr/DataFlowView.tsx`

Presentational; all logic from §3–§4. Rendered by `OsrNetworkPanel` when `tab==='dataflow'`. Props:
```ts
export function DataFlowView({ boardId, records }: { boardId: string; records: NetRecord[] }): ReactElement
```
**Layout (two columns — the signed-off mock):**
- **Toolbar:** the **opt-in toggle** `☐ Infer data shapes (reads response bodies)` (role=checkbox, mirrors
  `.bb-net-preserve`), a `?` help affordance, the privacy chip (`🔒 bodies off · inventory only` ⇄
  `values scrubbed · structure only`), and a `Group: route | raw` segmented control (route is default;
  `raw` shows un-collapsed paths — reuse the Network filter for now, `raw` MAY be a no-op stub labeled).
- **Left — Endpoint Inventory:** `groupByTemplate(records)` → one row per template (method badge neutral,
  route with `{id}`/`{uuid}` segments in `--accent`, calls, status-mix bar, p50/p95, a schema cell showing
  `{n}` when filled / a lock glyph when bodies-off / `~frames` for WS). Click expands:
  - **bodies-off:** the dashed **gate** ("Shapes are off · Enable") — clicking `Enable` flips `inferShapes`.
  - **bodies-on:** lazily call `sampleOsrNetSchema(boardId, newest≤20 requestIds of this template)`, set
    `loading`, then render `mergeShapes(samples)` as an indented field list: key (`--text`), type (neutral
    `--text-2`; id/uuid/`*Id` → `--accent`), `●required` / `optional · 41/61` presence markers (neutral,
    **never** status hues), `⚠ PII · value hidden` chip on `isPiiName` fields, `→ FK <Entity>` tag, and a
    `sampled N of M · newest-first · values dropped` footnote.
- **Right — Entity/Shape inspector:** over all filled schemas, `inferEntities` (§ below) → the selected
  template's entity: name, kind pill (`entity` / `response shape`), fields, **Produced by**, **Consumed by**,
  and **Relationships** (textual `User 1—* Order · FK name+type` or **None detected** with the flat-API
  explanation). For a flat API this column shows the island shape + "Relationships 0".

**Entity inference** is a small `lib/entityInfer.ts` (§9). **No graph, no SVG, no dagre.** No
`dangerouslySetInnerHTML` — every page string (keys, route segments, examples) is React text.

## 9. New `lib/` module — `src/renderer/src/lib/entityInfer.ts` (+ test)

```ts
export interface Entity { name; kind:'entity'|'shape'; pk?; schemaKey; fields: InferredField[]; fieldKeys; producedBy; consumedBy; fkFields; isLeaf }
export interface Relationship { from; to; via; kind:'1-*'|'1-1'; confidence:'name+type' }
export function inferEntities(inputs: { key; routeName; method; schema }[]): { entities; relationships }
export function fkBaseName(key: string): string | null   // FK base name (customerId→customer), null for PKs
```
**Recursively deconstructs every response — it does NOT only look at the top level.** `collect()` walks
the whole inferred-schema tree; **any object carrying an identity field** (`id`/`_id`/`uuid`/`guid`,
scalar) is an entity, *wherever it sits*:
- **Envelope unwrap:** a root with no id but a wrapper key (`data`/`result`/`payload`/`records`/`items`/…)
  is transparent — the inner object/array becomes the **route's** entity (named by the route, not the
  wrapper). So `{status, data:{id, customerId}}` → entity `Order` with the FK seen.
- **Nested entities:** a nested object/array with its own id (`order.customer{id}`) is promoted to its own
  entity, named by its field key, with a **containment** relationship (`Order 1—1/1—* Customer`).
- **Value objects** (a nested object with no id, e.g. `address`) stay nested **shape**, not an entity.
- **FK** = a scalar `<entity>Id` (or `<entity>_id`) field whose base matches another entity's name →
  `target 1—* holder`. **Name+type only — no values** (ADR 0010). `isLeaf` = no id anywhere & unreferenced.

The **inventory schema reveal renders the full nested tree** (objects/array-elements expanded inline, not
summarized to `{N}`) so the decomposition is visible; the **inspector shows the route's primary
(unwrapped) entity's fields** + its relationships.

**Tests:** envelope `{status,data:{id,customerId}}`→entity+FK; envelope list `{data:[{id}]}`→entity;
nested `{id,customer:{id}}`→2 entities + containment edge; value-object `{id,address:{…}}`→Address not
promoted; `Order{userId}`+`User{id}`→`User 1—* Order`; flat `Weather{city,tempC}`→`isLeaf`, zero edges.

## 10. CSS — `styles/boards/browser-devtools.css` (append-only block)

Append a `.bb-net-df-*` block (do **not** edit existing `.bb-net-*`), mirroring the mock tokens:
inventory row grid, method badge (neutral `--text-2`), `{id}`/`{uuid}` segment `--accent`, status-mix
(`--ok/--warn/--err` for status only), the dashed `.bb-net-df-gate`, the opt-in toggle, the schema field
list (key `--text`, type `--text-2`, id/FK `--accent`, presence markers neutral, `⚠ PII` chip on `--warn`
**text+border only, no fill**), the inspector sections, the privacy chip. **One accent**; status hues for
status only.

## 11. Security invariants (must hold)

- **No `dangerouslySetInnerHTML` / `innerHTML`** in `DataFlowView` (asserted by a component test).
- **No raw value leaves MAIN via inference** — `sampleOsrNetSchema` returns only `ShapeSampleWire`
  (value-less); raw bodies still reach the renderer only through the unchanged `getOsrNetBody`.
- **All new IPC `isForeignSender`-guarded**, board id + every requestId re-validated, caps enforced in MAIN.
- `contextIsolation`/`sandbox`/`nodeIntegration:false` untouched; opt-in re-validated MAIN-side per pass
  (a renderer can't sample without the live records / its own board).

## 12. Test plan

- **Unit:** `routeTemplate.test.ts`, `schemaInfer.test.ts`, `entityInfer.test.ts` (cases above) +
  `previewOsrNetwork`-side `extractShape` test (values dropped, format detected, parse-fail → null,
  truncated → `complete:false`).
- **Component:** render `DataFlowView` with `<script>`-bearing keys → escaped, no `dangerouslySetInnerHTML`;
  opt-in off → gate shown, zero `sampleOsrNetSchema` calls; opt-in on + expand → one call, schema renders.
- **e2e (`@preview`):** extend the Network spec. **Body-load gotcha:** to load a body in e2e the page must
  **FETCH a subresource** (`?xhr=1` → `/json` in `localServer`) — the main-document body is CDP-evicted
  post-commit ([[osr-net-body-e2e-cdp-eviction]]). Drive: open Data Flow tab → assert inventory rows
  (body-free, no opt-in) → flip opt-in → expand a template → assert a `required` and an `optional` field
  render and that no value text appears. Full matrix at the pre-merge gate.
- **Manual dev check (mandatory):** `$env:CANVAS_DEV_TITLE='PR#NNN JD-3 data-flow'; pnpm dev` → Browser
  board, hit a real repeated API, open **Data Flow**, confirm: inventory collapses repeated calls,
  opt-in gate works, schema fills with required/optional + PII chip, flat API shows "None detected".
  Confirm the window title before sign-off.

## 13. Acceptance criteria (gate to "done")

> With the opt-in **on**, repeated calls to `/api/users/{id}` collapse to **one** inventory row whose
> expanded schema marks an always-present field `required` and a sometimes-missing field `optional`, with
> `Authorization`/`Cookie` header values and example values **absent** from the rendered shape. With a flat
> unrelated API, the view shows inventory + schemas and **draws no entity→entity relationships** ("None
> detected"). With the opt-in **off**, the inventory renders fully and **zero** body reads occur.

## 14. File manifest / Definition of done

- **Add:** `lib/routeTemplate.ts` (+test), `lib/schemaInfer.ts` (+test), `lib/entityInfer.ts` (+test),
  `canvas/boards/osr/DataFlowView.tsx` (+ `DataFlowView.test.tsx`), **`main/previewOsrShape.ts`** (the
  value-stripping `extractShape` + `sampleResponseShapes` — split out of `previewOsrNetwork.ts` to stay
  under the 700-line `max-lines` cap), `docs/decisions/0010-data-shape-inference-sampling.md` (ADR).
- **Change:** `store/osrNetworkStore.ts` (`NetTab` + dataflow state), `canvas/boards/osr/OsrNetworkPanel.tsx`
  (Data Flow `TabBtn` + route to `DataFlowView`), `main/previewOsrNetwork.ts` (the thin frame-guarded
  `preview:osrNetSampleSchema` handler delegating to `previewOsrShape.sampleResponseShapes`, +tests),
  `preload/index.ts` (mirror types + `sampleOsrNetSchema`), `styles/boards/browser-devtools.css` (append
  `.bb-net-df-*`). `main/index.ts` unchanged (no IPC channel allowlist exists); `lib/osrNetFormat.ts`
  unchanged (`routeTemplate` is its own new module; `urlName` stays for the Network tab).
- **e2e:** extends `e2e/browserNetwork.e2e.ts` with the Data Flow flow (`@preview`).
- **DoD:** typecheck + lint + format:check + unit green; e2e matrix green both legs; manual dev check signed
  off against the mock; ADR 0010 → Accepted; one PR `feat/jd-3-dataflow`; the JD-3 spec + mock deleted in
  the merge PR (build-history line is the residue) per the doc-lifecycle policy.
