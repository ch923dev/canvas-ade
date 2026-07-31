/**
 * Swarm docked-terminals — the dock VIEWPORT (design gate 2026-07-30, artifact dc48270d):
 * every worker terminal docked in this swarm board renders here instead of as a canvas node,
 * one pane per worker, with the rail (SwarmWorkerCards) as the tab strip.
 *
 * Mechanics that keep this honest:
 *  - Workers STAY full boards. Each pane runs the REAL `useTerminalSpawn` against the real
 *    board object, so the PTY spawn/adopt/kill lifecycle, the MessagePort data plane, the
 *    consent/env registries (all board-id-keyed) are byte-identical to a canvas terminal.
 *    The dock changes WHERE the terminal renders, never what it is.
 *  - ALL docked panes stay MOUNTED; only the active tab is visible. Inactive panes use
 *    `visibility: hidden` — NOT `display: none` — because the spawn effect is
 *    ResizeObserver-deferred (#23/#34): a display-none host has no dims, so a freshly spawned
 *    worker would never actually spawn until first clicked. Hidden-but-laid-out keeps real
 *    dims (spawn proceeds) while the liveness gate (useTerminalLiveness's dock rule) holds
 *    an inactive pane's PTY bytes exactly like an off-screen board — switching tabs flushes
 *    the held buffer losslessly.
 *  - Pop out = `parkTerminal` THEN clear `dockedIn` (history-neutral patch): the pane's
 *    unmount `killTerminal` no-ops on a parked session, and the canvas TerminalBoard that
 *    mounts next adopts it + replays the ring — the background-sessions handoff, reused.
 *    The patch is untracked on purpose: a tracked flip would make Ctrl+Z remount the
 *    terminal across surfaces and the interleaved unmount would KILL a live PTY.
 */
import { useCallback, useContext, useEffect, useRef, useState, type ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import type { TerminalBoard as TerminalBoardData } from '../../../lib/boardSchema'
import { BoardActionsContext } from '../../boardActions'
import { parkTerminalForUndo } from '../terminal/terminalTeardown'
import { useCanvasStore, patchBoardUntracked } from '../../../store/canvasStore'
import { useDockStore } from '../../../store/dockStore'
import type { AttentionKind } from '../../../store/attentionStore'
import type { SwarmRun } from '../../../store/swarmStore'
import { rolePackById } from '../../../../../shared/rolePacks'
import { useTerminalSpawn } from '../terminal/useTerminalSpawn'
import { pasteIntoTerminal } from '../terminal/pasteIntoTerminal'
import { isOpenableScheme } from '../terminal/terminalLinks'
import { agentIdentity, isRunning } from '../terminalState'
import { presetById } from '../terminal/agentPresets'
import { useInterruptFeedback } from '../terminal/useInterruptFeedback'
import { useTerminalReraster } from '../terminal/useTerminalReraster'
import { resolveInitialFont } from '../terminal/terminalFont'
import { TerminalIdleAffordance } from '../terminal/TerminalIdleAffordance'
import { TerminalFindBar } from '../terminal/TerminalFindBar'
import { screen } from '../terminal/terminalBoardStyles'
import { stateOf, activityLine, type CardState } from './SwarmWorkerCards'

interface DockedPaneProps {
  board: TerminalBoardData
  active: boolean
  state: CardState
  activity: string
  /** The worker's role-pack id (run meta) — rendered as the `role · posture` head pill. */
  roleId?: string
  onPopOut: (boardId: string) => void
  onRemove: (boardId: string) => void
}

/**
 * Handoff serializer (the re-dock corpse fix). A re-dock flips `dockedIn` while the board's
 * CANVAS node is still in React Flow for one more commit (nodes derive from the store through
 * an effect → rf.setNodes — asynchronous). Mounting the pane inside that window double-surfaces
 * the session: the adopt's `pty:port` broadcast reaches BOTH surfaces, and the dying canvas
 * surface's unmount then closes the shared port and `killTerminal`s the freshly re-adopted LIVE
 * session (measured: MAIN sessions 2→1, pane left holding a dead frozen xterm at the old width).
 * Hold the pane until the canvas node is GONE, so the old surface's teardown — whose kill
 * no-ops on the still-parked session — strictly precedes the pane's adopt. Pop-out already has
 * this ordering naturally (the pane unmounts in the same commit the flag flips); first-spawn and
 * restore-from-disk boards never had a canvas node, so the gate passes immediately.
 */
function DockedPaneGate(props: DockedPaneProps): ReactElement | null {
  const stillOnCanvas = useStore((s) => s.nodeLookup.has(props.board.id))
  if (stillOnCanvas) return null
  return <DockedPane {...props} />
}

/** One docked worker's pane: minimal head chrome + the real xterm/PTY host. */
function DockedPane({
  board,
  active,
  state,
  activity,
  roleId,
  onPopOut,
  onRemove
}: DockedPaneProps): ReactElement {
  const screenRef = useRef<HTMLDivElement>(null)
  // Font nudges are a canvas-terminal affordance (Inspector/menu); the dock keeps the sticky
  // default, so the keymap's Ctrl±/0 bridges are inert here.
  const fontStepRef = useRef<(delta: number) => void>(() => {})
  const fontResetRef = useRef<() => void>(() => {})
  const projectDir = useCanvasStore((s) => s.project.dir)
  // Links: the dock has no push-to-preview wiring (that is canvas-board sugar) — a
  // Ctrl/Cmd-clicked URL opens in the OS browser; MAIN re-validates the scheme.
  const onLinkActivate = useCallback((uri: string): void => {
    if (isOpenableScheme(uri)) void window.api.openExternalUrl(uri)
  }, [])
  const {
    state: ptyState,
    restored,
    restoredExitCode,
    termRef,
    portRef,
    startLaunchRef,
    fitWhole,
    counterScale,
    findOpen,
    findApi
  } = useTerminalSpawn({
    board,
    projectDir,
    screenRef,
    fontStepRef,
    fontResetRef,
    pasteIntoTerminal,
    configPending: false,
    onLinkActivate
  })
  // Terminal parity (eyeball fix 2026-07-31): the SAME settled font seam + transition refit
  // TerminalBoard runs — without it the pane's render font never re-syncs and a resize/zoom
  // transition paints the garbled half-reflowed grid the canvas terminal already heals.
  const [bornFont] = useState<number>(() => resolveInitialFont(board.fontSize))
  const liveFontRef = useRef<number>(resolveInitialFont(board.fontSize))
  const screenStyle = useTerminalReraster({
    pinnedFontSize: board.fontSize,
    bornFont,
    counterScale,
    termRef,
    fitWhole,
    liveFontRef,
    identityStyle: screen
  })
  // Refit when devicePixelRatio changes (monitor move) — the host doesn't resize, so the RO
  // never fires, but the cell height changed (the TerminalBoard dpr effect, verbatim).
  useEffect(() => {
    let mql: MediaQueryList | null = null
    const onChange = (): void => {
      fitWhole()
      attach()
    }
    const attach = (): void => {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mql.addEventListener('change', onChange, { once: true })
    }
    attach()
    return () => mql?.removeEventListener('change', onChange)
  }, [fitWhole])
  const { interruptSent, interrupt } = useInterruptFeedback(portRef)
  const running = isRunning(ptyState)
  const presetLabel =
    board.agentKind && board.agentKind !== 'shell' ? presetById(board.agentKind)?.label : undefined
  const identity = presetLabel ?? agentIdentity(board.launchCommand, board.shell)
  // The head pill names the role AND its posture (`reviewer · read-only`) — the same fact the
  // spawn confirm disclosed, kept visible where the worker runs. Unknown role ⇒ id alone.
  const pack = roleId ? rolePackById(roleId) : undefined
  const roleLabel = roleId
    ? `${roleId}${pack ? ` · ${pack.permissionMode === 'plan' ? 'read-only' : 'write'}` : ''}`
    : undefined

  return (
    <section
      className="sw-vp-pane"
      style={{ visibility: active ? 'visible' : 'hidden' }}
      data-test={`swarm-dock-pane-${board.id}`}
      data-active={active || undefined}
    >
      <header className="sw-vp-head">
        <span className={`sw-st ${state}`} aria-hidden="true" />
        <span className="sw-vp-name">{board.title}</span>
        {roleLabel && <span className="sw-role">{roleLabel}</span>}
        <span className="sw-vp-activity">{activity}</span>
        <span className="sw-spacer" />
        {interruptSent && <span className="sw-vp-int">interrupt sent</span>}
        {running && (
          <button
            type="button"
            className="sw-btn sm"
            onClick={interrupt}
            data-test={`swarm-dock-interrupt-${board.id}`}
          >
            ⏹ Interrupt
          </button>
        )}
        <button
          type="button"
          className="sw-btn sm"
          onClick={() => onPopOut(board.id)}
          title="Pop out to a canvas board"
          data-test={`swarm-dock-popout-${board.id}`}
        >
          Pop out ↗
        </button>
        <button
          type="button"
          className="sw-btn sm"
          onClick={() => onRemove(board.id)}
          title="Remove worker board (undo restores it)"
          data-test={`swarm-dock-close-${board.id}`}
        >
          ✕
        </button>
      </header>
      {/* nodrag/nowheel: clicks focus xterm, wheel scrolls scrollback — never a canvas
          drag/zoom (the TerminalBoard screenWrap discipline). */}
      <div
        className="sw-vp-body nodrag nowheel"
        onMouseDown={(e) => {
          e.stopPropagation()
          termRef.current?.focus()
        }}
      >
        <div ref={screenRef} style={screenStyle} />
        {findOpen && <TerminalFindBar api={findApi} />}
        <TerminalIdleAffordance
          state={ptyState}
          restored={restored}
          restoredExitCode={restoredExitCode}
          identity={identity}
          onStart={() => startLaunchRef.current?.()}
        />
      </div>
    </section>
  )
}

export function SwarmDock({
  swarmId,
  docked,
  run,
  attention,
  running
}: {
  swarmId: string
  /** The docked worker boards, rail order (SwarmBoard derives this from the boards store). */
  docked: readonly TerminalBoardData[]
  run: SwarmRun
  attention: Record<string, AttentionKind>
  running: Record<string, boolean>
}): ReactElement {
  const active = useDockStore((s) => s.active[swarmId])
  const byBoard = new Map((run.ledger?.workers ?? []).map((w) => [w.boardId, w]))

  // Default tab: the stored selection when it still points at a docked board, else the first
  // docked worker. Never auto-switches on state changes (a needs-input worker jumps the RAIL
  // order — stealing the viewport mid-read would be the modal-steals-focus bug at board scale).
  const activeValid = active !== undefined && docked.some((b) => b.id === active)
  useEffect(() => {
    if (docked.length === 0) {
      if (active !== undefined) useDockStore.getState().clear(swarmId)
      return
    }
    if (!activeValid) useDockStore.getState().setActive(swarmId, docked[0].id)
  }, [docked, active, activeValid, swarmId])

  // Pop out: park FIRST (so the pane's unmount killTerminal no-ops), then clear the flag in a
  // HISTORY-NEUTRAL patch (see the module doc — a tracked flip would let undo kill the PTY).
  // Park failure (no live session — idle/exited board) still pops out: there is nothing to lose.
  const onPopOut = useCallback((boardId: string): void => {
    void Promise.resolve(window.api.parkTerminal?.(boardId))
      .catch(() => {})
      .then(() => patchBoardUntracked(boardId, { dockedIn: undefined }))
  }, [])

  // Remove (eyeball feedback 2026-07-31: a docked worker had NO delete path — no canvas node to
  // select). Route through the shared BoardActions.remove — the exact ⋯-menu/Delete-key flow
  // (parks the live session for undo, sweeps groups/connectors, one tracked step). The fallback
  // (context absent — bare test renders) replicates its park + remove core.
  const boardActions = useContext(BoardActionsContext)
  const onRemove = useCallback(
    (boardId: string): void => {
      if (boardActions) {
        boardActions.remove(boardId)
        return
      }
      parkTerminalForUndo(boardId)
      useCanvasStore.getState().removeBoard(boardId)
    },
    [boardActions]
  )

  return (
    <section className="sw-vp" data-test={`swarm-dock-${swarmId}`}>
      {docked.length === 0 ? (
        <div className="sw-vp-empty">workers dock here — ask the orchestrator to spawn one</div>
      ) : (
        docked.map((b) => {
          const st = stateOf(b.id, attention, running, byBoard.get(b.id))
          return (
            <DockedPaneGate
              key={b.id}
              board={b}
              active={activeValid ? b.id === active : b.id === docked[0].id}
              state={st}
              activity={activityLine(st, run.workerMeta[b.id] ?? {})}
              roleId={run.workerMeta[b.id]?.role}
              onPopOut={onPopOut}
              onRemove={onRemove}
            />
          )
        })
      )}
    </section>
  )
}
