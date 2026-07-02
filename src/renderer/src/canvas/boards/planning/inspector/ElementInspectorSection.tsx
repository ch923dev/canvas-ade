/**
 * The Planning inspector's ELEMENT section (P4) — the always-visible mirror of the on-board
 * TextToolbar (typography) + the right-click ElementContextMenu (tint / lock / group / align /
 * distribute / duplicate / send-to-board / delete). Presentation only: every control drives a
 * callback the board already owns, packaged by `usePlanningElementInspector`. Rendered at the TOP of
 * the inspector (above Tools/Canvas) whenever ≥1 element is selected with the select tool.
 *
 * Gating (decision 3): typography shows for a homogeneous TEXT selection, tint for a homogeneous NOTE
 * selection, align/distribute for ≥2 elements; the shared actions always show. The tint / align /
 * distribute rows render the SAME MenuEntry objects the context menu uses — one action model, two
 * surfaces, zero drift.
 */
import type { ReactElement } from 'react'
import { Icon, type IconName } from '../../../Icon'
import {
  InspectorAction,
  InspectorIconButtons,
  InspectorRow,
  InspectorSection,
  InspectorSegmented,
  InspectorSlider,
  InspectorSwatches,
  InspectorToggle
} from '../../../inspector/primitives'
import {
  STROKE_COLOR_TOKENS,
  STROKE_WIDTH_TOKENS,
  OPACITY_MAX,
  type StrokeColorToken,
  type StrokeWidthToken
} from '../strokeStyle'
import type {
  MenuActionEntry,
  MenuEntry,
  MenuIconRowEntry,
  MenuSwatchRowEntry
} from '../ElementContextMenu'
import {
  COLOR_CSS,
  FONT_FAMILY_TOKENS,
  FONT_SIZE_TOKENS,
  TEXT_ALIGN_TOKENS,
  TEXT_COLOR_TOKENS,
  type FontFamilyToken,
  type TextAlignToken,
  type TextColorToken
} from '../textStyle'
import type { ElementInspectorModel } from './usePlanningElementInspector'

const FONT_LABEL: Record<FontFamilyToken, string> = { sans: 'Sans', mono: 'Mono', serif: 'Serif' }
const ALIGN_LABEL: Record<TextAlignToken, string> = {
  left: 'Left',
  center: 'Center',
  right: 'Right'
}
const COLOR_LABEL: Record<TextColorToken, string> = {
  default: 'Default',
  muted: 'Muted',
  faint: 'Faint',
  accent: 'Accent'
}

// P4b Appearance presentation maps. The swatch FILL is the display colour (the `default` token shows
// the arrow's legacy border-strong ink); labels drive the a11y titles.
const STROKE_SWATCH_CSS: Record<StrokeColorToken, string> = {
  default: 'var(--border-strong)',
  white: 'var(--text)',
  accent: 'var(--accent)',
  green: 'var(--ok)',
  amber: 'var(--warn)'
}
const STROKE_COLOR_LABEL: Record<StrokeColorToken, string> = {
  default: 'Default',
  white: 'White',
  accent: 'Accent',
  green: 'Green',
  amber: 'Amber'
}
const STROKE_WIDTH_LABEL: Record<StrokeWidthToken, string> = { s: 'S', m: 'M', l: 'L' }

// Z-order button glyphs (to-front / forward / backward / to-back). The Icon set has no layer/order
// icons, so these use arrow marks; the `title` carries the accessible name.
const Z_ORDER_BUTTONS = [
  { id: 'front', title: 'Bring to front', glyph: '⤒' },
  { id: 'forward', title: 'Bring forward', glyph: '↑' },
  { id: 'backward', title: 'Send backward', glyph: '↓' },
  { id: 'back', title: 'Send to back', glyph: '⤓' }
] as const

/** Typed entry lookups — the ids are fixed by contextMenuEntries; guard defensively (a missing entry
 *  simply omits its control rather than throwing). */
function action(entries: MenuEntry[], id: string): MenuActionEntry | null {
  const e = entries.find((x) => x.id === id)
  return e?.kind === 'action' ? e : null
}
function swatchRow(entries: MenuEntry[], id: string): MenuSwatchRowEntry | null {
  const e = entries.find((x) => x.id === id)
  return e?.kind === 'swatchRow' ? e : null
}
function iconRow(entries: MenuEntry[], id: string): MenuIconRowEntry | null {
  const e = entries.find((x) => x.id === id)
  return e?.kind === 'iconRow' ? e : null
}

/** One shared action rendered as a grid/row button (no-op-safe: disabled entries don't fire). */
function ActionButton({
  entry,
  icon,
  label
}: {
  entry: MenuActionEntry | null
  icon?: ReactElement
  label?: string
}): ReactElement | null {
  if (!entry) return null
  return (
    <InspectorAction
      onClick={entry.onSelect}
      disabled={entry.disabled}
      danger={entry.danger}
      icon={icon}
      dataTest={`plan-el-${entry.id}`}
    >
      {label ?? entry.label}
    </InspectorAction>
  )
}

export function ElementInspectorSection({ model }: { model: ElementInspectorModel }): ReactElement {
  const { typography, entries, appearance } = model
  const tint = model.showTint ? swatchRow(entries, 'tint') : null
  const align = model.showArrange ? iconRow(entries, 'align') : null
  const distribute = model.showArrange ? iconRow(entries, 'distribute') : null
  const ungroup = action(entries, 'ungroup')

  const countChip = (
    <span className="ca-inspector-count" data-mixed={model.mixed || undefined}>
      {model.count}
    </span>
  )

  return (
    <InspectorSection
      label={`Element · ${model.kindLabel}`}
      persistKey="planning.element"
      aside={countChip}
    >
      {/* Typography — homogeneous text only. No-op-gated: re-selecting the active token never emits
          (mirrors the on-board TextToolbar), so it can't push a phantom undo step. */}
      {typography && (
        <>
          <InspectorRow label="Font">
            <InspectorSegmented<FontFamilyToken>
              value={(typography.current.fontFamily ?? '') as FontFamilyToken}
              options={FONT_FAMILY_TOKENS.map((f) => ({ value: f, label: FONT_LABEL[f] }))}
              onChange={(v) =>
                v !== typography.current.fontFamily && typography.apply({ fontFamily: v })
              }
              fill
              ariaLabel="Font family"
            />
          </InspectorRow>
          <InspectorRow label="Size">
            <InspectorSegmented
              value={(typography.current.fontSize ?? '') as (typeof FONT_SIZE_TOKENS)[number]}
              options={FONT_SIZE_TOKENS.map((s) => ({ value: s, label: s }))}
              onChange={(v) =>
                v !== typography.current.fontSize && typography.apply({ fontSize: v })
              }
              fill
              ariaLabel="Font size"
            />
          </InspectorRow>
          <InspectorRow label="Align">
            <InspectorSegmented<TextAlignToken>
              value={(typography.current.align ?? '') as TextAlignToken}
              options={TEXT_ALIGN_TOKENS.map((a) => ({ value: a, label: ALIGN_LABEL[a] }))}
              onChange={(v) => v !== typography.current.align && typography.apply({ align: v })}
              fill
              ariaLabel="Text align"
            />
          </InspectorRow>
          <InspectorRow label="Bold">
            <InspectorToggle
              checked={typography.current.bold}
              onChange={(next) => typography.apply({ bold: next })}
              ariaLabel="Bold"
            />
          </InspectorRow>
          <InspectorRow label="Color">
            <InspectorSwatches
              ariaLabel="Text color"
              swatches={TEXT_COLOR_TOKENS.map((c) => ({
                id: c,
                fill: COLOR_CSS[c],
                title: COLOR_LABEL[c],
                current: typography.current.color === c
              }))}
              onPick={(id) =>
                id !== typography.current.color && typography.apply({ color: id as TextColorToken })
              }
            />
          </InspectorRow>
        </>
      )}

      {/* Tint — homogeneous note only. Renders the context menu's swatchRow entry verbatim. */}
      {tint && (
        <InspectorRow label="Tint">
          <InspectorSwatches
            ariaLabel="Note tint"
            disabled={tint.disabled}
            swatches={tint.swatches.map((s) => ({
              id: s.id,
              fill: s.fill,
              edge: s.edge,
              title: s.title,
              current: s.current,
              glyph: s.id === 'plain' ? '∅' : undefined
            }))}
            onPick={(id) => tint.swatches.find((s) => s.id === id)?.onSelect()}
          />
        </InspectorRow>
      )}

      {/* Appearance (P4b) — a sub-block under the per-kind rows, above Arrange. Opacity for ALL kinds;
          Stroke colour + width only for an all-line selection (arrow / pen); Z-order (4) for all. */}
      <div className="ca-inspector-subhd">Appearance</div>
      <InspectorRow label="Opacity">
        <InspectorSlider
          value={appearance.opacity ?? OPACITY_MAX}
          onChange={appearance.setOpacity}
          ariaLabel="Element opacity"
          valueText={
            appearance.opacity == null ? 'Mixed' : `${Math.round(appearance.opacity * 100)}%`
          }
        />
        <span className="ca-inspector-slider-val" aria-hidden>
          {appearance.opacity == null ? 'Mixed' : `${Math.round(appearance.opacity * 100)}%`}
        </span>
      </InspectorRow>
      {appearance.showStroke && (
        <>
          <InspectorRow label="Stroke">
            <InspectorSwatches
              ariaLabel="Stroke color"
              swatches={STROKE_COLOR_TOKENS.map((t) => ({
                id: t,
                fill: STROKE_SWATCH_CSS[t],
                title: STROKE_COLOR_LABEL[t],
                current: appearance.strokeColor === t
              }))}
              onPick={(id) => appearance.setStrokeColor(id as StrokeColorToken)}
            />
          </InspectorRow>
          <InspectorRow label="Width">
            <InspectorSegmented<StrokeWidthToken>
              value={(appearance.strokeWidth ?? '') as StrokeWidthToken}
              options={STROKE_WIDTH_TOKENS.map((w) => ({ value: w, label: STROKE_WIDTH_LABEL[w] }))}
              onChange={appearance.setStrokeWidth}
              fill
              ariaLabel="Stroke width"
            />
          </InspectorRow>
        </>
      )}
      <InspectorRow label="Order">
        <InspectorIconButtons
          ariaLabel="Z-order"
          buttons={Z_ORDER_BUTTONS.map((b) => ({
            id: b.id,
            title: b.title,
            icon: <span aria-hidden>{b.glyph}</span>,
            onSelect:
              b.id === 'front'
                ? appearance.bringToFront
                : b.id === 'forward'
                  ? appearance.bringForward
                  : b.id === 'backward'
                    ? appearance.sendBackward
                    : appearance.sendToBack
          }))}
        />
      </InspectorRow>

      {/* Shared arrange actions — a 2-up cluster. Ungroup only surfaces when the selection is grouped
          (the context menu keeps it always-visible; the inspector hides the dead affordance). */}
      <div className="ca-inspector-actgrid">
        <ActionButton entry={action(entries, 'lock')} />
        <ActionButton entry={action(entries, 'group')} />
        <ActionButton entry={action(entries, 'duplicate')} />
        <ActionButton entry={action(entries, 'send-to-board')} label="Send…" />
      </div>
      {ungroup && !ungroup.disabled && <ActionButton entry={ungroup} />}

      {/* Align / distribute — ≥2 elements. Same icon entries as the menu (distribute self-disables
          under 3 via its own entry.disabled). */}
      {align && (
        <InspectorRow label="Align">
          <InspectorIconButtons
            ariaLabel="Align"
            disabled={align.disabled}
            buttons={align.buttons.map((b) => ({
              id: b.id,
              title: b.title,
              icon: <Icon name={b.icon as IconName} size={14} />,
              onSelect: b.onSelect
            }))}
          />
        </InspectorRow>
      )}
      {distribute && (
        <InspectorRow label="Distribute">
          <InspectorIconButtons
            ariaLabel="Distribute"
            disabled={distribute.disabled}
            buttons={distribute.buttons.map((b) => ({
              id: b.id,
              title: b.title,
              icon: <Icon name={b.icon as IconName} size={14} />,
              onSelect: b.onSelect
            }))}
          />
        </InspectorRow>
      )}

      <ActionButton entry={action(entries, 'delete')} icon={<Icon name="trash" size={14} />} />
    </InspectorSection>
  )
}
