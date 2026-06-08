# Text Font Toolbar — Design Spec

**Date:** 2026-06-07 · **Branch:** `feat/text-font-toolbar` · **Status:** design (pre-plan)
**Slice:** #1 of the planning-board improvement effort (Spec #2 = Mermaid diagram element, separate).
**Research input:** `docs/research/2026-06-06-planning-board-deep-dive.md` (items #13, font portion of the text/diagram ask).

---

## 1. Goal

Select a single free **`text`** element on a Planning board → a small **floating toolbar** appears above it →
set **font family · size · alignment · color · bold**. The toolbar hides on deselect. Nothing else changes.

This is the literal "add font settings of the text" ask, scoped to the one element that is pure text. It is
the first feature to **reverse the locked "Tweaks panel cut" decision** (CLAUDE.md › Locked decisions; ADR
0001 AVOID list) — narrowly, via a new ADR (§9), not as a general properties panel.

### Non-goals (explicit — do NOT build here)
- Opacity slider, z-order / layers, actions row (dup/delete/link) — the mockup bundled these; all cut.
  Duplicate/delete already exist in the element context menu; z-order is roadmap #14 (needs its own v-bump);
  link is roadmap #12 (anchored connectors).
- Note / checklist font controls — notes keep their fixed sticky-card typography (uniformity is the point;
  FigJam/Excalidraw do the same). Only `TextElement` gains fields.
- Handwriting / marker webfont — Sans·Mono·Serif only, all already available (zero new asset).
- Per-span rich text (bold/italic runs inside one block, TipTap/contenteditable) — whole-element styling only.
- A multi-color "rainbow" palette (red/orange/green/…) — breaks the single-accent lock (§4 color).
- Mermaid / diagrams — Spec #2.

---

## 2. Current state (grounded)

| Fact | Location |
|---|---|
| `SCHEMA_VERSION = 5` | `src/renderer/src/lib/boardSchema.ts:21` |
| `TextElement = { kind:'text'; text:string }` extends `ElementCommon {id,x,y,locked?,groupId?}` | `boardSchema.ts:63-85` |
| Migration pipeline = ordered one-liner steps, `4: (doc)=>({...doc,schemaVersion:5,connectors})` | `boardSchema.ts:290-301` |
| `assertPlanningElement` text branch only checks `text` is a string | `boardSchema.ts:397-399` |
| `makeText(id,at) = {id,kind:'text',x,y,text:''}` | `planning/elements.ts:66-68` |
| Text bbox = live DOM `measured` (from `FreeText.onMeasure`) refines `TEXT_NOMINAL {w:120,h:22}` | `elements.ts:259,290-293` |
| `FreeText` textarea hardcodes `color:var(--text)`, `fontFamily:var(--ui)`, `fontSize:13`, `lineHeight:'18px'` | `FreeText.tsx:178-191` |
| Single commit path: `patchElement` → `updateBoard(id,{elements})`; `PATCHABLE_KEYS.planning` includes `elements` | `elements.ts:134-140`; `canvasStore.ts` |
| Export `textBlock(x,y,raw,size,fill,weight)` hardcodes `FONT` (system sans) + left x-anchor; text branch passes `size 13, EXPORT_COLORS.text` | `whiteboardExport.ts:37,51-64,136-140` |
| **No foreground color palette exists** — strokes/arrows hardcode `var(--border-strong)`/`var(--text-2)` | `WhiteboardSvg.tsx:120,147` |

**Consequence — bbox reflow is already handled.** `FreeText` reports rendered size via `onMeasure` (DOM
`offsetWidth/Height`), and `elementBBox` prefers that measured size. A larger font ⇒ the textarea grows ⇒
`onMeasure` fires ⇒ marquee/snap/align pick up the new box automatically. **No geometry code changes.** The
`TEXT_NOMINAL` fallback stays fixed (only used when no DOM measurement exists, e.g. export — see §6).

---

## 3. Data model — schema v6

`TextElement` gains **five optional, token-valued** fields. Optional ⇒ existing v5 text validates unchanged
and renders with defaults; the migration is an identity bump.

```ts
export type FontFamilyToken = 'sans' | 'mono' | 'serif'   // default 'sans'
export type FontSizeToken   = 'S' | 'M' | 'L' | 'XL'      // default 'M'  (= today's 13px)
export type TextAlignToken  = 'left' | 'center' | 'right' // default 'left'
export type TextColorToken  = 'default' | 'muted' | 'faint' | 'accent' // default 'default'

export interface TextElement extends ElementCommon {
  kind: 'text'
  text: string
  fontFamily?: FontFamilyToken
  fontSize?: FontSizeToken
  align?: TextAlignToken
  color?: TextColorToken
  bold?: boolean
}
```

**Why tokens, not raw px/hex/CSS:** constrained set (no free-text px), themeable, export-portable, and a
closed union the validator + toolbar both enumerate. Raw values would re-open the drift problem and let an
imported/agent-written doc inject arbitrary CSS.

### Migration (v5 → v6)
```ts
// boardSchema.ts MIGRATIONS
5: (doc) => ({ ...doc, schemaVersion: 6 }),   // identity: new fields optional, defaulted at render
```
Bump `SCHEMA_VERSION = 6`. No per-element transform — absent fields default in the renderer/export.

### Validation
Extend the `assertPlanningElement` `case 'text'` branch (`boardSchema.ts:397`):
```ts
case 'text':
  if (typeof el.text !== 'string') fail('text element is missing string text')
  if (el.fontFamily !== undefined && !FONT_FAMILY_TOKENS.includes(el.fontFamily)) fail('text element bad fontFamily')
  if (el.fontSize  !== undefined && !FONT_SIZE_TOKENS.includes(el.fontSize))   fail('text element bad fontSize')
  if (el.align     !== undefined && !TEXT_ALIGN_TOKENS.includes(el.align))     fail('text element bad align')
  if (el.color     !== undefined && !TEXT_COLOR_TOKENS.includes(el.color))     fail('text element bad color')
  if (el.bold      !== undefined && typeof el.bold !== 'boolean')              fail('text element bad bold')
  return
```
Token arrays imported from `textStyle.ts` (§5) so model + validator share one source.

### v6 ownership (resolves research #13)
**This slice claims v6.** The triple-contested next bump (draw.io D2, file-editor board, PR #72 Diagram) all
wrote stale numbers from v2–v4. Mermaid (Spec #2) takes **v7**. Coordination action: update those four docs'
bump numbers to rebase off **6**. (Tracked in the implementation plan, not a code change here.)

---

## 4. Token → presentation

A single new module **`planning/textStyle.ts`** owns every token mapping, for BOTH the live board (CSS
custom props) and the SVG export (literal values). This is the anti-drift discipline the research flagged for
R7 (`exportColors.ts` duplicating `tints.ts` with only a "keep in step" comment) — here a **parity test**
asserts the two representations agree, so they cannot silently diverge.

```ts
// textStyle.ts — single source of truth
export const FONT_FAMILY_TOKENS = ['sans','mono','serif'] as const
export const FONT_SIZE_TOKENS   = ['S','M','L','XL'] as const
export const TEXT_ALIGN_TOKENS  = ['left','center','right'] as const
export const TEXT_COLOR_TOKENS  = ['default','muted','faint','accent'] as const

// live (CSS) family stack ↔ export (literal, portable generic) family stack
export const FAMILY_CSS    = { sans:'var(--ui)',        mono:'var(--term-mono)',  serif:'var(--serif)' }
export const FAMILY_EXPORT = { sans:'system-ui, -apple-system, Segoe UI, sans-serif',
                               mono:'Cascadia Mono, Consolas, ui-monospace, monospace',
                               serif:'Georgia, "Times New Roman", serif' }

export const SIZE_PX = { S:11, M:13, L:18, XL:26 }          // M = today's 13 (no visual change for existing text)
export const lineHeightFor = (px:number) => Math.round(px * 1.38)

// neutral ramp + the one accent — NO rainbow (single-accent lock, §9)
export const COLOR_CSS    = { default:'var(--text)', muted:'var(--text-2)', faint:'var(--text-3)', accent:'var(--accent)' }
export const COLOR_EXPORT = { default:'#ededee',     muted:'#9b9ba1',       faint:'#6a6a70',        accent:'#4f8cff' }   // mirror EXPORT_COLORS

export const WEIGHT = { normal:400, bold:700 }
```

**Color decision (correction to the approved design):** the mockup showed a 6-swatch red/green/blue/orange
"Stroke" row, but (a) no foreground color palette exists today and (b) a multi-hue palette violates the locked
"one accent (blue `#4f8cff`), functional only" rule. The toolbar therefore offers the **neutral text ramp +
the single accent** (`default · muted · faint · accent`). A genuine multi-color palette would be a *second*
aesthetic reversal — flagged for the user in the review gate; default is the lock-honoring ramp.

**Serif token:** `--serif` is added to `index.css` (e.g. `Georgia, "Times New Roman", serif`) so the live
side uses a token like the others; export uses the literal generic stack (portable, no embedding needed since
sans/mono/serif are CSS generic families).

---

## 5. Components

| Unit | New? | Purpose |
|---|---|---|
| `planning/textStyle.ts` | **new** | §4 token tables + maps + parity-tested. No React/DOM. |
| `planning/TextToolbar.tsx` | **new** | Floating toolbar. Renders only for a single selected `text` element. Family (3) · size (4) · align (3) · bold toggle · color (4) buttons. Emits `onPatch(partial)`. |
| `FreeText.tsx` | edit | Replace the 4 hardcoded style values with `textStyle` lookups off the element's tokens (defaults applied for absent fields). Add `textAlign`. |
| `PlanningBoard.tsx` | edit | When the selection is exactly one `text` element, render `<TextToolbar>` anchored above it; wire `onPatch` → `updateBoard(boardId,{elements: patchElement(els,id, el=>({...el,...partial}))})`. |
| `whiteboardExport.ts` | edit | `textBlock` gains `family` + `anchor` params; text branch resolves tokens → `FAMILY_EXPORT/SIZE_PX/WEIGHT/COLOR_EXPORT` + align (text-anchor + x). |
| `boardSchema.ts` | edit | v6 fields, migration, validation (§3). |
| `index.css` | edit | add `--serif` token. |

**Toolbar placement (v1):** render in the board's content coordinate space (sibling to the `FreeText`
cards), positioned at the element's top-left minus the toolbar height. It therefore **scales with board
zoom**, exactly like the cards — no separate camera-sync machinery (that exists only for native preview
views). Screen-constant sizing is a possible later refinement, noted but not built.

**Toolbar interaction:** each button is a discrete patch. Family/align/color/size = set the token; bold =
toggle the boolean. No text-entry, no drag, no new pointer state machine.

---

## 6. Data flow & invariants

```
select text el ──▶ PlanningBoard sees single text in selection ──▶ <TextToolbar element=el onPatch=…/>
click "L" ──▶ onPatch({fontSize:'L'}) ──▶ updateBoard(boardId,{elements: patchElement(els,id, e=>({...e,fontSize:'L'}))})
            ──▶ lazy beginChange ⇒ ONE undo step ──▶ FreeText re-renders larger ──▶ onMeasure ⇒ bbox reflows
```

- **Scene/session split** — toolbar visibility, position, and selection are ephemeral React state; they are
  NEVER added to `PATCHABLE_KEYS` or routed into `elements[]`. Only the five new persisted token fields touch
  the serialized model (via the existing `elements` key — no new patch key).
- **Undo invariants** — each toolbar action goes through the existing `patchElement → updateBoard` commit, so
  the lazy `beginChange` checkpoints once = one undo step per click. No new gesture, so no risk of the phantom
  step / 5-way-duplicated checkpoint class (research R5).
- **Sandbox** — pure JS + HTML overlay; no node/native; renderer-only.
- **Export fidelity** — center/right alignment in SVG uses `TEXT_NOMINAL.w` (no DOM at export time), so
  non-left alignment is approximate — consistent with the existing "nominal sizes, close enough for a one-shot
  deliverable" caveat (`whiteboardExport.ts:8-10`). Left-aligned (the default) is exact.
- **Backward compat** — a v5 doc migrates to v6 with no field changes; absent tokens default to
  `sans/M/left/default/false`, which render **byte-identical** to today (M=13px, var(--ui), var(--text),
  left). Existing boards look unchanged.

---

## 7. Testing

| Test | Asserts |
|---|---|
| `elements.test.ts` | `makeText` has no font fields (renders defaults); `patchElement` sets each field immutably. |
| `boardSchema.test.ts` | v5→v6 `migrate` bumps + leaves text elements untouched; `assertPlanningElement` accepts valid tokens, rejects `fontSize:'XXL'` / `bold:'yes'` / `color:'#fff'` / `fontFamily:'comic'`; `toObject`/`fromObject` round-trip preserves fields. |
| `textStyle.test.ts` (new) | token unions complete; **live↔export parity** — every `COLOR_CSS` token maps to the matching `COLOR_EXPORT` literal that equals `EXPORT_COLORS.*` (kills R7-style drift by construction). |
| `whiteboardExport.test.ts` | text branch honors family/size/weight/align/color; a text element with NO fields exports identically to the current baseline (regression). |
| e2e (`text-toolbar.e2e.ts`, new) | seed a text element → select → toolbar appears; click L → measured bbox grows; click bold/align/color → DOM reflects; deselect → toolbar hides; one undo reverts one change. (Use real `sendInputEvent` for the click per the transform-hit-test lesson.) |

Gate: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`, then `pnpm test:e2e:matrix`. Sequential
merge to `main` after green.

---

## 8. Files touched (summary)

```
src/renderer/src/lib/boardSchema.ts                          (v6 fields, migration, validation)
src/renderer/src/canvas/boards/planning/textStyle.ts         (NEW — token tables + maps)
src/renderer/src/canvas/boards/planning/TextToolbar.tsx      (NEW — floating toolbar)
src/renderer/src/canvas/boards/planning/FreeText.tsx         (apply tokens)
src/renderer/src/canvas/boards/planning/PlanningBoard.tsx    (render+wire toolbar)
src/renderer/src/canvas/boards/planning/whiteboardExport.ts  (export honors tokens)
src/renderer/src/index.css                                   (--serif token)
docs/decisions/0004-text-font-controls.md                    (NEW — ADR, §9)
+ the 4 unit/integration test files + 1 e2e spec above
```

---

## 9. ADR 0004 — text font controls (to author with the implementation)

`docs/decisions/0004-text-font-controls.md` records the decision to **narrowly reverse** the locked "Tweaks
panel cut entirely" line and the ADR 0001 AVOID entry "Font/size/align props panel":

- **Scope of reversal:** a floating, contextual font toolbar for the **`text` element only** — family (3),
  size (4 presets), alignment, bold, and color drawn from the **neutral ramp + single accent** (no rainbow).
- **What stays cut:** a general/persistent properties panel; per-element opacity; arbitrary fonts; rich text;
  multi-hue color. The single-accent aesthetic is preserved.
- **Rationale:** developer usefulness (the explicit product ask) at minimal aesthetic cost; tokenized + closed
  so it cannot drift into a full Tweaks panel.

---

## 10. Out of scope → next slices

- **Spec #2 — Mermaid diagram element** (v7): hidden-BrowserWindow worker render, `securityLevel:'strict'`,
  themed dark, merges PR #72 + draw.io D2. Separate brainstorm.
- Roadmap #12 anchored connectors, #14 z-order/resize, #9 element registry — independent, later.
</content>
</invoke>
