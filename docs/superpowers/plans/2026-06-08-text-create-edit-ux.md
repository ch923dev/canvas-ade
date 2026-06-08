# Text creation & editing UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Planning free-text discoverable and shapeable — toolbar appears on edit (not just grip-select), a header `T` tool, and a hybrid drag-to-create where drag width = wrap-box width and drag height = font-size token.

**Architecture:** Extends the v7 typography slice (#87). Adds an optional `width` to `TextElement` (schema v8) for an area-text wrap mode, a pure `tokenFromHeight` size mapper, a new `text` well-gesture in `usePlanningPointer` (peer to arrow/pen/marquee drafts), and widens the `TextToolbar` render gate to include the element being edited.

**Tech Stack:** TypeScript · React 18 · Zustand · React Flow · Vitest (unit/integration, jsdom) · Playwright `_electron` (e2e).

---

## ⚠️ Pre-flight (do once, before Task 1)

This branch (`feat/text-create-edit-ux`) was cut off `main` for a clean base. It **does not yet
contain #87's v7 code** (`textStyle.ts`, `TextToolbar.tsx`, the v7 fields on `TextElement`). Before
implementing:

- [ ] Confirm **PR #87 has merged to `main`**, then `git fetch origin && git rebase origin/main`.
      The plan's file references assume the post-#87 v7 baseline (`SCHEMA_VERSION === 7`,
      `TextElement.fontSize?` etc.). If #87 is not yet merged, **stop** — implementing on a pre-v7
      tree will not compile.
- [ ] `pnpm install` is NOT needed (worktree junctions main's `node_modules`). Run `pnpm typecheck`
      once to confirm a green starting tree.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/renderer/src/lib/boardSchema.ts` | schema, migration, validation | `width?` on `TextElement`; v7→v8; validator |
| `src/main/projectStore.ts` | MAIN schema mirror | `SCHEMA_VERSION = 8` |
| `src/renderer/src/canvas/boards/planning/textStyle.ts` | token↔presentation | add `tokenFromHeight` |
| `src/renderer/src/canvas/boards/planning/elements.ts` | element factories | `makeText` opts |
| `src/renderer/src/canvas/boards/planning/tools.ts` | tool set | add `text` to `PlanTool` |
| `src/renderer/src/canvas/boards/PlanningBoard.tsx` | board chrome + render | `TOOLS` row, `editingTextId`, toolbar gate, draft preview |
| `src/renderer/src/canvas/boards/planning/usePlanningPointer.ts` | well gestures | `textbox` draft gesture |
| `src/renderer/src/canvas/boards/planning/FreeText.tsx` | text element view | wrap mode + `onEditingChange` |
| `src/renderer/src/canvas/boards/planning/TextToolbar.tsx` | typography bar | `preventDefault` keep-focus |
| `docs/decisions/0004-text-font-controls.md` | ADR | note v8 + area text |

---

## Task 1: Schema v8 — `TextElement.width` + migration + validator

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts` (type ~97, MIGRATIONS ~328, `SCHEMA_VERSION` 36, validator ~442)
- Modify: `src/main/projectStore.ts:23`
- Test: `src/renderer/src/lib/boardSchema.test.ts`, `src/main/projectStore.test.ts`

- [ ] **Step 1: Write failing migration + validator tests**

In `src/renderer/src/lib/boardSchema.ts`'s test file (find the existing `migrate`/`assertPlanningElement` describe blocks; add these cases):

```ts
it('migrates v7 → v8 as an identity bump (text without width passes through)', () => {
  const v7 = { schemaVersion: 7, viewport: null, boards: [], connectors: [], groups: [] }
  expect(migrate(v7 as never).schemaVersion).toBe(8)
})

it('a v7 text element with no width survives migration to v8 unchanged (point text)', () => {
  const doc = {
    schemaVersion: 7, viewport: null, connectors: [], groups: [],
    boards: [{ id: 'p', type: 'planning', x: 0, y: 0, w: 400, h: 300,
      data: { elements: [{ id: 't', kind: 'text', x: 1, y: 2, text: 'hi' }] } }]
  }
  const out = migrate(doc as never)
  expect(out.schemaVersion).toBe(8)
  expect((out.boards[0] as never as { data: { elements: unknown[] } }).data.elements[0])
    .toEqual({ id: 't', kind: 'text', x: 1, y: 2, text: 'hi' })
})

it('accepts a text element with a positive width', () => {
  expect(() => assertCanvasDoc({
    schemaVersion: 8, viewport: null, connectors: [], groups: [],
    boards: [{ id: 'p', type: 'planning', x: 0, y: 0, w: 400, h: 300,
      data: { elements: [{ id: 't', kind: 'text', x: 0, y: 0, text: 'a', width: 200 }] } }]
  })).not.toThrow()
})

it('rejects a text element with a non-positive / non-finite width', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => assertCanvasDoc({
      schemaVersion: 8, viewport: null, connectors: [], groups: [],
      boards: [{ id: 'p', type: 'planning', x: 0, y: 0, w: 400, h: 300,
        data: { elements: [{ id: 't', kind: 'text', x: 0, y: 0, text: 'a', width: bad }] } }]
    })).toThrow(/width/)
  }
})
```

> NOTE: match the exact validator entry point used elsewhere in `boardSchema.test.ts` — it may be
> `assertCanvasDoc`, `parseCanvas`, or a direct `assertPlanningElement`. Mirror the file's existing
> calls; the structure above shows intent.

- [ ] **Step 2: Run the tests — verify they fail**

Run: `pnpm exec vitest run src/renderer/src/lib/boardSchema.test.ts -t "v8"`
Expected: FAIL — `migrate` still tops out at 7; `width` validator absent.

- [ ] **Step 3: Add the `width` field**

`boardSchema.ts`, in `interface TextElement` (after `bold?`):

```ts
export interface TextElement extends ElementCommon {
  kind: 'text'
  text: string
  fontFamily?: FontFamilyToken
  fontSize?: FontSizeToken
  align?: TextAlignToken
  color?: TextColorToken
  bold?: boolean
  /** v8: area-text wrap-box width (board px). Absent ⇒ point text (auto-size). */
  width?: number
}
```

- [ ] **Step 4: Bump version + add the migration**

`boardSchema.ts` line 36 and the doc-comment block (~31-35) and `MIGRATIONS`:

```ts
export const SCHEMA_VERSION = 8
```

In `MIGRATIONS`, after the `6:` entry:

```ts
  // v7: free-text typography tokens (all optional → identity bump; defaulted at render).
  6: (doc) => ({ ...doc, schemaVersion: 7 }),
  // v8: optional TextElement.width (area-text wrap box). All-optional → identity bump;
  // an existing text with no width renders as point text, byte-identical.
  7: (doc) => ({ ...doc, schemaVersion: 8 })
```

- [ ] **Step 5: Add the validator branch**

`boardSchema.ts`, in `assertPlanningElement` `case 'text':` (after the `bold` check, before `return`):

```ts
      if (el.width !== undefined && !isPositiveNum(el.width))
        fail(`text element has non-positive width ${String(el.width)}`)
      return
```

- [ ] **Step 6: Bump the MAIN mirror**

`src/main/projectStore.ts`: change `const SCHEMA_VERSION = 7` → `= 8`, and update the two
`(7)` comments on lines 17/19/134 to `(8)`.

- [ ] **Step 7: Update the projectStore mirror test**

`src/main/projectStore.test.ts`: change the three `7` assertions (lines ~60, 66, 71 and the
comments) to `8`:

```ts
expect(r.doc).toEqual({ schemaVersion: 8, viewport: null, boards: [], connectors: [] })
// ...
expect(onDisk.schemaVersion).toBe(8)
```

- [ ] **Step 8: Run the suites — verify green**

Run: `pnpm exec vitest run src/renderer/src/lib/boardSchema.test.ts src/main/projectStore.test.ts`
Expected: PASS (all, incl. the new v8 cases).

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/main/projectStore.ts src/renderer/src/lib/boardSchema.test.ts src/main/projectStore.test.ts
git commit -F - <<'EOF'
feat(schema): v8 — optional TextElement.width for area text

Identity 7->8 migration (existing texts have no width = point text,
byte-identical). Validator rejects non-positive/non-finite width.
MAIN projectStore mirror -> 8.
EOF
```

---

## Task 2: `tokenFromHeight` size mapper

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/textStyle.ts` (after `SIZE_PX`/`lineHeightFor`)
- Test: `src/renderer/src/canvas/boards/planning/textStyle.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `textStyle.test.ts` (import `tokenFromHeight` alongside the existing imports):

```ts
describe('tokenFromHeight', () => {
  it('maps drag height (board px) to the nearest size token', () => {
    expect(tokenFromHeight(0)).toBe('S')
    expect(tokenFromHeight(23)).toBe('S')
    expect(tokenFromHeight(24)).toBe('M')
    expect(tokenFromHeight(39)).toBe('M')
    expect(tokenFromHeight(40)).toBe('L')
    expect(tokenFromHeight(69)).toBe('L')
    expect(tokenFromHeight(70)).toBe('XL')
    expect(tokenFromHeight(9999)).toBe('XL')
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/textStyle.test.ts -t tokenFromHeight`
Expected: FAIL — `tokenFromHeight is not a function`.

- [ ] **Step 3: Implement**

`textStyle.ts`, after `lineHeightFor`:

```ts
/**
 * Map an area-text drag HEIGHT (board px) to the nearest size token. Thresholds chosen
 * so a small box reads as body text and a tall box as a heading. Pinned by a unit test —
 * a change to the bands is deliberate. < 24 → S · < 40 → M · < 70 → L · ≥ 70 → XL.
 */
export function tokenFromHeight(boardPx: number): FontSizeToken {
  if (boardPx < 24) return 'S'
  if (boardPx < 40) return 'M'
  if (boardPx < 70) return 'L'
  return 'XL'
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/textStyle.test.ts -t tokenFromHeight`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/textStyle.ts src/renderer/src/canvas/boards/planning/textStyle.test.ts
git commit -m "feat(planning): tokenFromHeight — drag height to S/M/L/XL"
```

---

## Task 3: `makeText` carries width + fontSize

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/elements.ts:66`
- Test: `src/renderer/src/canvas/boards/planning/elements.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `elements.test.ts` (import `makeText`):

```ts
describe('makeText', () => {
  it('makes point text (no width) by default', () => {
    const t = makeText('t', { x: 10.4, y: 20.6 })
    expect(t).toEqual({ id: 't', kind: 'text', x: 10, y: 21, text: '' })
    expect('width' in t).toBe(false)
  })
  it('carries width + fontSize for area text', () => {
    const t = makeText('t', { x: 0, y: 0 }, { width: 200, fontSize: 'XL' })
    expect(t.width).toBe(200)
    expect(t.fontSize).toBe('XL')
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/elements.test.ts -t makeText`
Expected: FAIL — `makeText` takes 2 args; `width`/`fontSize` undefined.

- [ ] **Step 3: Implement**

`elements.ts`, replace `makeText`:

```ts
import type { FontSizeToken } from './textStyle'
// ... (add the import next to the other textStyle imports if not present)

/** A new free-text element anchored at the drop point. `opts.width` ⇒ area text (wrap box). */
export function makeText(
  id: string,
  at: { x: number; y: number },
  opts?: { width?: number; fontSize?: FontSizeToken }
): TextElement {
  const base: TextElement = { id, kind: 'text', x: Math.round(at.x), y: Math.round(at.y), text: '' }
  if (opts?.fontSize) base.fontSize = opts.fontSize
  if (opts?.width !== undefined) base.width = Math.round(opts.width)
  return base
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/elements.test.ts -t makeText`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/elements.ts src/renderer/src/canvas/boards/planning/elements.test.ts
git commit -m "feat(planning): makeText accepts area-text width + fontSize"
```

---

## Task 4: `text` PlanTool + header tool button

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/tools.ts:12`
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx` (`TOOLS` 76-86)
- Test: `src/renderer/src/canvas/boards/planning/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tools.test.ts`:

```ts
it('text is a valid PlanTool but has no bare-letter shortcut (t = canvas Tidy)', () => {
  const tool: PlanTool = 'text'
  expect(tool).toBe('text')
  expect(shortcutTool('t', { ctrl: false, meta: false, alt: false })).toBeNull()
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/tools.test.ts -t "text is a valid"`
Expected: FAIL — `'text'` not assignable to `PlanTool`.

- [ ] **Step 3: Add `text` to the tool type**

`tools.ts:12`:

```ts
export type PlanTool = 'select' | 'note' | 'text' | 'check' | 'arrow' | 'pen' | 'erase'
```

(Leave `SHORTCUTS` unchanged — no key for `text` in v1.)

- [ ] **Step 4: Add the toolbar button**

`PlanningBoard.tsx`, the `TOOLS` array type union (line 78) gains `'text'`, and the array gains a row:

```ts
const TOOLS: ReadonlyArray<{
  tool: PlanTool
  icon: 'select' | 'note' | 'text' | 'check' | 'arrow' | 'pen' | 'erase'
}> = [
  { tool: 'select', icon: 'select' },
  { tool: 'note', icon: 'note' },
  { tool: 'text', icon: 'text' },
  { tool: 'check', icon: 'check' },
  { tool: 'arrow', icon: 'arrow' },
  { tool: 'pen', icon: 'pen' },
  { tool: 'erase', icon: 'erase' }
]
```

(`IconName` already includes `'text'` with a T glyph — `Icon.tsx:21,69` — no icon work needed.)

- [ ] **Step 5: Run — verify it passes + typecheck**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/tools.test.ts && pnpm typecheck:web`
Expected: PASS + clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/tools.ts src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/canvas/boards/planning/tools.test.ts
git commit -m "feat(planning): add Text tool to the board toolbar"
```

---

## Task 5: Hybrid drag-to-create gesture

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/usePlanningPointer.ts` (drag union 117-123, down 176-240, move 242-297, up 354-440, API type 60-80, return 461+)
- Test: covered by the e2e in Task 9 (the gesture is real-input; pure parts are Tasks 2-3).

- [ ] **Step 1: Add the `textbox` draft state + drag mode**

Near the other draft state (after `marqueeRect` useState ~127):

```ts
  const [draftTextBox, setDraftTextBox] = useState<{
    x: number; y: number; w: number; h: number
  } | null>(null)
```

Extend the `drag` ref union (117-123) with:

```ts
    | { mode: 'textbox'; startX: number; startY: number; sx: number; sy: number }
```

(`startX/startY` = board-local origin; `sx/sy` = screen-px origin, for the click-vs-drag test.)

Add a constant near the top of the hook body:

```ts
  const MIN_TEXT_W = 40 // floor for an area-text wrap width (mirrors FreeText's min)
```

- [ ] **Step 2: Handle `text` tool on pointer-down**

In `onWellPointerDown`, after the `erase` block (before the trailing comment at line 236):

```ts
      if (tool === 'text') {
        drag.current = { mode: 'textbox', startX: p.x, startY: p.y, sx: e.clientX, sy: e.clientY }
        setDraftTextBox({ x: p.x, y: p.y, w: 0, h: 0 })
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
```

- [ ] **Step 3: Track the box on move**

In `onWellPointerMove`, add a branch (after the `marquee` branch ~293):

```ts
      } else if (d.mode === 'textbox') {
        setDraftTextBox(rectFromPoints(d.startX, d.startY, p.x, p.y))
```

- [ ] **Step 4: Commit on pointer-up (click = point text, drag = area text)**

In `onWellPointerUp`, add a branch (after the `marquee` branch ~428). Import `makeText` and
`tokenFromHeight` at the top of the file if not already imported:

```ts
    } else if (d.mode === 'textbox') {
      const box = draftTextBox
      setDraftTextBox(null)
      beginChange()
      const movedScreen =
        box && (Math.abs(box.w) > 4 || Math.abs(box.h) > 4) // board px ~ screen at z≈1; 4px floor
      if (movedScreen && box) {
        // Area text: top-left anchor, width → wrap, height → size token.
        const el = makeText(newId(), { x: box.x, y: box.y }, {
          width: Math.max(MIN_TEXT_W, box.w),
          fontSize: tokenFromHeight(box.h)
        })
        commit([...elements, el])
        setSelectedIds(new Set([el.id]))
      } else {
        // Click (no drag): point text at the press origin, default size.
        commit([...elements, makeText(newId(), { x: d.startX, y: d.startY })])
      }
      setTool('select')
    }
```

Add `draftTextBox` and `setSelectedIds`/`setTool` to the `onWellPointerUp` dependency array
(`setSelectedIds`, `setTool` are already deps; add `draftTextBox`).

- [ ] **Step 5: Cancel cleanup**

In `onWellPointerCancel`, clear the draft (mirror the marquee clear ~455):

```ts
    setDraftTextBox(null)
```

- [ ] **Step 6: Expose `draftTextBox` on the API**

Add to the `PlanningPointerApi` interface (near `marqueeRect` ~74):

```ts
  draftTextBox: { x: number; y: number; w: number; h: number } | null
```

and to the returned object (near `marqueeRect` ~472):

```ts
    draftTextBox,
```

- [ ] **Step 7: Verify it compiles**

Run: `pnpm typecheck:web`
Expected: clean (no unused, no type errors). Behavior is exercised by the e2e in Task 9.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/usePlanningPointer.ts
git commit -m "feat(planning): text-tool drag gesture — click=point, drag=area text"
```

---

## Task 6: Draft-box preview in the board

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx` (destructure ~579-589; render near the toolbar ~919)

- [ ] **Step 1: Pull `draftTextBox` from the hook**

In the `usePlanningPointer({...})` destructure (~579-589), add `draftTextBox` alongside `marqueeRect`.

- [ ] **Step 2: Render the dashed preview + live letter**

In the board content layer (sibling to `<TextToolbar>`, near line 919), add:

```tsx
{draftTextBox && (
  <div
    aria-hidden
    style={{
      position: 'absolute',
      left: draftTextBox.x,
      top: draftTextBox.y,
      width: Math.max(1, draftTextBox.w),
      height: Math.max(1, draftTextBox.h),
      border: '1.5px dashed var(--accent)',
      borderRadius: 4,
      background: 'rgba(79,140,255,0.06)',
      display: 'grid',
      placeItems: 'center',
      pointerEvents: 'none',
      fontFamily: 'var(--serif)',
      color: 'rgba(79,140,255,0.85)',
      fontWeight: 700,
      lineHeight: 1,
      fontSize: SIZE_PX[tokenFromHeight(draftTextBox.h)]
    }}
  >
    A
  </div>
)}
```

Add `SIZE_PX` and `tokenFromHeight` to the existing `./planning/textStyle` import in PlanningBoard.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck:web && pnpm lint`
Expected: clean (0 errors).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "feat(planning): live drag-box preview for the text tool"
```

---

## Task 7: FreeText wrap mode + `onEditingChange`

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/FreeText.tsx`
- Test: `src/renderer/src/canvas/boards/planning/FreeText.integration.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `FreeText.integration.test.tsx`:

```ts
it('area text (width set) applies a fixed width + wraps', () => {
  const el = { id: 'a', kind: 'text', x: 0, y: 0, text: 'wrap me', width: 180 } as unknown as TextElement
  render(<FreeText element={el} interactive onDragStart={() => {}} onChangeText={() => {}} onDelete={() => {}} />)
  const ta = screen.getByPlaceholderText('Text…') as HTMLTextAreaElement
  expect(ta.style.width).toBe('180px')
  expect(ta.style.whiteSpace).toBe('pre-wrap')
})

it('fires onEditingChange(true) on focus and (false) on blur', () => {
  const onEditingChange = vi.fn()
  const el = { id: 'a', kind: 'text', x: 0, y: 0, text: 'x' } as unknown as TextElement
  render(<FreeText element={el} interactive onDragStart={() => {}} onChangeText={() => {}}
    onDelete={() => {}} onEditingChange={onEditingChange} />)
  const ta = screen.getByPlaceholderText('Text…')
  fireEvent.focus(ta)
  expect(onEditingChange).toHaveBeenCalledWith('a', true)
  fireEvent.blur(ta)
  expect(onEditingChange).toHaveBeenCalledWith('a', false)
})
```

- [ ] **Step 2: Run — verify they fail**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/FreeText.integration.test.tsx -t "area text|onEditingChange"`
Expected: FAIL — `width` not applied; `onEditingChange` not a prop.

- [ ] **Step 3: Add the `onEditingChange` prop**

`FreeText.tsx`, in `FreeTextProps` (after `onEditStart?`):

```ts
  /** Fired with (id, editing) when the textarea gains/loses focus — drives the toolbar-on-edit gate. */
  onEditingChange?: (id: string, editing: boolean) => void
```

Destructure it in the component signature, then wire focus/blur:

```ts
        onFocus={() => {
          onEditStart?.()
          onEditingChange?.(element.id, true)
        }}
        onBlur={() => {
          onEditingChange?.(element.id, false)
          if (!dragging.current && element.text.trim() === '') onDelete(element.id)
        }}
```

- [ ] **Step 4: Apply wrap mode when `width` is set**

`FreeText.tsx`: compute a wrap flag and apply it. After the existing token reads (`const weight = …`):

```ts
  const wrap = element.width !== undefined
```

In the auto-size `useEffect` (the `el.style.width = …` block, ~50-53), skip the width auto-grow when
wrapping:

```ts
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (!wrap) {
      el.style.width = 'auto'
      el.style.width = `${Math.max(40, el.scrollWidth)}px`
    }
```

Add `element.width` and `wrap` to that effect's dependency array.

On the `<textarea>` style object, override `whiteSpace`/`width` for wrap mode:

```ts
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          width: wrap ? element.width : undefined,
```

(Replace the existing `whiteSpace: 'pre'` line; add the `width` line.)

- [ ] **Step 5: Run — verify they pass**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/FreeText.integration.test.tsx`
Expected: PASS (new + existing).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/FreeText.tsx src/renderer/src/canvas/boards/planning/FreeText.integration.test.tsx
git commit -m "feat(planning): FreeText wrap mode + onEditingChange"
```

---

## Task 8: Toolbar-on-edit gate + keep-focus guard

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx` (state, FreeText wiring ~870-881, gate ~734-738 / 919-925)
- Modify: `src/renderer/src/canvas/boards/planning/TextToolbar.tsx` (root element ~70)
- Test: `src/renderer/src/canvas/boards/planning/TextToolbar.test.tsx`

- [ ] **Step 1: Write the failing keep-focus test**

Add to `TextToolbar.test.tsx` (it already renders `TextToolbar`; reuse its `el()` helper):

```ts
it('a pointer-down on the toolbar is prevented so the textarea keeps focus (no empty-prune)', () => {
  const r = render(<TextToolbar element={el({})} boardW={9999} onPatch={() => {}} />)
  const bar = r.container.querySelector('.pl-text-toolbar') as HTMLElement
  const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  bar.dispatchEvent(ev)
  expect(ev.defaultPrevented).toBe(true)
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/TextToolbar.test.tsx -t "keeps focus"`
Expected: FAIL — no `onMouseDown` preventDefault on the root.

- [ ] **Step 3: Add `preventDefault` on the toolbar root**

`TextToolbar.tsx`, on the root `<div className="pl-text-toolbar">` (~70-74), add:

```tsx
      // Keep the edited textarea focused when a control is pressed: mousedown default
      // would blur it → the empty-text prune (FreeText.onBlur) could delete a fresh,
      // still-empty element mid-style. preventDefault holds focus; click still fires.
      onMouseDown={(e) => e.preventDefault()}
```

(Keep the existing `onPointerDown` stopPropagation.)

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/TextToolbar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the editing state + widen the gate in PlanningBoard**

`PlanningBoard.tsx`: add state (near the other `useState`s, ~117):

```ts
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
```

Wire it onto both `<FreeText>` instances (the render at ~870 and any duplicate) — add the prop:

```tsx
                onEditingChange={(id, editing) =>
                  setEditingTextId((cur) => (editing ? id : cur === id ? null : cur))
                }
```

Widen the toolbar element derivation (the `selectedTextEl` block, ~734-738). After `selectedTextEl`:

```ts
  const editingTextEl =
    editingTextId && interactive
      ? (viewElements.find((e) => e.id === editingTextId && e.kind === 'text') ?? null)
      : null
  const toolbarTextEl = selectedTextEl ?? (editingTextEl as typeof selectedTextEl)
```

Change the render gate (~919-925) from `selectedTextEl` to `toolbarTextEl`:

```tsx
        {toolbarTextEl && (
          <TextToolbar
            element={toolbarTextEl}
            boardW={board.w}
            onPatch={(partial) => onTextPatch(toolbarTextEl.id, partial)}
          />
        )}
```

- [ ] **Step 6: Verify compile + lint**

Run: `pnpm typecheck:web && pnpm lint`
Expected: clean (0 errors). The editing-gate behavior is asserted end-to-end in Task 9.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/canvas/boards/planning/TextToolbar.tsx src/renderer/src/canvas/boards/planning/TextToolbar.test.tsx
git commit -m "feat(planning): show typography toolbar while editing (not only on select)"
```

---

## Task 9: E2e — real-input coverage

**Files:**
- Create: `e2e/textCreate.e2e.ts`
- Reference patterns: `e2e/textToolbar.e2e.ts` (pollRect, `seed`, `mainCall sendInput`), `e2e/placement.e2e.ts` (drag gesture).

- [ ] **Step 1: Write the e2e spec**

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

test.describe('text create + edit (real OS input)', () => {
  test('Text tool: drag makes a wrapped area text with a height-mapped size', async ({ page, electronApp }) => {
    const planId = await seed(page, 'planning', { w: 560, h: 420 })
    // Arm the Text tool by clicking its toolbar button.
    const tbtn = await evalIn<{ cx: number; cy: number }>(page, `(() => {
      const n = document.querySelector('.react-flow__node[data-id=' + ${JSON.stringify(JSON.stringify(planId))} + ']');
      const b = n.querySelector('button[title="text"]'); const r = b.getBoundingClientRect();
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) };
    })()`)
    for (const type of ['mouseDown', 'mouseUp'] as const)
      await mainCall(electronApp, 'sendInput', { type, x: tbtn.cx, y: tbtn.cy, button: 'left', clickCount: 1 })

    // Drag a tall+wide box inside the well.
    const well = await evalIn<{ x: number; y: number }>(page, `(() => {
      const n = document.querySelector('.react-flow__node[data-id=' + ${JSON.stringify(JSON.stringify(planId))} + ']');
      const w = n.querySelector('.pl-well'); const r = w.getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + 60) };
    })()`)
    await mainCall(electronApp, 'sendInput', { type: 'mouseDown', x: well.x, y: well.y, button: 'left', clickCount: 1 })
    await mainCall(electronApp, 'sendInput', { type: 'mouseMove', x: well.x + 220, y: well.y + 90, button: 'left' })
    await mainCall(electronApp, 'sendInput', { type: 'mouseUp', x: well.x + 220, y: well.y + 90, button: 'left' })

    // One text element with a width (area text) and XL size (drag height 90 → XL).
    const ok = await pollEval(page, `(() => {
      const els = window.__canvasE2E.getBoards().find(b => b.id === ${JSON.stringify(planId)}).data.elements;
      const t = els.find(e => e.kind === 'text');
      return !!t && typeof t.width === 'number' && t.width >= 40 && t.fontSize === 'XL';
    })()`, 4000)
    expect(ok).toBe(true)
  })

  test('typing in a fresh text shows the toolbar before any grip-select', async ({ page, electronApp }) => {
    const planId = await seed(page, 'planning', { w: 520, h: 400 })
    await evalIn(page, `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [
      { id: 'txt', kind: 'text', x: 120, y: 140, text: '' } ] })`)
    // Focus the textarea directly (a fresh element auto-focuses; assert the toolbar is present).
    const shown = await pollEval(page, `(() => {
      const n = document.querySelector('.react-flow__node[data-id=' + ${JSON.stringify(planId)} + ']');
      const ta = n && n.querySelector('.pl-text textarea'); if (ta) ta.focus();
      return !!(n && n.querySelector('.pl-text-toolbar'));
    })()`, 3000)
    expect(shown).toBe(true)
  })
})
```

> NOTE: confirm the well's class is `.pl-well` and the toolbar's is `.pl-text-toolbar` in the live
> DOM (grep the components); adjust selectors if they differ. `getBoards()`/`patchBoard` are existing
> `window.__canvasE2E` hooks (see `e2eHooks.ts`).

- [ ] **Step 2: Build + run the spec (Windows leg)**

Run: `pnpm test:e2e textCreate`
Expected: 2 passed. (`pretest:e2e` builds first — never run `playwright test` against a stale `out/`.)

- [ ] **Step 3: Commit**

```bash
git add e2e/textCreate.e2e.ts
git commit -m "test(e2e): text tool drag area-text + toolbar-on-edit"
```

---

## Task 10: ADR + full gate + matrix

**Files:**
- Modify: `docs/decisions/0004-text-font-controls.md` (note v8 + area text)
- Modify: `src/renderer/src/lib/boardSchema.ts` doc-comment (the `v8 =` line, if not done in Task 1)

- [ ] **Step 1: Update ADR 0004**

Append a short section noting: the typography slice's `width` follow-up takes **schema v8**;
drag-to-create area text (width→wrap, height→size); Diagram/visual-spec (#72) rebases to **v9**.

- [ ] **Step 2: Full gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: typecheck clean · lint 0 errors · prettier clean · all unit+integration green.

- [ ] **Step 3: E2e matrix (pre-push)**

Run: `pnpm test:e2e:matrix` (Windows native + Linux Docker — Docker must be up).
Expected: both legs green.

- [ ] **Step 4: Commit + push (opens the PR)**

```bash
git add docs/decisions/0004-text-font-controls.md src/renderer/src/lib/boardSchema.ts
git commit -m "docs(adr): 0004 — schema v8 area text; Diagram rebases to v9"
git push -u origin feat/text-create-edit-ux
```

---

## Self-review (author checklist — completed)

- **Spec coverage:** A toolbar-on-edit → Task 8 · B header tool → Task 4 · C hybrid drag → Tasks
  3/5/6 · D schema v8 → Task 1 · E FreeText wrap → Task 7 · testing → Tasks 1-9 · ADR → Task 10. ✓
- **Placeholders:** none — every code step shows real code; two `NOTE` callouts ask the implementer
  to confirm an exact selector/validator entry-point against the live tree (legitimate, not a TODO).
- **Type consistency:** `tokenFromHeight(number): FontSizeToken`, `makeText(id, at, opts?)`,
  `draftTextBox: {x,y,w,h}|null`, `onEditingChange(id, editing)`, `toolbarTextEl` — names match
  across Tasks 2-8. ✓
- **Dependency note:** Task 0 pre-flight enforces the rebase-onto-post-#87-`main` order.
