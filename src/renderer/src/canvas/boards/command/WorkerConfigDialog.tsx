/**
 * Worker config dialog (Phase C / C2d) — shown on every dispatch, AFTER the prompt is engineered and
 * BEFORE the worker terminal spawns. The user picks the agent + its launch flags (this is where
 * `--dangerously-skip-permissions` / `--yolo` / `--full-auto` live, so the worker boots past the
 * first-run "trust this folder?" gate straight to a ready REPL) and reviews/edits the engineered
 * instruction. On Dispatch the chosen `launchCommand` + (possibly edited) prompt are committed to the
 * task; the pump spawns it and hands off the prompt once the REPL is ready.
 *
 * Reuses the shipped terminal config building blocks — `AGENT_PRESETS` tiles + `CommandBuilder` +
 * `composeCommand` (same look as New Terminal) — over the shared Modal. Pre-fills from
 * `lastWorkerConfig` so repeated dispatches are a quick review-and-Dispatch.
 *
 * Orchestration Phase 0 adds the ROLE row: picking a pack (builder / code-reviewer / explorer /
 * planner) pre-fills the claude builder values from the pack's DATA (`packOptionValues` — model
 * tier, effort, permission posture) and commits `rolePackId` with the config so the dispatch
 * prepends the pack's role brief and the pump applies the write-role gate. "Custom" is the
 * pre-pack escape hatch (agent-agnostic, unchanged). Pack values stay user-editable — the pack is
 * the DEFAULT shape, the composed command remains the source of truth; switching the AGENT preset
 * drops back to Custom (packs are claude-hosted in Phase 0, Q8).
 */
import { useCallback, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { Modal } from '../../Modal'
import { Icon } from '../../Icon'
import { AGENT_PRESETS, presetById } from '../terminal/agentPresets'
import { CommandBuilder } from '../terminal/CommandBuilder'
import { composeCommand, type OptionValues } from '../terminal/composeCommand'
import {
  isWriteRolePack,
  packOptionValues,
  ROLE_PACKS,
  rolePackById,
  WRITE_ROLE_CONCURRENCY_CAP,
  type RolePack
} from '../../../lib/rolePacks'
import type { WorkerConfig } from '../../../store/commandStore'

const DEFAULT_PRESET = 'claude'
/**
 * First-dispatch defaults (no prior config): a Claude worker with `--dangerously-skip-permissions` on
 * (the `skip-permissions` toggle id). This clears the first-run "trust this folder?" gate so the
 * orchestrator's boot-settle lands the dispatched prompt at a ready REPL — and matches the autonomy an
 * orchestrated worker is dispatched to do. It's a `danger`-styled toggle the user can turn OFF; the
 * value is claude-specific (composeCommand ignores it for other presets, which reset on switch).
 */
const DEFAULT_WORKER_VALUES: OptionValues = { 'skip-permissions': true }

export function WorkerConfigDialog({
  zoneName,
  engineeredPrompt,
  initial,
  onDispatch,
  onCancel
}: {
  /** The smart zone/group name (the spawned group is named this). */
  zoneName: string
  /** The LLM-engineered instruction, shown editable. */
  engineeredPrompt: string
  /** Pre-fill from the last dispatch's config (null = first dispatch this session). */
  initial: WorkerConfig | null
  /** Commit: spawn the worker with `launchCommand` + hand off `prompt`; `config` is remembered. */
  onDispatch: (result: { launchCommand: string; prompt: string; config: WorkerConfig }) => void
  /** Dismiss without dispatching (the task stays queued-not-ready). */
  onCancel: () => void
}): ReactElement {
  const [presetId, setPresetId] = useState(initial?.presetId ?? DEFAULT_PRESET)
  const [values, setValues] = useState<OptionValues>(initial?.values ?? DEFAULT_WORKER_VALUES)
  const [rawOverride, setRawOverride] = useState<string | null>(initial?.rawOverride ?? null)
  const [rolePackId, setRolePackId] = useState<string | null>(initial?.rolePackId ?? null)
  const [prompt, setPrompt] = useState(engineeredPrompt)

  const preset = presetById(presetId) ?? AGENT_PRESETS[0]
  const composed = useMemo(() => composeCommand(preset, values), [preset, values])
  const command = rawOverride ?? composed
  const rolePack = rolePackById(rolePackId)

  const pickPreset = useCallback((id: string): void => {
    setPresetId(id)
    setValues({})
    setRawOverride(null)
    setRolePackId(null) // packs are claude-hosted in Phase 0 — an agent switch is a Custom choice
  }, [])

  /** Role row: a pack pre-fills the claude builder values from its data; null = Custom (as-is). */
  const pickRole = useCallback((pack: RolePack | null): void => {
    setRolePackId(pack ? pack.id : null)
    if (pack) {
      setPresetId(DEFAULT_PRESET)
      setValues(packOptionValues(pack))
      setRawOverride(null)
    }
  }, [])

  const onBuilderChange = useCallback((next: OptionValues): void => {
    setValues(next)
    setRawOverride(null)
  }, [])

  const dispatch = useCallback((): void => {
    onDispatch({
      launchCommand: command.trim(),
      prompt: prompt.trim() || engineeredPrompt,
      config: { presetId, values, rawOverride, rolePackId }
    })
  }, [command, prompt, engineeredPrompt, presetId, values, rawOverride, rolePackId, onDispatch])

  return (
    <Modal
      label="Configure worker"
      onClose={onCancel}
      zIndex={620}
      cardProps={{ 'data-testid': 'worker-config-dialog' }}
      cardStyle={card}
    >
      <div style={title}>Configure worker</div>
      <div style={zone}>
        Zone: <span style={zoneNameStyle}>{zoneName}</span>
      </div>

      <div>
        <div style={sectionLabel}>Role</div>
        <div style={roleRow}>
          <button
            type="button"
            onClick={() => pickRole(null)}
            style={rolePackId === null ? { ...roleChip, ...roleChipSel } : roleChip}
            data-testid="worker-role-custom"
            aria-pressed={rolePackId === null}
          >
            Custom
          </button>
          {ROLE_PACKS.map((p) => {
            const sel = p.id === rolePackId
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => pickRole(p)}
                style={sel ? { ...roleChip, ...roleChipSel } : roleChip}
                data-testid={`worker-role-${p.id}`}
                aria-pressed={sel}
              >
                {p.name}
              </button>
            )
          })}
        </div>
        {rolePack && (
          <div style={roleNote}>
            {isWriteRolePack(rolePack) ? 'write posture' : 'read-only posture'} · model{' '}
            {packOptionValues(rolePack).model} · role brief is prepended to the prompt on dispatch
          </div>
        )}
        {rolePack && isWriteRolePack(rolePack) && (
          <div style={roleWarn} data-testid="worker-role-write-warning">
            Write role — no workspace isolation yet: concurrent write workers are capped at{' '}
            {WRITE_ROLE_CONCURRENCY_CAP} (queued write tasks wait; read roles still dispatch).
          </div>
        )}
      </div>

      <div>
        <div style={sectionLabel}>Agent</div>
        <div style={presets}>
          {AGENT_PRESETS.map((p) => {
            const sel = p.id === presetId
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => pickPreset(p.id)}
                style={presetBtn}
                data-testid={`worker-preset-${p.id}`}
                aria-pressed={sel}
              >
                <span style={sel ? { ...tile, ...tileSel } : tile}>
                  <Icon name={p.glyph} size={20} />
                </span>
                <span style={sel ? { ...presetName, ...presetNameSel } : presetName}>
                  {p.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {preset.options && (
        <CommandBuilder
          key={preset.id}
          preset={preset}
          values={values}
          onChange={onBuilderChange}
        />
      )}

      <label style={fieldWrap}>
        <span style={fieldLabel}>
          {preset.options ? 'Command (composed, editable)' : 'Command'}
        </span>
        <input
          style={{ ...fld, fontFamily: 'var(--mono)' }}
          placeholder="e.g. claude --dangerously-skip-permissions  (blank = shell only)"
          spellCheck={false}
          value={command}
          onChange={(e) => setRawOverride(e.target.value)}
          data-testid="worker-command"
        />
      </label>

      <label style={fieldWrap}>
        <span style={fieldLabel}>Task prompt (engineered, editable)</span>
        <textarea
          style={promptArea}
          spellCheck={false}
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          data-testid="worker-prompt"
        />
      </label>

      <div style={footer}>
        <button type="button" style={btnGhost} onClick={onCancel} data-testid="worker-cancel">
          Cancel
        </button>
        <button type="button" style={btnPrimary} onClick={dispatch} data-testid="worker-dispatch">
          Dispatch
        </button>
      </div>
    </Modal>
  )
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
const zone: CSSProperties = { textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }
const zoneNameStyle: CSSProperties = { color: 'var(--accent)', fontWeight: 500 }
const sectionLabel: CSSProperties = {
  fontSize: 10,
  lineHeight: '14px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  marginBottom: 6
}
const roleRow: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap' }
const roleChip: CSSProperties = {
  height: 26,
  padding: '0 10px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-overlay)',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 11.5,
  cursor: 'pointer'
}
const roleChipSel: CSSProperties = {
  background: 'var(--accent-wash)',
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  fontWeight: 600
}
const roleNote: CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  lineHeight: '15px',
  color: 'var(--text-3)'
}
const roleWarn: CSSProperties = {
  marginTop: 4,
  fontSize: 11,
  lineHeight: '15px',
  color: 'var(--warn)'
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
  height: 44,
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
  colorScheme: 'dark'
}
const promptArea: CSSProperties = {
  padding: '8px 9px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  lineHeight: 1.45,
  outline: 'none',
  resize: 'vertical',
  colorScheme: 'dark'
}
const footer: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }
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
