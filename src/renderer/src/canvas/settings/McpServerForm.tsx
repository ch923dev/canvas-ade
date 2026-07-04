/**
 * Add / Edit form for one external MCP server (feature: add external MCP servers, Phase 5).
 *
 * Presentational: it owns the draft state and calls back into the manager for save/test. Secrets are
 * masked — an existing header/env value shows a "leave blank to keep" placeholder; a blank value on
 * save keeps the stored secret (the store honours that). "Test connection" saves first (a probe
 * needs a persisted server), then reports the point-in-time result. Matches the approved mock +
 * `index.css` tokens; host-agnostic so the settings-tiles MCP pane can mount the manager unchanged.
 */
import { useState, type ReactElement } from 'react'
import { Icon } from '../Icon'
import type {
  MaskedMcpServer,
  McpServerSaveInput,
  McpSaveResult,
  McpTestResult,
  McpTransport,
  OrchestrationCliId
} from '../../../../preload'

const CLIS: OrchestrationCliId[] = ['claude', 'codex', 'gemini', 'opencode']

/** A secret row in the draft: `hadValue` marks an existing (kept-when-blank) secret. */
interface SecretRow {
  name: string
  value: string
  hadValue: boolean
}

export interface McpServerFormProps {
  initial?: MaskedMcpServer
  detected: Record<OrchestrationCliId, boolean>
  onSubmit: (input: McpServerSaveInput) => Promise<McpSaveResult>
  onTest: (id: string) => Promise<McpTestResult>
  onSaved: () => void
  onCancel: () => void
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 'var(--fs-label)', fontWeight: 500, color: 'var(--text)' },
  hint: { fontSize: 'var(--fs-meta)', color: 'var(--text-3)' },
  input: {
    fontFamily: 'var(--ui)',
    fontSize: 'var(--fs-body)',
    color: 'var(--text)',
    background: 'var(--inset)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-ctl)',
    padding: '7px 9px',
    width: '100%'
  },
  seg: {
    display: 'inline-flex',
    background: 'var(--inset)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-ctl)',
    padding: 2,
    gap: 2
  },
  kv: { display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, alignItems: 'center' },
  targets: { display: 'flex', flexWrap: 'wrap', gap: 7 },
  testbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'var(--surface-raised)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '9px 11px'
  },
  footer: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 },
  error: { fontSize: 'var(--fs-meta)', color: 'var(--err)' }
} as const

const monoInput = { ...s.input, fontFamily: 'var(--mono)', fontSize: 'var(--fs-label)' } as const

function fromServer(sv: MaskedMcpServer | undefined): {
  transport: McpTransport
  headers: SecretRow[]
  env: SecretRow[]
} {
  return {
    transport: sv?.transport ?? 'http',
    headers: (sv?.headers ?? []).map((h) => ({ name: h.name, value: '', hadValue: h.hasValue })),
    env: (sv?.env ?? []).map((e) => ({ name: e.name, value: '', hadValue: e.hasValue }))
  }
}

export function McpServerForm({
  initial,
  detected,
  onSubmit,
  onTest,
  onSaved,
  onCancel
}: McpServerFormProps): ReactElement {
  const seed = fromServer(initial)
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(seed.transport)
  const [url, setUrl] = useState(initial?.url ?? '')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [argsText, setArgsText] = useState((initial?.args ?? []).join(' '))
  const [headers, setHeaders] = useState<SecretRow[]>(seed.headers)
  const [env, setEnv] = useState<SecretRow[]>(seed.env)
  const [targets, setTargets] = useState<Set<OrchestrationCliId>>(
    new Set(initial?.targets ?? CLIS.filter((c) => detected[c]))
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<McpTestResult | null>(initial?.lastTest ?? null)

  const editRows = (
    rows: SecretRow[],
    set: (r: SecretRow[]) => void,
    i: number,
    patch: Partial<SecretRow>
  ): void => set(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const secretsFor = (rows: SecretRow[]): { name: string; value: string }[] =>
    rows.filter((r) => r.name.trim() !== '').map((r) => ({ name: r.name.trim(), value: r.value }))

  const buildInput = (): McpServerSaveInput => ({
    id: initial?.id,
    name: name.trim(),
    enabled: initial?.enabled ?? true,
    transport,
    url: transport === 'http' ? url.trim() : undefined,
    headers: transport === 'http' ? secretsFor(headers) : undefined,
    command: transport === 'stdio' ? command.trim() : undefined,
    args: transport === 'stdio' ? argsText.trim().split(/\s+/).filter(Boolean) : undefined,
    env: transport === 'stdio' ? secretsFor(env) : undefined,
    targets: [...targets]
  })

  const reasonText = (r: McpSaveResult): string =>
    r.ok
      ? ''
      : r.reason === 'encryption-unavailable'
        ? 'No system keyring — a secret can’t be stored encrypted on this machine.'
        : r.detail === 'name-reserved'
          ? '“canvas-ade” is reserved. Pick another name.'
          : r.detail === 'name-duplicate'
            ? 'A server with that name already exists.'
            : r.detail === 'name-invalid' || r.detail === 'name-empty'
              ? 'Name: letters, digits, and - _ . only.'
              : r.detail === 'url-required' || r.detail === 'url-invalid'
                ? 'Enter a valid http(s) URL.'
                : r.detail === 'command-required'
                  ? 'Enter a command to run.'
                  : 'Could not save — check the fields and try again.'

  const submit = async (): Promise<McpSaveResult> => {
    const r = await onSubmit(buildInput())
    if (!r.ok) setError(reasonText(r))
    return r
  }

  const onSave = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if ((await submit()).ok) onSaved()
    } catch {
      setError('Could not save — please try again.')
    } finally {
      setBusy(false)
    }
  }

  // Test needs a persisted server (the probe reads it from the store), so save first.
  const onTestClick = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setTest(null)
    try {
      const r = await submit()
      if (r.ok) setTest(await onTest(r.id))
    } catch {
      setError('Could not test — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const secretTable = (
    rows: SecretRow[],
    set: (r: SecretRow[]) => void,
    valueLabel: string
  ): ReactElement => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ ...s.kv, ...s.hint }}>
        <span>Name</span>
        <span>{valueLabel}</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div style={s.kv} key={i}>
          <input
            style={monoInput}
            aria-label={`${valueLabel} name ${i + 1}`}
            value={r.name}
            onChange={(e) => editRows(rows, set, i, { name: e.target.value })}
          />
          <input
            style={monoInput}
            type="password"
            aria-label={`${valueLabel} value ${i + 1}`}
            placeholder={r.hadValue ? '•••• (leave blank to keep)' : 'value'}
            value={r.value}
            onChange={(e) => editRows(rows, set, i, { value: e.target.value })}
          />
          <button
            type="button"
            className="ca-btn-ghost"
            aria-label={`Remove ${r.name || 'row'}`}
            onClick={() => set(rows.filter((_, j) => j !== i))}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        style={{
          fontSize: 'var(--fs-label)',
          color: 'var(--accent)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          padding: 0
        }}
        onClick={() => set([...rows, { name: '', value: '', hadValue: false }])}
      >
        ＋ Add {valueLabel.toLowerCase()}
      </button>
    </div>
  )

  return (
    <div style={s.wrap} data-test="mcp-server-form">
      <label style={s.field}>
        <span style={s.label}>Name</span>
        <input
          style={monoInput}
          aria-label="Server name"
          value={name}
          placeholder="e.g. linear, github, postgres"
          onChange={(e) => setName(e.target.value)}
          data-test="mcp-form-name"
        />
        <span style={s.hint}>The key written into each agent’s config. Must be unique.</span>
      </label>

      <div style={s.field}>
        <span style={s.label}>Transport</span>
        <div style={s.seg} role="radiogroup" aria-label="Transport">
          {(['http', 'stdio'] as McpTransport[]).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={transport === t}
              onClick={() => setTransport(t)}
              data-test={`mcp-form-transport-${t}`}
              style={{
                fontSize: 'var(--fs-label)',
                padding: '4px 12px',
                borderRadius: 'var(--r-ctl)',
                border: 'none',
                cursor: 'pointer',
                background: transport === t ? 'var(--surface-overlay)' : 'transparent',
                color: transport === t ? 'var(--text)' : 'var(--text-2)',
                boxShadow: transport === t ? 'inset 0 0 0 1px var(--border)' : 'none'
              }}
            >
              {t === 'http' ? 'HTTP' : 'stdio (local command)'}
            </button>
          ))}
        </div>
      </div>

      {transport === 'http' ? (
        <>
          <label style={s.field}>
            <span style={s.label}>URL</span>
            <input
              style={monoInput}
              aria-label="Server URL"
              value={url}
              placeholder="https://…"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <div style={s.field}>
            <span style={s.label}>Headers</span>
            {secretTable(headers, setHeaders, 'Header')}
          </div>
        </>
      ) : (
        <>
          <label style={s.field}>
            <span style={s.label}>Command</span>
            <input
              style={monoInput}
              aria-label="Command"
              value={command}
              placeholder="npx, uvx, node, /path/to/server"
              onChange={(e) => setCommand(e.target.value)}
            />
          </label>
          <label style={s.field}>
            <span style={s.label}>Arguments</span>
            <input
              style={monoInput}
              aria-label="Arguments"
              value={argsText}
              placeholder="-y @modelcontextprotocol/server-github"
              onChange={(e) => setArgsText(e.target.value)}
            />
          </label>
          <div style={s.field}>
            <span style={s.label}>Environment</span>
            {secretTable(env, setEnv, 'Variable')}
            <span style={s.hint}>Values are encrypted at rest and never leave your machine.</span>
          </div>
        </>
      )}

      <div style={s.field}>
        <span style={s.label}>Use in</span>
        <div style={s.targets}>
          {CLIS.map((c) => {
            const on = targets.has(c)
            return (
              <button
                key={c}
                type="button"
                role="checkbox"
                aria-checked={on}
                data-test={`mcp-form-target-${c}`}
                onClick={() => {
                  const next = new Set(targets)
                  if (on) next.delete(c)
                  else next.add(c)
                  setTargets(next)
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '6px 10px',
                  borderRadius: 'var(--r-ctl)',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                  background: on ? 'var(--accent-wash)' : 'var(--surface-raised)',
                  color: 'var(--text)',
                  fontSize: 'var(--fs-label)',
                  cursor: 'pointer'
                }}
              >
                {c}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-3)' }}>
                  {detected[c] ? 'detected' : 'not installed'}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div style={s.testbar}>
        <button
          type="button"
          className="ca-btn-ghost"
          disabled={busy}
          onClick={() => void onTestClick()}
          data-test="mcp-form-test"
        >
          <Icon name="refresh" size={12} /> Test connection
        </button>
        <div style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 'var(--fs-meta)' }}>
          {test && (
            <span
              style={{ color: test.ok ? 'var(--ok)' : 'var(--err)' }}
              data-test="mcp-form-test-result"
            >
              {test.ok
                ? `✓ connected · ${test.toolCount ?? 0} tools`
                : `✕ ${test.detail ?? 'failed'}`}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" style={s.error} data-test="mcp-form-error">
          {error}
        </div>
      )}

      <div style={s.footer}>
        <button type="button" className="ca-btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="ca-btn-primary"
          disabled={busy}
          onClick={() => void onSave()}
          data-test="mcp-form-save"
        >
          Save server
        </button>
      </div>
    </div>
  )
}
