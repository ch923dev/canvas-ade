/** Browser viewport preset cycling (Duplicate → next preset for side-by-side compare). */
import type { BrowserViewport } from './boardSchema'

const ORDER: readonly BrowserViewport[] = ['mobile', 'tablet', 'desktop']

export function nextViewport(v: BrowserViewport): BrowserViewport {
  return ORDER[(ORDER.indexOf(v) + 1) % ORDER.length]
}
