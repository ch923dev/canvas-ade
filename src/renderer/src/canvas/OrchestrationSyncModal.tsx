/**
 * Agent Orchestration — Sync modal (mock Step 2, `.claude/mocks/agent-orchestration-modal-mock.*`).
 *
 * The "apply" half of the two-step flow: push this canvas's LIVE loopback endpoint + bearer into
 * every detected agent CLI's own MCP config + the project, so a terminal agent can actually reach
 * Expanse's MCP. Re-runnable + idempotent; the same write also auto-fires on terminal start (the
 * spawn-time hook), which is why a stale-after-restart endpoint self-heals.
 *
 * PRESENTATIONAL on purpose: it takes the status + an `onSync` callback as props and owns only the
 * selection + per-row result UI. The IPC that produces `status` and runs the provisioners lives in
 * MAIN (`src/main/cliProvisioners/*`) and is wired by the onboarding lane's AppChrome host — so
 * this component is unit-testable and dev-checkable with mock props, and never touches `window.api`
 * or a raw token. The endpoint's token arrives ALREADY masked; the real value never leaves MAIN.
 *
 * Exported for WT-onboarding to mount in its `<OrchestrationModals/>` host (PLAN §4 coordination).
 */
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { Modal } from './Modal'

/** CLI ids — mirrors `src/main/cliProvisioners/shared.ts` `CliId` across the IPC boundary. */
export type SyncCliId = 'claude' | 'codex' | 'gemini' | 'opencode'

export interface SyncEndpoint {
  host: string
  port: number
  /** Pre-masked placeholder — this component never sees raw token characters. */
  maskedToken: string
}

export interface SyncTargetRow {
  id: SyncCliId
  label: string
  configLabel: string
  detected: boolean
}

export interface SyncStatusData {
  endpoint: SyncEndpoint
  rows: SyncTargetRow[]
}

export type SyncRowStatus = 'synced' | 'error'
export interface SyncRowResult {
  id: SyncCliId
  status: SyncRowStatus
  detail: string
  path?: string
}

export interface OrchestrationSyncModalProps {
  /** Endpoint + per-CLI detection. `null` while MAIN is still probing (shows a loading state). */
  status: SyncStatusData | null
  /** Runs the selected provisioners in MAIN; resolves to a per-CLI result. */
  onSync: (ids: SyncCliId[]) => Promise<SyncRowResult[]>
  onClose: () => void
}

export function OrchestrationSyncModal({
  status,
  onSync,
  onClose
}: OrchestrationSyncModalProps): ReactElement {
  // Default selection = every detected CLI (not-installed rows are off + disabled).
  const detectedIds = useMemo(
    () => (status ? status.rows.filter((r) => r.detected).map((r) => r.id) : []),
    [status]
  )
  const [selected, setSelected] = useState<Set<SyncCliId>>(() => new Set(detectedIds))
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Map<SyncCliId, SyncRowResult>>(new Map())

  // Re-seed the selection once detection arrives (status flips null → data).
  const [seededFor, setSeededFor] = useState<SyncStatusData | null>(null)
  if (status && status !== seededFor) {
    setSeededFor(status)
    setSelected(new Set(detectedIds))
    setResults(new Map())
  }

  const toggle = (id: SyncCliId): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const runSync = async (): Promise<void> => {
    if (busy || !status) return
    setBusy(true)
    try {
      const out = await onSync([...selected])
      setResults(new Map(out.map((r) => [r.id, r])))
    } catch {
      // A whole-batch IPC failure → mark every selected row failed so the user sees it, not silence.
      setResults(
        new Map(
          [...selected].map((id) => [
            id,
            { id, status: 'error' as const, detail: "Couldn't reach the app to sync." }
          ])
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const endpoint = status?.endpoint
  const nSelected = selected.size
  // A sync has completed at least once → the footer offers a clear close (Done) and demotes the
  // re-run to a secondary "Sync again" instead of keeping a primary "Sync now" that reads as
  // unfinished work after every row already shows SYNCED.
  const hasSynced = results.size > 0

  return (
    <Modal
      label="Sync agent orchestration"
      onClose={onClose}
      closeDisabled={busy}
      zIndex={1000}
      scrimProps={{ 'data-test': 'orch-sync-scrim' }}
      cardProps={{ 'data-test': 'orch-sync-modal' }}
      cardStyle={card}
    >
      {/* header */}
      <div style={mhead}>
        <span style={mark}>
          <RefreshIcon size={16} />
        </span>
        <span style={ttl}>Sync</span>
      </div>

      <div style={mbody}>
        <p style={intro}>
          Push this canvas&apos;s connection to <b>every agent CLI</b> on your machine. Re-runs
          automatically when a terminal starts &mdash; and whenever the endpoint rotates.
        </p>

        {/* endpoint */}
        <div style={lbl}>Endpoint</div>
        <div style={endpointRow} data-test="orch-sync-endpoint">
          {endpoint ? (
            <>
              <span style={k}>url</span>
              <span>
                {endpoint.host}:{endpoint.port}/mcp
              </span>
              <span style={{ ...k, marginLeft: 8 }}>token</span>
              <span>{endpoint.maskedToken}</span>
              <span style={rot}>rotates on restart</span>
            </>
          ) : (
            <span style={{ color: 'var(--text-3)' }}>Detecting endpoint&hellip;</span>
          )}
        </div>

        {/* targets */}
        <div style={lbl}>Sync targets</div>
        <div style={targets}>
          {status ? (
            <>
              {status.rows.map((row) => (
                <TargetRow
                  key={row.id}
                  row={row}
                  checked={selected.has(row.id)}
                  result={results.get(row.id)}
                  disabled={busy || !row.detected}
                  onToggle={() => toggle(row.id)}
                />
              ))}
              {/* The project .mcp.json baseline — always written, not a togglable CLI. */}
              <div style={trowBase} data-test="orch-sync-row-project">
                <span style={{ ...cbox, ...cboxOn }} aria-hidden>
                  <CheckIcon />
                </span>
                <span style={nm}>This project</span>
                <span style={pathTxt}>.mcp.json</span>
                <span style={badge2}>always</span>
              </div>
            </>
          ) : (
            <div style={{ ...pathTxt, padding: '8px' }}>Detecting installed CLIs&hellip;</div>
          )}
        </div>

        <div style={note}>
          Each CLI uses its own config format &mdash; Expanse writes the right one for each, with
          the file locked to <code style={code}>0o600</code>.
        </div>
      </div>

      {/* footer — pre-sync: [Later] [Sync now]. After a sync completes the primary action becomes
          [Done] (a clear close), with the re-run demoted to a secondary [Sync again]. */}
      <div style={mfoot}>
        {hasSynced ? (
          <>
            <button
              style={{ ...btn, opacity: busy || !status ? 0.6 : 1 }}
              onClick={() => void runSync()}
              disabled={busy || !status || nSelected === 0}
              data-test="orch-sync-now"
            >
              <RefreshIcon size={13} style={{ marginRight: 6, verticalAlign: -1 }} />
              {busy ? 'Syncing…' : 'Sync again'}
            </button>
            <button
              style={{ ...btn, ...btnPrimary }}
              onClick={onClose}
              disabled={busy}
              data-test="orch-sync-done"
            >
              Done
            </button>
          </>
        ) : (
          <>
            <button style={btn} onClick={onClose} disabled={busy} data-test="orch-sync-later">
              Later
            </button>
            <button
              style={{ ...btn, ...btnPrimary, opacity: busy || !status ? 0.6 : 1 }}
              onClick={() => void runSync()}
              disabled={busy || !status || nSelected === 0}
              data-test="orch-sync-now"
            >
              <RefreshIcon size={13} style={{ marginRight: 6, verticalAlign: -1 }} />
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}

function TargetRow({
  row,
  checked,
  result,
  disabled,
  onToggle
}: {
  row: SyncTargetRow
  checked: boolean
  result: SyncRowResult | undefined
  disabled: boolean
  onToggle: () => void
}): ReactElement {
  const on = checked && row.detected
  return (
    <div
      style={{ ...trow, ...(on ? trowOn : trowOff) }}
      data-test={`orch-sync-row-${row.id}`}
      data-detected={row.detected ? 'true' : 'false'}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        aria-label={row.label}
        disabled={disabled}
        onClick={onToggle}
        style={{ ...cbox, ...(on ? cboxOn : cboxOff), cursor: disabled ? 'default' : 'pointer' }}
        data-test={`orch-sync-check-${row.id}`}
      >
        {on ? <CheckIcon /> : null}
      </button>
      <span style={nm}>{row.label}</span>
      <span style={pathTxt}>{row.configLabel}</span>
      <RowBadge row={row} result={result} />
    </div>
  )
}

function RowBadge({
  row,
  result
}: {
  row: SyncTargetRow
  result: SyncRowResult | undefined
}): ReactElement {
  if (result) {
    const ok = result.status === 'synced'
    return (
      <span
        style={{ ...badge2, color: ok ? 'var(--ok)' : 'var(--err)' }}
        title={result.detail}
        data-test={`orch-sync-result-${row.id}`}
      >
        {ok ? 'synced' : 'failed'}
      </span>
    )
  }
  return (
    <span style={{ ...badge2, ...(row.detected ? { color: 'var(--ok)' } : {}) }}>
      {row.detected ? 'detected' : 'not installed'}
    </span>
  )
}

// ── icons ──────────────────────────────────────────────────────────────────

function RefreshIcon({ size = 16, style }: { size?: number; style?: CSSProperties }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden
    >
      <path d="M20 11a8 8 0 0 0-14-4M4 5v3h3" />
      <path d="M4 13a8 8 0 0 0 14 4M20 19v-3h-3" />
    </svg>
  )
}

function CheckIcon(): ReactElement {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12l5 5 9-11" />
    </svg>
  )
}

// ── styles (design tokens — src/renderer/src/index.css) ────────────────────

const card: CSSProperties = {
  width: 446,
  padding: 0,
  overflow: 'hidden',
  borderRadius: 'var(--r-board)',
  border: '1px solid var(--border)'
}
const mhead: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  padding: '18px 20px 12px'
}
const mark: CSSProperties = {
  width: 30,
  height: 30,
  flex: 'none',
  borderRadius: 'var(--r-ctl)',
  background: 'var(--accent-wash)',
  border: '1px solid rgba(79,140,255,.32)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--accent)'
}
const ttl: CSSProperties = {
  fontSize: 15,
  lineHeight: '22px',
  fontWeight: 600,
  letterSpacing: '-.01em',
  color: 'var(--text)'
}
const mbody: CSSProperties = { padding: '0 20px 4px' }
const intro: CSSProperties = {
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--text-2)',
  margin: '0 0 16px'
}
const lbl: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  lineHeight: '14px',
  fontWeight: 500,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  margin: '0 0 7px'
}
const endpointRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'var(--inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)',
  padding: '8px 10px',
  margin: '0 0 16px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--text-2)'
}
const k: CSSProperties = { color: 'var(--text-3)' }
const rot: CSSProperties = { marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 9.5 }
const targets: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  margin: '0 0 14px'
}
const trow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 8px',
  borderRadius: 'var(--r-ctl)'
}
const trowOn: CSSProperties = { background: 'var(--surface)' }
const trowOff: CSSProperties = { opacity: 0.5 }
const trowBase: CSSProperties = { ...trow, background: 'var(--surface)' }
const cbox: CSSProperties = {
  width: 16,
  height: 16,
  flex: 'none',
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0
}
const cboxOn: CSSProperties = {
  background: 'var(--accent)',
  border: '1px solid var(--accent)',
  color: '#fff'
}
const cboxOff: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border-strong)',
  color: 'transparent'
}
const nm: CSSProperties = { fontSize: 12.5, color: 'var(--text)', minWidth: 96 }
const pathTxt: CSSProperties = { fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)' }
const badge2: CSSProperties = {
  marginLeft: 'auto',
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--text-3)'
}
const note: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  lineHeight: '16px',
  color: 'var(--text-3)',
  padding: '11px 0 0',
  borderTop: '1px solid var(--border-subtle)'
}
const code: CSSProperties = { color: 'var(--text-2)' }
const mfoot: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '14px 20px 18px'
}
const btn: CSSProperties = {
  height: 30,
  padding: '0 14px',
  borderRadius: 'var(--r-ctl)',
  fontSize: 12.5,
  fontWeight: 500,
  fontFamily: 'var(--ui)',
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-2)',
  cursor: 'pointer'
}
const btnPrimary: CSSProperties = {
  background: 'var(--accent)',
  borderColor: 'var(--accent)',
  color: '#fff'
}
