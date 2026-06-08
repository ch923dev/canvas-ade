# Text creation & editing UX — design spec

**Date:** 2026-06-08 · **Branch:** `feat/text-create-edit-ux` · **Slice:** Planning Spec #1b
(follow-up to the text-font-toolbar slice, PR #87).

## Goal

Make the Planning free-text element discoverable and shapeable. Three changes, one slice:

1. **Toolbar-on-edit** — the typography toolbar appears the moment you create or click into a
   text element, not only after selecting its 6px grip.
2. **Text tool in the header** — a dedicated `T` tool in the board toolbar (double-click stays as
   the quick default).
3. **Hybrid drag-to-create** — dragging the `T` tool makes an *area text* box: the drag **width**
   sets the wrap width, the drag **height** snaps the font to S/M/L/XL. A click (no drag) makes
   *point text* at default M.

These were chosen interactively (brainstorm 2026-06-08): toolbar **on edit OR select**; drag =
**hybrid width+size**; lands as a **new slice after #87** (schema v7 → v8).

## Dependency & merge order

- **Builds on #87's v7** (the typography tokens + `TextToolbar` + `textStyle.ts`). This branch is
  cut off `main` for a clean base; **rebase onto `main` after #87 merges**, then implement against
  the v7 baseline. (Branching off `main` rather than off `feat/text-font-toolbar` avoids
  squash-merge ancestry drift — see memory `verifying-squash-merged-branch-deletion`.)
- **Takes schema v8.** The Diagram/visual-spec work (PR #72) also eyed v8 → first-to-land rule
  (ADR 0004 pattern): this slice claims **v8**, Diagram rebases to **v9**.

## Components

### A · Toolbar-on-edit

- `PlanningBoard.tsx` tracks an ephemeral `editingTextId: string | null` (React state, **never**
  serialized — scene/session split). Set when a `FreeText` textarea gains focus, cleared on blur.
- The toolbar render gate widens: `const toolbarTextEl = selectedTextEl ?? editingTextEl` where
  `editingTextEl` resolves `editingTextId` against `viewElements` (kind `text`, single). Render
  `TextToolbar` for `toolbarTextEl`.
- `FreeText.tsx` gains an `onEditingChange?(id, editing)` callback fired from `onFocus`/`onBlur`
  (alongside the existing `onEditStart`).
- **Empty-prune guard (critical):** clicking a toolbar button blurs the textarea, and the existing
  `onBlur` prunes an empty text element (`FreeText.tsx:173`). The toolbar must **keep focus**: its
  buttons already `stopPropagation` on pointerdown — add `onMouseDown={e => e.preventDefault()}` on
  the toolbar root so the textarea never blurs when a control is pressed. This preserves the
  empty-prune for real click-aways while letting you restyle a freshly-created (still empty) text.

### B · Text tool in the header

- Add `'text'` to `PlanTool` (`planning/tools.ts`) and to the `TOOLS` array in `PlanningBoard.tsx`
  (`{ tool: 'text', icon: 'text' }`).
- Add a `text` glyph to the board icon set (the `icon` union + the renderer that maps
  `'select' | 'note' | … ` to an SVG/char). Glyph: a `T`.
- **No keyboard shortcut in v1** — `t` is already Tidy at the canvas level; a non-clashing key can
  be added in a later pass. The tool is reachable via the header button only.
- Selecting the tool arms text placement; the well cursor becomes `text`.

### C · Hybrid drag-to-create (well gesture)

Implemented in `usePlanningPointer.ts` as a new draft gesture, peer to `draftArrow` / `draftStroke`
/ `marqueeRect`:

- **pointerdown** on the bare well while `tool === 'text'` → record `p0 = toBoard(e)`, start
  `draftTextBox = { x0,y0,x1,y1 }`.
- **pointermove** → update `draftTextBox`; render a dashed preview rect (new `<TextBoxDraft>` or
  reuse the marquee visual) with a scaled letter `A` whose size = `tokenFromHeight(height)` so the
  user previews the size live.
- **pointerup**:
  - **click** (`|dx| < 4 && |dy| < 4`, screen px): `makeText(newId(), p0)` → point text, no width,
    default size. Auto-focus (existing mount focus).
  - **drag**: `makeText` at the rect's top-left with `width = max(MIN_W, |dx|)` (board px) and
    `fontSize = tokenFromHeight(|dy|)`. Auto-focus.
- After commit, `setTool('select')` (one-shot, matching the canvas drag-to-create board redesign,
  PR #75). The plan may revisit sticky-vs-one-shot; **default one-shot**.
- **Double-click** (`onWellDoubleClick`) is unchanged — still drops point text M in select mode.

`tokenFromHeight(boardPx): FontSizeToken` lives in `textStyle.ts` (leaf-pure, unit-tested):

| drag height (board px) | token | px |
|---|---|---|
| `< 24` | `S` | 11 |
| `< 40` | `M` | 13 |
| `< 70` | `L` | 18 |
| `>= 70` | `XL` | 26 |

Thresholds are the initial tuning; pinned by a unit test so a change is deliberate.

### D · Schema v8 — wrap width

- `TextElement` gains optional `width?: number` (board px, the wrap-box width). **Absent ⇒ point
  text** (today's auto-size behavior, byte-identical).
- Validator (`assertPlanningElement` / `boardSchema.ts`): if present, `width` must be a finite
  positive number; clamp to a sane range (e.g. `[MIN_W, 4096]`). Reject NaN/Infinity/≤0 — same
  closed-validation discipline as the v7 tokens (an imported/agent-written `canvas.json` can't
  inject a bad width).
- `MIGRATIONS`: add identity `7 → 8` (all-optional, no backfill — existing texts have no `width`).
  `SCHEMA_VERSION = 8`.
- `projectStore.ts` MAIN mirror `SCHEMA_VERSION → 8` (lock-step; covered by the existing mirror
  test).

### E · FreeText render modes

- `element.width` **set** → the container + textarea take `width: element.width`, the textarea uses
  `white-space: pre-wrap` (wraps at the box), and `textAlign` (L/C/R, already a v7 token) becomes
  meaningful within the box.
- `element.width` **absent** → today's auto-size path (`white-space: pre`, auto width/height via
  the `scrollWidth` measure effect).
- `onMeasure` still reports the rendered box for the selection/snap bbox; for area text the width
  is fixed and the height grows with wrapped lines.
- The `onMeasure` re-measure effect deps gain `element.width` (a width change re-wraps → re-measure).

## Data flow

```
T tool armed ──▶ well pointerdown ──▶ draftTextBox (dashed preview, live size letter)
                                   └▶ pointerup
                                        ├─ click ─▶ makeText(p0)            (point, M, no width)
                                        └─ drag  ─▶ makeText(tl, {width, fontSize})  (area)
                                                     │
                              new element mounts ──▶ FreeText auto-focus ──▶ onEditingChange(id,true)
                                                     │                         │
                                              PlanningBoard editingTextId ◀────┘
                                                     │
                                              TextToolbar renders (edit OR select)
                                                     │
                              click a control ─▶ preventDefault keeps focus ─▶ onTextPatch (v7 path)
```

## Edge cases / error handling

- **Empty text + toolbar click** → `preventDefault` keeps focus, no prune (A above).
- **Empty area-text left untouched** → blur prune fires as today (still empty + not dragging).
- **Drag that ends as a near-zero box** → treated as a click (point text), never a 0-width box.
- **`width` below `MIN_W`** → clamped at creation and at load (validator).
- **Loading a v7 doc** → migrate to v8 identity; all texts render as point text (unchanged).
- **A width that exceeds the board** → allowed (text can overflow the well as any element can); not
  clamped to board width in v1.

## Testing

- **Unit:** `tokenFromHeight` threshold table; `makeText` carries `width`/`fontSize` when given and
  omits `width` for point text; `boardSchema` v8 migrate (7→8 identity, pipeline-ends-at-8 with
  groups+typography preserved) + validator (good width passes, NaN/≤0/Infinity rejected);
  `projectStore` mirror = 8; toolbar render-gate shows for an editing-but-unselected text.
- **Integration (jsdom):** FreeText wrap mode applies `width` + `pre-wrap`; toolbar button click
  does not blur/prune an empty text (preventDefault path).
- **E2e (real OS input):** `T` tool → drag a box → area text persists `width` + the height-mapped
  `fontSize`, wraps; `T` tool → click → point text (no width); start typing a fresh text → toolbar
  is visible before any grip-select.

## Out of scope (v1)

- Wrap-box **resize handle** (re-wrap an existing area text by dragging its edge) — natural
  follow-up, deferred (YAGNI).
- **Free numeric** font size (keep the closed S/M/L/XL token set).
- Per-span rich text; notes/checklist typography.

## Files touched

`planning/tools.ts` (PlanTool) · `PlanningBoard.tsx` (TOOLS, editingTextId, toolbar gate) ·
`usePlanningPointer.ts` (text gesture + draftTextBox) · `FreeText.tsx` (wrap mode,
onEditingChange) · `TextToolbar.tsx` (preventDefault root) · `planning/textStyle.ts`
(`tokenFromHeight`) · `lib/boardSchema.ts` (v8, `width`, validator, migration) · `main/projectStore.ts`
(mirror) · board icon set (`text` glyph) · tests for each.
