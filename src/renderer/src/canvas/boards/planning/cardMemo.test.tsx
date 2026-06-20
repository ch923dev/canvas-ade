import { describe, it, expect } from 'vitest'
import { NoteCard } from './NoteCard'
import { ChecklistCard } from './ChecklistCard'
import { FreeText } from './FreeText'
import { ImageCard } from './ImageCard'
import { WhiteboardSvg } from './WhiteboardSvg'

/**
 * P0 perf — per-card render isolation. `React.memo(fn)` returns an exotic element type
 * whose `$$typeof` is the memo symbol. Asserting it here guards the optimization: if a
 * card is ever un-memo'd again, editing ONE planning element would re-render EVERY card in
 * the well (the regression this slice fixes). The companion prop-stability test proves the
 * board actually hands those memo'd cards stable props so the skip really happens.
 */
const MEMO = Symbol.for('react.memo')
const isMemo = (c: unknown): boolean =>
  typeof c === 'object' && c !== null && (c as { $$typeof?: symbol }).$$typeof === MEMO

describe('planning cards are memoized', () => {
  it.each([
    ['NoteCard', NoteCard],
    ['ChecklistCard', ChecklistCard],
    ['FreeText', FreeText],
    ['ImageCard', ImageCard]
  ])('%s is a React.memo component', (_name, Comp) => {
    expect(isMemo(Comp)).toBe(true)
  })
})

describe('the whiteboard vector layer is memoized (PLAN-07)', () => {
  it('WhiteboardSvg is a React.memo component', () => {
    // Once PLAN-01 stops the board re-rendering per camera frame, memo lets the SVG layer
    // skip re-renders that don't touch its (useMemo-stabilized) arrow/stroke props.
    expect(isMemo(WhiteboardSvg)).toBe(true)
  })
})
