/**
 * MCP dispatch audit probe (M4 T4.1). Proves the audit trail round-trips end to end:
 * MAIN appends an entry to the real append-only JSONL (the exact seam the dispatch
 * tools T4.3+ will write through, `getAuditLog()`), and the RENDERER reads it back over
 * the frame-guarded `audit:read` IPC (`window.api.mcp.readAudit`) AND the viewer panel
 * renders the row.
 *
 * Future M4 cards (T4.3 handoff_prompt etc.) replace the direct `append` here with a
 * real dispatch and assert the SAME readback — the audit infra is shared.
 *
 * No baseline mutation (the audit log is a separate userData file, not the canvas), so
 * nothing to restore beyond closing the viewer it opens.
 */
import { randomUUID } from 'node:crypto'
import type { E2EProbe } from '../types'
import { getAuditLog } from '../../auditIpc'

const SENTINEL = 'CANVAS_E2E_AUDIT_PROBE'
const TOGGLE_KEY = `window.dispatchEvent(new KeyboardEvent('keydown',{key:'A',ctrlKey:true,shiftKey:true}))`

export const dispatchAudit: E2EProbe = {
  name: 'dispatch-audit',
  async run(ctx) {
    const log = getAuditLog()
    if (!log) {
      return {
        name: 'dispatch-audit',
        ok: false,
        detail: 'getAuditLog() returned null (not wired)'
      }
    }

    const nonce = randomUUID()
    const targetId = randomUUID()
    const written = await log.append({
      type: 'handoff_prompt',
      targetId,
      prompt: SENTINEL,
      nonce,
      status: 'dispatched'
    })

    // (1) readback through the renderer IPC path (MAIN persist → audit:read → preload).
    const seenInRenderer = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.api.mcp.readAudit({ limit: 50 }).then((es) => es.some((e) =>` +
            ` e.nonce === ${JSON.stringify(nonce)} && e.prompt === ${JSON.stringify(SENTINEL)}` +
            ` && e.seq === ${written.seq} && e.status === 'dispatched'))`
        ),
      4000
    )

    // (2) the viewer renders the entry. Open once, then poll the DOM (open fetches async).
    await ctx.evalIn(TOGGLE_KEY)
    const renderedInViewer = await ctx.poll(
      () => ctx.evalIn<boolean>(`!!document.querySelector('[data-audit-seq="${written.seq}"]')`),
      4000
    )
    await ctx.evalIn(TOGGLE_KEY) // close — restore baseline UI

    const ok = seenInRenderer && renderedInViewer
    return {
      name: 'dispatch-audit',
      ok,
      detail: ok
        ? `audit entry #${written.seq} persisted → read back via IPC + rendered in viewer`
        : JSON.stringify({ writtenSeq: written.seq, seenInRenderer, renderedInViewer })
    }
  }
}
