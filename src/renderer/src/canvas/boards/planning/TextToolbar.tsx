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
  // Sit above the element; flip below when there's no room above — the content well
  // clips overflow at its top edge, so a negative top would hide the toolbar. The
  // below offset (28) clears a single text line; multi-line text at the very top edge
  // is a rare v1 edge case.
  const top = element.y >= 40 ? element.y - 40 : element.y + 28

  const btn = (active: boolean, extra = ''): string =>
    `pl-tt-btn${active ? ' is-active' : ''}${extra ? ' ' + extra : ''}`
  // Patch only on a real change — an active-button click is a no-op (no phantom undo step).
  const patchIf = (active: boolean, partial: Partial<TextElement>) => (): void => {
    if (!active) onPatch(partial)
  }

  return (
    <div
      className="pl-text-toolbar"
      style={{ position: 'absolute', left: element.x, top }}
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
