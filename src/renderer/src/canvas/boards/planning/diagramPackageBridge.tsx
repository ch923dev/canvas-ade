/**
 * Host bridge for `@expanse-ade/diagram` (Phase 5 Card 2 extraction) — the ONE place the app wires
 * the package's host seams. Imported for its side effects from `main.tsx`, before the first render:
 *  - styles: the motion/dim/ghost stylesheet (`pl-spec-*`) the package's renderer classes expect —
 *    this replaced the deleted planning.css § DiagramSpec motion block, byte-identical rules;
 *  - ELK worker: the package cannot carry Vite's `?worker` syntax, so the app injects the bundled
 *    elk worker here — layout runs OFF-THREAD exactly as before the extraction (specElk seam);
 *  - icons: `SpecNode.icon` renders through the HOST Icon registry (13px, text-3 ink — the node
 *    mark chrome), restoring the pre-extraction `<Icon>` render for the closed SPEC_ICON_NAMES set.
 */
import '@expanse-ade/diagram/styles.css'
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker'
import { configureSpecElkWorker, registerSpecIconRenderer } from '@expanse-ade/diagram'
import { Icon, type IconName } from '../../Icon'

configureSpecElkWorker(() => new ElkWorker())

registerSpecIconRenderer((name, { size, style }) => (
  <Icon name={name as IconName} size={size} style={style} />
))
