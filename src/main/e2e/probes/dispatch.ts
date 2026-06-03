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
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { E2EProbe } from '../types'
import { getAuditLog } from '../../auditIpc'
import { requestConfirm } from '../../mcpConfirm'

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

const APPROVE = `document.querySelector('[data-testid="confirm-approve"]').click()`
const DENY = `document.querySelector('[data-testid="confirm-deny"]').click()`
const MODAL_PRESENT = `!!document.querySelector('[data-testid="confirm-modal"]')`

/**
 * Human-confirm gate probe (M4 T4.2). Proves the gate genuinely BLOCKS the caller until
 * the human acts, and that approve / deny each resolve correctly through the real
 * `mcp:confirm` round-trip (MAIN requestConfirm → modal → reply). Drives the modal the
 * way a user would (clicking the rendered buttons).
 */
export const dispatchConfirm: E2EProbe = {
  name: 'dispatch-confirm',
  async run(ctx) {
    // ── APPROVE path: the gate must stay pending until the human approves. ──
    const approveP = requestConfirm(ipcMain, () => ctx.win, {
      title: 'E2E confirm',
      body: 'Approve this dispatch?'
    })
    const modalShown = await ctx.poll(() => ctx.evalIn<boolean>(MODAL_PRESENT), 4000)
    // Race the still-unanswered promise against a delay: it MUST be pending (blocking).
    const blockedBeforeAnswer =
      (await Promise.race([
        approveP.then(() => 'resolved' as const),
        ctx.delay(250).then(() => 'pending' as const)
      ])) === 'pending'
    await ctx.evalIn(APPROVE)
    const approveDecision = await approveP
    const modalGone = await ctx.poll(async () => !(await ctx.evalIn<boolean>(MODAL_PRESENT)), 4000)

    // ── DENY path: a second request, denied via the button. ──
    const denyP = requestConfirm(ipcMain, () => ctx.win, {
      title: 'E2E confirm',
      body: 'Deny this dispatch?'
    })
    await ctx.poll(() => ctx.evalIn<boolean>(MODAL_PRESENT), 4000)
    await ctx.evalIn(DENY)
    const denyDecision = await denyP

    const ok =
      modalShown &&
      blockedBeforeAnswer &&
      approveDecision.approved === true &&
      modalGone &&
      denyDecision.approved === false
    return {
      name: 'dispatch-confirm',
      ok,
      detail: ok
        ? 'gate blocked until answered; approve→{approved:true}, deny→{approved:false}'
        : JSON.stringify({
            modalShown,
            blockedBeforeAnswer,
            approveDecision,
            modalGone,
            denyDecision
          })
    }
  }
}
