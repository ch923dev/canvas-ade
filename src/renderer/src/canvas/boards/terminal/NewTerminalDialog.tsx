/**
 * New Terminal dialog (place-first flow): opens over a just-dropped terminal whose spawn
 * is held (`configPendingId`) until this resolves. Quick Start agent presets pre-fill the
 * launch command + set the board's `agentKind`; Details/Appearance tabs edit name / command
 * / cwd / monitor / font. Create applies the patch then releases the spawn (the gated spawn
 * effect mounts fresh and auto-spawns with the chosen command); Cancel/Esc releases it as a
 * plain shell. Built on the shared Modal (scrim + focus-trap + Esc).
 *
 * A1 ships the raw Command field (pre-filled per preset). The searchable per-agent command
 * builder is A2 — it composes into the same `launchCommand` string this field holds.
 */
import { useCallback, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { Modal } from '../../Modal'
import { Icon } from '../../Icon'
import { useCanvasStore } from '../../../store/canvasStore'
import type { TerminalBoard as TerminalBoardData } from '../../../lib/boardSchema'
import { AGENT_PRESETS, presetById } from './agentPresets'
import { CommandBuilder } from './CommandBuilder'
import { composeCommand, type OptionValues } from './composeCommand'
import {
  MIN_TERMINAL_FONT,
  MAX_TERMINAL_FONT,
  DEFAULT_TERMINAL_FONT,
  resolveInitialFont
} from './terminalFont'

const DEFAULT_PRESET = 'claude'

export function NewTerminalDialog({ board }: { board: TerminalBoardData }): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  const clearConfigPending = useCanvasStore((s) => s.clearConfigPending)

  const [presetId, setPresetId] = useState(DEFAULT_PRESET)
  const [tab, setTab] = useState<'details' | 'appearance'>('details')
  // A board dropped from the dock carries the default 'Terminal' title — start the Name
  // field empty (placeholder guides) rather than pre-filling that placeholder text.
  const [name, setName] = useState(board.title === 'Terminal' ? '' : board.title)
  // A2: structured builder values per option id; the command is composed from them. A manual
  // edit of the command field sets `rawOverride` and wins until a builder control recomposes.
  const [values, setValues] = useState<OptionValues>({})
  const [rawOverride, setRawOverride] = useState<string | null>(null)
  const [cwd, setCwd] = useState(board.cwd ?? '')
  const [monitor, setMonitor] = useState(true)
  const seedFont = resolveInitialFont(board.fontSize)
  const [font, setFont] = useState(seedFont)

  const preset = presetById(presetId) ?? AGENT_PRESETS[0]
  const composed = useMemo(() => composeCommand(preset, values), [preset, values])
  // The final launch command: a manual raw edit overrides the composed value.
  const command = rawOverride ?? composed

  // Switching preset resets the builder + any raw override (the new agent owns the command).
  const pickPreset = useCallback((id: string): void => {
    setPresetId(id)
    setValues({})
    setRawOverride(null)
  }, [])

  // A builder control change recomposes from values — it takes back control from a manual edit.
  const onBuilderChange = useCallback((next: OptionValues): void => {
    setValues(next)
    setRawOverride(null)
  }, [])

  const create = useCallback((): void => {
    beginChange()
    updateBoard(board.id, {
      title: name.trim() || board.title,
      agentKind: presetId,
      launchCommand: command.trim() || undefined,
      cwd: cwd.trim() || undefined,
      // Absent monitorActivity reads as `true`, so only persist the opt-out.
      ...(monitor ? {} : { monitorActivity: false }),
      // Only persist a font that differs from the sticky default seed (else follow it).
      ...(font !== seedFont ? { fontSize: font } : {})
    })
    clearConfigPending()
  }, [
    beginChange,
    updateBoard,
    clearConfigPending,
    board.id,
    board.title,
    name,
    presetId,
    command,
    cwd,
    monitor,
    font,
    seedFont
  ])

  // Cancel / Esc / scrim: release the spawn as a plain shell (no patch).
  const cancel = useCallback((): void => clearConfigPending(), [clearConfigPending])

  return (
    <Modal
      label="New Terminal"
      onClose={cancel}
      zIndex={600}
      scrimProps={{ 'data-test': 'new-terminal-scrim' }}
      cardProps={{ 'data-test': 'new-terminal-dialog' }}
      cardStyle={card}
    >
      <div style={title}>New Terminal</div>

      <div>
        <div style={sectionLabel}>Quick start</div>
        <div style={presets}>
          {AGENT_PRESETS.map((p) => {
            const sel = p.id === presetId
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => pickPreset(p.id)}
                style={presetBtn}
                data-test={`preset-${p.id}`}
                aria-pressed={sel}
              >
                <span style={sel ? { ...tile, ...tileSel } : tile}>
                  <Icon name={p.glyph} size={22} />
                </span>
                <span style={sel ? { ...presetName, ...presetNameSel } : presetName}>
                  {p.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div style={seg}>
        <button
          type="button"
          style={tab === 'details' ? segOn : segBtn}
          onClick={() => setTab('details')}
        >
          Details
        </button>
        <button
          type="button"
          style={tab === 'appearance' ? segOn : segBtn}
          onClick={() => setTab('appearance')}
        >
          Appearance
        </button>
      </div>

      {tab === 'details' ? (
        <>
          <Field label="Name">
            <input
              style={fld}
              placeholder="What this terminal is for"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={ringOn}
              onBlur={ringOff}
            />
          </Field>
          {preset.options && (
            <CommandBuilder preset={preset} values={values} onChange={onBuilderChange} />
          )}
          <Field label={preset.options ? 'Command (composed, editable)' : 'Command'}>
            <input
              style={{ ...fld, fontFamily: 'var(--mono)' }}
              placeholder="e.g. claude  (blank = shell only)"
              spellCheck={false}
              value={command}
              onChange={(e) => setRawOverride(e.target.value)}
              onFocus={ringOn}
              onBlur={ringOff}
              data-test="new-terminal-command"
            />
          </Field>
          <Field label="Working dir">
            <input
              style={{ ...fld, fontFamily: 'var(--mono)' }}
              placeholder="(blank = project folder)"
              spellCheck={false}
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              onFocus={ringOn}
              onBlur={ringOff}
            />
          </Field>
          <button
            type="button"
            style={check}
            onClick={() => setMonitor((m) => !m)}
            aria-pressed={monitor}
            data-test="new-terminal-monitor"
          >
            <span style={monitor ? { ...box, ...boxOn } : box}>
              {monitor && <Icon name="check" size={11} style={{ color: 'var(--void)' }} />}
            </span>
            <span style={checkLbl}>Monitor activity</span>
            <span style={checkHint}>status &amp; recap · joins the swarm</span>
          </button>
        </>
      ) : (
        <Field label="Font size">
          <div style={fontRow}>
            <button
              type="button"
              style={{ ...stepBtn, ...(font <= MIN_TERMINAL_FONT ? stepOff : null) }}
              onClick={() => setFont((f) => Math.max(MIN_TERMINAL_FONT, f - 1))}
              disabled={font <= MIN_TERMINAL_FONT}
            >
              A{'−'}
            </button>
            <span style={fontVal}>
              {font === DEFAULT_TERMINAL_FONT ? `${font} (default)` : font}
            </span>
            <button
              type="button"
              style={{ ...stepBtn, ...(font >= MAX_TERMINAL_FONT ? stepOff : null) }}
              onClick={() => setFont((f) => Math.min(MAX_TERMINAL_FONT, f + 1))}
              disabled={font >= MAX_TERMINAL_FONT}
            >
              A+
            </button>
          </div>
        </Field>
      )}

      <div style={footer}>
        <button type="button" style={btnGhost} onClick={cancel} data-test="new-terminal-cancel">
          Cancel
        </button>
        <button type="button" style={btnPrimary} onClick={create} data-test="new-terminal-create">
          Create
        </button>
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      {children}
    </label>
  )
}

// Inline-styled fields can't use :focus-visible — mirror the §6 select-ring on focus/blur
// (matches TerminalConfig's ringOn/ringOff).
const ringOn = (e: { currentTarget: HTMLElement }): void => {
  e.currentTarget.style.boxShadow = '0 0 0 1.5px var(--accent)'
}
const ringOff = (e: { currentTarget: HTMLElement }): void => {
  e.currentTarget.style.boxShadow = ''
}

const card: CSSProperties = {
  width: 396,
  maxWidth: '90vw',
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 13
}
const title: CSSProperties = {
  textAlign: 'center',
  fontSize: 15,
  lineHeight: '22px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--text)'
}
const sectionLabel: CSSProperties = {
  fontSize: 10,
  lineHeight: '14px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  marginBottom: 6
}
const presets: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'space-between' }
const presetBtn: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 5,
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer'
}
const tile: CSSProperties = {
  width: '100%',
  maxWidth: 54,
  height: 46,
  borderRadius: 'var(--r-inner)',
  background: 'var(--surface-overlay)',
  border: '1px solid var(--border-subtle)',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--text-2)'
}
const tileSel: CSSProperties = {
  background: 'var(--accent-wash)',
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  boxShadow: '0 0 0 1px var(--accent)'
}
const presetName: CSSProperties = {
  fontSize: 11,
  lineHeight: '13px',
  color: 'var(--text-3)',
  textAlign: 'center'
}
const presetNameSel: CSSProperties = { color: 'var(--text-2)' }
const seg: CSSProperties = {
  alignSelf: 'center',
  display: 'inline-flex',
  gap: 2,
  padding: 2,
  background: 'var(--inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)'
}
const segBtn: CSSProperties = {
  height: 24,
  padding: '0 14px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--text-3)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  cursor: 'pointer'
}
const segOn: CSSProperties = {
  ...segBtn,
  background: 'var(--accent-wash)',
  color: 'var(--accent)',
  fontWeight: 500
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
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  outline: 'none'
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
const checkLbl: CSSProperties = { fontSize: 12.5, color: 'var(--text)' }
const checkHint: CSSProperties = { fontSize: 11, color: 'var(--text-3)' }
const fontRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const stepBtn: CSSProperties = {
  height: 28,
  width: 36,
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 13,
  cursor: 'pointer'
}
const stepOff: CSSProperties = { opacity: 0.35, cursor: 'default' }
const fontVal: CSSProperties = {
  minWidth: 80,
  textAlign: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--text-2)'
}
const footer: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 2
}
const btnGhost: CSSProperties = {
  height: 30,
  padding: '0 14px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  cursor: 'pointer'
}
const btnPrimary: CSSProperties = {
  ...btnGhost,
  border: '1px solid var(--accent)',
  background: 'var(--accent-wash)',
  color: 'var(--accent)',
  fontWeight: 600
}
