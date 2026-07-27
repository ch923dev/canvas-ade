/**
 * Boot auto-reopen: ask MAIN for the most-recent project and open it, else land on the picker.
 *
 * Lifted out of `App.tsx` by audit R4 for one reason — it is the door that was WRONG, and inside
 * the App root it was untestable. Boot alone among the three open doors took no switch lock, so a
 * user clicking a recent while `project.current()` was still resolving ran two concurrent opens
 * (#BUG-009). Routing it through `openProject` fixes that; living in its own module is what lets a
 * test prove it still does.
 */
import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'
import { openProject } from './openProject'
import { isE2E } from '../smoke/e2eRegistry'

export function useProjectBoot(): void {
  useEffect(() => {
    // E2E (CANVAS_E2E) seeds boards directly and never opens a project. Flip to `open` so the
    // canvas mounts (and installs `window.__canvasE2E`); the disk path is irrelevant under the
    // harness. NOTE: this means the real boot path below is NOT exercised by the e2e suite —
    // `useProjectBoot.test.ts` + the manual dev check are its coverage.
    if (isE2E()) {
      useCanvasStore.setState({ project: { dir: null, name: 'e2e', status: 'open' } })
      return
    }
    void openProject(() => window.api.project.current())
  }, [])
}
