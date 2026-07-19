/**
 * "Route via OpenRouter" section of the New Terminal dialog (v20, maintainer-private —
 * compile-gated __TERMINAL_OPENROUTER__ via featureFlags). Renders NULL in every ungated
 * build (the whole subtree DCEs out) and for presets whose CLI can't honour the injected
 * env (OPENROUTER_CAPABLE_PRESETS). Owns the reveal UI + the per-provider key-status row;
 * the enabled/model VALUE lives in the dialog (its Apply persists the board patch and the
 * composed command overlays the slug via applyOpenRouterModel). The key itself is never
 * seen here — presence only, over llm:hasKey.
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { Icon } from '../../Icon'
import { isTerminalOpenRouterEnabled } from '../../../lib/featureFlags'
import { OPENROUTER_CAPABLE_PRESETS } from './composeCommand'

const OPENROUTER_UI = isTerminalOpenRouterEnabled()

export interface OpenRouterValue {
  enabled: boolean
  model: string
}

export function OpenRouterSection({
  presetId,
  value,
  onChange
}: {
  presetId: string
  value: OpenRouterValue
  onChange: (next: OpenRouterValue) => void
}): ReactElement | null {
  // Key presence for the status row, checked when the section is revealed. Presence only —
  // the key never crosses IPC (llm:hasKey); null = check pending (no row flashes). A live
  // setKey in Settings is picked up on the next reveal (the dialog is transient).
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const enabled = value.enabled
  useEffect(() => {
    if (!OPENROUTER_UI || !enabled) return undefined
    let live = true
    void window.api.llm.hasKey({ provider: 'openrouter' }).then((has) => {
      if (live) setHasKey(has)
    })
    return () => {
      live = false
    }
  }, [enabled])

  if (!OPENROUTER_UI || !OPENROUTER_CAPABLE_PRESETS.has(presetId)) return null
  return (
    <div style={wrap}>
      <button
        type="button"
        style={check}
        onClick={() => onChange({ ...value, enabled: !value.enabled })}
        aria-pressed={value.enabled}
        data-test="new-terminal-openrouter"
      >
        <span style={value.enabled ? { ...box, ...boxOn } : box}>
          {value.enabled && <Icon name="check" size={11} style={{ color: 'var(--void)' }} />}
        </span>
        <span style={lbl}>Route via OpenRouter</span>
        <span style={hint}>env · key never stored here</span>
      </button>
      {value.enabled && (
        <div style={reveal}>
          <label style={fieldWrap}>
            <span style={fieldLabel}>Model</span>
            <input
              style={fld}
              placeholder={
                presetId === 'opencode'
                  ? 'e.g. moonshotai/kimi-k2'
                  : 'e.g. anthropic/claude-sonnet-4.5'
              }
              spellCheck={false}
              value={value.model}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
              data-test="openrouter-model"
            />
          </label>
          {hasKey === true && (
            <div style={keyRow} data-test="openrouter-key-ok">
              <span style={dotOk} />
              OpenRouter key saved · injected as env at launch
            </div>
          )}
          {hasKey === false && (
            <div style={{ ...keyRow, ...keyWarn }} data-test="openrouter-key-missing">
              <span style={dotWarn} />
              No OpenRouter key saved, terminal launches without routing. Add one in Settings ›
              Context · LLM.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Mirrors the dialog's Monitor-activity row + Field styles (mock-approved layout, 2026-07-19):
// a light top-border groups the section like CommandBuilder's wrap; the reveal indents under
// the checkbox.
const wrap: CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 9
}
const check: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left'
}
const box: CSSProperties = {
  width: 16,
  height: 16,
  flex: 'none',
  borderRadius: 4,
  border: '1px solid var(--border-strong)',
  background: 'transparent',
  display: 'grid',
  placeItems: 'center'
}
const boxOn: CSSProperties = { background: 'var(--accent)', borderColor: 'var(--accent)' }
const lbl: CSSProperties = { fontSize: 12.5, color: 'var(--text)' }
const hint: CSSProperties = { fontSize: 11, color: 'var(--text-3)' }
const reveal: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  paddingLeft: 24
}
const fieldWrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const fieldLabel: CSSProperties = { fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }
const fld: CSSProperties = {
  height: 30,
  padding: '0 9px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: 12.5,
  outline: 'none'
}
const keyRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 11,
  lineHeight: '15px',
  color: 'var(--text-2)',
  borderRadius: 'var(--r-ctl)'
}
const keyWarn: CSSProperties = {
  color: 'var(--warn)',
  background: 'var(--warn-wash)',
  padding: '5px 8px'
}
const dotOk: CSSProperties = {
  width: 8,
  height: 8,
  flex: 'none',
  borderRadius: '50%',
  background: 'var(--ok)'
}
const dotWarn: CSSProperties = { ...dotOk, background: 'var(--warn)' }
