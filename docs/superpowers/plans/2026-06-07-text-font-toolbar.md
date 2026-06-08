# Text Font Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A floating toolbar that styles a single selected free-`text` element on a Planning board — font family (sans/mono/serif), size (S/M/L/XL), alignment (L/C/R), bold, and color (neutral ramp + accent).

**Architecture:** Five optional, token-valued fields are added to `TextElement` (schema **v6**). A new pure `textStyle.ts` owns every token→presentation map for BOTH the live board and the SVG export (parity-tested, so they can't drift). `FreeText` reads the tokens; a new `TextToolbar` writes them through the existing single commit path (`patchElement → updateBoard`), so each click is one undo step. No new pointer state machine, no ephemeral state added to the persisted model.

**Tech Stack:** TypeScript · React 18 · @xyflow/react · Vitest 4 (node + jsdom projects) · Playwright `_electron` (e2e). Renderer-only; no main/native changes.

**Spec:** `docs/superpowers/specs/2026-06-07-text-font-toolbar-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `src/renderer/src/canvas/boards/planning/textStyle.ts` (**new**) | Token→presentation maps (live CSS + export literal), defaults, line-height, anchor. Pure. |
| `src/renderer/src/canvas/boards/planning/textStyle.test.ts` (**new**) | Parity + completeness of the maps. |
| `src/renderer/src/lib/boardSchema.ts` (edit) | Token unions/types; `TextElement` +5 fields; `SCHEMA_VERSION` 5→6; v5→v6 migration; text validation. |
| `src/renderer/src/lib/boardSchema.test.ts` (edit) | Update the three `=== 5` assertions; add v6 migration + field-validation tests. |
| `src/renderer/src/index.css` (edit) | Add `--serif` token. |
| `src/renderer/src/canvas/boards/planning/FreeText.tsx` (edit) | Apply tokens to the textarea style. |
| `src/renderer/src/canvas/boards/planning/FreeText.test.tsx` (**new**) | Textarea reflects tokens + defaults. |
| `src/renderer/src/canvas/boards/planning/TextToolbar.tsx` (**new**) | The floating toolbar component. |
| `src/renderer/src/canvas/boards/planning/TextToolbar.test.tsx` (**new**) | Active state, emit-on-change, no-op guard. |
| `src/renderer/src/index.css` (edit) | `.pl-text-toolbar` styling. |
| `src/renderer/src/canvas/boards/PlanningBoard.tsx` (edit) | Render the toolbar for a single selected text element; wire `onTextPatch`. |
| `src/renderer/src/canvas/boards/planning/whiteboardExport.ts` (edit) | `textBlock` + text branch honor tokens (regression-identical for defaults). |
| `src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts` (edit) | Token export + default regression. |
| `e2e/textToolbar.e2e.ts` (**new**) | Real-input: select text → toolbar → click size → persists. |
| `docs/decisions/0004-text-font-controls.md` (**new**) | ADR recording the narrow reversal. |

**Run-command reference (per project layout):**
- A single unit file: `pnpm exec vitest run <relative/path.test.ts>` (`.test.ts`→node env, `.test.tsx`→jsdom).
- Full unit gate: `pnpm test`
- Typecheck / lint / format: `pnpm typecheck` · `pnpm lint` · `pnpm format:check`
- e2e single spec (build first): `pnpm build && pnpm exec playwright test e2e/textToolbar.e2e.ts`

---

## Task 1: `textStyle.ts` — the token source of truth

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/textStyle.ts`
- Create (test): `src/renderer/src/canvas/boards/planning/textStyle.test.ts`

This task depends on the token TYPES that Task 2 adds to `boardSchema.ts`. To keep the tasks independently testable, define the token ARRAYS here too and have Task 2 import them. (The element interface in Task 2 imports the token types from here.)

- [ ] **Step 1: Write `textStyle.ts`**

```ts
/**
 * Single source of truth for free-text typography tokens (schema v6). Owns the token
 * unions + their LIVE (CSS custom-prop) and EXPORT (literal, portable) representations
 * for family / size / color, plus weight, line-height, and SVG text-anchor. Both the
 * live board (FreeText) and the SVG export (whiteboardExport) read from here so the two
 * can never drift — the R7 lesson (exportColors.ts duplicating tints.ts). A parity test
 * pins the EXPORT literals to the resolved design tokens.
 *
 * Pure data — no React, no DOM. Safe in the node test env.
 */
export const FONT_FAMILY_TOKENS = ['sans', 'mono', 'serif'] as const
export const FONT_SIZE_TOKENS = ['S', 'M', 'L', 'XL'] as const
export const TEXT_ALIGN_TOKENS = ['left', 'center', 'right'] as const
export const TEXT_COLOR_TOKENS = ['default', 'muted', 'faint', 'accent'] as const

export type FontFamilyToken = (typeof FONT_FAMILY_TOKENS)[number]
export type FontSizeToken = (typeof FONT_SIZE_TOKENS)[number]
export type TextAlignToken = (typeof TEXT_ALIGN_TOKENS)[number]
export type TextColorToken = (typeof TEXT_COLOR_TOKENS)[number]

/** Defaults chosen so a v5 text element (no tokens) renders byte-identical to pre-v6. */
export const TEXT_DEFAULTS = {
  fontFamily: 'sans' as FontFamilyToken,
  fontSize: 'M' as FontSizeToken,
  align: 'left' as TextAlignToken,
  color: 'default' as TextColorToken,
  bold: false
}

/** Live family stack (CSS custom prop). */
export const FAMILY_CSS: Record<FontFamilyToken, string> = {
  sans: 'var(--ui)',
  mono: 'var(--term-mono)',
  serif: 'var(--serif)'
}
/** Export family stack (literal generic — an exported SVG has no CSS custom props). */
export const FAMILY_EXPORT: Record<FontFamilyToken, string> = {
  sans: 'system-ui, -apple-system, Segoe UI, sans-serif',
  mono: 'Cascadia Mono, Consolas, ui-monospace, monospace',
  serif: 'Georgia, "Times New Roman", serif'
}

/** Pixel size per token. M = 13 (the pre-v6 hardcoded size). */
export const SIZE_PX: Record<FontSizeToken, number> = { S: 11, M: 13, L: 18, XL: 26 }
/** Line height (px) for a px size: 1.38× → lineHeightFor(13) === 18 (matches pre-v6). */
export const lineHeightFor = (px: number): number => Math.round(px * 1.38)

/** Live color (CSS custom prop). */
export const COLOR_CSS: Record<TextColorToken, string> = {
  default: 'var(--text)',
  muted: 'var(--text-2)',
  faint: 'var(--text-3)',
  accent: 'var(--accent)'
}
/** Export color (literal hex; mirrors the index.css token block / EXPORT_COLORS). */
export const COLOR_EXPORT: Record<TextColorToken, string> = {
  default: '#ededee',
  muted: '#9b9ba1',
  faint: '#6a6a70',
  accent: '#4f8cff'
}

export const WEIGHT = { normal: 400, bold: 700 } as const

/** SVG text-anchor for an alignment token. */
export const ANCHOR: Record<TextAlignToken, 'start' | 'middle' | 'end'> = {
  left: 'start',
  center: 'middle',
  right: 'end'
}
```

- [ ] **Step 2: Write the failing test `textStyle.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import {
  SIZE_PX,
  lineHeightFor,
  COLOR_EXPORT,
  TEXT_COLOR_TOKENS,
  TEXT_DEFAULTS
} from './textStyle'
import { EXPORT_COLORS } from './exportColors'

describe('textStyle tokens', () => {
  it('M size + its line height match the pre-v6 hardcoded text (no visual regression)', () => {
    expect(SIZE_PX.M).toBe(13)
    expect(lineHeightFor(SIZE_PX.M)).toBe(18)
  })

  it('defaults are sans / M / left / default / not-bold', () => {
    expect(TEXT_DEFAULTS).toEqual({
      fontFamily: 'sans',
      fontSize: 'M',
      align: 'left',
      color: 'default',
      bold: false
    })
  })

  it('export color literals mirror the resolved design tokens (anti-drift, R7)', () => {
    expect(COLOR_EXPORT.default).toBe(EXPORT_COLORS.text)
    expect(COLOR_EXPORT.muted).toBe(EXPORT_COLORS.text2)
    expect(COLOR_EXPORT.faint).toBe(EXPORT_COLORS.text3)
    expect(COLOR_EXPORT.accent).toBe(EXPORT_COLORS.accent)
  })

  it('every color token has a hex export literal', () => {
    for (const t of TEXT_COLOR_TOKENS) expect(COLOR_EXPORT[t]).toMatch(/^#[0-9a-f]{6}$/)
  })
})
```

- [ ] **Step 3: Run the test**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/textStyle.test.ts`
Expected: PASS (4 tests). If the parity test fails, a `COLOR_EXPORT` literal diverged from `EXPORT_COLORS` — fix the literal, do not change the assertion.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/textStyle.ts src/renderer/src/canvas/boards/planning/textStyle.test.ts
git commit -m "feat(planning): textStyle token source of truth for v6 text typography"
```

---

## Task 2: Schema v6 — `TextElement` fields, migration, validation

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts`
- Test: `src/renderer/src/lib/boardSchema.test.ts`

- [ ] **Step 1: Add token unions + `TextElement` fields + bump version**

In `boardSchema.ts`, change `SCHEMA_VERSION` (currently `:21`):
```ts
export const SCHEMA_VERSION = 6
```

Add the token unions just above the `ElementCommon`/`TextElement` block (near `:61`), importing the arrays from `textStyle.ts` so there is one source:
```ts
import {
  FONT_FAMILY_TOKENS,
  FONT_SIZE_TOKENS,
  TEXT_ALIGN_TOKENS,
  TEXT_COLOR_TOKENS,
  type FontFamilyToken,
  type FontSizeToken,
  type TextAlignToken,
  type TextColorToken
} from '../canvas/boards/planning/textStyle'
```

Replace the `TextElement` interface (`:82-85`) with:
```ts
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

- [ ] **Step 2: Add the v5→v6 migration step**

In the `MIGRATIONS` map (after the `4:` entry, `:301`), add:
```ts
  4: (doc) => ({ ...doc, schemaVersion: 5, connectors: previewConnectorsFor(doc.boards) }),
  // v6: free-text typography tokens (all optional → identity bump; defaulted at render).
  5: (doc) => ({ ...doc, schemaVersion: 6 })
```
(Keep the existing `4:` line; only the `5:` line is new — shown with its predecessor for placement.)

- [ ] **Step 3: Extend the `text` validation branch**

Replace the `case 'text'` branch in `assertPlanningElement` (`:397-399`) with:
```ts
    case 'text':
      if (typeof el.text !== 'string') fail('text element is missing string text')
      if (el.fontFamily !== undefined && !FONT_FAMILY_TOKENS.includes(el.fontFamily as FontFamilyToken))
        fail(`text element has invalid fontFamily ${String(el.fontFamily)}`)
      if (el.fontSize !== undefined && !FONT_SIZE_TOKENS.includes(el.fontSize as FontSizeToken))
        fail(`text element has invalid fontSize ${String(el.fontSize)}`)
      if (el.align !== undefined && !TEXT_ALIGN_TOKENS.includes(el.align as TextAlignToken))
        fail(`text element has invalid align ${String(el.align)}`)
      if (el.color !== undefined && !TEXT_COLOR_TOKENS.includes(el.color as TextColorToken))
        fail(`text element has invalid color ${String(el.color)}`)
      if (el.bold !== undefined && typeof el.bold !== 'boolean') fail('text element has non-boolean bold')
      return
```

- [ ] **Step 4: Update the three existing assertions the bump breaks**

In `boardSchema.test.ts`:
- `:471-473` rename + revalue:
```ts
  it('SCHEMA_VERSION is 6', () => {
    expect(SCHEMA_VERSION).toBe(6)
  })
```
- `:475-478` body:
```ts
    expect(doc).toEqual({ schemaVersion: 6, viewport: vp, boards: [], connectors: [] })
```
- `:484-489` name + body:
```ts
  it('migrates a v1 doc (no viewport) to v6 (via v2–v5) with viewport=null', () => {
    const v1 = { schemaVersion: 1, boards: [] } as unknown
    const out = fromObject(v1)
    expect(out.schemaVersion).toBe(6)
    expect(out.viewport).toBeNull()
  })
```

- [ ] **Step 5: Write the new failing tests (append to `boardSchema.test.ts`)**

```ts
describe('schema v6 — text typography fields', () => {
  const planBoard = (els: unknown[]): unknown => ({
    id: 'p',
    type: 'planning',
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    title: 'P',
    elements: els
  })

  it('migrates a v5 doc to v6 leaving text elements untouched', () => {
    const v5 = {
      schemaVersion: 5,
      viewport: null,
      connectors: [],
      boards: [planBoard([{ id: 't', kind: 'text', x: 1, y: 2, text: 'hi' }])]
    }
    const out = migrate(structuredClone(v5) as never)
    expect(out.schemaVersion).toBe(6)
    expect((out.boards[0] as { elements: unknown[] }).elements[0]).toEqual({
      id: 't',
      kind: 'text',
      x: 1,
      y: 2,
      text: 'hi'
    })
  })

  it('accepts a text element carrying valid typography tokens', () => {
    const doc = {
      schemaVersion: 6,
      viewport: null,
      connectors: [],
      boards: [
        planBoard([
          {
            id: 't',
            kind: 'text',
            x: 0,
            y: 0,
            text: 'styled',
            fontFamily: 'mono',
            fontSize: 'XL',
            align: 'center',
            color: 'accent',
            bold: true
          }
        ])
      ]
    }
    expect(() => fromObject(doc)).not.toThrow()
  })

  it('rejects an out-of-set token', () => {
    const bad = (field: string, value: unknown): unknown => ({
      schemaVersion: 6,
      viewport: null,
      connectors: [],
      boards: [planBoard([{ id: 't', kind: 'text', x: 0, y: 0, text: 'x', [field]: value }])]
    })
    expect(() => fromObject(bad('fontSize', 'XXL'))).toThrow()
    expect(() => fromObject(bad('fontFamily', 'comic'))).toThrow()
    expect(() => fromObject(bad('align', 'justify'))).toThrow()
    expect(() => fromObject(bad('color', '#fff'))).toThrow()
    expect(() => fromObject(bad('bold', 'yes'))).toThrow()
  })

  it('round-trips the typography fields through toObject/fromObject', () => {
    const el = {
      id: 't',
      kind: 'text' as const,
      x: 5,
      y: 6,
      text: 'rt',
      fontFamily: 'serif' as const,
      fontSize: 'L' as const,
      align: 'right' as const,
      color: 'muted' as const,
      bold: true
    }
    const board = {
      id: 'p',
      type: 'planning' as const,
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      title: 'P',
      elements: [el]
    }
    const doc = toObject([board], null)
    const back = fromObject(JSON.parse(JSON.stringify(doc)))
    const got = (back.boards[0] as { elements: unknown[] }).elements[0]
    expect(got).toEqual(el)
  })
})
```

> Note: `toObject`'s exact board-array signature — match the call already used in this file (search for `toObject(` in the existing tests). The W4 image describe (`:639`) shows the established planning-board test shape; mirror it if the literal above needs a field adjustment.

- [ ] **Step 6: Run the schema tests**

Run: `pnpm exec vitest run src/renderer/src/lib/boardSchema.test.ts`
Expected: PASS (all, including the updated `=== 6` assertions and the new v6 describe).

- [ ] **Step 7: Typecheck (the import path lib→planning is new)**

Run: `pnpm typecheck`
Expected: PASS. If a circular-import or path error appears, confirm `textStyle.ts` imports NOTHING from `boardSchema.ts` (it must not — the dependency is one-way planning→lib for types, lib→planning only for the token arrays, which are leaf constants).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts
git commit -m "feat(schema): v6 text typography fields + migration + validation"
```

---

## Task 3: `--serif` token + `FreeText` applies tokens

**Files:**
- Modify: `src/renderer/src/index.css` (add `--serif`)
- Modify: `src/renderer/src/canvas/boards/planning/FreeText.tsx`
- Test: `src/renderer/src/canvas/boards/planning/FreeText.test.tsx` (new)

- [ ] **Step 1: Add the `--serif` token**

In `index.css`, in the `:root` token block next to `--ui` (`:27`) and `--term-mono` (`:34`), add:
```css
  --serif: Georgia, 'Times New Roman', serif;
```

- [ ] **Step 2: Write the failing component test `FreeText.test.tsx`**

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { FreeText } from './FreeText'
import type { TextElement } from '../../../lib/boardSchema'

const noop = (): void => {}
const base = (over: Partial<TextElement> = {}): TextElement => ({
  id: 't1',
  kind: 'text',
  x: 0,
  y: 0,
  text: 'hi',
  ...over
})

const renderFreeText = (el: TextElement): HTMLTextAreaElement => {
  const { container } = render(
    <FreeText
      element={el}
      interactive
      onDragStart={noop}
      onChangeText={noop}
      onDelete={noop}
    />
  )
  return container.querySelector('textarea') as HTMLTextAreaElement
}

describe('FreeText typography', () => {
  it('renders pre-v6 defaults when the element carries no tokens', () => {
    const ta = renderFreeText(base())
    expect(ta.style.fontSize).toBe('13px')
    expect(ta.style.fontFamily).toBe('var(--ui)')
    expect(ta.style.lineHeight).toBe('18px')
    expect(ta.style.color).toBe('var(--text)')
    expect(ta.style.textAlign).toBe('left')
  })

  it('applies every token', () => {
    const ta = renderFreeText(
      base({ fontFamily: 'mono', fontSize: 'XL', align: 'center', color: 'accent', bold: true })
    )
    expect(ta.style.fontSize).toBe('26px')
    expect(ta.style.fontFamily).toBe('var(--term-mono)')
    expect(ta.style.textAlign).toBe('center')
    expect(ta.style.color).toBe('var(--accent)')
    expect(ta.style.fontWeight).toBe('700')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/FreeText.test.tsx`
Expected: FAIL — the defaults test fails on `fontFamily`/`textAlign` not matching (today's hardcoded values lack `textAlign`, and the token branch isn't there yet).

- [ ] **Step 4: Apply tokens in `FreeText.tsx`**

Add the import after the existing `boardSchema` import (`:8`):
```ts
import { FAMILY_CSS, SIZE_PX, lineHeightFor, COLOR_CSS, WEIGHT, TEXT_DEFAULTS } from './textStyle'
```

Inside the component body, before the `return` (e.g. just after the third `useEffect`, near `:76`), derive the resolved style:
```ts
  const fam = element.fontFamily ?? TEXT_DEFAULTS.fontFamily
  const px = SIZE_PX[element.fontSize ?? TEXT_DEFAULTS.fontSize]
  const align = element.align ?? TEXT_DEFAULTS.align
  const colorTok = element.color ?? TEXT_DEFAULTS.color
  const weight = element.bold ? WEIGHT.bold : WEIGHT.normal
```

Replace the textarea `style` object (`:178-191`) with:
```tsx
        style={{
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: COLOR_CSS[colorTok],
          fontFamily: FAMILY_CSS[fam],
          fontSize: px,
          fontWeight: weight,
          textAlign: align,
          lineHeight: `${lineHeightFor(px)}px`,
          padding: 0,
          overflow: 'hidden',
          whiteSpace: 'pre',
          cursor: interactive ? 'text' : 'default'
        }}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/FreeText.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/index.css src/renderer/src/canvas/boards/planning/FreeText.tsx src/renderer/src/canvas/boards/planning/FreeText.test.tsx
git commit -m "feat(planning): FreeText renders v6 typography tokens (+ --serif token)"
```

---

## Task 4: `TextToolbar` component

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/TextToolbar.tsx`
- Create (test): `src/renderer/src/canvas/boards/planning/TextToolbar.test.tsx`
- Modify: `src/renderer/src/index.css` (`.pl-text-toolbar` + button styles)

- [ ] **Step 1: Write the failing test `TextToolbar.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { TextToolbar } from './TextToolbar'
import type { TextElement } from '../../../lib/boardSchema'

const el = (o: Partial<TextElement> = {}): TextElement => ({
  id: 't',
  kind: 'text',
  x: 0,
  y: 0,
  text: 'x',
  ...o
})

describe('TextToolbar', () => {
  it('renders a button per token (3 family · 4 size · 3 align · bold · 4 color)', () => {
    const { getByLabelText } = render(<TextToolbar element={el()} onPatch={() => {}} />)
    for (const f of ['sans', 'mono', 'serif']) expect(getByLabelText(`font ${f}`)).toBeTruthy()
    for (const s of ['S', 'M', 'L', 'XL']) expect(getByLabelText(`size ${s}`)).toBeTruthy()
    for (const a of ['left', 'center', 'right']) expect(getByLabelText(`align ${a}`)).toBeTruthy()
    expect(getByLabelText('bold')).toBeTruthy()
    for (const c of ['default', 'muted', 'faint', 'accent']) expect(getByLabelText(`color ${c}`)).toBeTruthy()
  })

  it('reflects the active token via aria-pressed (defaults applied)', () => {
    const { getByLabelText } = render(<TextToolbar element={el({ fontSize: 'L' })} onPatch={() => {}} />)
    expect(getByLabelText('size L').getAttribute('aria-pressed')).toBe('true')
    expect(getByLabelText('size M').getAttribute('aria-pressed')).toBe('false')
    // default family is sans
    expect(getByLabelText('font sans').getAttribute('aria-pressed')).toBe('true')
  })

  it('emits a patch when a different token is clicked', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(<TextToolbar element={el({ fontSize: 'M' })} onPatch={onPatch} />)
    fireEvent.click(getByLabelText('size L'))
    expect(onPatch).toHaveBeenCalledWith({ fontSize: 'L' })
  })

  it('does NOT emit when the already-active token is clicked (no phantom undo step)', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(<TextToolbar element={el({ fontSize: 'M' })} onPatch={onPatch} />)
    fireEvent.click(getByLabelText('size M'))
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('bold toggles from its current value', () => {
    const onPatch = vi.fn()
    const { getByLabelText } = render(<TextToolbar element={el({ bold: false })} onPatch={onPatch} />)
    fireEvent.click(getByLabelText('bold'))
    expect(onPatch).toHaveBeenCalledWith({ bold: true })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/TextToolbar.test.tsx`
Expected: FAIL with "Cannot find module './TextToolbar'".

- [ ] **Step 3: Write `TextToolbar.tsx`**

```tsx
/**
 * Floating typography toolbar for a single selected free-`text` element (schema v6).
 * Lives in the board's content coordinate space (sibling to the cards) so it scales
 * with the board and sits just above the element. Each "set" control is a no-op when
 * its token is already active → it does NOT emit, so re-clicking the active button can't
 * push a phantom undo step / no-op commit. Bold is a toggle and always emits.
 */
import type { ReactElement } from 'react'
import type { TextElement } from '../../../lib/boardSchema'
import {
  FONT_FAMILY_TOKENS,
  FONT_SIZE_TOKENS,
  TEXT_ALIGN_TOKENS,
  TEXT_COLOR_TOKENS,
  COLOR_CSS,
  FAMILY_CSS,
  TEXT_DEFAULTS,
  type FontFamilyToken,
  type FontSizeToken,
  type TextAlignToken
} from './textStyle'

export interface TextToolbarProps {
  element: TextElement
  onPatch: (partial: Partial<TextElement>) => void
}

const FAMILY_GLYPH: Record<FontFamilyToken, string> = { sans: 'A', mono: '</>', serif: 'A' }
const ALIGN_GLYPH: Record<TextAlignToken, string> = { left: '⇤', center: '⇔', right: '⇥' }

export function TextToolbar({ element, onPatch }: TextToolbarProps): ReactElement {
  const fam = element.fontFamily ?? TEXT_DEFAULTS.fontFamily
  const size = element.fontSize ?? TEXT_DEFAULTS.fontSize
  const align = element.align ?? TEXT_DEFAULTS.align
  const color = element.color ?? TEXT_DEFAULTS.color
  const bold = element.bold ?? TEXT_DEFAULTS.bold

  const btn = (active: boolean, extra = ''): string =>
    `pl-tt-btn${active ? ' is-active' : ''}${extra ? ' ' + extra : ''}`
  // Emit only on a real change (active button click = no-op).
  const set = (active: boolean, partial: Partial<TextElement>) => (): void => {
    if (!active) onPatch(partial)
  }

  return (
    <div
      className="pl-text-toolbar"
      style={{ position: 'absolute', left: element.x, top: element.y - 40 }}
      // Keep clicks off the well (which would clear selection / start a draw gesture).
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pl-tt-group" role="group" aria-label="Font family">
        {FONT_FAMILY_TOKENS.map((f) => (
          <button
            key={f}
            type="button"
            aria-label={`font ${f}`}
            aria-pressed={fam === f}
            className={btn(fam === f)}
            style={{ fontFamily: FAMILY_CSS[f] }}
            onClick={set(fam === f, { fontFamily: f as FontFamilyToken })}
          >
            {FAMILY_GLYPH[f]}
          </button>
        ))}
      </div>

      <div className="pl-tt-group" role="group" aria-label="Font size">
        {FONT_SIZE_TOKENS.map((s) => (
          <button
            key={s}
            type="button"
            aria-label={`size ${s}`}
            aria-pressed={size === s}
            className={btn(size === s)}
            onClick={set(size === s, { fontSize: s as FontSizeToken })}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="pl-tt-group" role="group" aria-label="Text align">
        {TEXT_ALIGN_TOKENS.map((a) => (
          <button
            key={a}
            type="button"
            aria-label={`align ${a}`}
            aria-pressed={align === a}
            className={btn(align === a)}
            onClick={set(align === a, { align: a as TextAlignToken })}
          >
            {ALIGN_GLYPH[a]}
          </button>
        ))}
      </div>

      <button
        type="button"
        aria-label="bold"
        aria-pressed={bold}
        className={btn(bold)}
        style={{ fontWeight: 700 }}
        onClick={() => onPatch({ bold: !bold })}
      >
        B
      </button>

      <div className="pl-tt-group" role="group" aria-label="Text color">
        {TEXT_COLOR_TOKENS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`color ${c}`}
            aria-pressed={color === c}
            className={btn(color === c, 'pl-tt-swatch')}
            style={{ background: COLOR_CSS[c] }}
            onClick={set(color === c, { color: c })}
          />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/TextToolbar.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Add toolbar styling to `index.css`**

Append near the other `.pl-*` whiteboard rules:
```css
.pl-text-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  z-index: 5;
}
.pl-tt-group {
  display: flex;
  gap: 2px;
}
.pl-tt-btn {
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  font-size: 11px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: pointer;
}
.pl-tt-btn:hover {
  color: var(--text);
  background: var(--inset);
}
.pl-tt-btn.is-active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-wash);
}
.pl-tt-swatch {
  width: 16px;
  min-width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
}
.pl-tt-swatch.is-active {
  box-shadow: 0 0 0 1.5px var(--accent);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/TextToolbar.tsx src/renderer/src/canvas/boards/planning/TextToolbar.test.tsx src/renderer/src/index.css
git commit -m "feat(planning): TextToolbar component (family/size/align/bold/color)"
```

---

## Task 5: Wire `TextToolbar` into `PlanningBoard`

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx`

No isolated unit test (the board needs the store + React Flow context; the codebase tests it via e2e — Task 7). Verified by typecheck here + the e2e next.

- [ ] **Step 1: Import the toolbar**

After the `FreeText` import (`:43`):
```ts
import { TextToolbar } from './planning/TextToolbar'
```

- [ ] **Step 2: Add the patch handler**

Near the other element callbacks (e.g. after `setTextText`, `:361`), add:
```ts
  const onTextPatch = useCallback(
    (id: string, partial: Partial<TextElement>) => {
      beginChange()
      commit((cur) => patchElement<TextElement>(cur, id, (t) => ({ ...t, ...partial })))
    },
    [beginChange, commit]
  )
```
(`useCallback`, `patchElement`, `TextElement`, `beginChange`, `commit` are all already imported/in scope — confirm via the existing `setTextText` definition.)

- [ ] **Step 3: Render the toolbar for a single selected text element**

Immediately AFTER the `{viewElements.map((el) => { … })}` block closes (the map ending around `:884`, inside the same parent that holds the cards), add:
```tsx
        {interactive &&
          selectedIds.size === 1 &&
          (() => {
            const sid = [...selectedIds][0]
            const sel = viewElements.find((e) => e.id === sid)
            if (!sel || sel.kind !== 'text') return null
            return <TextToolbar element={sel} onPatch={(partial) => onTextPatch(sel.id, partial)} />
          })()}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (`sel` narrows to `TextElement` after the `kind !== 'text'` guard, so `<TextToolbar element={sel}>` typechecks.)

- [ ] **Step 5: Lint + format the touched files**

Run: `pnpm lint && pnpm format:check`
Expected: PASS (0 errors). If format flags the new JSX, run `pnpm format` and re-stage.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "feat(planning): show TextToolbar for a single selected text element"
```

---

## Task 6: SVG export honors tokens (default-identical)

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/whiteboardExport.ts`
- Test: `src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`

- [ ] **Step 1: Write the failing tests (append to `whiteboardExport.test.ts`)**

```ts
describe('boardToSvg — text typography (v6)', () => {
  it('a text element with NO tokens exports identically to the pre-v6 baseline', () => {
    const { svg } = boardToSvg(board([{ id: 't', kind: 'text', x: 10, y: 10, text: 'plain' }]), {})
    expect(svg).toContain('font-size="13"')
    expect(svg).toContain('font-family="system-ui, -apple-system, Segoe UI, sans-serif"')
    expect(svg).toContain('fill="#ededee"')
    expect(svg).not.toContain('text-anchor=') // left is the default → no anchor attr
  })

  it('honors family / size / weight / color / align tokens', () => {
    const { svg } = boardToSvg(
      board([
        {
          id: 't',
          kind: 'text',
          x: 10,
          y: 10,
          text: 'styled',
          fontFamily: 'mono',
          fontSize: 'XL',
          align: 'center',
          color: 'accent',
          bold: true
        }
      ]),
      {}
    )
    expect(svg).toContain('font-size="26"')
    expect(svg).toContain('font-weight="700"')
    expect(svg).toContain('Cascadia Mono, Consolas, ui-monospace, monospace')
    expect(svg).toContain('fill="#4f8cff"')
    expect(svg).toContain('text-anchor="middle"')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: FAIL on the token test (size/weight/family/anchor not applied yet).

- [ ] **Step 3: Extend `textBlock` to accept family + anchor**

Add the import after the existing `elements`/`exportColors` imports (`:13-14`):
```ts
import { SIZE_PX, COLOR_EXPORT, FAMILY_EXPORT, ANCHOR, WEIGHT } from './textStyle'
```

Replace `textBlock` (`:51-64`) with:
```ts
/** A multi-line <text> block: one <tspan> per source line. `anchor` defaults to 'start'
 *  (left) so existing callers (note/checklist) emit byte-identical markup. */
function textBlock(
  x: number,
  y: number,
  raw: string,
  size: number,
  fill: string,
  weight = 400,
  family: string = FONT,
  anchor: 'start' | 'middle' | 'end' = 'start'
): string {
  const lines = raw.split('\n')
  const tspans = lines
    .map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size + 4}">${esc(ln)}</tspan>`)
    .join('')
  const a = anchor !== 'start' ? ` text-anchor="${anchor}"` : ''
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}"${a} fill="${fill}">${tspans}</text>`
}
```

- [ ] **Step 4: Resolve tokens in the `text` branch**

Replace the `case 'text'` branch (`:136-140`) with:
```ts
    case 'text': {
      const fam = el.fontFamily ?? 'sans'
      const px = SIZE_PX[el.fontSize ?? 'M']
      const align = el.align ?? 'left'
      const colorTok = el.color ?? 'default'
      const weight = el.bold ? WEIGHT.bold : WEIGHT.normal
      // Anchor x at the nominal box edge/center (no DOM at export time → approximate for
      // center/right, exact for left). Baseline el.y + px + 3 === el.y + 16 at px=13,
      // keeping default text byte-identical to pre-v6.
      const w = TEXT_NOMINAL.w
      const ax = align === 'center' ? el.x + w / 2 : align === 'right' ? el.x + w : el.x
      return {
        markup: textBlock(ax, el.y + px + 3, el.text, px, COLOR_EXPORT[colorTok], weight, FAMILY_EXPORT[fam], ANCHOR[align]),
        embedded: false
      }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: PASS — both the default-regression and the token test. (The existing note/checklist export tests must stay green, proving `textBlock`'s default path is unchanged.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/whiteboardExport.ts src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts
git commit -m "feat(planning): SVG export honors v6 text typography tokens"
```

---

## Task 7: e2e — real-input happy path

**Files:**
- Create: `e2e/textToolbar.e2e.ts`

Models the real-OS-input pattern from `e2e/whiteboard.e2e.ts` (`seed`, `patchBoard`, `getBoards`, `mainCall(sendInput)`, `evalIn`, `pollEval`). Selection is driven by a real click on the text element's drag grip (`.pl-text-grip`), which is the only path that calls `onSelect` — so the toolbar appearing proves selection + `interactive` both worked.

- [ ] **Step 1: Write the e2e spec**

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

test.describe('text font toolbar (real OS input)', () => {
  test('select a text element → toolbar → click size L → persists fontSize', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning')
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 400, elements: [
        { id: 'txt', kind: 'text', x: 160, y: 160, text: 'Hello' }
      ] })`
    )
    await page.waitForTimeout(160)

    // Select the board (real click on the well) so the board is interactive, then click
    // the text's drag grip to select the element.
    const gripRect = await pollEval<{ cx: number; cy: number } | false>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const grip = node && node.querySelector('.pl-text-grip');
         if (!grip) return false;
         const r = grip.getBoundingClientRect();
         if (!(r.width > 0)) return false;
         return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
       })()`,
      4000
    )
    expect(gripRect, 'text grip is on screen').not.toBe(false)
    const g = gripRect as { cx: number; cy: number }

    // A press-release on the grip (no movement) selects the non-empty text element.
    await mainCall(electronApp, 'sendInput', { type: 'mouseDown', x: g.cx, y: g.cy, button: 'left', clickCount: 1 })
    await mainCall(electronApp, 'sendInput', { type: 'mouseUp', x: g.cx, y: g.cy, button: 'left', clickCount: 1 })

    // Toolbar should appear for the single text selection.
    const sizeLRect = await pollEval<{ cx: number; cy: number } | false>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const btn = node && node.querySelector('.pl-text-toolbar button[aria-label="size L"]');
         if (!btn) return false;
         const r = btn.getBoundingClientRect();
         if (!(r.width > 0)) return false;
         return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
       })()`,
      4000
    )
    expect(sizeLRect, 'toolbar appeared with a size-L button').not.toBe(false)
    const s = sizeLRect as { cx: number; cy: number }

    // Click the L size button.
    await mainCall(electronApp, 'sendInput', { type: 'mouseDown', x: s.cx, y: s.cy, button: 'left', clickCount: 1 })
    await mainCall(electronApp, 'sendInput', { type: 'mouseUp', x: s.cx, y: s.cy, button: 'left', clickCount: 1 })

    const persisted = await pollEval(
      page,
      `(() => {
         const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)});
         const t = b && b.type === 'planning' ? b.elements.find((e) => e.id === 'txt') : null;
         return !!t && t.fontSize === 'L';
       })()`,
      4000
    )
    expect(persisted, 'fontSize L persisted to the element').toBe(true)
  })
})
```

- [ ] **Step 2: Build + run the e2e spec**

Run: `pnpm build && pnpm exec playwright test e2e/textToolbar.e2e.ts`
Expected: PASS (1 test). If the toolbar never appears, the board was not interactive — add an initial real click on the well center (`x = wellRect.left + 30, y = wellRect.top + 30`) before the grip click, mirroring the focus step in `whiteboard.e2e.ts`.

- [ ] **Step 3: Commit**

```bash
git add e2e/textToolbar.e2e.ts
git commit -m "test(e2e): text font toolbar select → set size persists"
```

---

## Task 8: ADR 0004 + full gate

**Files:**
- Create: `docs/decisions/0004-text-font-controls.md`

- [ ] **Step 1: Write the ADR**

```markdown
# ADR 0004 — Text font controls (narrow reversal of "Tweaks panel cut")

**Status:** Accepted · **Date:** 2026-06-07 · **Supersedes (narrowly):** the "Tweaks panel cut entirely"
line in CLAUDE.md › Locked decisions, and the ADR 0001 AVOID entry "Font/size/align props panel · Excalifont".

## Context
The Planning board's free-`text` element had a single fixed font/size/color. Developers asked for basic
typography. The locked design cut the Tweaks panel and forbade a font/size/align props panel to protect the
calm, single-accent Linear/Raycast aesthetic.

## Decision
Add a **floating, contextual** font toolbar for the **`text` element only**: family (sans·mono·serif), size
(S/M/L/XL presets), alignment (L/C/R), bold, and color drawn from the **neutral text ramp + the single
accent** — no multi-hue palette. Values are closed tokens (schema v6), not free-form CSS.

## What stays cut
A general/persistent properties panel; per-element opacity; arbitrary/handwriting fonts; per-span rich text;
multi-hue color; note/checklist typography. The single blue accent remains the only color.

## Consequences
- Schema bumps to **v6**; this slice owns it. The Mermaid diagram element takes **v7**; the draw.io-D2,
  file-editor, and PR #72 Diagram docs rebase their bump numbers off v6.
- Tokenized + closed, so the feature cannot grow into the full Tweaks panel without another ADR.
- Reversible: the fields are optional; dropping the toolbar leaves data that still validates.
```

- [ ] **Step 2: Update the v6-owner numbers in the contested docs**

Per the spec §3, update the next-schema-version references so they rebase off v6 (Mermaid = v7) in:
`docs/roadmap-drawio.md`, `docs/research/file-editor-board-integration-research.md`,
and the PR #72 Diagram research doc (`docs/research/…visual-spec…`). Change each "next bump = vN" note to
"v7 (after the v6 text-typography slice)". (Search each file for `schemaVersion` / `v6` / "next bump".)

- [ ] **Step 3: Run the FULL gate**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```
Expected: typecheck clean · lint 0 errors · format clean · all unit+integration green (the prior baseline + the new textStyle/FreeText/TextToolbar/boardSchema-v6/whiteboardExport tests). If `format:check` flags anything, run `pnpm format` and re-stage.

- [ ] **Step 4: Run the e2e matrix**

Run: `pnpm test:e2e:matrix`
Expected: Windows-native + Linux-Docker legs green (the new `textToolbar` spec passes both; the `browser`/`browser-gesture`/`focus-detach` trio is a known env flake — rerun for a clean pass, not a regression).

- [ ] **Step 5: Commit + push the branch**

```bash
git add docs/decisions/0004-text-font-controls.md docs/roadmap-drawio.md docs/research/file-editor-board-integration-research.md
git commit -m "docs(adr): 0004 text font controls; rebase contested schema bumps to v7"
git push -u origin feat/text-font-toolbar
```

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- §3 schema v6 fields/migration/validation → Task 2 ✓
- §4 token tables + live/export parity → Task 1 ✓
- §5 `textStyle.ts` → T1; `TextToolbar.tsx` → T4; `FreeText` apply → T3; `PlanningBoard` wire → T5; `whiteboardExport` → T6; `--serif` → T3 ✓
- §6 single commit path / one undo step / no-op guard → T4 (component guard) + T5 (beginChange+commit) ✓; scene/session split → no `PATCHABLE_KEYS`/ephemeral change (verified: only `elements` fields touched) ✓
- §7 testing (model/schema/parity/export/e2e) → T1/T2/T3/T4/T6/T7 ✓
- §9 ADR 0004 → T8 ✓
- §3 v6-owner coordination → T8 step 2 ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. The one "match the existing `toObject(` signature" note (T2 step 5) points at a concrete in-file reference, not a gap.

**3. Type consistency:** `onTextPatch(id, partial)` (T5) ↔ `TextToolbar.onPatch(partial)` (T4) — the board closes over `sel.id`. Token type names (`FontFamilyToken` etc.) defined in `textStyle.ts` (T1), imported by `boardSchema.ts` (T2) and `TextToolbar.tsx`/`FreeText.tsx` (T3/T4) — consistent. `SIZE_PX`/`COLOR_EXPORT`/`FAMILY_EXPORT`/`ANCHOR`/`WEIGHT` defined in T1, consumed in T3/T6 with matching shapes. `textBlock` default `anchor='start'` keeps note/checklist callers (T6) unchanged.

**4. Known nuance carried from the spec:** `textAlign` on the auto-width textarea only shows on multi-line text — acceptable v1, no task needed.
</content>
