/**
 * Global project-switch hotkey — the RENDERER half. MAIN owns the OS-wide accelerator + window
 * foregrounding (globalHotkey.ts) and forwards only a cycle direction; this hook turns that into
 * an actual switch by walking the recents ring (the same MRU list the ProjectSwitcher shows) and
 * driving the shared `performProjectSwitch` pipeline (lock → keep-decision → flush → handover →
 * load). `project.open` transparently foregrounds a backgrounded resident or cold-opens a recent,
 * so one call covers both.
 *
 * Mounted ONCE at the App root: it must outlive a project switch, and the ProjectSwitcher unmounts
 * the moment status flips to 'loading' — so it can't own this subscription.
 */
import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'
import { performProjectSwitch } from './projectSwitch'
import { showToast } from './toastStore'
import { toastLockedSwitch } from '../canvas/projectSessionsShared'

async function cycleProject(dir: 1 | -1): Promise<void> {
  const recents = await window.api.project.recents().catch(() => [])
  if (recents.length === 0) {
    showToast({ id: 'hotkey-no-project', kind: 'info', message: 'No recent projects to switch to' })
    return
  }
  const currentDir = useCanvasStore.getState().project.dir
  const idx = recents.findIndex((r) => r.path === currentDir)
  // Current not in recents (e.g. a brand-new unsaved project) → step in from the ring's edge.
  let target = idx < 0 ? (dir === 1 ? recents[0] : recents[recents.length - 1]) : undefined
  if (idx >= 0) {
    if (recents.length === 1) {
      showToast({ id: 'hotkey-no-project', kind: 'info', message: 'No other project to switch to' })
      return
    }
    target = recents[(idx + dir + recents.length) % recents.length]
  }
  if (!target || target.path === currentDir) return
  const t = target
  // toastLockedSwitch surfaces the 'locked' outcome (a second cycle mid-switch) the same way a
  // double-clicked switcher row does; every other outcome is handled inside the pipeline.
  toastLockedSwitch(
    await performProjectSwitch(() => window.api.project.open(t.path), { incomingName: t.name })
  )
}

export function useProjectSwitchHotkey(): void {
  useEffect(() => {
    // Guarded for non-electron test runtimes (window.api absent), like the App's recap effect.
    const onCycle = window.api?.project?.onCycleProject
    const onFail = window.api?.hotkey?.onRegisterFailed
    const unsubs: Array<() => void> = []
    if (onCycle) unsubs.push(onCycle((d) => void cycleProject(d)))
    if (onFail) {
      unsubs.push(
        onFail((accels) =>
          showToast({
            id: 'hotkey-register-failed',
            kind: 'error',
            sticky: true,
            message: `Couldn't bind the project-switch hotkey (${accels.join(', ')} already in use). Rebind it in Settings › Shortcuts.`
          })
        )
      )
    }
    return () => unsubs.forEach((u) => u())
  }, [])
}
