/**
 * Delete Workspace dialog (WS-4, design §4.3 "Delete"; approved mock
 * claude.ai/artifact/HA8mQkDgxmQZKsXPZEjbbt). Four questions, asked only when they apply:
 *   1. the boards — Keep them (they become project-level, the default — O-8) or Close them;
 *   2. live terminals spawned inside the worktree — they must stop first (Windows refuses to
 *      remove a folder that is any process's cwd);
 *   3. a DIRTY worktree — the swarm's disposition row: Keep on disk (default + cancel path) /
 *      Commit / Stash / Discard (Discard asks a second time). Keep archives the workspace;
 *   4. a clean worktree is simply removed (`git worktree remove`); the branch is always kept.
 * MAIN re-checks every fact at the moment it acts (`workspace:delete`); this dialog only shows them.
 */
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Modal } from '../Modal'
import { useCanvasStore } from '../../store/canvasStore'
import { showToast } from '../../store/toastStore'
import type { Workspace } from '../../lib/workspaceSchema'
import type {
  WorkspaceDisposition,
  WorkspaceStatusResult
} from '../../../../shared/workspaceIpcTypes'
import { finishDelete, statusWithRetry } from './workspaceLifecycle'
import * as S from './workspaceDialogStyles'

type Status = Extract<WorkspaceStatusResult, { ok: true }>

const DISPOSITIONS: { id: WorkspaceDisposition; label: string }[] = [
  { id: 'keep', label: 'Keep on disk' },
  { id: 'commit', label: 'Commit to branch, then remove' },
  { id: 'stash', label: 'Stash, then remove' },
  { id: 'discard', label: 'Discard, then remove' }
]

const STOP_POLLS = 12
const STOP_POLL_MS = 300

export function DeleteWorkspaceDialog({
  workspace: ws,
  onClose
}: {
  workspace: Workspace
  onClose: () => void
}): ReactElement {
  const api = window.api.workspace
  const wt = ws.worktrees?.[0]
  const boardCount = useCanvasStore((s) => s.boards.filter((b) => b.workspaceId === ws.id).length)
  const boardTitle = useCanvasStore((s) => s.boards)
  const [status, setStatus] = useState<Status | null>(null)
  const [close, setClose] = useState(false)
  const [disposition, setDisposition] = useState<WorkspaceDisposition>('keep')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Show one status read (or its refusal); returns the usable status, null on a refusal. */
  const apply = useCallback((r: WorkspaceStatusResult): Status | null => {
    if (!r.ok) {
      setError(
        r.reason === 'unknown-workspace' ? 'Expanse could not find this workspace.' : r.reason
      )
      return null
    }
    setStatus(r)
    return r
  }, [])

  const refresh = async (): Promise<Status | null> => apply(await statusWithRetry(api, ws.id))

  useEffect(() => {
    let live = true
    void statusWithRetry(api, ws.id).then((r) => {
      if (live) apply(r)
    })
    return () => {
      live = false
    }
  }, [api, ws.id, apply])

  const running = status?.running ?? []
  const dirty = status?.kind === 'worktree' && status.exists && status.dirty
  const blocked = running.length > 0

  const stopTerminals = async (): Promise<void> => {
    setStopping(true)
    setError(null)
    await Promise.all(running.map((id) => window.api.killTerminal(id).catch(() => false)))
    for (let i = 0; i < STOP_POLLS; i++) {
      const r = await refresh()
      if (!r || r.running.length === 0) break
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS))
    }
    setStopping(false)
  }

  const confirm = async (): Promise<void> => {
    if (!status || blocked || busy) return
    if (dirty && disposition === 'discard' && !confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    setBusy(true)
    setError(null)
    const r = await api
      .remove({ id: ws.id, ...(dirty ? { disposition } : {}) })
      .catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err)
      }))
    setBusy(false)
    setConfirmDiscard(false)
    if (!r.ok) {
      setError(r.reason)
      if ('running' in r && r.running) setStatus({ ...status, running: r.running })
      if ('dirty' in r && r.dirty !== undefined) {
        setStatus({ ...status, dirty: true, changed: r.dirty })
      }
      return
    }
    finishDelete(ws, r.outcome, close)
    const branch = wt?.branch
    showToast({
      message:
        r.outcome === 'archived'
          ? `Workspace "${ws.name}" archived — its worktree stays on disk.`
          : r.outcome === 'removed'
            ? `Workspace "${ws.name}" deleted — worktree removed${branch ? `, branch ${branch} kept` : ''}.`
            : r.outcome === 'gone'
              ? `Workspace "${ws.name}" deleted — its worktree was already gone.`
              : `Workspace "${ws.name}" deleted. ${ws.root === '.' ? 'The project folder' : `${ws.root}/`} was not touched.`
    })
    onClose()
  }

  if (confirmDiscard && status) {
    return (
      <Modal
        label="Discard uncommitted work?"
        onClose={() => setConfirmDiscard(false)}
        closeDisabled={busy}
        zIndex={600}
        cardProps={{ 'data-test': 'wsdel-discard-confirm' }}
        cardStyle={{ ...S.card, width: 440 }}
      >
        <div style={S.title}>Discard uncommitted work?</div>
        <div style={S.note.err}>
          This permanently throws away <b>{plural(status.changed, 'file')}</b> in{' '}
          <span style={S.mono}>{wt?.worktree}</span>. It cannot be undone. Commits already on{' '}
          <span style={S.mono}>{wt?.branch}</span> survive, and the branch is kept.
        </div>
        <div style={S.footer}>
          <span style={S.footerMsg} />
          <button
            type="button"
            style={S.btnPrimary}
            onClick={() => setConfirmDiscard(false)}
            data-test="wsdel-discard-no"
          >
            Keep it
          </button>
          <button
            type="button"
            style={S.btnDanger}
            disabled={busy}
            onClick={() => void confirm()}
            data-test="wsdel-discard-yes"
          >
            Discard
          </button>
        </div>
      </Modal>
    )
  }

  const danger = close || (dirty && disposition === 'discard')
  const goLabel = close
    ? 'Close boards & delete'
    : dirty && disposition === 'keep'
      ? 'Archive workspace'
      : dirty && disposition === 'discard'
        ? 'Discard & delete'
        : 'Delete workspace'
  const canGo = !!status && !blocked && !busy && !stopping
  const goStyle = { ...(danger ? S.btnDanger : S.btnPrimary), ...(canGo ? {} : S.btnDisabled) }

  return (
    <Modal
      label={`Delete workspace ${ws.name}`}
      onClose={onClose}
      closeDisabled={busy || stopping}
      zIndex={600}
      scrimProps={{ 'data-test': 'delete-workspace-scrim' }}
      cardProps={{ 'data-test': 'delete-workspace-dialog' }}
      cardStyle={S.card}
    >
      <div style={S.title}>Delete workspace “{ws.name}”?</div>
      <div style={S.subtitle}>
        {ws.root === '.' ? '.' : `${ws.root}/`}
        {wt ? ` · ${wt.worktree} · ${wt.branch}` : ' · folder as-is'}
      </div>

      {boardCount > 0 && (
        <div>
          <div style={S.sectionLabel}>Its {plural(boardCount, 'board')}</div>
          <div style={S.tiles2}>
            <Tile on={!close} testid="wsdel-keep-boards" onPick={() => setClose(false)}>
              <span style={S.optionTitle}>Keep them</span>
              <span style={S.hint}>They become project-level.</span>
            </Tile>
            <Tile on={close} bad testid="wsdel-close-boards" onPick={() => setClose(true)}>
              <span style={S.optionTitle}>Close them</span>
              <span style={S.hint}>Stops their agents.</span>
            </Tile>
          </div>
          {close && (
            <div style={{ ...S.note.err, marginTop: 7 }}>
              Closing removes {plural(boardCount, 'board')} and stops any agent running in them.
              Undo brings the boards back, not the agent sessions.
            </div>
          )}
        </div>
      )}

      {running.length > 0 && (
        <div data-test="wsdel-running">
          <div style={S.sectionLabel}>Running inside the worktree</div>
          <div style={S.listBox}>
            {running.map((id, i) => (
              <div
                key={id}
                style={{
                  ...S.listRow,
                  cursor: 'default',
                  ...(i === 0 ? { borderTop: 'none' } : {})
                }}
              >
                <span style={S.colorDot('var(--ok)')} />
                <span style={{ flex: 1 }}>
                  {boardTitle.find((b) => b.id === id)?.title ?? 'Terminal'}
                </span>
                <span style={S.tag}>running</span>
              </div>
            ))}
          </div>
          <div style={{ ...S.row, marginTop: 7 }}>
            <span style={{ ...S.hint, flex: 1 }}>
              Windows can&apos;t remove a folder a running process is using. Stop them first.
            </span>
            <button
              type="button"
              style={stopping ? { ...S.btnSmall, ...S.btnDisabled } : S.btnSmall}
              disabled={stopping}
              onClick={() => void stopTerminals()}
              data-test="wsdel-stop"
            >
              {stopping ? 'Stopping…' : `Stop ${plural(running.length, 'terminal')}`}
            </button>
          </div>
        </div>
      )}

      <TreeSection ws={ws} status={status}>
        {dirty && status && (
          <div>
            <div style={S.note.warn} data-test="wsdel-dirty">
              <b>{plural(status.changed, 'uncommitted file')}</b> on{' '}
              <span style={S.mono}>{wt?.branch}</span> in <span style={S.mono}>{wt?.worktree}</span>
              . Nothing is lost until you choose.
            </div>
            <div style={{ ...S.tiles2, marginTop: 7 }}>
              {DISPOSITIONS.map((d) => (
                <Tile
                  key={d.id}
                  on={disposition === d.id}
                  bad={d.id === 'discard'}
                  testid={`wsdel-disp-${d.id}`}
                  onPick={() => setDisposition(d.id)}
                >
                  <span>{d.label}</span>
                </Tile>
              ))}
            </div>
            <div style={{ ...S.hint, marginTop: 6 }}>
              {disposition === 'keep'
                ? 'Keep: the workspace is archived and stays listed with Re-open / Remove when clean.'
                : 'Commits already on the branch survive. The branch is never deleted.'}
            </div>
          </div>
        )}
      </TreeSection>

      <div style={S.footer}>
        <span
          style={{ ...S.footerMsg, color: error ? 'var(--err)' : undefined }}
          data-test="wsdel-error"
        >
          {error ?? (blocked ? 'Stop the terminals to continue.' : '')}
        </span>
        <button
          type="button"
          style={S.btnGhost}
          disabled={busy}
          onClick={onClose}
          data-test="wsdel-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          style={goStyle}
          disabled={!canGo}
          onClick={() => void confirm()}
          data-test="wsdel-confirm"
        >
          {busy ? 'Working…' : goLabel}
        </button>
      </div>
    </Modal>
  )
}

/** The "what happens on disk" block: folder untouched / reading / clean / gone / dirty (children). */
function TreeSection({
  ws,
  status,
  children
}: {
  ws: Workspace
  status: Status | null
  children: ReactNode
}): ReactElement {
  const wt = ws.worktrees?.[0]
  if (!wt) {
    return (
      <div style={S.note.plain} data-test="wsdel-folder">
        Expanse never touches{' '}
        <span style={S.mono}>{ws.root === '.' ? 'the project folder' : `${ws.root}/`}</span> — only
        the workspace is removed.
      </div>
    )
  }
  let body: ReactNode
  if (!status) body = <div style={S.note.plain}>Reading git status…</div>
  else if (!status.exists) {
    body = (
      <div style={S.note.plain} data-test="wsdel-gone">
        The worktree folder is already gone — only the workspace is removed.
      </div>
    )
  } else if (!status.dirty) {
    body = (
      <div style={S.note.ok} data-test="wsdel-clean">
        Clean — <span style={S.mono}>git worktree remove</span> runs. Branch{' '}
        <span style={S.mono}>{wt.branch}</span> is kept.
      </div>
    )
  } else body = children
  return (
    <div>
      <div style={S.sectionLabel}>Worktree</div>
      {body}
    </div>
  )
}

function Tile({
  on,
  bad = false,
  testid,
  onPick,
  children
}: {
  on: boolean
  bad?: boolean
  testid: string
  onPick: () => void
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-test={testid}
      onClick={onPick}
      style={{
        ...S.option,
        alignItems: 'center',
        ...(on ? (bad ? S.optionBad : S.optionOn) : {})
      }}
    >
      <span style={{ ...S.dot(on), marginTop: 0 }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{children}</span>
    </button>
  )
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
