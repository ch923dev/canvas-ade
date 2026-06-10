/**
 * D0-4: close a transient picker on Escape or an outside pointerdown, matching the
 * BoardMenu / TidyMenu / project-switcher dismissal pattern (the port + browser
 * pickers were Cancel-only). The picker's root element must stop its OWN pointerdown
 * (`onPointerDown={(e) => e.stopPropagation()}`) so an inside click never reaches the
 * document listener. `dismiss` should be referentially stable (useCallback) so the
 * listeners aren't re-armed every render.
 */
import { useEffect } from 'react'

export function usePickerDismiss(active: boolean, dismiss: () => void): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onKey)
    }
  }, [active, dismiss])
}
