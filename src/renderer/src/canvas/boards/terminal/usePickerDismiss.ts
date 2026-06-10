/**
 * D0-4: close a transient picker on Escape or an outside pointerdown, matching the
 * BoardMenu / TidyMenu / project-switcher dismissal pattern (the port + browser
 * pickers were Cancel-only). The picker's root element must stop its OWN pointerdown
 * (`onPointerDown={(e) => e.stopPropagation()}`) so an inside click never reaches the
 * document listener. `dismiss` is forwarded through a ref, so callers do NOT need to
 * stabilise it — the listeners are armed once per `active` and always call the latest
 * callback.
 */
import { useEffect, useRef } from 'react'

export function usePickerDismiss(active: boolean, dismiss: () => void): void {
  const dismissRef = useRef(dismiss)
  useEffect(() => {
    dismissRef.current = dismiss
  }, [dismiss])
  useEffect(() => {
    if (!active) return
    const onPtr = (): void => dismissRef.current()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissRef.current()
    }
    document.addEventListener('pointerdown', onPtr)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPtr)
      document.removeEventListener('keydown', onKey)
    }
  }, [active])
}
