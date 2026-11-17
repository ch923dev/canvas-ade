/**
 * New Workspace dialog (WS-4, design §4.3 step 1 + §4.6; approved mock
 * claude.ai/artifact/HA8mQkDgxmQZKsXPZEjbbt). Collects name / goal / colour, the folder (picked
 * inside the project — O-7), the git mode, the base branch (O-10: asked the first time per repo,
 * remembered after), the dependency tick (O-9) and the starter boards — then hands everything to
 * `createWorkspaceFlow`, which lets MAIN allocate + stat-prove BEFORE any record is written.
 *
 * Git facts all come from MAIN (`window.api.workspace`): this component never decides whether a
 * folder is a repo, and it offers no way to make one ("Expanse never runs `git init`").
 */
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Modal } from '../Modal'
import { useCanvasStore } from '../../store/canvasStore'
import { isWorkspaceNameTaken } from '../../lib/workspaceSchema'
import { sanitizeGroupName } from '../../../../shared/groupName'
import {
  WORKSPACE_COLORS,
  nextWorkspaceColor,
  type WorkspaceColor
} from '../../../../shared/workspaceRules'
import type {
  WorkspaceBranchesResult,
  WorkspaceGitMode,
  WorkspaceProbeResult,
  WorkspaceRepo
} from '../../../../shared/workspaceIpcTypes'
import { WORKSPACE_COLOR_CSS } from './workspaceColors'
import { createWorkspaceFlow, pickBase, type BaseChoice } from './workspaceLifecycle'
import * as S from './workspaceDialogStyles'

type Branches = Extract<WorkspaceBranchesResult, { ok: true }>

/** Preview of MAIN's slug (`swarmWorktree.slugify`) — display only; MAIN suffixes collisions. */
function slugPreview(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 45)
    .replace(/-+$/g, '')
  return s || 'worker'
}

const label = (rel: string): string => (rel === '.' ? 'This project (.)' : `${rel}/`)

export function NewWorkspaceDialog({
  onClose,
  anchor
}: {
  onClose: () => void
  /** World-space point the starter boards are placed near (the viewport centre). */
  anchor: () => { x: number; y: number }
}): ReactElement {
  const api = window.api.workspace
  const workspaces = useCanvasStore((s) => s.workspaces)
  const repoDefaults = useCanvasStore((s) => s.repoDefaults)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [color, setColor] = useState<WorkspaceColor>(() =>
    nextWorkspaceColor(useCanvasStore.getState().workspaces)
  )
  const [repos, setRepos] = useState<WorkspaceRepo[] | null>(null)
  const [root, setRoot] = useState('')
  // Async results are KEYED by the input they answer, so a stale one reads as "loading" without a
  // synchronous reset inside the effect.
  const [probed, setProbed] = useState<{ root: string; result: WorkspaceProbeResult } | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [mode, setMode] = useState<WorkspaceGitMode>('folder')
  const [listed, setListed] = useState<{
    repoRoot: string
    branches: Branches | null
    error: string | null
  } | null>(null)
  const [choice, setChoice] = useState<BaseChoice | null>(null)
  const [base, setBase] = useState('')
  const [attach, setAttach] = useState('')
  const [remember, setRemember] = useState(true)
  const [deps, setDeps] = useState(true)
  const [terminal, setTerminal] = useState(true)
  const [launch, setLaunch] = useState('claude')
  const [browser, setBrowser] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  // The repos MAIN finds (root + one level down); the first one is the starting folder.
  useEffect(() => {
    let live = true
    void api
      .listRepos()
      .then((list) => {
        if (!live) return
        setRepos(list)
        setRoot((r) => r || list[0]?.rel || '.')
      })
      .catch(() => live && (setRepos([]), setRoot((r) => r || '.')))
    return () => {
      live = false
    }
  }, [api])

  // Probe the folder (debounced while typing). A folder outside any repo drops to folder-as-is.
  useEffect(() => {
    if (!root) return
    let live = true
    const t = setTimeout(() => {
      void api.probe(root).then((p) => {
        if (!live) return
        setProbed({ root, result: p })
        if (!p.ok || !p.repoRoot) setMode('folder')
      })
    }, 180)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [api, root])

  const probe = probed?.root === root ? probed.result : null
  const repoRoot = probe?.ok ? probe.repoRoot : undefined
  const remembered = repoRoot ? repoDefaults[repoRoot]?.base : undefined

  // The repo's branches (on disk, never fetched — read-only and cheap, so read once per repo) →
  // the O-10 base pre-fill.
  useEffect(() => {
    if (!repoRoot) return
    let live = true
    void api.listBranches(repoRoot).then((b) => {
      if (!live) return
      if (!b.ok) return setListed({ repoRoot, branches: null, error: b.reason })
      setListed({ repoRoot, branches: b, error: null })
      const c = pickBase(b, useCanvasStore.getState().repoDefaults[repoRoot]?.base)
      setChoice(c)
      setBase(c.base)
      setAttach(b.local.find((x) => x !== b.current) || b.local[0] || '')
    })
    return () => {
      live = false
    }
  }, [api, repoRoot])
  const current = listed?.repoRoot === repoRoot ? listed : null
  const branches = current?.branches ?? null
  const branchError = current?.error ?? null

  const cleanName = sanitizeGroupName(name)
  const taken = cleanName !== '' && isWorkspaceNameTaken(workspaces, cleanName)
  const gitMode = mode !== 'folder'
  const slug = slugPreview(cleanName)
  const canCreate =
    !busy &&
    cleanName !== '' &&
    !taken &&
    probe?.ok === true &&
    (mode === 'folder' || (!!repoRoot && !!branches && (mode === 'worktree' ? !!base : !!attach)))

  const create = async (): Promise<void> => {
    if (!canCreate || !probe?.ok) return
    setBusy(true)
    setError(null)
    const out = await createWorkspaceFlow(
      {
        name: cleanName,
        goal,
        color,
        root: probe.root,
        mode,
        base,
        branch: attach,
        remember,
        deps,
        terminal,
        launchCommand: launch,
        browser,
        at: anchor()
      },
      api
    ).catch((err: unknown) => ({
      ok: false as const,
      reason: err instanceof Error ? err.message : String(err)
    }))
    setBusy(false)
    if (out.ok) onClose()
    else setError(out.reason)
  }

  const browse = async (): Promise<void> => {
    setPickError(null)
    const r = await api.pickFolder()
    if (r.ok) setRoot(r.root)
    else if (r.reason !== 'cancelled') setPickError(r.reason)
  }

  const baseOptions = useMemo(() => {
    if (!branches) return null
    const head = !branches.current || base === 'HEAD'
    return (
      <>
        {head && <option value="HEAD">HEAD</option>}
        <optgroup label="Local">
          {branches.local.map((b) => (
            <option key={`l-${b}`} value={b}>
              {b}
            </option>
          ))}
        </optgroup>
        {branches.remote.length > 0 && (
          <optgroup label="Remote">
            {branches.remote.map((b) => (
              <option key={`r-${b}`} value={b}>
                {b}
              </option>
            ))}
          </optgroup>
        )}
      </>
    )
  }, [branches, base])

  const repoKey = repoRoot ? label(repoRoot) : ''
  const baseBlock = (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={S.row}>
        <span style={S.fieldLabel}>Branch</span>
        <span style={{ ...S.mono, color: 'var(--text)' }}>ws/{slug}</span>
        <span style={S.hint}>new</span>
      </div>
      <div style={S.row}>
        <span style={S.fieldLabel}>Off</span>
        {branches ? (
          <select
            style={S.select}
            aria-label="Base branch"
            data-test="ws-base"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            onFocus={S.ringOn}
            onBlur={S.ringOff}
          >
            {baseOptions}
          </select>
        ) : (
          <span style={S.hint}>{branchError ?? 'Reading branches…'}</span>
        )}
        {choice?.kind === 'remembered' && base === remembered && (
          <span style={S.tagTone.accent} data-test="ws-base-remembered">
            remembered
          </span>
        )}
      </div>
      {choice?.kind === 'first' && (
        <div style={S.note.accent} data-test="ws-base-first">
          First worktree from <span style={S.mono}>{repoKey}</span> — which branch should it start
          from?
        </div>
      )}
      {choice?.kind === 'fallback' && (
        <div style={S.note.warn} data-test="ws-base-fallback">
          Remembered base <span style={S.mono}>{choice.missing}</span> no longer exists in{' '}
          <span style={S.mono}>{repoKey}</span> — starting from <span style={S.mono}>HEAD</span>
          {branches?.current ? (
            <>
              {' '}
              (<span style={S.mono}>{branches.current}</span>)
            </>
          ) : null}
          .
        </div>
      )}
      <Check
        on={remember}
        onToggle={() => setRemember((v) => !v)}
        testid="ws-remember"
        hint="Pre-fills the base next time. Stored in canvas.json."
      >
        Remember for <span style={S.mono}>{repoKey}</span>
      </Check>
    </div>
  )

  const attachBlock = (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={S.row}>
        <span style={S.fieldLabel}>Branch</span>
        {branches ? (
          <select
            style={S.select}
            aria-label="Branch to attach"
            data-test="ws-attach-branch"
            value={attach}
            onChange={(e) => setAttach(e.target.value)}
            onFocus={S.ringOn}
            onBlur={S.ringOff}
          >
            {branches.local.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        ) : (
          <span style={S.hint}>{branchError ?? 'Reading branches…'}</span>
        )}
      </div>
      <div style={S.hint}>
        Local branches only. git refuses a branch already checked out in another worktree — its
        words are shown here.
      </div>
    </div>
  )

  return (
    <Modal
      label="New workspace"
      onClose={onClose}
      closeDisabled={busy}
      zIndex={600}
      scrimProps={{ 'data-test': 'new-workspace-scrim' }}
      cardProps={{ 'data-test': 'new-workspace-dialog' }}
      cardStyle={S.card}
    >
      <div style={S.title}>New workspace</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={S.row}>
          <span style={S.fieldLabel}>Name</span>
          <input
            style={S.fld}
            placeholder="e.g. API"
            aria-label="Workspace name"
            data-test="ws-name"
            spellCheck={false}
            autoFocus
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onFocus={S.ringOn}
            onBlur={S.ringOff}
          />
          <div style={{ display: 'flex', gap: 5 }} role="radiogroup" aria-label="Colour">
            {WORKSPACE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                title={c}
                data-test={`ws-color-${c}`}
                onClick={() => setColor(c)}
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 'var(--r-pill)',
                  padding: 0,
                  cursor: 'pointer',
                  background: WORKSPACE_COLOR_CSS[c],
                  border: '2px solid var(--surface-raised)',
                  outline: color === c ? '1px solid var(--text)' : '1px solid transparent'
                }}
              />
            ))}
          </div>
        </div>
        {taken && (
          <div style={{ ...S.hint, color: 'var(--err)', paddingLeft: 54 }} data-test="ws-taken">
            A workspace named “{cleanName}” already exists.
          </div>
        )}
        <div style={S.row}>
          <span style={S.fieldLabel}>Goal</span>
          <input
            style={S.fld}
            placeholder="One line — what this workspace is for"
            aria-label="Workspace goal"
            data-test="ws-goal"
            value={goal}
            maxLength={200}
            onChange={(e) => setGoal(e.target.value)}
            onFocus={S.ringOn}
            onBlur={S.ringOff}
          />
        </div>
      </div>

      <div>
        <div style={S.sectionLabel}>Folder</div>
        {repos && repos.length > 0 && (
          <div style={{ ...S.listBox, marginBottom: 7 }}>
            {repos.map((r, i) => (
              <button
                key={r.rel}
                type="button"
                aria-pressed={root === r.rel}
                data-test={`ws-repo-${r.rel}`}
                onClick={() => setRoot(r.rel)}
                style={{
                  ...S.listRow,
                  ...(i === 0 ? { borderTop: 'none' } : {}),
                  ...(root === r.rel
                    ? { background: 'var(--accent-wash)', color: 'var(--text)' }
                    : {})
                }}
              >
                <span style={S.dot(root === r.rel)} />
                <span style={{ ...S.mono, flex: 1 }}>{label(r.rel)}</span>
                <span style={S.tag}>git</span>
              </button>
            ))}
            <button
              type="button"
              data-test="ws-repo-other"
              onClick={() => folderRef.current?.focus()}
              style={S.listRow}
            >
              <span style={S.dot(!repos.some((r) => r.rel === root))} />
              <span style={{ flex: 1 }}>Other folder in the project…</span>
            </button>
          </div>
        )}
        <div style={S.row}>
          <input
            ref={folderRef}
            style={S.fldMono}
            aria-label="Workspace folder (inside the project)"
            data-test="ws-folder"
            spellCheck={false}
            placeholder=". (the whole project) or a folder like api"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            onFocus={S.ringOn}
            onBlur={S.ringOff}
          />
          <button type="button" style={S.btnSmall} data-test="ws-browse" onClick={browse}>
            Browse…
          </button>
        </div>
        {pickError && (
          <div style={{ ...S.note.err, marginTop: 7 }} data-test="ws-pick-error">
            {pickError}
          </div>
        )}
        <ProbeLine probe={probe} />
      </div>

      <div>
        <div style={S.sectionLabel}>Git</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <ModeOption
            on={mode === 'folder'}
            testid="ws-mode-folder"
            title="Use folder as-is"
            desc={
              <>
                Terminals start in <span style={S.mono}>{probe?.ok ? label(probe.root) : '…'}</span>
                . No branch, no worktree.
              </>
            }
            onPick={() => setMode('folder')}
          />
          <ModeOption
            on={mode === 'worktree'}
            disabled={!repoRoot}
            testid="ws-mode-worktree"
            title="New worktree + branch"
            desc={
              <>
                A separate checkout at <span style={S.mono}>.canvas/worktrees/ws-{slug}</span>.
              </>
            }
            onPick={() => setMode('worktree')}
          >
            {mode === 'worktree' && baseBlock}
          </ModeOption>
          <ModeOption
            on={mode === 'attach'}
            disabled={!repoRoot}
            testid="ws-mode-attach"
            title="Attach existing branch"
            desc="Check an existing local branch out into its own worktree."
            onPick={() => setMode('attach')}
          >
            {mode === 'attach' && attachBlock}
          </ModeOption>
        </div>
      </div>

      {gitMode && (
        <Check
          on={deps && terminal && launch.trim() !== ''}
          disabled={!terminal || launch.trim() === ''}
          onToggle={() => setDeps((v) => !v)}
          testid="ws-deps"
          hint={
            !terminal || launch.trim() === ''
              ? "Needs the starter terminal's agent — the prompt goes to it."
              : 'Once the starter agent is up it gets one prompt to install them. Expanse never runs an install itself.'
          }
        >
          Ask the agent to install dependencies
        </Check>
      )}

      <div>
        <div style={S.sectionLabel}>Starter boards</div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <Check on={terminal} onToggle={() => setTerminal((v) => !v)} testid="ws-starter-terminal">
            Terminal
          </Check>
          <input
            style={{ ...S.fldMono, flex: 'none', width: 150, height: 26 }}
            aria-label="Starter terminal launch command"
            data-test="ws-launch"
            spellCheck={false}
            placeholder="agent command, or empty for a shell"
            disabled={!terminal}
            value={launch}
            onChange={(e) => setLaunch(e.target.value)}
            onFocus={S.ringOn}
            onBlur={S.ringOff}
          />
          <Check on={browser} onToggle={() => setBrowser((v) => !v)} testid="ws-starter-browser">
            Browser
          </Check>
        </div>
      </div>

      <div style={S.footer}>
        <span style={{ ...S.footerMsg, color: 'var(--err)' }} data-test="ws-error">
          {error}
        </span>
        <button
          type="button"
          style={S.btnGhost}
          disabled={busy}
          onClick={onClose}
          data-test="ws-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          style={canCreate ? S.btnPrimary : { ...S.btnPrimary, ...S.btnDisabled }}
          disabled={!canCreate}
          onClick={() => void create()}
          data-test="ws-create"
        >
          {busy ? (gitMode ? 'Creating worktree…' : 'Creating…') : 'Create workspace'}
        </button>
      </div>
    </Modal>
  )
}

function ProbeLine({ probe }: { probe: WorkspaceProbeResult | null }): ReactElement {
  const line = { ...S.hint, display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }
  if (!probe) return <div style={line}>Checking the folder…</div>
  if (!probe.ok) {
    return (
      <div style={{ ...S.note.err, marginTop: 7 }} data-test="ws-probe-error">
        {probe.reason}
      </div>
    )
  }
  if (!probe.repoRoot) {
    return (
      <div style={line} data-test="ws-git-reason">
        <span aria-hidden="true">○</span>
        {probe.gitReason}
      </div>
    )
  }
  return (
    <div style={line} data-test="ws-git-ok">
      <span style={{ color: 'var(--ok)' }} aria-hidden="true">
        ●
      </span>
      git repo <span style={S.mono}>{label(probe.repoRoot)}</span>
      {probe.current ? (
        <>
          · on <span style={S.mono}>{probe.current}</span>
        </>
      ) : (
        ' · detached HEAD'
      )}
    </div>
  )
}

function ModeOption({
  on,
  disabled = false,
  testid,
  title,
  desc,
  onPick,
  children
}: {
  on: boolean
  disabled?: boolean
  testid: string
  title: string
  desc: ReactNode
  onPick: () => void
  children?: ReactNode
}): ReactElement {
  return (
    <div
      style={{
        ...S.option,
        flexDirection: 'column',
        gap: 0,
        ...(on ? S.optionOn : {}),
        ...(disabled ? S.optionOff : {})
      }}
      data-test={testid}
      data-on={on ? 'true' : 'false'}
    >
      <button
        type="button"
        aria-pressed={on}
        aria-label={title}
        disabled={disabled}
        onClick={onPick}
        style={{
          all: 'unset',
          display: 'flex',
          gap: 9,
          alignItems: 'flex-start',
          flex: 1,
          cursor: disabled ? 'not-allowed' : 'pointer'
        }}
      >
        <span style={S.dot(on)} />
        <span style={{ flex: 1 }}>
          <span style={{ ...S.optionTitle, display: 'block' }}>{title}</span>
          <span style={{ ...S.hint, display: 'block', marginTop: 2 }}>{desc}</span>
        </span>
      </button>
      {children && <div style={{ width: '100%' }}>{children}</div>}
    </div>
  )
}

function Check({
  on,
  disabled = false,
  onToggle,
  testid,
  hint,
  children
}: {
  on: boolean
  disabled?: boolean
  onToggle: () => void
  testid: string
  hint?: string
  children: ReactNode
}): ReactElement {
  return (
    <label
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        color: 'var(--text-2)',
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1
      }}
    >
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={onToggle}
        data-test={testid}
        style={{ margin: '1px 0 0', accentColor: 'var(--accent)' }}
      />
      <span>
        <span style={{ display: 'block' }}>{children}</span>
        {hint && <span style={{ ...S.hint, display: 'block' }}>{hint}</span>}
      </span>
    </label>
  )
}
