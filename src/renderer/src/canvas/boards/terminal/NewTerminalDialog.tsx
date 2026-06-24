/**
 * Terminal config dialog — one modal for BOTH creating and editing a terminal.
 *
 * - `mode: 'create'` (place-first flow): opens over a just-dropped terminal whose spawn is
 *   held (`configPendingId`) until this resolves. The primary button is "Create"; on apply
 *   the parent's `onClose` clears the held flag and the gated spawn effect mounts fresh and
 *   auto-spawns with the chosen command. Cancel/Esc releases it as a plain shell.
 * - `mode: 'edit'` (⚙ / first-run hint): opens over a LIVE terminal, pre-filled from the
 *   board. The primary button is "Apply & restart"; on apply the patch to shell/launchCommand/
 *   cwd re-runs TerminalBoard's spawn effect and respawns. Cancel/Esc just closes (no patch).
 *
 * Quick Start agent presets set the board's `agentKind` and pre-fill the launch command; the
 * searchable per-agent command builder (CommandBuilder) composes into the same editable
 * `launchCommand` string the Command field holds (the raw field stays the source of truth +
 * escape hatch — in edit mode it pre-fills with the board's existing command). Built on the
 * shared Modal (scrim + focus-trap + Esc), so explicit Cancel/Apply replace the old non-modal
 * popover's unsaved-changes guard.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
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
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  SCROLLBACK_PRESETS,
  resolveInitialScrollback,
  writeStickyScrollback
} from './terminalScrollback'

const DEFAULT_PRESET = 'claude'

type ShellInfo = Awaited<ReturnType<typeof window.api.listShells>>[number]

export function NewTerminalDialog({
  board,
  mode = 'create',
  onClose
}: {
  board: TerminalBoardData
  /** 'create' = place-first held spawn; 'edit' = reconfigure a live terminal. */
  mode?: 'create' | 'edit'
  /** Close the dialog. For create the host clears the held spawn; for edit it hides it. */
  onClose: () => void
}): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  const editing = mode === 'edit'

  // Edit pre-fills from the board; create starts from the defaults. An edit of a board with no
  // agentKind (MCP-spawned / pre-v10) falls back to the raw 'shell' preset (command-only).
  const [presetId, setPresetId] = useState(
    editing && board.agentKind && presetById(board.agentKind)
      ? board.agentKind
      : editing
        ? 'shell'
        : DEFAULT_PRESET
  )
  const [tab, setTab] = useState<'details' | 'appearance'>('details')
  // Create: a dock-dropped board carries the default 'Terminal' title → start Name empty
  // (the placeholder guides). Edit: show the board's actual current title.
  const [name, setName] = useState(
    editing ? board.title : board.title === 'Terminal' ? '' : board.title
  )
  // A2: structured builder values per option id; the command is composed from them. A manual
  // edit of the command field sets `rawOverride` and wins until a builder control recomposes.
  // Edit seeds the raw override with the board's existing command (shown as-is, editable).
  const [values, setValues] = useState<OptionValues>({})
  const [rawOverride, setRawOverride] = useState<string | null>(
    editing ? (board.launchCommand ?? null) : null
  )
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [shell, setShell] = useState(board.shell ?? '')
  const [cwd, setCwd] = useState(board.cwd ?? '')
  // Absent monitorActivity reads as true, so default the toggle on unless explicitly opted out.
  const [monitor, setMonitor] = useState(board.monitorActivity !== false)
  const seedFont = resolveInitialFont(board.fontSize)
  const [font, setFont] = useState(seedFont)
  // Scrollback: seed from the board pin else the sticky default. The dialog is scrollback's ONLY
  // entry point (no in-terminal gesture like font's Ctrl+/-), so apply both pins the board AND
  // writes the sticky default for the next new terminal.
  const seedScrollback = resolveInitialScrollback(board.scrollback)
  const [scrollback, setScrollback] = useState(seedScrollback)

  // Shell list (OS-aware). Only PERSIST a shell the user actually picked: the select auto-seeds
  // to list[0] for display when the board has no explicit shell, but persisting that auto-seed
  // would flip board.shell undefined → default and respawn on a label-only apply (TerminalConfig #9).
  const shellTouched = useRef(false)
  const seededShell = useRef(board.shell)
  useEffect(() => {
    let live = true
    void window.api.listShells().then((list) => {
      if (!live) return
      setShells(list)
      if (!seededShell.current && list[0]) setShell(list[0].path)
    })
    return () => {
      live = false
    }
  }, [])

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

  const apply = useCallback((): void => {
    beginChange()
    updateBoard(board.id, {
      title: name.trim() || board.title,
      agentKind: presetId,
      // Only persist `shell` when the user explicitly chose one (see shellTouched above).
      ...(shellTouched.current ? { shell: shell || undefined } : {}),
      launchCommand: command.trim() || undefined,
      cwd: cwd.trim() || undefined,
      // Create omits the key when monitoring is on (stays absent = true); edit writes the
      // explicit boolean so the user can toggle it back ON after a prior opt-out.
      ...(editing ? { monitorActivity: monitor } : monitor ? {} : { monitorActivity: false }),
      // Only pin a font/scrollback that differs from the seed (else follow the sticky default).
      ...(font !== seedFont ? { fontSize: font } : {}),
      ...(scrollback !== seedScrollback ? { scrollback } : {})
    })
    // Scrollback's only entry point is this dialog → it owns the sticky new-terminal default.
    if (scrollback !== seedScrollback) writeStickyScrollback(scrollback)
    onClose()
  }, [
    beginChange,
    updateBoard,
    board.id,
    board.title,
    name,
    presetId,
    shell,
    command,
    cwd,
    monitor,
    font,
    seedFont,
    scrollback,
    seedScrollback,
    editing,
    onClose
  ])

  return (
    <Modal
      label={editing ? 'Terminal Settings' : 'New Terminal'}
      onClose={onClose}
      zIndex={600}
      scrimProps={{ 'data-test': 'new-terminal-scrim' }}
      cardProps={{ 'data-test': 'new-terminal-dialog' }}
      cardStyle={card}
    >
      <div style={title}>{editing ? 'Terminal Settings' : 'New Terminal'}</div>

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
          <Field label="Shell">
            <select
              style={fld}
              value={shell}
              onChange={(e) => {
                shellTouched.current = true
                setShell(e.target.value)
              }}
              onFocus={ringOn}
              onBlur={ringOff}
            >
              {shells.map((s) => (
                <option key={s.path} value={s.path} style={shellOpt}>
                  {s.label}
                  {s.default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </Field>
          {preset.options && (
            <CommandBuilder
              key={preset.id}
              preset={preset}
              values={values}
              onChange={onBuilderChange}
            />
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
        <>
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
          <Field label="Scrollback">
            <>
              <div style={sbRow} data-test="terminal-scrollback">
                {SCROLLBACK_PRESETS.map((n) => {
                  const on = scrollback === n
                  return (
                    <button
                      key={n}
                      type="button"
                      style={on ? { ...sbChip, ...sbChipOn } : sbChip}
                      onClick={() => setScrollback(n)}
                      aria-pressed={on}
                      data-test={`scrollback-${n}`}
                    >
                      {n.toLocaleString()}
                      {n === DEFAULT_TERMINAL_SCROLLBACK && <span style={sbSub}>default</span>}
                    </button>
                  )
                })}
              </div>
              <span style={sbHint}>
                Lines of output kept above the viewport. More history stays searchable, using more
                memory.
              </span>
            </>
          </Field>
        </>
      )}

      <div style={footer}>
        <button type="button" style={btnGhost} onClick={onClose} data-test="new-terminal-cancel">
          Cancel
        </button>
        <button type="button" style={btnPrimary} onClick={apply} data-test="new-terminal-create">
          {editing ? 'Apply & restart' : 'Create'}
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
  width: 460,
  maxWidth: '92vw',
  maxHeight: '92vh',
  overflowY: 'auto',
  scrollbarWidth: 'thin',
  scrollbarColor: 'var(--border-strong) transparent',
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
  outline: 'none',
  // Render the native Shell dropdown popup with dark chrome (harmless for the text inputs).
  colorScheme: 'dark'
}
// Explicit per-option colors so the native Shell popup is always readable on dark.
const shellOpt: CSSProperties = { background: 'var(--surface-overlay)', color: 'var(--text)' }
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
const sbRow: CSSProperties = { display: 'flex', gap: 6 }
const sbChip: CSSProperties = {
  flex: 1,
  height: 32,
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1.1
}
const sbChipOn: CSSProperties = {
  background: 'var(--accent-wash)',
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  boxShadow: '0 0 0 1px var(--accent)'
}
const sbSub: CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  opacity: 0.85,
  marginTop: 1
}
const sbHint: CSSProperties = {
  fontSize: 11,
  lineHeight: '15px',
  color: 'var(--text-3)',
  marginTop: 2
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
