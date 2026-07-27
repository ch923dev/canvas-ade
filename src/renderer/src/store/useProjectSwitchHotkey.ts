/**
 * Project-switch hotkey (RENDERER half). MAIN binds the chord to the focused window
 * (globalHotkey.ts) and forwards a cycle DIRECTION (1 = next / -1 = prev) plus the HOLD modifier;
 * this hook turns that into the running-projects switcher overlay — open it (or, if already open,
 * advance the highlight). The actual switch is committed from the overlay via performProjectSwitch;
 * the overlay owns the frozen running-set snapshot (see runningSwitcherStore) so the cycle is
 * stable.
 *
 * R16 (commit-on-release) is why this hook also owns a `keyup` listener. Two things force it here
 * rather than into the overlay component:
 *   1. TIMING. The overlay mounts only after an async snapshot fetch, and a fast tap releases the
 *      modifier before that lands. A listener that exists only while the overlay is open would
 *      miss the release of the single most common Alt-Tab gesture, leaving the picker stranded.
 *      This hook is mounted at the App root for the whole session, so the release is never missed.
 *   2. VISIBILITY. MAIN `preventDefault`s the chord's keydown, so the renderer never sees it — the
 *      only way the renderer can know a modifier is being held is to be told, which is exactly
 *      what the `hold` argument is. The modifier's own keyup is not a chord match and is therefore
 *      never swallowed, so it arrives here as an ordinary DOM event.
 *
 * Mounted ONCE at the App root: it must outlive a project switch, and the ProjectSwitcher pill
 * unmounts the moment status flips to 'loading' — so it can't own this subscription.
 */
import { useEffect } from 'react'
import type { ProjectCycleHold } from '../../../preload'
import { useAccountStore } from './accountStore'
import { useRunningSwitcherStore } from './runningSwitcherStore'

function onCycle(dir: 1 | -1, hold: ProjectCycleHold): void {
  // The forced sign-in overlay (__REQUIRE_ACCOUNT__ + signed-out) is a locked gate meant to block
  // ALL interaction until sign-in; the hotkey — the one vector that can bypass renderer focus —
  // must NOT raise the switcher behind it (reviewer PR #309). No-op while that gate is up.
  if (__REQUIRE_ACCOUNT__ && useAccountStore.getState().status === 'signed-out') return
  // Arm the hold BEFORE the (async) open, so a release that lands mid-fetch is still recorded.
  useRunningSwitcherStore.getState().noteHoldKey(hold)
  void useRunningSwitcherStore.getState().openWith(dir)
}

export function useProjectSwitchHotkey(): void {
  useEffect(() => {
    // Guarded for non-electron test runtimes (window.api absent), like the App's recap effect.
    const subscribe = window.api?.project?.onCycleProject
    if (!subscribe) return
    return subscribe((d, hold) => onCycle(d, hold))
  }, [])

  useEffect(() => {
    // Passive: this fires on every keyup in the app, but does nothing at all unless a hold is
    // currently armed — which only a hotkey press does. Capture phase so a focused terminal/input
    // that stops propagation cannot swallow the release the switch depends on.
    const onKeyUp = (e: KeyboardEvent): void => {
      const { holdKey } = useRunningSwitcherStore.getState()
      if (holdKey !== null && e.key === holdKey)
        useRunningSwitcherStore.getState().noteHoldReleased()
    }
    window.addEventListener('keyup', onKeyUp, true)
    return () => window.removeEventListener('keyup', onKeyUp, true)
  }, [])
}
