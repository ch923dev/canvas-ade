import { useEffect, useMemo, useState } from 'react'
import {
  highlightSnapshotAsync,
  needsAsyncHighlight,
  resolveLanguage,
  snapshotImmediateHtml
} from './fileBoardSyntax'

type SnapshotParser = ReturnType<typeof resolveLanguage>['parser']

/**
 * SLICE-008 — the static snapshot's highlighted HTML, kept OFF the open-time critical path.
 *
 * Small files highlight synchronously (flash-free, identical to the old one-shot `buildSnapshotHtml`).
 * Large files (≤200 KB cap, where a single `parser.parse` blocked the frame for 64–197 ms on open)
 * render escaped plaintext immediately, then a time-sliced async parse (`highlightSnapshotAsync`)
 * swaps in the highlighted HTML — byte-identical to the synchronous result — so opening a big file
 * never blocks a frame. A newer `text`/`parser` supersedes an in-flight pass: the `stale` flag stops
 * it, and the (src, parser)-identity guard rejects a late straggler that still resolves.
 *
 * `text` should be the DEFERRED text (React 19 `useDeferredValue`) so fast typing coalesces (SLICE-009).
 */
export function useFileSnapshotHtml(text: string, parser: SnapshotParser): string {
  const immediate = useMemo(() => snapshotImmediateHtml(text, parser), [text, parser])
  const [asyncSnap, setAsyncSnap] = useState<{
    src: string
    parser: SnapshotParser
    html: string
  } | null>(null)
  useEffect(() => {
    if (!needsAsyncHighlight(text, parser)) return
    let stale = false
    void highlightSnapshotAsync(text, parser, () => stale).then((html) => {
      if (!stale && html != null) setAsyncSnap({ src: text, parser, html })
    })
    return () => {
      stale = true
    }
  }, [text, parser])
  return asyncSnap && asyncSnap.src === text && asyncSnap.parser === parser
    ? asyncSnap.html
    : immediate
}
