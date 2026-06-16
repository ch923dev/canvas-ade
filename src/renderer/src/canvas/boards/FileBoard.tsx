/**
 * File board content (file-tree epic — S1 PLACEHOLDER).
 *
 * The real on-canvas file viewer/editor (CodeMirror 6 — static highlighted snapshot when
 * zoomed-out / read-only, a counter-scaled live editor on edit-intent, dirty + save) arrives
 * in S3 and REPLACES this body. For now this renders the board's title chrome + the bound
 * relative `path` (or an unbound hint) + a muted "viewer arrives in S3" line, so the `'file'`
 * board type is reachable end-to-end (dock → placement → render → persist) and the schema
 * round-trips. Matches the design tokens in `src/renderer/src/index.css`.
 */
import type { ReactElement } from 'react'
import type { FileBoard as FileBoardData } from '../../lib/boardSchema'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'

export function FileBoard({
  board,
  selected,
  hovered,
  dimmed,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onStartConnect
}: BoardViewProps<FileBoardData>): ReactElement {
  return (
    <BoardFrame
      type="file"
      boardId={board.id}
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      onFull={onFull}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
      onAddToGroup={onAddToGroup}
      onRemoveFromGroup={onRemoveFromGroup}
      onStartConnect={onStartConnect}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: 16,
          textAlign: 'center'
        }}
      >
        {board.path ? (
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12.5,
              color: 'var(--text)',
              wordBreak: 'break-all',
              maxWidth: '100%'
            }}
          >
            {board.path}
          </div>
        ) : (
          <div style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--text-2)' }}>
            No file — open from the tree
          </div>
        )}
        <div style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--text-3)' }}>
          Viewer arrives in S3
        </div>
      </div>
    </BoardFrame>
  )
}
