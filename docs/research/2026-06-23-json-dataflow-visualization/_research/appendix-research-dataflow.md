I now have everything needed. The key implementation constraint confirmed: **response bodies are NOT in the aggregated store** — they're fetched lazily/capped on user click (`preview:osrNetGetBody`). This is the single most important architectural fact for schema inference, since inferring response shapes requires bodies, which means either opportunistic body capture or on-demand sampling. This directly shapes the effort ranking.

Let me compose the final research report.

---

# Deep Research: Visualizing the Full Data Flow from Browser-Board Network Capture

## 0. Grounding in the existing system (what you already have vs. what's missing)

The Browser board already runs an always-on, MAIN-side CDP `Network` capture per board (`src/main/previewOsrNetwork.ts`) into a bounded ring buffer (`MAX_RECORDS = 1000`), mirrored into a renderer Zustand store (`src/renderer/src/store/osrNetworkStore.ts`) and surfaced as a DevTools-parity panel (`OsrNetworkPanel.tsx`). Records already carry: `url`, `method`, `type`, `status`, `mimeType`, sizes, `timing`, `initiator`, WS frames, and per-request/response **headers**.

**The single load-bearing constraint that shapes everything below:** response and request **bodies are NOT buffered**. Per the trust-boundary comment in `previewOsrNetwork.ts` (`BODY_CAP`, the `preview:osrNetGetBody` handler) bodies are fetched lazily, capped, and only on explicit user click. So:
- Concepts that need only URL+method+status+headers+timing (endpoint inventory, the call graph, the waterfall/sequence) work **on the data you already aggregate today** — low marginal cost.
- Concepts that need body *shape* (schema inference, ER view, id-lineage) require a **new opportunistic body-sampling path** in MAIN — and that path is exactly where the privacy contract bites. This is the dominant effort/risk axis in the ranking.

This research feeds the existing empty `feat/json-dataflow-viz` worktree.

---

## 1. The four inference engines (the shared substrate all views render)

All view concepts below are different renderings of the same four pure, incremental inference passes. Build these once in `lib/` (unit-testable, no React), then the views are thin.

### 1a. Endpoint inventory — route-template collapsing
Group records by `method + normalize(pathname)`. The normalizer collapses variable segments to placeholders, the same heuristic mitmproxy2swagger and observability cardinality-reducers use ([mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger), [ASP.NET route templates](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing)):
- numeric segment → `{id}`
- UUID (regex) → `{uuid}`
- long hex / base64-ish / >24-char opaque → `{id}`
- segment that varies across samples while siblings are constant → `{param}` (value-variance fallback for slugs that aren't numeric/uuid)
- keep a per-template **example set** (mitmproxy2swagger's editable `x-path-templates` model) so the user can correct an over- or under-collapse — never fully trust the heuristic.

Per template aggregate: count, method, distinct status codes (+ rate), p50/p95 latency (from `timing`/`endTs−startTs`), request content-types, last-seen. You already have `urlName()` in `osrNetFormat.ts` doing half of this — extend it to a `routeTemplate()` pure fn. Output is effectively a **discovered OpenAPI `paths` object**.

### 1b. Schema inference from JSON samples (the merge algorithm)
Adopt the **monoid/property-accumulator model** from [JSONoid](https://github.com/dataunitylab/jsonoid-discovery) ([paper](https://arxiv.org/abs/2307.03113)) — each schema node accumulates a small bag of monoids that merge associatively, so you can fold each new sample in incrementally (perfect for a streaming capture):
- **type** → union (`string | null`, becomes `["string","null"]` per [JSON Schema combining](https://json-schema.org/understanding-json-schema/reference/combining) / [Speakeasy nullability](https://www.speakeasy.com/openapi/schemas/null)).
- **required vs optional** → a field is `required` only if present in *every* sample seen for that endpoint; presence-count / total-count drives the "optional" marker (the key distinction: a missing key = optional; a present-but-`null` key = nullable-required).
- **arrays** → recursively merge all element schemas into one `items` schema (array-of-T, with T itself possibly a union).
- **format hints** → regex-sniff string values for `date-time`, `uuid`, `email`, `uri`, int-in-string (JSONoid's `Format` property with a match-threshold).
- **ranges/examples** → min/max length, numeric min/max, and a capped example set (JSONoid caps ~100 leaf examples) — but **examples are PII-bearing**, so this is the privacy-gated tier (§6).

Merge result per endpoint = an **inferred response schema** = a JSON Schema you can render as a type tree, an OpenAPI fragment, or a TS `interface`.

### 1c. Entity inference + ER (from the merged shapes)
Reuse the discovered schemas. An "entity" = a repeated object shape that (a) recurs across ≥2 endpoints or array elements and (b) has an identity field. Detection heuristics from [Hackolade's PK/FK inference](https://hackolade.com/help/InferPrimaryKeysandForeignKeyRel.html) and [JSONoid's monoid PK detection](https://arxiv.org/abs/2307.03113):
- **PK candidate**: a field named `id`/`*Id`/`uuid`/`slug`, short, non-null, high distinct-value ratio (JSONoid uses HyperLogLog cardinality ≈ doc count ⇒ unique ⇒ PK).
- **FK / relationship**: field named `<entity>Id` / `<entity>_id` whose values overlap the value-set of another entity's PK (Bloom-filter inclusion-dependency test — cheap and incremental). Also: an embedded object whose shape matches a known entity.
- **entity naming**: derive from the route template (`/users/{id}` ⇒ `User`) and from the wrapping key (`{ user: {...} }`).

Output = entities + typed relationships (`User 1—* Order`, `Order *—1 Product`).

### 1d. Data-flow / lineage graph (id propagation)
The novel, highest-insight pass. Edges:
- **page → endpoint** (`initiator` already in records; the document/`navBoundary` row gives the page).
- **endpoint → entity** (from 1c).
- **lineage / id-propagation**: an id value that appeared in a *response* body of call A and later appears in the *URL path/query/request body* of call B ⇒ edge `A ⊳ B` ("the id from A drove B"). This is the request-chaining insight [Postman Flows](https://learning.postman.com/docs/postman-flows/overview) makes you wire by hand — here it's *discovered* from observed traffic. (Needs bodies ⇒ privacy-gated.) Value-overlap is the same inclusion-dependency primitive as FK detection, reused.

---

## 2. Prior-art map (what to borrow, what to avoid)

| Tool | Borrow | Avoid / gap |
|---|---|---|
| [Postman Flows](https://www.postman.com/product/flows/) | infinite-canvas node graph of requests; data-chaining edges as the core insight | it's *authoring* (you wire it); we want *discovery* (auto-derived) — don't make the user build it |
| [mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger) | path-template collapsing + editable template list + two-pass "confirm the guess" UX; merge multiple captures | CLI/YAML round-trip; no live view |
| [JSONoid](https://github.com/dataunitylab/jsonoid-discovery) | the incremental monoid merge algorithm for schema/PK detection | Scala/distributed scale is overkill — port only the property model |
| [GraphQL Voyager](https://github.com/APIs-guru/graphql-voyager) | types-as-nodes / fields-as-edges ER graph; "shape of the API" framing for onboarding | introspection-based (we have no introspection — we infer) |
| [Hackolade](https://hackolade.com/help/InferPrimaryKeysandForeignKeyRel.html) | PK/FK scoring heuristics (name similarity + value-range containment) | logistic-regression model is heavier than needed |
| Chrome DevTools / [Waterfall Viewer](https://waterfall-tools.com/) | the waterfall you already ship; timing phases | per-request only — no aggregation (the thing users are asking past) |
| [Stripe Workbench](https://docs.stripe.com/workbench/overview) | "Inspector" linking an object to *related* objects + its request logs; the related-object navigation model | hosted, single-API |
| [Bruno](https://www.usebruno.com) / [Hoppscotch](https://hoppscotch.io) | clean collection/inventory tree grouping | authoring-first, not observed |

The white space: **every tool is either per-request (DevTools) or author-it-yourself (Postman Flows). Nobody renders an auto-discovered, live, whole-app data-flow map from passive clicking — on an infinite canvas next to the running app.** That's the differentiated concept.

---

## 3. Three view concepts (ranked by value/effort)

### ⭐ CONCEPT A — "API Inventory" panel tab (rank #1: highest value/effort)
A third tab beside Network in the existing `OsrNetworkPanel`, reading the *same* store. Zero new capture; pure aggregation of data you already have (URL/method/status/timing/headers). Bodies optional (schema column lazy-fills as the user clicks into rows — reusing the existing `getOsrNetBody` path opportunistically).

```
┌─ Network · Inventory · Data Flow ───────────────────[▤][▥][⤢][x]┐
│ 12 endpoints · 247 calls · 3 with errors        🔒 bodies off ▸ │
├──────────────────────────────────────────────────────────────────┤
│ METHOD  ROUTE TEMPLATE              CALLS  STATUS    p95    SCHEMA │
│ ───────────────────────────────────────────────────────────────── │
│ ▸ GET   /api/users                   18    200       42ms   {12}  │
│ ▾ GET   /api/users/{id}              63    200·404   88ms   {9}   │
│      ├ response 200  (inferred shape, union of 61 samples)        │
│      │   id        string·uuid   ●required                        │
│      │   name      string        ●required                        │
│      │   email     string·email  ●required                        │
│      │   avatarUrl string|null    optional (seen 41/61)           │
│      │   roleId    string·uuid   ●required   →FK Role             │
│      └ examples · samples 61 · ⚠ contains email (PII)  [reveal]   │
│ ▸ POST  /api/orders                  9     201·422   120ms  {7}   │
│ ▸ GET   /api/orders/{id}/items       22    200       55ms   [{5}] │
│ ▸ WS    /ws/notifications            1     101      live   ~frames│
├──────────────────────────────────────────────────────────────────┤
│ [Export OpenAPI ▾] [→ Planning board] [→ Agent context]          │
└──────────────────────────────────────────────────────────────────┘
```

- Inventory pass (1a) runs continuously; schema pass (1b) runs **lazily per expanded row** (fetch+merge bodies only on demand → privacy by default, cheap by default).
- Inline FK arrows (`→FK Role`) hint the ER relationships without a separate graph.
- Export buttons feed the canvas integrations (§4).
- **Effort: low.** It's a new tab on an existing panel + the inventory/merge libs. No new capture architecture. Ships the 80% of "see every endpoint and its shape" ask immediately.

### ⭐ CONCEPT B — "Data Flow" board (rank #2: highest ceiling, native to the canvas)
A **new board type** (or a Planning-board overlay) that renders the lineage graph (1d) using your **existing React Flow v12 engine** — the canvas-native payoff. Pages, endpoints, and entities are nodes; calls and id-propagation are edges; auto-laid-out with dagre/elkjs ([React Flow dagre example](https://reactflow.dev/examples/layout/dagre)). It lives *on the same infinite canvas as the running app*, so a Browser board and its data-flow map sit side by side and you can wire your own arrows/notes between them.

```
        ┌──────────────┐
        │ PAGE /login  │
        └──────┬───────┘
               │ calls
        ┌──────▼─────────────┐        returns      ┌──────────┐
        │ POST /api/session  │───────────────────▶ │ ◇ Session│
        └──────┬─────────────┘                     │  token   │
               │ token ⊳ (id propagated)           └────┬─────┘
               ▼                                        │ FK
        ┌──────────────┐  calls   ┌───────────────┐     ▼
        │ PAGE /home   │────────▶ │ GET /api/users │──▶ ◇ User ──*──◇ Order
        └──────────────┘          └───────────────┘         │
                                                            └─*─◇ Item
   ── edges: ─── calls   ━━━ returns-entity   ┄┄ id-propagation (lineage)
   [Layout: ⟲ graph | ⇉ sequence | ∿ sankey]   [filter: page ▾]
```

Three swappable layouts (the panel toggles the same node set):
- **Graph** (dagre force/layered) — "how everything connects" / onboarding map (GraphQL-Voyager framing).
- **Sequence/waterfall** — chronological swimlane per page-visit (DevTools waterfall ⨉ Postman-Flows ordering); best for "what fired when I clicked X".
- **Sankey** — call volume / byte volume flow page→endpoint→entity; best for "where's the traffic concentrated".

Recommendation: **graph as the hero, sequence as the second tab; treat sankey as a stretch** (it's the least actionable for a builder debugging their app).

- **Effort: medium–high.** Reuses RF (big win) but needs: a new board type (schema bump per ADR 0007, registered in `boardSchema.ts`/`elementRegistry`), the lineage pass (needs opportunistic body sampling ⇒ the privacy work in §6), and dagre/elkjs as a new dep. Highest insight ceiling; do it *after* A proves the inference libs.

### CONCEPT C — "Entity / ER snapshot → Planning board" export (rank #3: cheapest canvas integration, narrower)
Not a live view — a **one-shot "Sketch the data model" action** (from Concept A's export button) that materializes the inferred entities (1c) as **Diagram or note/arrow elements inside a Planning board**, using the existing `materializePlanningOps` / Mermaid `DiagramCard` path. The agent context and the human both get a durable, editable ER snapshot on the canvas.

```
   Inventory panel ──[→ Planning board]──▶  Planning board "Data Model @ 14:32"
                                            ┌─────────┐      ┌──────────┐
                                            │  User   │──*──▶│  Order   │
                                            │ id pk   │      │ id pk    │
                                            │ email   │      │ userId fk│
                                            │ roleId  │      │ total    │
                                            └─────────┘      └────┬─────┘
                                            (rendered as a Mermaid erDiagram element,
                                             or as note-cards + arrows — both already exist)
```

- Emits a Mermaid `erDiagram` into a `DiagramElement` (zero new render path — `makeDiagram` exists), **or** notes+arrows via the MCP planning-write materializer.
- Because it's an *export/snapshot*, the privacy scrub (§6) happens once at export time — simplest consent story of the three.
- **Effort: low–medium.** Reuses Planning elements + Mermaid worker entirely; the only new work is entity inference (1c) + a Mermaid serializer. Great "agent context" play: the inferred schema/ER becomes durable project memory the Terminal agent can read.

---

## 4. Canvas-native integration (how it lives in Canvas ADE)

Lean into the three surfaces the codebase already exposes, in increasing ambition:
1. **Panel tab** (Concept A) — least friction, ships first, reuses `osrNetworkStore` + `OsrNetworkPanel` chrome (dock/resize/full-view all free).
2. **Dedicated Data-Flow board** (Concept B) — the canvas payoff: RF nodes on the *same infinite canvas* as the live Browser board, user can draw their own arrows from a Planning note to an endpoint node. Register as a board type (schema bump, two-tier ADR 0007).
3. **Export into Planning board / agent context** (Concept C) — the durable-memory play. The inventory/ER becomes a Mermaid diagram element or notes, and/or is written into `.canvas/memory/` as context the Terminal agent reads ("here are the endpoints your app exercises and their shapes"). This is the strongest tie-in to the project's MCP/context subsystem and the "AI-assisted development" thesis.

Recommended sequence: **A → C → B.** A delivers value on existing data; C is a cheap high-value export reusing Planning+Mermaid; B is the flagship once the inference libs and the body-sampling/privacy path are proven.

---

## 5. Privacy contract (the gating constraint — design it first, not last)

Bodies are page-controlled and may carry secrets/PII; capture is ephemeral; the codebase already treats every captured string as untrusted and caps it in MAIN. The data-flow features extend exfil from "one body the user clicked" to "aggregated/exported shapes." Required controls:

- **Bodies-off by default.** Inventory (1a) and the call graph need *no* bodies — ship them with zero body access. Schema/ER/lineage need bodies ⇒ gate behind an explicit per-board **"Infer data shapes (reads response bodies)"** opt-in toggle (mirrors the Context subsystem's consent-gated egress and `canvasMemory.setCommitOptIn` pattern).
- **Shape, not values.** The inferred schema stores *types, field names, presence counts, format hints* — never raw values, by default. Example values are a separate, deeper opt-in ("include examples") with a PII warning, since JSONoid-style example bags are the leak vector.
- **Scrub on aggregate/export.** Reuse the Context subsystem's secret-scrubber on any export to Planning/agent-context/OpenAPI. Redact header values (`Authorization`, `Cookie`, `Set-Cookie`) and any field whose name/format matches a secret/PII pattern (email, token, key, ssn, card). Field *names* like `email` are kept (they're schema), values are dropped.
- **Ephemeral by default; export is the consent moment.** The inferred model lives in the ephemeral store like the rest of `osrNetworkStore` (never serialized). Persisting it (Concept C into `.canvas/`) is an explicit user action — that's where the scrub+consent prompt fires, and it inherits the `.canvas/` git-ignore-by-default rule for anything body-derived.
- **MAIN-side enforcement.** Sampling/merge of bodies happens in MAIN (where the trust boundary already lives), capped, behind the same `isForeignSender` frame guard as `getOsrNetBody`. The renderer only ever receives merged *schemas*, not raw bodies, unless the user opens a single row.

---

## Bottom line

- **Build the 4 inference passes once** as pure `lib/` modules (route-template, monoid schema-merge, entity/PK-FK, id-lineage). The views are thin renderers over them.
- **Ship Concept A (Inventory tab) first** — it answers "see every endpoint and its shape" on the data you already aggregate, body-free, low effort.
- **Then Concept C (ER → Planning/agent export)** — cheap, reuses Mermaid+Planning, and is the strongest agent-context tie-in.
- **Concept B (Data-Flow board) is the flagship** — auto-discovered live lineage graph on your own React Flow engine, side by side with the running app; the genuine white space no competitor occupies. Higher effort (new board type + schema bump + body-sampling + dagre dep) and it's the one that most needs the §6 privacy work, so do it last.
- **Privacy is the gating axis:** inventory+graph need no bodies; schema/ER/lineage need bodies → opt-in, shape-not-values, scrub-on-export. Bodies are not in your store today, so that sampling path is the main new architecture and the main risk.

Relevant files: `Z:\Canvas ADE\src\main\previewOsrNetwork.ts` (capture + the `getBody` exfil surface), `Z:\Canvas ADE\src\renderer\src\store\osrNetworkStore.ts` (the aggregated mirror to read from), `Z:\Canvas ADE\src\renderer\src\canvas\boards\osr\OsrNetworkPanel.tsx` (host for Concept A's tab), `Z:\Canvas ADE\src\renderer\src\lib\osrNetFormat.ts` (extend `urlName`→`routeTemplate`), `Z:\Canvas ADE\src\renderer\src\canvas\boards\planning\elements.ts` + `materializePlanningOps` / `makeDiagram` (Concept C export targets). The feature has an empty waiting worktree at `Z:\Canvas ADE\.worktrees\json-dataflow-viz` (branch `feat/json-dataflow-viz`).

Sources: [Postman Flows](https://learning.postman.com/docs/postman-flows/overview), [mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger), [JSONoid (paper)](https://arxiv.org/abs/2307.03113) / [repo](https://github.com/dataunitylab/jsonoid-discovery), [GraphQL Voyager](https://github.com/APIs-guru/graphql-voyager), [Hackolade PK/FK inference](https://hackolade.com/help/InferPrimaryKeysandForeignKeyRel.html), [JSON Schema combining/nullability](https://json-schema.org/understanding-json-schema/reference/combining), [Speakeasy null best practices](https://www.speakeasy.com/openapi/schemas/null), [Stripe Workbench](https://docs.stripe.com/workbench/overview), [mitmproxy HAR](https://www.mitmproxy.org/posts/har-support/), [React Flow dagre/elkjs layout](https://reactflow.dev/examples/layout/dagre), [ASP.NET route templating](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing).