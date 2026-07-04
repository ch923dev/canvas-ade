/**
 * External MCP servers manager (feature: add external MCP servers, Phase 5).
 *
 * The list state + host for the Add/Edit form ({@link ./McpServerForm}). Self-contained: it owns its
 * own reactive list (hydrated from `window.api.mcpServers`, re-fetched after each mutation) and
 * renders NOTHING but the section body — so it drops into main's SettingsModal today and the
 * settings-tiles MCP pane later without change. The renderer only ever sees MASKED rows (no secret
 * values). Matches the approved mock + `index.css` tokens.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Icon } from '../Icon'
import { McpServerForm } from './McpServerForm'
import type { MaskedMcpServer, OrchestrationCliId } from '../../../../preload'

const NO_DETECT: Record<OrchestrationCliId, boolean> = {
  claude: false,
  codex: false,
  gemini: false,
  opencode: false
}

const s = {
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    gap: 10,
    alignItems: 'center',
    background: 'var(--surface-raised)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-inner)',
    padding: '10px 12px'
  },
  name: {
    fontSize: 'var(--fs-body)',
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    gap: 8
  },
  badge: {
    fontFamily: 'var(--mono)',
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 'var(--r-pill)',
    border: '1px solid var(--border)',
    textTransform: 'uppercase'
  },
  meta: {
    fontFamily: 'var(--mono)',
    fontSize: 'var(--fs-meta)',
    color: 'var(--text-3)',
    marginTop: 3
  },
  chips: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' },
  chip: {
    fontSize: 10,
    padding: '1px 5px',
    borderRadius: 3,
    background: 'var(--surface-overlay)',
    border: '1px solid var(--border-subtle)',
    color: 'var(--text-2)'
  },
  actions: { display: 'flex', alignItems: 'center', gap: 6 },
  empty: { fontSize: 'var(--fs-meta)', color: 'var(--text-2)', padding: '10px 0' }
} as const

function dot(sv: MaskedMcpServer): { color: string; title: string } {
  if (!sv.lastTest) return { color: 'var(--text-faint)', title: 'Never tested' }
  return sv.lastTest.ok
    ? { color: 'var(--ok)', title: 'Last test passed' }
    : { color: 'var(--err)', title: 'Last test failed' }
}

function lastLine(sv: MaskedMcpServer): string {
  if (!sv.lastTest) return sv.enabled ? 'not tested' : 'not tested · disabled'
  const base = sv.lastTest.ok
    ? `✓ ${sv.lastTest.toolCount ?? 0} tools`
    : `✕ ${sv.lastTest.detail ?? 'failed'}`
  return sv.enabled ? base : `${base} · disabled`
}

function Row({
  sv,
  busy,
  onTest,
  onEdit,
  onRemove,
  onToggle
}: {
  sv: MaskedMcpServer
  busy: boolean
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
  onToggle: () => void
}): ReactElement {
  const d = dot(sv)
  const detail =
    sv.transport === 'http' ? (sv.url ?? '') : [sv.command, ...(sv.args ?? [])].join(' ')
  return (
    <div style={{ ...s.row, opacity: sv.enabled ? 1 : 0.6 }} data-test={`mcp-row-${sv.name}`}>
      <span
        title={d.title}
        style={{ width: 8, height: 8, borderRadius: '50%', background: d.color }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={s.name}>
          {sv.name}
          <span
            style={{
              ...s.badge,
              color: sv.transport === 'http' ? 'var(--accent)' : 'var(--warn)',
              borderColor: sv.transport === 'http' ? 'rgba(79,140,255,.35)' : 'rgba(232,179,57,.35)'
            }}
          >
            {sv.transport}
          </span>
        </div>
        <div style={s.meta}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detail}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 2, flexWrap: 'wrap' }}>
            <span style={s.chips}>
              {sv.targets.map((t) => (
                <span key={t} style={s.chip}>
                  {t}
                </span>
              ))}
            </span>
            <span
              style={{ color: sv.lastTest && !sv.lastTest.ok ? 'var(--err)' : 'var(--text-3)' }}
            >
              {lastLine(sv)}
            </span>
          </div>
        </div>
      </div>
      <div style={s.actions}>
        <button
          type="button"
          className="ca-btn-ghost"
          disabled={busy}
          onClick={onTest}
          data-test={`mcp-test-${sv.name}`}
        >
          <Icon name="refresh" size={12} /> Test
        </button>
        <button
          type="button"
          className="ca-btn-ghost"
          onClick={onEdit}
          data-test={`mcp-edit-${sv.name}`}
        >
          Edit
        </button>
        <button
          type="button"
          className="ca-btn-ghost"
          aria-label={`Remove ${sv.name}`}
          onClick={onRemove}
          data-test={`mcp-remove-${sv.name}`}
        >
          <Icon name="trash" size={12} />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={sv.enabled}
          aria-label={`${sv.name} enabled`}
          onClick={onToggle}
          data-test={`mcp-toggle-${sv.name}`}
          style={{
            width: 30,
            height: 17,
            borderRadius: 'var(--r-pill)',
            border: 'none',
            cursor: 'pointer',
            position: 'relative',
            flex: 'none',
            background: sv.enabled ? 'var(--accent)' : 'var(--border-strong)'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: sv.enabled ? 15 : 2,
              width: 13,
              height: 13,
              borderRadius: '50%',
              background: '#fff'
            }}
          />
        </button>
      </div>
    </div>
  )
}

export function McpServersManager(): ReactElement {
  const [servers, setServers] = useState<MaskedMcpServer[]>([])
  const [detected, setDetected] = useState<Record<OrchestrationCliId, boolean>>(NO_DETECT)
  const [editing, setEditing] = useState<MaskedMcpServer | 'new' | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async (): Promise<void> => {
    const api = window.api?.mcpServers
    if (!api) return
    try {
      setServers(await api.list())
    } catch {
      /* leave the last-known list on a transient IPC failure */
    }
  }

  // Hydrate from MAIN on mount. Inlined (not via `reload`) so the setState lands in an async `.then`,
  // and guarded by `cancelled` so a slow resolve after unmount is dropped. `window.api.mcpServers`
  // is absent in non-electron test runtimes (like SettingsVoiceSection's guard) → render an empty
  // manager rather than throw.
  useEffect(() => {
    const api = window.api?.mcpServers
    if (!api) return
    let cancelled = false
    void api
      .list()
      .then((l) => {
        if (!cancelled) setServers(l)
      })
      .catch(() => {})
    void api
      .detectClis()
      .then((d) => {
        if (!cancelled) setDetected(d)
      })
      .catch(() => {
        if (!cancelled) setDetected(NO_DETECT)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await reload()
    } catch {
      /* best-effort — the list re-fetch reflects the true state */
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <McpServerForm
        initial={editing === 'new' ? undefined : editing}
        detected={detected}
        onSubmit={(input) => window.api.mcpServers.save(input)}
        onTest={(id) => window.api.mcpServers.test(id)}
        onSaved={() => {
          setEditing(null)
          void reload()
        }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      data-test="mcp-servers-manager"
    >
      {servers.length === 0 ? (
        <div style={s.empty} data-test="mcp-empty">
          No external servers yet. Add one to make it available to your terminal agents.
        </div>
      ) : (
        <div style={s.list}>
          {servers.map((sv) => (
            <Row
              key={sv.id}
              sv={sv}
              busy={busy}
              onTest={() => void guard(() => window.api.mcpServers.test(sv.id))}
              onEdit={() => setEditing(sv)}
              onRemove={() => void guard(() => window.api.mcpServers.remove(sv.id))}
              onToggle={() =>
                void guard(() => window.api.mcpServers.setEnabled(sv.id, !sv.enabled))
              }
            />
          ))}
        </div>
      )}
      <button
        type="button"
        className="ca-btn-primary"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => setEditing('new')}
        data-test="mcp-add-server"
      >
        <Icon name="plus" size={12} /> Add server
      </button>
    </div>
  )
}
