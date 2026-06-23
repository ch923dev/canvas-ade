I have comprehensive reference material. Let me synthesize into the structured catalog. I have enough data across all six topic areas with concrete numbers (virtual-json-viewer's load benchmarks, the 100/10k/100k DOM thresholds, jless's FlatJson architecture, react18-json-view's prop model, the WAI-ARIA keyboard contract, and the BigInt precision details).

---

# JSON Response Optimization & Visualization — Technique Catalog

Synthesized for a **vendored, dependency-light React component** (Canvas ADE house style: no `react-json-view`, no heavy tree libs). Each technique below: **what it solves → implementation sketch → perf/effort → recommendation**. Recommendations are tiered **MUST-HAVE** (ship in v1), **NICE-TO-HAVE** (v2), **OPTIONAL** (only if the use-case demands it).

## How the reference tools actually work (the load-bearing insight)

The single most important architectural decision — confirmed by **jless** (Rust, terminal), **virtual-json-viewer** (browser ext), and Firefox's tree component — is:

> **Flatten the JSON tree into a single linear array of "rows", then render only a virtualized window of that array. Do NOT recurse into nested React components.**

jless's `flatjson.rs` builds a `Vec<Row>` where every node (and every container's close-bracket) is one entry carrying `{depth, parent, prev_sibling, next_sibling, index_in_parent, key_range, value, collapsed, close_index/open_index}`. Collapse/expand never deletes rows — it flips a `collapsed` flag, and `next_visible_row()` *jumps past* a collapsed container via its `close_index`. virtual-json-viewer does the identical thing in the DOM with `react-window`. **This flat-array-of-rows model is the spine of every recommendation below** — adopt it first, everything else hangs off it.

---

## 1. Collapsible tree rendering

| Technique | What it solves | Implementation sketch | Perf / Effort | Recommend |
|---|---|---|---|---|
| **Flat-row model + visible-row derivation** | The whole rendering architecture; makes collapse O(1) and virtualization trivial | Pre-walk the parsed value once into `rows: {id, depth, keyOrIndex, kind, value, parentId, childCount, closeId}[]`. Maintain a `Set<id>` of collapsed container ids. `visibleRows` = filter that skips any row whose ancestor is collapsed (use `closeId` to skip the whole span in one jump, like jless). | Walk is O(n) once. Effort: **M** (this is the core) | **MUST** |
| **Collapse/expand single node** | Basic interaction | Toggle id in the collapsed `Set`; recompute `visibleRows` (memoized on `[rows, collapsedSet]`). Never re-parse. | O(visible) recompute. **S** | **MUST** |
| **Collapse-all / Expand-all** | Taming a big payload instantly | Collapse-all = put every container id in the set (or: keep only root). Expand-all = clear set. Guard expand-all behind a node-count check (warn/confirm above ~5k). | O(n). **S** | **MUST** |
| **Default-collapse by depth threshold** | First paint of a deep/large doc shouldn't explode | On parse, seed the collapsed set with every container at `depth > defaultExpandDepth` (react18-json-view does this via `collapsed={2}`; default 1–2 levels). Also auto-collapse any container whose `childCount > N` (react18-json-view's `collapseObjectsAfterLength=99`). | O(n) at parse. **S** | **MUST** |
| **Child counts / size badges** | Orientation without expanding (`{…} 12 keys`, `[…] 480 items`) | Store `childCount` on each container row; render as a dim badge next to the collapsed glyph. react18-json-view = `displaySize`. | Free (computed in walk). **S** | **MUST** |
| **Array windowing — "show N more"** | A 50k-element array must not emit 50k rows | When materializing an array's child rows, emit only the first `window` (e.g. 100) + a synthetic `"▸ 49,900 more"` row that, when clicked, raises the window (chunk by +100/+1000). react18-json-view = "split large array"; jless collapses by default. | Caps rows hard. **M** | **MUST** |
| **Sticky path breadcrumb** | "Where am I" in a deeply scrolled tree | On scroll, find the first visible row, walk its `parentId` chain to build `root.users[3].address.city`, render pinned at the top of the viewport. fx shows the current path at the bottom. | Cheap (parent-walk on scroll, throttled). **M** | **NICE** |
| **Inline preview of collapsed value** | See content without expanding | For a collapsed container, render a truncated one-line preview (`{ name: "Ada", age: 36, … }`) built from the first few children. | Build lazily/memoized per collapsed node. **M** | **NICE** |

---

## 2. Large-payload performance

**Where naive rendering breaks (concrete thresholds):**
- **< ~1,000 visible DOM rows:** naive full render is fine. No virtualization needed.
- **~1,000–5,000 rows:** noticeable jank on expand/scroll; memoization helps but you're on borrowed time.
- **~10,000+ rows:** mounting/painting takes seconds. virtual-json-viewer benchmarks: **10MB/~1,000 objects ≈ 450ms; 100MB/~10,000 objects ≈ 4,000ms** *without* virtualization. General React figure: **100k naive DOM nodes ≈ 3–8s to mount.** With virtualization, the live DOM holds **only ~10–50 rows regardless of total**, and response time drops to milliseconds.
- **Rule of thumb (from the React virtualization literature): any list > ~100 items is a virtualization candidate; > ~1,000 it's mandatory.**

| Technique | What it solves | Implementation sketch | Perf / Effort | Recommend |
|---|---|---|---|---|
| **Row virtualization (windowing)** | The headline scalability win | Render `visibleRows` through a fixed-height windowing layer. **Dependency-light path:** vendor a ~80-line windower (measure container height, `startIdx = floor(scrollTop/rowH)`, render `start…start+visibleCount+overscan`, pad with a top/bottom spacer div) — no `react-window` needed if rows are uniform height. Uniform row height is the enabling constraint; design rows as single-line. | DOM stays ~constant. **M–L** (the windower is the main custom code) | **MUST** |
| **Single-line uniform rows** | Enables cheap virtualization (no row-height measurement) | One JSON token per row, ellipsize long strings, never wrap. Multi-line values become "expand to view". | Unlocks fixed `rowHeight`. **S** | **MUST** |
| **Cap / lazy materialization** | Avoid building 1M row objects up front | Don't flatten collapsed subtrees until expanded (lazy flatten on first expand), OR flatten eagerly but cap arrays via windowing (§1). For pathological payloads, hard-cap total materialized rows (e.g. 200k) with a "result truncated" banner. | Bounds memory. **M** | **MUST** |
| **Memoization** | Stop re-rendering unchanged rows | `React.memo` each `Row` keyed by `id`; memoize `visibleRows` on `[rows, collapsedSet, arrayWindows]`; keep the collapsed set in a ref/store so toggling one node doesn't re-render all. | Big constant-factor win. **S** | **MUST** |
| **Worker / incremental parsing** | A 50MB string blocks the main thread on `JSON.parse` + flatten | Move parse **and the flatten walk** into a Web Worker; post back the flat `rows` array (transfer where possible). Show a spinner/progress for >~5MB. Electron renderer: a `Worker` or a hidden utility process. | Keeps UI responsive on huge payloads. **L** | **NICE** (gate on payload size) |
| **Streaming / NDJSON** | Log-style or line-delimited responses; show data before the stream ends | Detect NDJSON (multiple top-level values / newline-separated). Parse line-by-line, appending rows incrementally as a synthetic top-level array (fx + virtual-json-viewer both special-case JSON Lines). Pairs naturally with virtualization (append to the row array). | Incremental render. **M–L** | **OPTIONAL** (only if you expect streams) |
| **Avoid giant single DOM nodes** | One 2MB string value = one monster text node = layout death | Always truncate value display (`collapseStringsAfterLength`, default ~100 chars) with "show more"/copy-full. Never inject a megabyte string into the DOM. | Prevents single-node blowups. **S** | **MUST** |

---

## 3. Syntax + semantics

| Technique | What it solves | Implementation sketch | Perf / Effort | Recommend |
|---|---|---|---|---|
| **Type coloring** | Scannability | CSS custom props per type (react18-json-view: `--json-string/-number/-property/-boolean/-null`). One accent for strings/keys, distinct hues for number/bool/null. Map to Canvas ADE's token palette (single blue accent + neutrals; keep it calm, no rainbow). | Pure CSS. **S** | **MUST** |
| **Type badges** | Disambiguate at a glance for non-obvious values | Small dim badge for container kind + count; optionally `int`/`float`/`bigint` micro-badges where it matters. Don't over-badge primitives. | **S** | **NICE** |
| **Big-number / BigInt precision safety** | `JSON.parse` silently corrupts integers > 2^53 (`9007199254740993` → `…992`); reviver can't fix it (runs *after* the lossy parse) | **Don't rely on `JSON.parse` for display fidelity.** Either (a) vendor a tiny tokenizing parser that keeps each number as its **source string** (the lossless-json / `LosslessNumber` approach — hold the raw text, only coerce to Number for non-critical math), or (b) flag any integer-literal with > 15–16 significant digits as "may be imprecise" and display the **raw source substring** rather than the round-tripped value. Display from source text, never from a re-stringified Number. | Tokenizer is the real work; flag-only is cheap. **M** (tokenizer) / **S** (flag) | **MUST** (at least the flag+raw-display; full lossless tokenizer is **NICE**) |
| **Nested-JSON-in-string detection** | APIs that embed JSON as an escaped string (`"{\"a\":1}"`) | If a string value `trim()`s to start with `{`/`[` and `JSON.parse` succeeds, show a "parse as JSON ⤵" affordance that renders the parsed value as an inline subtree (lazily, on click). Guard with length cap + try/catch. | Lazy parse on demand. **M** | **NICE** |
| **Clickable URLs** | Navigate out of the payload | Regex-detect `https?://…` string values (react18-json-view `matchesURL`); render as a link → in Electron, route through `shell.openExternal` (never in-app nav — matches the security contract). | **S** | **MUST** |
| **Timestamp humanization** | `1718000000` / ISO strings are unreadable | Heuristic: 10-digit (s) or 13-digit (ms) integer, or ISO-8601 string → show humanized form (`2024-06-10 · 3 days ago`) as a dim suffix/tooltip; keep raw value primary. Ambiguity (is `1700000000` a timestamp or just a number?) → only annotate, never replace, and gate on a key-name hint (`*_at`, `time`, `ts`). | Date math is cheap. **M** | **NICE** |
| **Color swatches** | Visual feedback for color values | If a string matches `#rgb/#rrggbb/rgb()`, render a small swatch chip before it. | **S** | **OPTIONAL** |
| **Image / base64 thumbnails** | Inline preview of `data:image/*;base64,…` or image URLs | Detect `data:image/` or image-extension URLs → small lazy `<img>` thumbnail on hover/click (cap size, lazy-load). | Lazy-load to avoid fetch storms. **M** | **OPTIONAL** |
| **Key sorting** | Find a key in a 200-key object | Toggle: original order ↔ alphabetical. Sort the *child-row ordering* in the flatten step, not the data, so it's reversible and non-destructive. | **S** | **NICE** |

---

## 4. Navigation / extraction

| Technique | What it solves | Implementation sketch | Perf / Effort | Recommend |
|---|---|---|---|---|
| **In-body search + highlight + next/prev** | Find a value/key in a large payload | Search over the flat `rows` (keys + stringified values), collect matching row ids into an ordered `matches[]`, highlight substrings, and **scroll the virtualizer to** match `n` on next/prev (`Ctrl/Cmd+G`, like virtual-json-viewer). Show "3 / 41". Critical detail: a match inside a **collapsed** subtree must auto-expand its ancestors before scrolling to it. | Search is O(n) over flat array. **M** | **MUST** |
| **Filter-to-matching-keys** | Hide everything that doesn't match | Beyond highlight: a "filter" toggle that hides any subtree with **zero** matching descendants (virtual-json-viewer "completely hide subtrees without a match"). Computed by marking matches then propagating "has-match" up the parent chain. | One up-propagation pass. **M** | **NICE** |
| **Key-path display + copy** | Get a pointer to a value for code/JSONPath | Each row knows its path (parent-walk). Render on hover/select; **copy buttons** for both dot-path (`data.users[3].name`) and JSONPath (`$.data.users[3].name`). | **S** | **MUST** |
| **Copy value / copy subtree** | Extract data | Copy-value = the raw scalar/source text; copy-subtree = `JSON.stringify` of that node's reconstructed value (or slice the source range, jless-style, to preserve big-number fidelity). react18-json-view `enableClipboard`. | **S** | **MUST** |
| **Fold-by-path** | Programmatic collapse/expand of a known path | Resolve a path → row id → toggle. Backs "collapse this whole branch" and deep-linking to a node. | **S** | **NICE** |

---

## 5. Modes + query + diff

| Technique | What it solves | Implementation sketch | Perf / Effort | Recommend |
|---|---|---|---|---|
| **Pretty-tree mode** | The default explorable view | Everything above. | — | **MUST** |
| **Raw mode** | Copy-the-whole-thing, regex-eyeball, see source-of-truth (incl. exact big numbers) | Show pretty-printed source text (re-indent from the original string, not a re-`stringify`, to keep number fidelity). Add prettify/minify toggle (virtual-json-viewer). For huge payloads, virtualize the raw text by lines too. | **S–M** | **MUST** |
| **Preview / compact mode** | Skim shape without values | Render keys + types + counts, values collapsed/elided. (Effectively "default-collapse to depth 1 + size badges".) | Reuses §1. **S** | **NICE** |
| **Query affordance (JSONPath / jq-like)** | Slice/transform without leaving the tool | Two tiers: (a) **JSONPath-lite** — vendor a tiny evaluator for `$.a.b[0]`, `[*]`, `..key` and feed the result back into the same tree. (b) **jq-like** — fx uses plain JS expressions (no DSL to learn); virtual-json-viewer compiles **jq → WASM** (`jq-wasm`) but warns CSP can block WASM. For Canvas ADE's sandbox, prefer JSONPath-lite or a guarded JS-expression evaluator over shipping a WASM jq. | JSONPath-lite **M**; jq-WASM **L** + CSP risk | **NICE** (JSONPath-lite) / **OPTIONAL** (jq) |
| **Diff of two responses** | "What changed between request A and B" | Recursively diff two parsed values → per-path status `added/removed/changed/unchanged`; render in the same tree with green/red/amber row tints and an "only-changes" filter. Reuse the flatten + path machinery; diff is the new layer. | Recursive diff is O(n); rendering reuses everything. **M–L** | **NICE** (high value for a dev tool) |

---

## 6. Accessibility + keyboard nav

**This is where the flat-row + virtualization model needs care:** virtualization means most `treeitem`s aren't in the DOM, so use **`aria-activedescendant` focus management** (single tabindex on the tree container, point `aria-activedescendant` at the focused row's id) rather than roving tabindex — roving tabindex breaks when the focused node scrolls out of the window and unmounts.

| Technique | What it solves | Implementation sketch | Perf / Effort | Recommend |
|---|---|---|---|---|
| **ARIA tree roles** | Screen-reader semantics | Container `role="tree"` + `aria-label`; each row `role="treeitem"` with `aria-level` (= depth+1), `aria-expanded` (`true/false` on containers **only**), `aria-selected`, and `aria-setsize`/`aria-posinset` (required since rows are virtualized/"dynamically loaded"). | **M** | **MUST** |
| **Arrow-key tree navigation** (WAI-ARIA contract) | Native-app-style keyboard nav | **Right:** closed node → open (no focus move); open node → focus first child. **Left:** open node → close; leaf/closed → focus parent. **Down/Up:** move to next/prev *visible* row (no expand). **Home/End:** first / last visible row. **Enter/Space:** activate/select (containers: toggle). **`*`:** expand all siblings. **Typeahead:** focus next row whose key matches typed chars. Operate over `visibleRows` indices; scroll the virtualizer to keep the active row in view. | **M** (the keymap is the work) | **MUST** |
| **`aria-activedescendant` focus model** | Keeps focus valid under virtualization | Tree container `tabIndex=0`; track `activeRowId`; set `aria-activedescendant={activeRowId}`; ensure the active row is rendered (force it into the window even at edges) and `id`'d. | **M** | **MUST** |
| **Visible focus ring + screen-reader value text** | Non-mouse usability | Strong focus outline on the active row; give each treeitem an accessible name like `key: value, 12 items, collapsed`. | **S** | **MUST** |

---

## Recommended build order (dependency-light, vendored)

1. **Core (MUST):** flat-row model → default-collapse-by-depth + size badges → single-line rows → **custom uniform-height virtualizer** → memoized `Row` + `visibleRows`. This alone clears the 10k-node wall.
2. **Semantics (MUST):** type coloring (Canvas tokens), URL→`shell.openExternal`, **big-number raw-source display** (flag ≥16 digits; full lossless tokenizer later), array windowing "show N more", truncate long strings.
3. **Nav/extraction (MUST):** in-body search + highlight + next/prev (auto-expand ancestors) + key-path/copy/copy-subtree.
4. **A11y (MUST):** `role=tree/treeitem`, WAI-ARIA arrow keymap, `aria-activedescendant`.
5. **Modes (MUST→NICE):** Raw mode (source-preserving) → Preview mode.
6. **V2 (NICE):** sticky breadcrumb, filter-to-matching-keys, nested-JSON-in-string, timestamp humanization, key sorting, **diff**, JSONPath-lite query, worker parsing (gate on size), NDJSON.

**Dependencies to vendor vs. avoid:** vendor the **virtualizer** (~80 lines, the only non-trivial custom piece — uniform row height makes `react-window` unnecessary) and a **JSONPath-lite** evaluator. Avoid `react-json-view`/`@uiw/react-json-view` (heavy, recursive-render, no big-number safety) and `jq-wasm` (WASM + CSP friction in the Electron sandbox). The one library worth *reading for technique* (MIT) is **react18-json-view** — its prop model (`collapsed` depth, `collapseStringsAfterLength`, `collapseObjectsAfterLength`, `matchesURL`, `displaySize`) is a ready-made config surface to mirror. For big-number handling, mirror **lossless-json**'s "hold the number as source text" approach rather than depending on it.

---

## Sources

- [jless — GitHub](https://github.com/PaulJuliusMartinez/jless) and [jless.io](https://jless.io/) — FlatJson/`Vec<Row>` flat-array architecture, collapse-via-flag, regex search, data/line modes.
- [react18-json-view — npm](https://www.npmjs.com/package/react18-json-view) / [GitHub](https://github.com/YYsuni/react18-json-view) — `collapsed` depth, `collapseStringsAfterLength`, `collapseObjectsAfterLength`, `matchesURL`, `displaySize`, type-color CSS vars, split-large-array.
- [virtual-json-viewer — GitHub](https://github.com/paolosimone/virtual-json-viewer) — `react-window` virtual DOM, search highlight + Ctrl+G next/prev + subtree-hide filter, jq-WASM filtering, tree/raw/JSON-Lines modes, **load benchmarks (1MB≈150ms, 10MB≈450ms, 100MB≈4s)**.
- [react-json-view-lite — GitHub](https://github.com/AnyRoad/react-json-view-lite) and [@uiw/react-json-view comparison](https://npm-compare.com/react-json-tree,react-json-view) — zero-dependency lightweight tree baselines.
- [Firefox DevTools Tree Component — Bugzilla 1247065](https://bugzilla.mozilla.org/show_bug.cgi?id=1247065) and [JSON Viewer modernization — Bugzilla 1418250](https://bugzilla.mozilla.org/show_bug.cgi?id=1418250) — generic virtualized React tree, sync/async data, virtual viewport.
- [fx — fx.wtf](https://fx.wtf/) / [GitHub](https://github.com/antonmedv/fx) — fuzzy path search (`@`), regex search, current-path display, JS-expression query (vs jq DSL), NDJSON/streaming.
- [WAI-ARIA APG Tree View Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/) and [MDN treeitem role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/treeitem_role) — arrow-key contract, `aria-expanded/level/setsize/posinset`, roving-tabindex vs `aria-activedescendant`.
- [lossless-json — GitHub](https://github.com/josdejong/lossless-json) and [Why JSON.parse corrupts large numbers](https://jsoneditoronline.org/indepth/parse/why-does-json-parse-corrupt-large-numbers/) — `>2^53` precision loss, reviver-runs-too-late, hold-number-as-string (`LosslessNumber`) strategy.
- [Virtualization in React — handling 100k rows](https://hoangtrungdigital.com/en/blog/virtualization-in-react-technique-for-handling-100000-rows-without-lag) and [Rendering 100k JSON nodes in React](https://medium.com/@vothanhdat/how-i-rendered-100-000-json-nodes-in-react-without-crashing-the-browser-64fbcfd94f10) — naive 100k DOM ≈ 3–8s, virtualized DOM stays ~10–50 nodes, >100 items = virtualize candidate / >1,000 mandatory.