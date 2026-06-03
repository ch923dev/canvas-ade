import { createMemoryEngine } from '../../memoryEngine'
import type { E2EProbe } from '../types'

/**
 * M-memory T-M2: the meaningful-change detector. Drives createMemoryEngine directly
 * (MAIN-side, like context-memory) with a SHORT real debounce + a counting onIntent, and
 * asserts: a CONTENT change (note text) fires exactly ONE intent after the debounce, while
 * a PURE MOVE (x only) fires ZERO. Real timer (not a fake) so it exercises the production
 * setTimeout path end-to-end. No LLM, no .canvas/ write.
 */
export const contextChange: E2EProbe = {
  name: 'context-change',
  async run(ctx) {
    void ctx // MAIN-side only: no renderer interaction needed for the detector
    const intents: string[] = []
    const debounceMs = 40
    const engine = createMemoryEngine({
      onIntent: (i) => intents.push(i.boardId),
      debounceMs
    })
    const docWith = (text: string, x: number): unknown => ({
      schemaVersion: 4,
      viewport: null,
      boards: [
        {
          id: 'b1',
          type: 'planning',
          x,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [{ id: 'n1', kind: 'note', x: 0, y: 0, w: 100, h: 80, tint: 'yellow', text }]
        }
      ]
    })
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, debounceMs + 200))

    // 1) baseline (no emit) → a CONTENT change → exactly one intent after the debounce
    engine.observe(docWith('hello', 0))
    engine.observe(docWith('hello world', 0)) // note text changed
    await settle()
    const afterContent = intents.length // expect 1

    // 2) a PURE MOVE (x changes, text identical) → no new intent
    engine.observe(docWith('hello world', 999))
    await settle()
    const afterMove = intents.length // expect still 1

    const ok = afterContent === 1 && afterMove === 1 && intents[0] === 'b1'
    return {
      name: 'context-change',
      ok,
      detail: ok
        ? 'content change → 1 intent; pure move → 0 (debounced detector)'
        : JSON.stringify({ afterContent, afterMove, intents })
    }
  }
}
