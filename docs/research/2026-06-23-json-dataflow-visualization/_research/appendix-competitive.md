I now have comprehensive coverage across all tools. Here is the structured teardown.

---

# Competitive UX Teardown: JSON Rendering + API/Data-Flow Surfacing

Goal: extract concrete, stealable affordances + their failure modes for a board-based tool. Canvas ADE context: each board is a small, resizable, camera-scaled node, so the binding constraints are (a) tiny default viewport, (b) bodies that arrive from a live agent/preview at unknown size, and (c) the whole thing must stay legible while zoomed.

---

## PART A — JSON Response Viewing

### 1. Chrome DevTools — Network "Preview" vs "Response"
The split itself is the lesson: two tabs over one body. **Response** = raw source text + a one-click bottom **`{ }` Format** button (idempotent pretty-print on demand, never automatic). **Preview** = a parsed, collapsible, type-colored tree that only materializes if the body parses as JSON; if it doesn't, Preview gracefully falls back to rendering it as HTML/image so an HTML error page from an API is still readable.

- **Steal #1 — Two views over one body, raw is the default, pretty is opt-in.** Raw text never freezes; the expensive tree is a deliberate click. This is exactly how Postman *should* behave (see its anti-pattern below).
- **Steal #2 — "Copy property path"** (right-click any node → yields `[0].name` / `.data.items[3].id`). For an agent canvas this is the single highest-value affordance: a user clicks a value and gets a machine-usable accessor they can paste into the terminal agent's prompt ("read `data.items[3].id`").
- **Steal #3 — "Store as global variable"** (`temp1`): a node becomes a live handle. Canvas analog: "send this subtree to the agent as context" / "pin as a chip."
- **Anti-pattern to avoid:** the Preview/Response distinction is *undiscoverable* — most users never learn Preview is the parsed tree, and the Format button hides at the bottom. Don't bury your good view behind a tab whose name doesn't say "parsed."
- 1MB+ behavior: fine on Response (it's just text); Preview's tree lazy-renders children on expand, so deep trees stay responsive. Search = `Ctrl/Cmd+F` within the panel, plain substring.

### 2. Firefox built-in JSON viewer
Auto-renders any `application/json` document into three tabs: **JSON** (collapsed tree, `+` expand), **Raw Data**, **Pretty Print**, plus a **Filter box** that live-filters the tree as you type, and it surfaces request/response **headers** inline.

- **Steal #1 — The persistent filter box above the tree** that prunes to matching paths/values in real time (not a find-next cursor — it *collapses away non-matches*). This is the best "find the needle in a 5000-key body" interaction in the comparison set and maps perfectly to a small board.
- **Steal #2 — Raw / Pretty / Tree as peer tabs**, all reachable, none modal.
- **Anti-pattern / failure mode:** the filter is substring-only — there's a years-old, never-shipped request for **JSONPath** in the filter (Bugzilla 1244922 / Mozilla Connect idea). Users hit the wall the moment they want `$.items[*].price`. Lesson: ship a filter box, but design the query grammar to grow into structured queries from day one rather than bolting it on.

### 3. Postman / Insomnia / Bruno / Hoppscotch (response panels)
Common shape: **Pretty / Raw / Preview** toggle, language auto-detect + syntax color, body search, collapsible tree. Bruno and Hoppscotch are lighter and noticeably faster on big bodies; Insomnia sits between.

- **Steal #1 (Postman/Insomnia) — Response *meta* rail:** status code (colored), **time**, and **size** always pinned next to the body. Cheap, and on a board it's the at-a-glance "did this call go well" signal even when zoomed too far to read the body.
- **Steal #2 (Hoppscotch/Bruno) — keep the renderer cheap and virtualized;** their speed advantage is the proof that the body view must not pretty-print-the-world synchronously.
- **Anti-pattern to avoid (Postman — documented, severe):** Postman **auto-formats on arrival** and the synchronous "Formatting…" pass **freezes the whole app for ~25s on a 15MB array** and can white-screen/crash above ~50–100MB (issues #1089, #4751, #8288, #12790). The official workaround is literally "switch to Raw view." **Lesson for Canvas ADE: never auto-pretty-print an unbounded body; gate it behind a size threshold + an explicit "Format" click, and stream/virtualize.** This is the single most important failure mode in this entire teardown given that bodies arrive from a live agent/preview of unknown size.

### 4. `jless` (terminal)
Vim-keyed TUI JSON/YAML browser. Expand/collapse per node, **regex search across keys AND string values**, jump-between-same-key (`n`/`N` style), syntax highlight, handles NDJSON streamed from `jq`.

- **Steal #1 — "jump to next value for the same key."** Press a key, hop through every `price` in the doc. In a board you'd expose this as clicking a key name → cycle all siblings/cousins with that key. Nobody else here does this and it's superb for scanning arrays of records.
- **Steal #2 — Collapse-to-structure first.** jless opens showing skeleton; you drill down. For a tiny board this is the right default (see expansion-default note below).
- **Failure mode:** purely keyboard/regex — no copy-path, no type filtering, no Windows support historically. Discoverability is zero without the keymap. Don't ship a powerful viewer whose affordances are invisible.

### 5. `fx` (terminal)
Interactive viewer **plus** a processor: navigate with arrows/expand-collapse, and drop into **JavaScript expressions** (`.items.filter(x => x.price > 10)`) as the query language — no DSL to learn. Streams gigabyte/NDJSON inputs **without loading into memory**, written in Go, instant start.

- **Steal #1 — Code-expression as the query language.** For an *AI dev* canvas this is on-brand: the "filter" box accepts a JS/JSONPath expression that transforms the body, and the result is itself a viewable subtree you can pin. Pairs naturally with "send result to agent."
- **Steal #2 — Streaming, bounded-memory ingest.** The architectural answer to the Postman freeze: parse incrementally, never hold-and-format the whole blob.
- **Failure mode:** expression power = a learning cliff for non-coders; mitigate with a filter box that accepts *either* a plain substring *or* an expression.

### 6. Web JSON-tree components (`@uiw/react-json-view`, `react-json-view`, `react-json-tree`)
The off-the-shelf building blocks, and they encode the consensus defaults:
- **Collapse-at-depth** via an integer prop (e.g. expand 1–2 levels, collapse the rest) — the right default for a small board.
- **Per-node clipboard icon** on hover (copy that object/array).
- **Arrays grouped/chunked by count** with expandable bracket ranges → the standard answer to "10,000-element array."
- **`react-json-tree` virtualizes** — only visible nodes render.

- **Steal:** adopt these as the literal defaults — *expand to depth N, virtualize, per-node copy icon, chunk big arrays, type-color (string/number/bool/null distinct)* — rather than reinventing. They're battle-tested and free.
- **Failure mode:** the popular `react-json-view` (mac-s-g) is effectively unmaintained and **not** virtualized → it chokes on large bodies; `@uiw/react-json-view` v2 or `react-json-tree` are the live, virtualization-aware choices.

**Cross-cutting answers to your specific questions:**
- *Default expansion:* best-in-class = **collapsed-to-structure or expand-to-depth-1/2**, never expand-all (jless, the tree components). Expand-all is what makes a 1MB body unusable.
- *1MB+ body:* winners **virtualize + lazy-expand children + chunk arrays + stream-parse** (fx, react-json-tree, DevTools Preview). Loser pattern = **synchronous pretty-print on arrival** (Postman).
- *Search:* spectrum from substring find (DevTools, Postman) → live tree-pruning filter (Firefox) → regex across keys+values with same-key jump (jless) → full expression/JSONPath (fx). **The filter-that-prunes (Firefox) is the best fit for a small viewport.**
- *Copy-path:* DevTools "Copy property path" is the gold standard; tree components give per-node "copy value/subtree." Offer **both**.
- *Type coloring:* universal and expected — distinct colors for string vs number vs bool vs null vs key; keys de-emphasized, values emphasized.

---

## PART B — Data-Flow / API-Surface Legibility

### 7. Postman Flows
Node-graph builder: drag blocks (request, condition, transform), wire outputs→inputs, data flows along edges; good for non-coders to *see* a sequence step by step.

- **Steal #1 — Data-on-the-wire visualization:** you can inspect the actual payload traveling each edge, so the graph doubles as a live debugger. For a canvas where boards already are nodes, edges that carry/preview real data between boards (terminal → preview → planning) is the native analog.
- **Anti-patterns / complaints:** (a) **doesn't scale visually** — large flows become unreadable spaghetti; (b) **hard to debug / hard to assert** — users explicitly want "fail when actual ≠ expected" and can't easily get it (community feedback thread); (c) HN skepticism that most devs adopt it at all. **Lesson: a node-graph is legible only with aggressive grouping/collapsing and a way to assert/inspect, or it rots into spaghetti** — directly relevant since Canvas ADE is itself a node canvas (your Named Board Groups + grouped-focus are the mitigation).

### 8. Hoppscotch
Lightweight, fast, browser-first API client; real-time/WebSocket/GraphQL panels; minimal chrome.

- **Steal:** **speed and minimalism as a feature** — instant render, no heavy app shell. Validates the "keep the renderer cheap" thesis. Its GraphQL panel shows schema + docs inline without a separate heavyweight tool.
- **Failure mode:** thin on org-scale surfacing (no traffic→spec, limited at-scale history) — fine, that's not its job; don't expect it to be your data-flow layer.

### 9. GraphQL Voyager
Auto-renders any introspectable schema as an **interactive type graph** — types as nodes, fields as arrows, pan/zoom, focus-on-type, skip-deprecated toggle. Best-in-class "see the whole API surface at a glance."

- **Steal #1 — Auto-generate the map from the source of truth** (introspection), don't hand-draw it. Canvas analog: auto-derive an API/data-flow map from observed traffic or an OpenAPI doc rather than asking users to wire it.
- **Steal #2 — "Focus on this type"** to prune the graph to one node + its immediate neighbors. The essential legibility lever.
- **Anti-pattern:** **renders the *entire* schema → unreadable for large/complex schemas** (documented complaint). **Lesson: any whole-surface graph MUST default to a focused/filtered subgraph, never "draw everything."** This is the same failure as Postman Flows from the other direction.

### 10. Stripe Dashboard "Logs" / Workbench
A **timeline of every API request/response** with rich inline filters (date, status, method, endpoint, API version, error type/code, IP), recent **errors highlighted with fix suggestions**, each log links to the related API resource, and **"Edit in API Explorer" pre-fills the call so you can replay/modify it**.

- **Steal #1 — The request *log as a filterable timeline*** with status-colored rows is the most legible-at-scale pattern in this whole set. It scales because it's a list with strong faceted filters, not a graph.
- **Steal #2 — Error rows carry an inline suggested fix** + a deep link to the resource and to a pre-filled replay. For an agent canvas: a failed request the agent made → one click to "explain + retry with edits."
- **Steal #3 — "Pre-fill into the explorer"** = turn any observed request into an editable, re-runnable call. Highest-leverage idea for closing the loop between *observed* traffic and *acting* on it.
- **Failure mode (community-noted):** enabling Workbench changed/relocated the familiar Request Logs panel and surprised users — moving a debugging surface people rely on without a migration affordance costs trust. Don't relocate the debug timeline silently.

### 11. mitmproxy vs HTTP Toolkit
Both intercept live HTTP(S). **HTTP Toolkit**: per-message **highlighting & autoformat for JSON/Protobuf/Base64/HTML/XML/hex (built on Monaco)**, **filter by status/method/host/headers**, **rules** (match → edit/redirect/inject-error/breakpoint), pause-and-edit in-flight. **mitmproxy**: CLI + web + Python API; infinitely scriptable.

- **Steal #1 (HTTP Toolkit) — Faceted filtering of a live traffic list** (status/method/host/header) + autoformat-by-content-type. This is the proven "make a firehose legible" pattern: a filterable list, color-coded, with bodies pretty-printed per detected type.
- **Steal #2 (HTTP Toolkit) — Reuse Monaco for the body view** — you already vendor Monaco-class editing (file-tree research); one editor component handles JSON/XML/Base64/hex with folding + search for free.
- **Anti-pattern (mitmproxy):** maximum power, **steep learning curve** — needs networking + Python fluency. Lesson: a scriptable API is great as a *floor*, terrible as the *only* UI. Give the legible list first, the scripting hatch second.

### 12. Auto-OpenAPI-from-traffic (Optic · Akita · mitmproxy2swagger · traffic2openapi)
Observe real requests → synthesize/maintain an OpenAPI spec. Standout behaviors:
- **Akita — parameter coalescing:** collapses `/users/{uuid}` instead of emitting one endpoint per UUID; builds a **graph of all endpoints** and **flags breaking changes**.
- **Optic — idempotent + diff-aware:** run repeatedly; it *patches* the spec to match current behavior and **verifies the API still matches the doc** (catches drift).
- **mitmproxy2swagger — HAR ingest + mergeable multiple captures + `--examples`/`--headers`.**

- **Steal #1 — Parameter coalescing (Akita)** is *the* legibility trick: without it, an observed-traffic surface explodes into thousands of near-duplicate rows. Whatever Canvas ADE surfaces from live preview/agent traffic must **group by route template, not by concrete URL**.
- **Steal #2 — Idempotent, diff-aware regeneration (Optic):** re-derive the surface continuously and **show what changed** rather than a static dump. "This call's response gained a field since last run" is gold on a live canvas.
- **Failure mode:** these tools over-fragment endpoints (the very thing Akita fixes) and produce noisy specs from messy traffic; auto-derived surfaces need a human "confirm/merge" step (mitmproxy2swagger's mergeable captures) or they drift into junk.

---

## What Canvas ADE Should Steal — Shortlist

Ordered by leverage for a small, camera-scaled, agent-fed board:

1. **Never auto-pretty-print an unbounded body** (the Postman freeze). Default to **raw/streamed**; pretty-tree is an explicit click; **virtualize + lazy-expand + chunk big arrays + stream-parse**. This is the #1 correctness/perf rule — your bodies come from a live preview/agent at unknown size. Use `@uiw/react-json-view` v2 / `react-json-tree`, not the unmaintained `react-json-view`.
2. **Expand-to-depth-1/2 by default** (jless / tree-component default), never expand-all — correct for a tiny default viewport.
3. **A live *pruning* filter box (Firefox model) over the tree**, with a grammar designed to grow into JSONPath/JS-expression (fx) — substring for everyone, expression for power users. Plus jless's **"jump to next same-key value."**
4. **"Copy property path" on every node** (DevTools) → emit `data.items[3].id`, and a companion **"send this subtree to the agent as context"** (DevTools "store as global" analog). This is the unique win an *AI* canvas has — turn an inspected value into agent input.
5. **Always-pinned status/time/size meta** + **status-colored rows** (Stripe/Postman) so a board is readable even when zoomed past the body text.
6. **A filterable *traffic timeline*, not a graph, as the primary data-flow surface** (Stripe Logs + HTTP Toolkit faceted filter). Graphs (Voyager, Postman Flows) only stay legible when **defaulted to a focused subgraph** — and you already have Named Board Groups / grouped-focus to lean on. Avoid "draw the whole surface."
7. **If you ever derive an API map from live traffic: coalesce by route template (Akita), regenerate idempotently and diff-highlight changes (Optic), and require a human confirm/merge** — otherwise it fragments into thousands of per-UUID rows and rots.
8. **Reuse one Monaco-class editor for all body types** (HTTP Toolkit) — JSON/XML/Base64/hex folding + search for free; you already plan Monaco for the file tree.
9. **Pre-fill any observed request into an editable, re-runnable call** (Stripe "Edit in API Explorer") + **inline error-with-suggested-fix on failed calls** — closes the observe→act loop, which is the whole point of an agent canvas.

**Three anti-patterns to hard-avoid:** (a) synchronous full-body formatting (Postman white-screen); (b) "render the entire surface" graphs (Voyager unreadable / Flows spaghetti); (c) power-only-no-discoverability UIs (mitmproxy, jless keymap) — every affordance needs a visible, mouse-reachable entry on a board.

Sources: [Chrome DevTools Network reference](https://developer.chrome.com/docs/devtools/network/reference) · [DevTools copy property path](https://techbrij.com/chrome-developer-tools-inspect-json-path-query) · [Firefox JSON viewer](https://firefox-source-docs.mozilla.org/devtools-user/json_viewer/index.html) · [Firefox JSONPath filter request](https://connect.mozilla.org/t5/ideas/filter-using-json-path-in-json-viewer/idi-p/76213) · [Postman large-response freeze #1089](https://github.com/postmanlabs/postman-app-support/issues/1089) · [Postman crash #8288](https://github.com/postmanlabs/postman-app-support/issues/8288) · [Postman format lag #12790](https://github.com/postmanlabs/postman-app-support/issues/12790) · [jless](https://jless.io/) · [jless GitHub](https://github.com/PaulJuliusMartinez/jless) · [fx](https://fx.wtf/) · [fx GitHub](https://github.com/antonmedv/fx) · [@uiw/react-json-view](https://www.npmjs.com/package/@uiw/react-json-view) · [react-json-view](https://github.com/mac-s-g/react-json-view) · [Postman Flows feedback](https://community.postman.com/t/user-feedback-postman-flows/28121) · [GraphQL Voyager](https://github.com/APIs-guru/graphql-voyager) · [Stripe request logs](https://docs.stripe.com/development/dashboard/request-logs) · [Stripe Workbench](https://docs.stripe.com/workbench/overview) · [HTTP Toolkit](https://httptoolkit.com/) · [HTTP Toolkit vs mitmproxy (HN)](https://news.ycombinator.com/item?id=29627819) · [mitmproxy2swagger](https://github.com/alufers/mitmproxy2swagger) · [Optic generate-openapi](https://github.com/opticdev/optic/blob/main/docs/generate-openapi.md) · [Akita / traffic→OpenAPI](https://apievangelist.com/2019/12/12/automatically-generate-openapi-for-your-apis-just-by-using-them/)