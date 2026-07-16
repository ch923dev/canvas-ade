/**
 * Project-switch hotkey (RENDERER half). MAIN binds the chord to the focused window
 * (globalHotkey.ts) and forwards only a cycle DIRECTION (1 = next / -1 = prev); this hook turns
 * that into the running-projects switcher overlay — open it (or, if already open, advance the
 * highlight). The actual switch is committed from the overlay via performProjectSwitch; the
 * overlay owns the frozen running-set snapshot (see runningSwitcherStore) so the cycle is stable.
 *
 * Mounted ONCE at the App root: it must outlive a project switch, and the ProjectSwitcher pill
 * unmounts the moment status flips to 'loading' — so it can't own this subscription.
 */
import { useEffect } from 'react'
import { useAccountStore } from './accountStore'
import { useRunningSwitcherStore } from './runningSwitcherStore'

function onCycle(dir: 1 | -1): void {
  // The forced sign-in overlay (__REQUIRE_ACCOUNT__ + signed-out) is a locked gate meant to block
  // ALL interaction until sign-in; the hotkey — the one vector that can bypass renderer focus —
  // must NOT raise the switcher behind it (reviewer PR #309). No-op while that gate is up.
  if (__REQUIRE_ACCOUNT__ && useAccountStore.getState().status === 'signed-out') return
  void useRunningSwitcherStore.getState().openWith(dir)
}

export function useProjectSwitchHotkey(): void {
  useEffect(() => {
    // Guarded for non-electron test runtimes (window.api absent), like the App's recap effect.
    const subscribe = window.api?.project?.onCycleProject
    if (!subscribe) return
    return subscribe((d) => onCycle(d))
  }, [])
}
