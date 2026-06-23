# JD-1 — JSON viewer core (implementation spec)

> **Slice:** JD-1 of the [JD umbrella](./EPIC.md) · **maps to** REPORT §6 P0 · **Effort:** M · **Risk:** Low
> **Goal:** retire the flat-`<pre>` JSON eyesore in the Network inspector — replace it with a
> collapsible, token-faithful, Option-A-colored JSON tree. Ships standalone.
> **Design artifact (sign-off gate satisfied):** [`mock-a-json-viewer.png`](./mock-a-json-viewer.png)
> (the viewer) + [`mock-d-syntax-palettes.png`](./mock-d-syntax-palettes.png) (palette = **Option A**,
> accent-on-keys). No new pixels are invented here — build to those mocks.

## 1. What ships (and what does NOT)

**In scope (P0):** flat-row tree model · single lenient **source-string tokenizer** (NOT `JSON.parse`) ·
Option-A coloring (accent keys, neutral values, grey type badges) · default-collapse-to-depth-2 · fold/
unfold · child-count summaries on collapsed containers · size badges · **Raw⇄Tree** toggle ·
truncation/parse-fail tolerance · BOM strip · form-urlencoded → kv rows · binary/non-JSON graceful
fallback.

**Explicitly OUT (→ JD-2):** virtualization / array windowing / row cap · in-body search & highlight ·
copy property-path/value/subtree · ARIA `tree` + keymap · `shell.openExternal` on URL values · WS-frame
routing. Do **not** build these now — JD-1 must stay a small, isolated swap.

**No persisted state** → **no schema bump.** The viewer + its fold state are ephemeral React state.

## 2. Current state (the eyesore)

`src/renderer/src/lib/osrNetFormat.ts:577` — `prettyBody(body, mime, base64)` does a
`JSON.stringify(JSON.parse(body), null, 2)` round-trip behind an inline `looksJson` gate (`:579`). The
round-trip **loses fidelity** (reorders/dedupes keys, mangles big integers) and the output is a flat
wall of text.

Two render call sites, both inside `<pre className="bb-net-bodytext">`, in
`src/renderer/src/canvas/boards/osr/OsrNetworkDetail.tsx`:
- **`BodyBar`** (`:106`–`:110`) — Response tab + Request-payload tab. Wraps with a `[binary · base64]\n`
  prefix and a `\n…(truncated)` suffix.
- **`PreviewTab`** non-image branch (`:248`–`:253`) — same `<pre>`, **no** binary prefix (minor
  inconsistency JD-1 unifies).

The body contract (`OsrNetworkDetail.tsx:46`):
```ts
export interface BodyState { loading?: boolean; body?: string; base64?: boolean; truncated?: boolean; error?: string }
```
`rec.mimeType` is present for responses; **absent for request payloads** (why `detectBodyKind` must
sniff the body). `state.body` is already capped at 5 MB in MAIN (`BODY_CAP`) and `state.truncated`
marks a clipped tail. *(Line numbers drift — match on the `prettyBody(` call and the `bb-net-bodytext`
`<pre>`, not the line.)*

## 3. New module — `src/renderer/src/lib/osrJson.ts` (pure, unit-tested)

All logic lives here (the "table-math → lib" doctrine). **No React, no DOM.** This is the non-trivial
piece — a small lenient tokenizing pretty-printer, not a one-liner.

### 3.1 Detection (shared, replaces the inline gate)
```ts
export function looksJson(body: string, mime?: string): boolean
//  strip a leading BOM (﻿) first, then: mime includes "json" OR /^\s*[{[]/.test(stripped)

export type BodyKind = 'json' | 'form' | 'text' | 'binary'
export function detectBodyKind(body: string, mime?: string, base64?: boolean): BodyKind
//  base64 → 'binary'; looksJson → 'json';
//  mime includes "x-www-form-urlencoded" OR body matches /^[^=&\s]+=[^=&]*(&|$)/ → 'form';
//  else → 'text'
```
`osrNetFormat.ts` imports `looksJson` from here (one detector, BOM-aware). `prettyBody` **stays** as the
Raw-mode/last-resort fallback only.

### 3.2 The lenient tokenizer + flat-row model
A hand-written scanner walks the **source string** and emits rows **without building a JS value** — so
duplicate keys, key order, and oversized numbers survive verbatim, and a truncated body yields a partial
tree instead of throwing.

```ts
export interface JsonRow {
  id: number                 // stable, = source order
  depth: number              // indent level (0 = root)
  key?: string               // object member key, decoded for display (raw kept for copy in JD-2)
  kind: 'open' | 'scalar' | 'close'
  brace?: '{' | '[' | '}' | ']'
  valueType?: 'string' | 'number' | 'bigint' | 'bool' | 'null'
  valueText?: string         // SOURCE slice of the scalar (1e999 / 12345678901234567890 shown verbatim)
  childCount?: number        // on 'open': member/element count for the collapsed summary
  closeId?: number           // on 'open': id of the matching 'close' row (fold target)
  duplicateKey?: boolean     // this key already appeared in the same object
  truncatedHere?: boolean    // source ended inside this container/value
}

export interface JsonModel {
  rows: JsonRow[]
  kind: BodyKind
  meta: { duplicateKeys: number; bigInts: number; truncated: boolean; parseError: boolean }
}

export function buildModel(body: string, mime: string | undefined, base64?: boolean): JsonModel
//  'json' → tokenize to rows (lenient). 'form' → one 'scalar' row per key=value pair.
//  'text'/'binary' → a single synthetic 'scalar' row carrying the raw text (graceful passthrough).
```

**Big numbers:** a numeric literal whose integer part exceeds `Number.MAX_SAFE_INTEGER` (or carries
high-precision decimals) is typed `'bigint'` and its `valueText` is the **source slice** — never parsed.
**Duplicate keys:** track seen keys per object frame; second+ occurrences set `duplicateKey` (both are
kept — no dedupe). **Truncation:** when the scanner hits end-of-string mid-structure, close open frames
synthetically, set `truncatedHere` on the deepest open row and `meta.truncated`. **Parse junk:** on an
unexpected token, stop cleanly, set `meta.parseError`, keep the rows gathered so far (the Raw toggle is
the escape hatch).

### 3.3 Fold + Raw helpers
```ts
export function initialCollapsed(rows: JsonRow[], depth = 2): Set<number>
//  every 'open' row with depth >= depth starts collapsed (top two levels open)

export function visibleRows(rows: JsonRow[], collapsed: Set<number>): JsonRow[]
//  skip rows between a collapsed 'open' (exclusive) and its closeId (exclusive); the 'open' row renders
//  a summary ("{ … } 9" / "[ … ] 128"). Pure — memoize on (rows, collapsed) in the component.

export function reindent(body: string, mime?: string, base64?: boolean): string
//  Raw mode: walk the SAME tokenizer and re-emit 2-space-indented source (lossless: keeps order, dups,
//  big ints). On parseError/binary, return the original body verbatim. (prettyBody may delegate here.)
```

## 4. New component — `src/renderer/src/canvas/boards/osr/JsonView.tsx`

Presentational only; all logic from §3. **A new file by the one-file-one-purpose rule** (a tree blows
the `max-lines:700` budget on `OsrNetworkDetail.tsx`).

```ts
export function JsonView(props: {
  body: string | undefined
  mime: string | undefined
  base64?: boolean
  truncated?: boolean
}): ReactElement
```

**Render model.**
- `const model = useMemo(() => buildModel(body, mime, base64), [body, mime, base64])`.
- `const [collapsed, setCollapsed] = useState(() => initialCollapsed(model.rows))`; reset on body change.
- `const [raw, setRaw] = useState(false)`.
- Tree mode: map `visibleRows(model.rows, collapsed)` → one `<div className="bb-net-json-row">` per row,
  indent via `padding-left: depth*N`. Each row is built from **token `<span>`s** — key span, punctuation
  spans, value span, type-badge span — **never a string of HTML, never `dangerouslySetInnerHTML`.**
  Clicking an `'open'` row toggles its id in `collapsed`.
- Raw mode: a single `<pre className="bb-net-bodytext">{reindent(body, mime, base64)}</pre>`.

**Option-A coloring (the contract — see `mock-a`/`mock-d`).** Keys → `--accent`. **All** scalar values →
`--text-2` (neutral, regardless of type). Type is shown by a small **grey** badge (`string`/`number`/
`bool`/`null`) at `--text-faint`/`--text-3`, not by value color. Braces/colons/commas → `--text-faint`.
The lone exception preserved from the data-flow mocks (id/FK accent) is **not** part of JD-1 — JD-1 keys
are uniformly accent.

**Affordances (P0 minimum).**
- Collapsed container summary: `{ … }` + child count (`childCount`); a disclosure chevron that rotates.
- Size badge in the toolbar: byte size of `body` via `formatSize` + element/key count of the root.
- `Raw ⇄ Tree` segmented toggle (top-right, mirrors the mock toolbar).
- Duplicate key → a small `dup` chip on the row (`--warn` text, no fill). Big int → a `64-bit` chip.
  Truncated body → a final `…(truncated)` marker row (replaces the old suffix). Binary → a
  `[binary · base64]` label row (unifies the BodyBar/PreviewTab inconsistency).
- Empty/error states: empty body → `(empty body)` dim label; `meta.parseError` → render the rows
  gathered **plus** an inline `not valid JSON — showing raw` hint that flips to Raw. Non-JSON text →
  passthrough `<pre>` styling (graceful superset of today's behavior).

**No** virtualization — render all visible rows. Correct under the 5 MB cap + Load-body gate for typical
bodies; the 50k-row stress case is JD-2's virtualizer.

## 5. Call-site swap — `OsrNetworkDetail.tsx`

- **`BodyBar`** (`:105`–`:110`): replace the `<pre className="bb-net-bodytext">…prettyBody…</pre>` block
  with `<JsonView body={state.body} mime={rec.mimeType} base64={state.base64} truncated={state.truncated} />`.
  The binary prefix + truncated suffix now live **inside** JsonView, so drop them here.
- **`PreviewTab`** (`:248`–`:253`): keep the image branch (`:238`–`:247`) untouched; replace the
  non-image `<pre>` with the same `<JsonView … />`.
- Drop the `prettyBody` import from this file (it's no longer called here). Keep `formatSize` etc.
- Net change to this file is small (two JSX swaps + one import line) — well within `max-lines`.

## 6. CSS — `src/renderer/src/styles/boards/browser-devtools.css` (append-only)

Add a `.bb-net-json*` block **mirroring** `.bb-net-bodytext` (mono 11px, `--text-2` base, `width:100%`,
`max-height:100%`) plus the Option-A token classes. Suggested classes (match the mock):
`.bb-net-json` (scroll container), `.bb-net-json-toolbar`, `.bb-net-json-row` (flex, line-height ~1.55),
`.bb-net-json-key` (`--accent`), `.bb-net-json-punc` (`--text-faint`), `.bb-net-json-val`
(`--text-2`), `.bb-net-json-badge` (`--text-faint`, the grey type tag), `.bb-net-json-chip` (`dup`/
`64-bit`/`truncated`), `.bb-net-json-toggle` (Raw⇄Tree seg). **One accent only**; status colors for
status only. Do not rewrite any existing `.bb-net-*` class (other slices append their own block).

## 7. `osrNetFormat.ts` change

Extract the `looksJson` gate out of `prettyBody` into `osrJson.ts` (§3.1), import it back, and have
`prettyBody` delegate its JSON branch to `osrJson.reindent` (lossless) — or leave `prettyBody` intact as
the pure fallback and just re-export the shared `looksJson`. Either way: **one detector, BOM-aware**, and
`prettyBody` survives only as the Raw/last-resort path. No behavior change for non-JSON.

## 8. Security invariants (must hold)

- **No `dangerouslySetInnerHTML` / no `innerHTML`** anywhere in `JsonView`. Every key/value/URL from the
  page is rendered as React text inside a `<span>` → auto-escaped. This is asserted by a unit test on the
  rendered element tree (§9).
- **No new IPC, no new capture, no MAIN change.** JD-1 consumes the already-fetched `BodyState`.
- `contextIsolation`/`sandbox`/`nodeIntegration:false` untouched; no `eval`, no `Function`, no dynamic
  import of body content.

## 9. Test plan

**Unit (`src/renderer/src/lib/osrJson.test.ts`):**
1. duplicate keys both survive (no dedupe) and the 2nd+ is flagged `duplicateKey`.
2. key order preserved (round-trip through `reindent` keeps source order).
3. big integer `12345678901234567890` typed `'bigint'`, `valueText` equals the source (not `1.2345e19`).
4. truncated body → partial `rows` + `meta.truncated` + a `truncatedHere` row; no throw.
5. BOM-prefixed `﻿{...}` → `looksJson` true; root parses.
6. `a=1&b=2` (no mime) → `detectBodyKind` `'form'` → two kv scalar rows.
7. the four states: empty body, `parseError` junk, plain text passthrough, binary base64 label.
8. `initialCollapsed`/`visibleRows` fold math: a depth-2 container hidden by default; expanding reveals
   its children; collapsing an array hides through its `closeId`.

**Component-level (no innerHTML assert):** render `JsonView` with `<script>`-bearing string values and
assert (a) the text appears escaped and (b) the component tree contains no node with
`dangerouslySetInnerHTML`.

**Manual dev check (mandatory, CLAUDE.md):** `$env:CANVAS_DEV_TITLE='PR#NNN JD-1 json-viewer'; pnpm dev`
→ open a Browser board, hit a real API, Load body on a 200-key nested JSON response, confirm: tree folds,
keys are accent / values neutral / type badges grey, Raw⇄Tree round-trips, a big array folds in one
click. Confirm the window title before sign-off.

**e2e:** `@preview`-tagged; extend the existing Network spec to Load a JSON body and assert a folded row
toggles. Full matrix at the pre-merge gate (`pnpm test:e2e:matrix`, both legs).

## 10. Acceptance criteria (gate to "done")

> A 200-key nested JSON response renders as a collapsible, accent-keyed tree that folds a large array in
> one click, with **no `dangerouslySetInnerHTML` anywhere** in the component (asserted by the unit test on
> the rendered element tree **+** the manual dev check with the PR-stamped title). Big integers, duplicate
> keys, key order, and a truncated tail all display faithfully (asserted by §9 unit tests). Raw mode is a
> lossless re-indent of the source.

## 11. File manifest / Definition of done

- **Add:** `src/renderer/src/lib/osrJson.ts`, `src/renderer/src/lib/osrJson.test.ts`,
  `src/renderer/src/canvas/boards/osr/JsonView.tsx`.
- **Change:** `src/renderer/src/canvas/boards/osr/OsrNetworkDetail.tsx` (two JSX swaps + drop one import),
  `src/renderer/src/lib/osrNetFormat.ts` (extract/share `looksJson`; `prettyBody` → fallback),
  `src/renderer/src/styles/boards/browser-devtools.css` (append `.bb-net-json*` block).
- **DoD:** typecheck + lint + format:check + unit green; e2e matrix green both legs; manual dev check
  signed off against `mock-a`; H1/H2/H3/H4/H6/M4/M8/M9 retired; one PR `feat/jd-1-json-viewer`; the slice
  spec deleted in the merge PR (build-history line is the residue) per the doc-lifecycle policy.
