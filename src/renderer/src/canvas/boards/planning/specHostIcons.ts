/**
 * Host-side pin of the `@expanse-ade/diagram` icon vocabulary (Phase 5 Card 2 extraction seam).
 * The package types `SPEC_ICON_NAMES` as `readonly string[]` (it cannot know the host registry);
 * this module is where the names narrow back to `IconName`: the list below is compile-checked
 * against the registry (`satisfies`), and the bridge unit test pins it EQUAL to the package's
 * vocabulary — a package-side change can never silently outrun the registry. Side-effect-free on
 * purpose (the palette imports it; the seam WIRING lives in diagramPackageBridge.tsx).
 */
import { SPEC_ICON_NAMES } from '@expanse-ade/diagram'
import type { IconName } from '../../Icon'

/** The package's closed icon vocabulary, narrowed to the HOST registry type. */
export const SPEC_HOST_ICONS = [
  'play',
  'stop',
  'cpu',
  'globe',
  'file',
  'download',
  'settings',
  'plug',
  'activity',
  'bell'
] as const satisfies readonly IconName[]

/** True when the package vocabulary and the host pin above agree (unit-tested; cheap set equal). */
export function specIconVocabularyInSync(): boolean {
  return (
    SPEC_ICON_NAMES.length === SPEC_HOST_ICONS.length &&
    SPEC_ICON_NAMES.every((n) => (SPEC_HOST_ICONS as readonly string[]).includes(n))
  )
}
