I have all three files. Here is the exhaustive audit of the current JSON-response rendering UX.

---

# Network Inspector — JSON Body Rendering UX Audit

## The current implementation (ground truth)

The entire JSON viewing experience reduces to one expression rendered into one DOM node:

- **`prettyBody`** (`osrNetFormat.ts:577`): `JSON.stringify(JSON.parse(body), null, 2)` when `base64` is false and the body looks like JSON (mime contains `json` **or** the string starts with `{`/`[`). On any parse failure it silently returns the raw string. No structure is preserved — the return type is a flat `string`.
- **Render site** (`OsrNetworkDetail.tsx` — `BodyBar` `:106`, `PreviewTab` `:249`): the formatted string is dropped, verbatim, into a single `<pre className="bb-net-bodytext">`, prefixed with `[binary · base64]\n` for binary and suffixed with `\n…(truncated)` when capped.
- **Styling** (`browser-devtools.css` — `.bb-net-bodytext` `:807`): `white-space: pre-wrap; word-break: break-all; font: 11px var(--mono); color: var(--text-2); max-height: 100%`. The scroll container is `.bb-net-dbody` (`:675`, `overflow:auto`, `padding 10px 13px`), and the whole detail pane (`.bb-net-details` `:642`) is height-capped at **40% / min 120px** of the panel.

So: one flat monochrome blob, in a short pane, wrapped with `break-all`, no structure of any kind. Everything below follows from that.

---

## HIGH impact (the core eyesore — what makes a long JSON unusable)

### H1 — Zero syntax differentiation (single color, single weight)
Every token renders in `var(--text-2)` at `mono 11px`. Keys, string values, numbers, booleans, `null`, punctuation, and brackets are visually identical. The reader has to *parse the JSON in their head* to tell a key from its value. This is the single largest legibility loss versus any real JSON viewer (Chrome DevTools, Firefox, every editor) which color-codes by type. — `.bb-net-bodytext:807`, `prettyBody:582`.

### H2 — No collapse / expand / folding
The output is a static string; there is no tree, no disclosure triangles, no per-node fold. A 400-line response forces you to scroll the entire thing to skip a single large nested array/object. There is no way to collapse `"items": [ … 2000 entries … ]` to see the sibling keys. (Contrast: the *Headers* tab uses real `<details>` disclosure — the body tab has none.) — `BodyBar:106`, `PreviewTab:249`.

### H3 — `word-break: break-all` mangles every long token
`break-all` breaks **inside** words at arbitrary character boundaries. A long URL, JWT, UUID, base64 field, hash, or signature is chopped mid-string across lines with no hyphen and no respect for token boundaries — unreadable and un-double-clickable as a unit. It also destroys the visual integrity of the 2-space indentation because a wrapped value re-flows back to the left margin, breaking the indent ladder that is the *only* structural cue present. — `.bb-net-bodytext:811`.

### H4 — The pane is tiny and the body is huge
`.bb-net-details` is **40% height, min 120px**. A pretty-printed 5 MB body (or even a few-KB one) is viewed through a ~120–200px slit with `overflow:auto`. Combined with no folding (H2), the user scrolls a giant document through a keyhole. There is no "expand body to full panel" / pop-out / maximize affordance. — `.bb-net-details:642`.

### H5 — No virtualization; the whole formatted body is one DOM `<pre>`
The entire `JSON.stringify(…, null, 2)` result — up to the **5 MB cap** (`.bb-net-hint` "capped 5 MB" `:128`) — becomes a single text node in one `<pre>`. A 5 MB body is hundreds of thousands of lines of layout/wrap work with `pre-wrap` + `break-all` (the most expensive wrapping mode). No windowing, no incremental render. Selecting a tab or re-rendering the parent re-lays-out the whole node. On a board canvas (already under OSR frame pressure) this is a real jank/freeze risk, not theoretical.

### H6 — Re-parse + re-stringify cost on every render, uncached
`prettyBody` runs `JSON.parse` then `JSON.stringify` **inside render** (`BodyBar:108`, `PreviewTab:250`) — it is not memoized. Every re-render of the detail pane (tab switch, selection, parent state change, resize) re-parses and re-serializes the full body. For a multi-MB body that is a multi-hundred-ms synchronous parse/serialize on the UI thread per render. The result is also held **twice** in memory (the raw `state.body` string *and* the pretty string), doubling the footprint of an already-5 MB-capped payload.

### H7 — Cannot search *within* a body
The panel has a powerful row filter (`applyNetFilter`, regex, `key:value` tokens), but **none of it reaches inside a body**. Once you open a response there is no find-in-body, no Ctrl-F-style match highlighting, no "jump to next match." Finding a field in a long JSON is pure manual scroll-and-eyeball. — entire `osrNetFormat.ts` filter surface is row-scoped only.

---

## MEDIUM impact (expected affordances that are absent)

### M1 — No copy-value / copy-path / copy-as
There is no "copy value," no "copy this subtree," no "copy key-path / JSONPath," no "copy as cURL." The user's only recourse is a native text drag-select over the `<pre>` — which `break-all` (H3) actively sabotages, since a selected long value spans mangled line breaks. — no copy controls anywhere in `OsrNetworkDetail.tsx`.

### M2 — No path / breadcrumb / "where am I"
Deep in a nested object the user has no indication of the current path (e.g. `data.user.profile.addresses[3].zip`). Indentation-as-text (H1/H3) is the only depth cue, and it's fragile under wrapping. No sticky key headers, no breadcrumb. — render is a flat string.

### M3 — No line numbers, gutter, or indent guides
A code/JSON viewer convention (line numbers + vertical indent guides) is entirely missing. With wrapping on, even counting lines by eye is unreliable. There's no anchor to reference a position ("the error is around line 240"). — `.bb-net-bodytext` has no gutter.

### M4 — No type badges / array & object counts
No `{8}` / `[2000]` size annotations on collapsed (or even expanded) containers, no inline length on arrays, no type chips. The reader can't gauge the size/shape of a branch without scrolling it. (This is the natural pairing with H2 folding — both are missing.)

### M5 — No nested-JSON-in-string detection
A very common API shape is a JSON string *inside* a JSON field (e.g. `"payload": "{\"a\":1}"`, escaped). The current formatter renders it as an opaque escaped one-liner — `\"a\":1` etc. — with no offer to re-parse/expand the embedded document. It's some of the hardest content to read and gets the *worst* treatment (escapes shown literally). — `prettyBody` parses only the top level.

### M6 — Non-JSON structured formats all fall back to raw
`prettyBody` only handles a single `JSON.parse`. Everything else degrades to the same flat `<pre>`:
- **NDJSON / JSON-Lines** (`{…}\n{…}\n{…}`) — fails the single `JSON.parse`, shown raw, unformatted, unfolded. Very common for streaming/log/bulk APIs.
- **SSE** (`text/event-stream`, `data: {…}` framed) — raw text; the per-event JSON is never parsed or framed.
- **GraphQL envelopes** — they *are* JSON so they pretty-print, but there's no awareness of the `{data, errors, extensions}` shape (no surfacing/erroring on the `errors` array, which is the thing you actually care about).
- **Form bodies** (`application/x-www-form-urlencoded`, multipart) — raw; not decoded into key/value like the Query String table already does for the URL.
- **XML / HTML / protobuf-text** — raw.
— `prettyBody:577`.

### M7 — Binary / base64 is a dead end
Binary bodies render as the literal label `[binary · base64]\n` + the raw base64 string (`BodyBar:107`). There's no hex view, no size, no decoded-type detection, no "save as." Raster images *are* handled (the `PreviewTab` `<img>` at `:238`) — but only in the Preview tab, and only for non-SVG raster; the Response tab shows the same image as a wall of base64.

### M8 — The "looks like JSON" heuristic is lossy at the edges
`/^\s*[{[]/` (`:579`) will *attempt* to JSON-parse anything starting with `{`/`[` regardless of content-type, and on failure silently fall through to raw with **no signal** to the user that formatting was skipped. Conversely a JSON body served with a wrong/missing content-type that *doesn't* start with `{`/`[` (rare, e.g. a top-level JSON string/number response) won't be recognized. There's no "raw ⇄ pretty" toggle and no "couldn't format" notice — the user can't tell "this is ugly because it's not JSON" from "this is ugly because formatting failed."

### M9 — Truncation is silent-ish and lossy
At the 5 MB cap the body is cut and `…(truncated)` appended (`BodyBar:109`). If the cut lands mid-token the `JSON.parse` in `prettyBody` **fails on the truncated string**, so the *entire* body silently falls back to raw/unformatted (the pretty path is all-or-nothing). So the largest bodies — the ones that most need structure — are the ones guaranteed to lose it. There's also no "load more / raw download" escape hatch beyond the cap.

---

## LOW impact (semantic richness / polish gaps)

### L1 — No value affordances
URLs aren't linkified, timestamps (epoch/ISO) aren't humanized or hover-decoded, hex/`rgb()` color strings get no swatch, durations/bytes aren't annotated. Everything is inert monospace text. — render is plain text by design.

### L2 — No response diff
Each body is viewed in isolation; there's no "compare with previous response to this URL" or "diff two selected requests." For an API you're iterating on, seeing *what changed* between two calls is high-value and entirely absent.

### L3 — No key filter / property search within the tree
Beyond find-in-body (H7), there's no "show only keys matching X" / collapse-others filter that real JSON viewers offer for wide objects.

### L4 — No pretty/raw/preview parity controls
The Headers tab has a per-section **"view source / view parsed"** toggle (`HeaderList:69`); the body has no equivalent (no raw-bytes view, no "view parsed/expanded," no word-wrap toggle). Inconsistent affordance language within the same panel.

### L5 — `font-variant-numeric` not applied to the body
Numbers in the body don't get `tabular-nums` (it's used elsewhere, e.g. `.bb-vol-pct:40`), so numeric columns/values don't align — minor, but a free legibility win that's missed.

---

## THE BIG-PICTURE GAP (this is the framing the report should lead with)

### G1 — Every body is an island; nothing aggregates the API surface
The deepest shortcoming isn't any single missing button — it's that **the inspector is per-request, per-body, view-in-isolation**. The user is exercising an *API surface* (a set of endpoints, their shapes, their relationships, how a value flows from one call into the next), but the tool only ever shows one opaque blob at a time. There is:
- no aggregated view of "all the JSON shapes I've seen on this host,"
- no schema/shape inference across repeated calls to the same endpoint,
- no data-flow linkage (this response's `id` becomes that request's path param),
- no per-endpoint history of how a body evolved.

The row table aggregates *metadata* (status/size/timing — see the rich `summaryStats`, `waterfall*`, sort/filter machinery), but the *payload semantics* — the actual data the user cares about — are never aggregated, compared, or related. That is the "whole data flow" gap the redesign should target: lift the body from a flat string-in-a-`<pre>` to a structured, foldable, searchable, **and cross-request-aware** view.

---

## Priority summary

| Rank | ID | One-line |
|---|---|---|
| **High** | H1 | No syntax coloring — keys/strings/numbers/null/bool all identical |
| **High** | H2 | No collapse/expand/fold of large arrays/objects |
| **High** | H3 | `word-break:break-all` mangles long tokens/URLs + breaks the indent ladder |
| **High** | H4 | Body shown through a ~120px/40% slit, no maximize/pop-out |
| **High** | H5 | 5 MB body = one giant `<pre>`, no virtualization |
| **High** | H6 | `JSON.parse`+`stringify` run in render, uncached, body held twice |
| **High** | H7 | Cannot search *within* a body |
| **Med** | M1 | No copy value / copy key-path (JSONPath) / copy-as |
| **Med** | M2 | No path/breadcrumb/sticky-key — "where am I" |
| **Med** | M3 | No line numbers / gutter / indent guides |
| **Med** | M4 | No type badges or array/object counts |
| **Med** | M5 | No nested-JSON-in-string detection/expansion |
| **Med** | M6 | NDJSON / SSE / GraphQL / form / XML all fall back to raw |
| **Med** | M7 | Binary/base64 is a dead-end label; no hex/save-as |
| **Med** | M8 | Lossy "looks like JSON" heuristic; no pretty⇄raw toggle, no "couldn't format" notice |
| **Med** | M9 | Truncated 5 MB bodies fail to parse → silently lose ALL formatting |
| **Low** | L1 | No URL/timestamp/color/value affordances |
| **Low** | L2 | No diff vs another response |
| **Low** | L3 | No key filter / collapse-others |
| **Low** | L4 | No body-level raw/parsed/wrap toggles (Headers tab has them, body doesn't) |
| **Low** | L5 | Body numbers don't use `tabular-nums` |
| **Big-picture** | G1 | Bodies viewed in isolation; nothing aggregates/relates the API surface (the "whole data flow" gap) |

**Relevant files:**
- `Z:/Canvas ADE/.worktrees/json-dataflow-viz/src/renderer/src/lib/osrNetFormat.ts` — `prettyBody` (line 577) is the entire formatting layer; the rich filter/sort/waterfall machinery above it is all row-metadata-scoped, never body-scoped.
- `Z:/Canvas ADE/.worktrees/json-dataflow-viz/src/renderer/src/canvas/boards/osr/OsrNetworkDetail.tsx` — `BodyBar` (line 92/106), `PreviewTab` (line 226/249), `HttpDetail` (line 285); the `<pre className="bb-net-bodytext">` render sites and the (better) `HeaderList` `<details>`/source-toggle pattern the body lacks.
- `Z:/Canvas ADE/.worktrees/json-dataflow-viz/src/renderer/src/styles/boards/browser-devtools.css` — `.bb-net-bodytext` (line 807), `.bb-net-dbody` (line 675), `.bb-net-details` (line 642, the 40%/120px cap).