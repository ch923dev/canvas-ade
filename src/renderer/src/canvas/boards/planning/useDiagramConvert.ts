/**
 * Convert-action state for DiagramCard (mermaid → expanse, the ⧉ header action). Owns the
 * transient failure notice (auto-cleared) and the extract→map→commit pipeline. Extraction (the
 * hidden worker via `diagram:extractFlow`) AND the strict mapping (mermaidFlowToSpec) both
 * complete BEFORE any store write: only a fully-valid spec arms the undo checkpoint (onEditStart)
 * and commits — every failure path leaves the mermaid element exactly as it was and just flashes
 * the card's error ribbon with `convertError`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiagramSpec } from '../../../lib/boardSchema'
import { mermaidFlowToSpec } from '../../../lib/mermaidToSpec'

/** How long a failed convert's notice stays in the error ribbon before auto-clearing. */
const CONVERT_ERROR_MS = 4_000

export function useDiagramConvert(
  id: string,
  source: string,
  onEditStart: () => void,
  onConvert: (id: string, spec: DiagramSpec, importedFrom: string) => void
): { convertError: string | null; convertClick: () => Promise<void> } {
  const [convertError, setConvertError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showError = useCallback((msg: string) => {
    setConvertError(msg)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setConvertError(null), CONVERT_ERROR_MS)
  }, [])
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )
  const convertClick = useCallback(async () => {
    try {
      const res = await window.api.diagram.extractFlow(source)
      if (!res.ok) throw new Error(res.error)
      const spec = mermaidFlowToSpec(res.flow)
      onEditStart()
      onConvert(id, spec, source)
    } catch (e) {
      showError(String((e as Error)?.message ?? e))
    }
  }, [id, source, onConvert, onEditStart, showError])
  return { convertError, convertClick }
}
