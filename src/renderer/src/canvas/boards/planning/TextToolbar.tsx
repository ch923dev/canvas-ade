/**
 * Floating typography toolbar for a single selected free-`text` element (schema v7).
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
  SIZE_PX,
  lineHeightFor,
  TEXT_DEFAULTS,
  type FontFamilyToken,
  type TextAlignToken
} from './textStyle'

/** The typography-only patch surface — narrower than Partial<TextElement> so the toolbar
 *  can NEVER write identity/geometry/text (id/kind/x/y/text) through the style channel. */
export type TextStylePatch = Partial<
  Pick<TextElement, 'fontFamily' | 'fontSize' | 'align' | 'color' | 'bold'>
>

export interface TextToolbarProps {
  element: TextElement
  /** Board-local content width (board.w) — used to clamp the bar inside the well. */
  boardW: number
  onPatch: (partial: TextStylePatch) => void
}

const FAMILY_GLYPH: Record<FontFamilyToken, string> = { sans: 'A', mono: '</>', serif: 'A' }
const ALIGN_GLYPH: Record<TextAlignToken, string> = { left: '⇤', center: '⇔', right: '⇥' }

/** Px the toolbar sits above the element (≈ its own height) AND the room-above threshold. */
const TOOLBAR_OFFSET = 40
/** Min px below the element's top when flipped down — clears a single M-size line. Larger
 *  tokens (L/XL) widen it to their own line height so the bar never overlaps the first line. */
const BELOW_OFFSET = 28
/** Conservative on-screen width of the full bar (15 buttons + groups/gaps/padding). The
 *  well clips overflow, so an element near the right edge would hide the rightmost
 *  controls; we clamp `left` against this. jsdom can't measure, so it's a constant. */
const TOOLBAR_WIDTH = 380

export function TextToolbar({ element, boardW, onPatch }: TextToolbarProps): ReactElement {
  const fam = element.fontFamily ?? TEXT_DEFAULTS.fontFamily
  const size = element.fontSize ?? TEXT_DEFAULTS.fontSize
  const align = element.align ?? TEXT_DEFAULTS.align
  const color = element.color ?? TEXT_DEFAULTS.color
  const bold = element.bold ?? TEXT_DEFAULTS.bold
  // Sit above the element; flip below when there's no room above — the content well
  // clips overflow at its top edge, so a negative top would hide the toolbar. The flip-down
  // offset clears the element's own first line (≥ M baseline). Multi-line text at the very
  // top edge — and the symmetric case of a flipped bar clipping a very short board's BOTTOM
  // edge — stay rare v1 edge cases (TODO: clamp `top` against board height when flipped).
  const belowOffset = Math.max(BELOW_OFFSET, lineHeightFor(SIZE_PX[size]))
  const top = element.y >= TOOLBAR_OFFSET ? element.y - TOOLBAR_OFFSET : element.y + belowOffset
  // Pull the bar left so it never clips at the well's right edge (no clamp needed when the
  // element leaves room); never below 0 so it can't slide off the left for a narrow board.
  const left = Math.max(0, Math.min(element.x, boardW - TOOLBAR_WIDTH))

  const btn = (active: boolean, extra = ''): string =>
    `pl-tt-btn${active ? ' is-active' : ''}${extra ? ' ' + extra : ''}`
  // Patch only on a real change — an active-button click is a no-op (no phantom undo step).
  const patchIf = (active: boolean, partial: TextStylePatch) => (): void => {
    if (!active) onPatch(partial)
  }

  return (
    <div
      className="pl-text-toolbar"
      style={{ position: 'absolute', left, top }}
      // Keep clicks off the well (which would clear selection / start a draw gesture).
      onPointerDown={(e) => e.stopPropagation()}
      // Keep the edited textarea focused when a control is pressed: a mousedown's default
      // would blur the textarea → the empty-text prune (FreeText.onBlur) could delete a
      // fresh, still-empty element mid-style. preventDefault holds focus; click still fires.
      onMouseDown={(e) => e.preventDefault()}
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
            onClick={patchIf(fam === f, { fontFamily: f })}
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
            onClick={patchIf(size === s, { fontSize: s })}
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
            onClick={patchIf(align === a, { align: a })}
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
            onClick={patchIf(color === c, { color: c })}
          />
        ))}
      </div>
    </div>
  )
}
