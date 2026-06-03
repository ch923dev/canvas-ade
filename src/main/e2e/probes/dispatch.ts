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
import type { E2ECtx } from '../context'
import { getAuditLog } from '../../auditIpc'
import { requestConfirm } from '../../mcpConfirm'
import { buildOrchestrator, type BoardRegistry } from '../../mcpOrchestrator'
import { listBoardMirror, listConnectors } from '../../boardRegistry'
import { listPtySessions, readPtyOutput, writeToPty, drainPty } from '../../pty'
import { readBoardResult, recordBoardResult } from '../../boardResults'
import { readProjectMemory, readBoardSummary } from '../../boardMemory'
import { sendMcpCommand } from '../../mcpCommand'

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

const MODAL = `!!document.querySelector('[data-testid="confirm-modal"]')`
const APPROVE_BTN = `(() => { const b = document.querySelector('[data-testid="confirm-approve"]'); if (b) b.click(); return !!b })()`

/**
 * 🔒 handoff_prompt dispatch probe (M4 T4.3, the keystone). Exercises the REAL MAIN
 * dispatch path end-to-end — `buildOrchestrator` wired to the production seams
 * (`listBoardMirror`, `writeToPty`, `requestConfirm`, `getAuditLog().append`) — against
 * a real terminal board:
 *  • label-targeting rejected (a title/unknown string is not an opaque board id);
 *  • happy path: confirm gate → write `echo SENTINEL\r` → the text LANDS in the PTY
 *    framebuffer → the call resolves → a `completed` audit entry is readable via
 *    `audit:read`;
 *  • a replayed/forged nonce (guard.consume → false) is rejected and writes NOTHING.
 * Restores the seed baseline (board count back to 4).
 */
export const dispatchHandoff: E2EProbe = {
  name: 'dispatch-handoff',
  async run(ctx) {
    const audit = getAuditLog()
    if (!audit) return { name: 'dispatch-handoff', ok: false, detail: 'getAuditLog() null' }

    // The production registry wiring (mirror of src/main/index.ts), so the probe drives
    // the true dispatch path rather than a stand-in.
    const registry: BoardRegistry = {
      listBoards: listBoardMirror,
      listConnectors,
      listSessions: listPtySessions,
      readOutput: readPtyOutput,
      readResult: readBoardResult,
      readMemory: readProjectMemory,
      readSummary: readBoardSummary,
      sendCommand: (c) => sendMcpCommand(ipcMain, () => ctx.win, c),
      drainPty,
      writeToPty,
      confirm: (req) => requestConfirm(ipcMain, () => ctx.win, req),
      audit: (e) => audit.append(e).then(() => {}),
      recordResult: recordBoardResult
    }
    const orch = buildOrchestrator(registry, { handoffPollMs: 100, handoffTimeoutMs: 6000 })

    // Spawn a real terminal board (addBoard → canvas + mirror + shell), like lifecycle.
    const id = randomUUID()
    await sendMcpCommand(ipcMain, () => ctx.win, {
      type: 'addBoard',
      board: { id, type: 'terminal' }
    })
    await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.__canvasE2E.getBoards().some((b) => b.id === ${JSON.stringify(id)})`
        ),
      4000
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const shellUp = await ctx.poll(async () => ctx.dbg.terminalPid(id) !== null, 10000)
    // The orchestrator resolves the target through the MAIN-side board mirror (the
    // renderer publishes it ~150ms after addBoard). Wait for it before dispatching, or
    // step-1 resolution would reject the just-spawned board as "not found".
    const inMirror = await ctx.poll(async () => listBoardMirror().some((b) => b.id === id), 6000)

    // (a) 🔒 label-targeting rejected — a TITLE / unknown string is not an opaque id.
    let labelRejected = false
    try {
      await orch.handoffPrompt('Terminal', 'echo nope')
    } catch {
      labelRejected = true
    }

    // (b) happy path — confirm → write → land in the PTY → result returns → audited.
    const SENT = 'CANVAS_E2E_HANDOFF'
    let handoffResolved = false
    let handoffErr = ''
    const hp = orch
      .handoffPrompt(id, `echo ${SENT}`)
      .then(() => {
        handoffResolved = true
      })
      .catch((e) => {
        handoffErr = (e as Error).message
      })
    const modalShown = await ctx.poll(() => ctx.evalIn<boolean>(MODAL), 8000)
    if (modalShown) await ctx.evalIn(APPROVE_BTN)
    // Flip the board idle so the interim await-idle poll returns promptly (M5 = real attention).
    await ctx.evalIn(`window.__canvasE2E.setTerminalDown(${JSON.stringify(id)})`)
    await hp
    const landed = await ctx.poll(async () => {
      const t = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
      )
      return typeof t === 'string' && t.includes(SENT)
    }, 10000)
    const completedAudited = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.api.mcp.readAudit({ limit: 50 }).then((es) => es.some((e) =>` +
            ` e.targetId === ${JSON.stringify(id)} && e.status === 'completed'` +
            ` && e.prompt === ${JSON.stringify('echo ' + SENT)}))`
        ),
      4000
    )

    // (c) 🔒 replayed/forged nonce rejected — same real path, consume → false, NO write.
    const SENT2 = 'CANVAS_E2E_HANDOFF_REPLAY'
    const replayOrch = buildOrchestrator(registry, {
      guard: { issue: () => ({ nonce: 'forged', seq: 1 }), consume: () => false },
      handoffPollMs: 100,
      handoffTimeoutMs: 6000
    })
    let replayRejected = false
    const rp = replayOrch
      .handoffPrompt(id, `echo ${SENT2}`)
      .then(() => {})
      .catch(() => {
        replayRejected = true
      })
    const replayModal = await ctx.poll(() => ctx.evalIn<boolean>(MODAL), 8000)
    if (replayModal) await ctx.evalIn(APPROVE_BTN)
    await rp
    // The forged-nonce dispatch must NOT have written its sentinel into the PTY.
    const replayWrote = await ctx.poll(async () => {
      const t = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
      )
      return typeof t === 'string' && t.includes(SENT2)
    }, 1500)
    const replayAbsent = !replayWrote

    // Restore the baseline: drain + removeBoard (count back to 4).
    await drainPty(id)
    await sendMcpCommand(ipcMain, () => ctx.win, { type: 'removeBoard', id })
    const restored = await ctx.poll(
      () => ctx.evalIn<boolean>('window.__canvasE2E.getBoards().length === 4'),
      4000
    )

    const ok =
      shellUp &&
      inMirror &&
      labelRejected &&
      modalShown &&
      handoffResolved &&
      landed &&
      completedAudited &&
      replayRejected &&
      replayAbsent &&
      restored
    return {
      name: 'dispatch-handoff',
      ok,
      detail: ok
        ? 'label rejected; confirm→write→PTY land→result→completed audit; replayed nonce wrote nothing; baseline 4'
        : JSON.stringify({
            shellUp,
            inMirror,
            handoffErr,
            labelRejected,
            modalShown,
            handoffResolved,
            landed,
            completedAudited,
            replayRejected,
            replayAbsent,
            restored
          })
    }
  }
}

/** Build the production-wired BoardRegistry (mirror of src/main/index.ts) for a probe. */
function productionRegistry(ctx: E2ECtx): BoardRegistry {
  const audit = getAuditLog()
  return {
    listBoards: listBoardMirror,
    listConnectors,
    listSessions: listPtySessions,
    readOutput: readPtyOutput,
    readResult: readBoardResult,
    readMemory: readProjectMemory,
    readSummary: readBoardSummary,
    sendCommand: (c) => sendMcpCommand(ipcMain, () => ctx.win, c),
    drainPty,
    writeToPty,
    confirm: (req) => requestConfirm(ipcMain, () => ctx.win, req),
    audit: (e) => (audit ? audit.append(e).then(() => {}) : Promise.resolve()),
    recordResult: recordBoardResult
  }
}

/**
 * 🔒 assign_prompt dispatch probe (M4 T4.4) — the FIRE-AND-FORGET sibling of
 * dispatch-handoff. Exercises the REAL MAIN dispatch path against a live terminal:
 *  • label-targeting rejected (a title is not an opaque board id);
 *  • happy path: confirm gate → write `echo SENTINEL\r` → the text LANDS in the PTY → the
 *    call RESOLVES WITHOUT awaiting idle (no setTerminalDown needed) → a `dispatched`
 *    audit entry is readable AND there is NO `completed` entry (fire-and-forget);
 *  • a replayed/forged nonce (consume → false) is rejected and writes NOTHING.
 * Restores the seed baseline (board count back to 4).
 */
export const dispatchAssign: E2EProbe = {
  name: 'dispatch-assign',
  async run(ctx) {
    if (!getAuditLog()) return { name: 'dispatch-assign', ok: false, detail: 'getAuditLog() null' }
    const registry = productionRegistry(ctx)
    const orch = buildOrchestrator(registry)

    const id = randomUUID()
    await sendMcpCommand(ipcMain, () => ctx.win, {
      type: 'addBoard',
      board: { id, type: 'terminal' }
    })
    await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.__canvasE2E.getBoards().some((b) => b.id === ${JSON.stringify(id)})`
        ),
      4000
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const shellUp = await ctx.poll(async () => ctx.dbg.terminalPid(id) !== null, 10000)
    const inMirror = await ctx.poll(async () => listBoardMirror().some((b) => b.id === id), 6000)

    // (a) 🔒 label-targeting rejected — a TITLE / unknown string is not an opaque id.
    let labelRejected = false
    try {
      await orch.dispatchPrompt('Terminal', 'echo nope')
    } catch {
      labelRejected = true
    }

    // (b) happy path — confirm → write → land in the PTY → RESOLVES (no await-idle).
    const SENT = 'CANVAS_E2E_ASSIGN'
    let assignResolved = false
    let assignErr = ''
    const ap = orch
      .dispatchPrompt(id, `echo ${SENT}`)
      .then(() => {
        assignResolved = true
      })
      .catch((e) => {
        assignErr = (e as Error).message
      })
    const modalShown = await ctx.poll(() => ctx.evalIn<boolean>(MODAL), 8000)
    if (modalShown) await ctx.evalIn(APPROVE_BTN)
    // Fire-and-forget: NO setTerminalDown — the call must resolve on its own once the
    // write lands (it does not poll the board to idle, unlike handoff).
    await ap
    const landed = await ctx.poll(async () => {
      const t = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
      )
      return typeof t === 'string' && t.includes(SENT)
    }, 10000)
    // a `dispatched` (assign_prompt) entry exists; NO `completed` entry (fire-and-forget).
    const dispatchedAudited = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.api.mcp.readAudit({ limit: 50 }).then((es) => es.some((e) =>` +
            ` e.type === 'assign_prompt' && e.targetId === ${JSON.stringify(id)}` +
            ` && e.status === 'dispatched' && e.prompt === ${JSON.stringify('echo ' + SENT)}))`
        ),
      4000
    )
    const noCompleted = await ctx.evalIn<boolean>(
      `window.api.mcp.readAudit({ limit: 50 }).then((es) => !es.some((e) =>` +
        ` e.type === 'assign_prompt' && e.targetId === ${JSON.stringify(id)} && e.status === 'completed'))`
    )

    // (c) 🔒 replayed/forged nonce rejected — same real path, consume → false, NO write.
    const SENT2 = 'CANVAS_E2E_ASSIGN_REPLAY'
    const replayOrch = buildOrchestrator(registry, {
      guard: { issue: () => ({ nonce: 'forged', seq: 1 }), consume: () => false }
    })
    let replayRejected = false
    const rp = replayOrch
      .dispatchPrompt(id, `echo ${SENT2}`)
      .then(() => {})
      .catch(() => {
        replayRejected = true
      })
    const replayModal = await ctx.poll(() => ctx.evalIn<boolean>(MODAL), 8000)
    if (replayModal) await ctx.evalIn(APPROVE_BTN)
    await rp
    const replayWrote = await ctx.poll(async () => {
      const t = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`
      )
      return typeof t === 'string' && t.includes(SENT2)
    }, 1500)
    const replayAbsent = !replayWrote

    // Restore the baseline: drain + removeBoard (count back to 4).
    await drainPty(id)
    await sendMcpCommand(ipcMain, () => ctx.win, { type: 'removeBoard', id })
    const restored = await ctx.poll(
      () => ctx.evalIn<boolean>('window.__canvasE2E.getBoards().length === 4'),
      4000
    )

    const ok =
      shellUp &&
      inMirror &&
      labelRejected &&
      modalShown &&
      assignResolved &&
      landed &&
      dispatchedAudited &&
      noCompleted &&
      replayRejected &&
      replayAbsent &&
      restored
    return {
      name: 'dispatch-assign',
      ok,
      detail: ok
        ? 'label rejected; confirm→write→PTY land→resolves (no await-idle); dispatched audit, no completed; replayed nonce wrote nothing; baseline 4'
        : JSON.stringify({
            shellUp,
            inMirror,
            assignErr,
            labelRejected,
            modalShown,
            assignResolved,
            landed,
            dispatchedAudited,
            noCompleted,
            replayRejected,
            replayAbsent,
            restored
          })
    }
  }
}

/**
 * 🔒 write_result probe (M4 T4.4) — the FIRST worker-tier write. Drives the REAL adapter
 * `writeResult(boardId, {...})` (the seam the worker-tier `write_result` tool calls with
 * the caller's token-bound id) and asserts the structured result round-trips into
 * `readBoardResult` (which backs `canvas://board/{id}/result`, T1.5): a fresh id reads the
 * empty shell, and after writing it reads `present:true` + the recorded fields + a stamped
 * `at`. The board-result store is a separate userData-less map (not the canvas), so there
 * is no baseline to restore.
 */
export const dispatchWriteResult: E2EProbe = {
  name: 'dispatch-write-result',
  async run(ctx) {
    const orch = buildOrchestrator(productionRegistry(ctx))
    const id = randomUUID()
    const before = readBoardResult(id)
    await orch.writeResult(id, {
      status: 'success',
      summary: 'e2e write_result',
      refs: ['src/x.ts']
    })
    const after = readBoardResult(id)
    const ok =
      before.present === false &&
      after.present === true &&
      after.status === 'success' &&
      after.summary === 'e2e write_result' &&
      Array.isArray(after.refs) &&
      after.refs[0] === 'src/x.ts' &&
      typeof after.at === 'string'
    return {
      name: 'dispatch-write-result',
      ok,
      detail: ok
        ? 'empty shell → writeResult → canvas://board/{id}/result reflects present:true + fields + at'
        : JSON.stringify({ before, after })
    }
  }
}

/**
 * 🔒 interrupt dispatch probe (M4 T4.5) — Ctrl-C to a target terminal. Exercises the REAL
 * MAIN dispatch path against a live terminal: label-targeting rejected; happy path =
 * confirm gate → write `\x03` → the call RESOLVES → an `interrupt`/`dispatched` audit
 * entry is readable (a Ctrl-C has no echo, so the audit trail is the proof); a
 * replayed/forged nonce (consume → false) is rejected. Restores the baseline (count 4).
 */
export const dispatchInterrupt: E2EProbe = {
  name: 'dispatch-interrupt',
  async run(ctx) {
    if (!getAuditLog())
      return { name: 'dispatch-interrupt', ok: false, detail: 'getAuditLog() null' }
    const registry = productionRegistry(ctx)
    const orch = buildOrchestrator(registry)

    const id = randomUUID()
    await sendMcpCommand(ipcMain, () => ctx.win, {
      type: 'addBoard',
      board: { id, type: 'terminal' }
    })
    await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.__canvasE2E.getBoards().some((b) => b.id === ${JSON.stringify(id)})`
        ),
      4000
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    const shellUp = await ctx.poll(async () => ctx.dbg.terminalPid(id) !== null, 10000)
    const inMirror = await ctx.poll(async () => listBoardMirror().some((b) => b.id === id), 6000)

    // (a) 🔒 label-targeting rejected — a TITLE / unknown string is not an opaque id.
    let labelRejected = false
    try {
      await orch.interrupt('Terminal')
    } catch {
      labelRejected = true
    }

    // (b) happy path — confirm → write \x03 → RESOLVES → `interrupt`/`dispatched` audited.
    let interruptResolved = false
    let interruptErr = ''
    const ip = orch
      .interrupt(id)
      .then(() => {
        interruptResolved = true
      })
      .catch((e) => {
        interruptErr = (e as Error).message
      })
    const modalShown = await ctx.poll(() => ctx.evalIn<boolean>(MODAL), 8000)
    if (modalShown) await ctx.evalIn(APPROVE_BTN)
    await ip
    const dispatchedAudited = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.api.mcp.readAudit({ limit: 50 }).then((es) => es.some((e) =>` +
            ` e.type === 'interrupt' && e.targetId === ${JSON.stringify(id)} && e.status === 'dispatched'))`
        ),
      4000
    )

    // (c) 🔒 replayed/forged nonce rejected — same real path, consume → false.
    const replayOrch = buildOrchestrator(registry, {
      guard: { issue: () => ({ nonce: 'forged', seq: 1 }), consume: () => false }
    })
    let replayRejected = false
    const rp = replayOrch
      .interrupt(id)
      .then(() => {})
      .catch(() => {
        replayRejected = true
      })
    const replayModal = await ctx.poll(() => ctx.evalIn<boolean>(MODAL), 8000)
    if (replayModal) await ctx.evalIn(APPROVE_BTN)
    await rp

    // Restore the baseline: drain + removeBoard (count back to 4).
    await drainPty(id)
    await sendMcpCommand(ipcMain, () => ctx.win, { type: 'removeBoard', id })
    const restored = await ctx.poll(
      () => ctx.evalIn<boolean>('window.__canvasE2E.getBoards().length === 4'),
      4000
    )

    const ok =
      shellUp &&
      inMirror &&
      labelRejected &&
      modalShown &&
      interruptResolved &&
      dispatchedAudited &&
      replayRejected &&
      restored
    return {
      name: 'dispatch-interrupt',
      ok,
      detail: ok
        ? 'label rejected; confirm→\\x03→resolves→interrupt/dispatched audit; replayed nonce rejected; baseline 4'
        : JSON.stringify({
            shellUp,
            inMirror,
            interruptErr,
            labelRejected,
            modalShown,
            interruptResolved,
            dispatchedAudited,
            replayRejected,
            restored
          })
    }
  }
}

/**
 * 🔒 relay_prompt probe (M4 T4.6, the M4 gate) — agent-to-agent dispatch over an
 * orchestration connector. Spawns two real terminals A + B, draws an orchestration cable
 * A→B (the e2e hook's `addConnector`, the same path the real gesture uses), waits for the
 * cable to mirror to MAIN, then:
 *  • 🔒 a relay with NO cable in that direction (B→A) is rejected (the cable is the auth);
 *  • happy path: confirm gate → write `echo SENT\r` into B's PTY → resolves → the text
 *    LANDS in B (not A) → a `relay_prompt`/`dispatched` audit (targetId=B) is readable.
 * Restores the seed baseline (count back to 4; closing the boards drops the incident cable).
 */
export const dispatchRelay: E2EProbe = {
  name: 'dispatch-relay',
  async run(ctx) {
    if (!getAuditLog()) return { name: 'dispatch-relay', ok: false, detail: 'getAuditLog() null' }
    const registry = productionRegistry(ctx)
    const orch = buildOrchestrator(registry)

    // Spawn two real terminal boards A + B.
    const a = randomUUID()
    const b = randomUUID()
    for (const id of [a, b]) {
      await sendMcpCommand(ipcMain, () => ctx.win, {
        type: 'addBoard',
        board: { id, type: 'terminal' }
      })
    }
    const present = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.__canvasE2E.getBoards().filter((x) => x.id === ${JSON.stringify(a)} || x.id === ${JSON.stringify(b)}).length === 2`
        ),
      4000
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(b)})`)
    const shellUp = await ctx.poll(async () => ctx.dbg.terminalPid(b) !== null, 10000)
    const inMirror = await ctx.poll(
      async () =>
        listBoardMirror().some((x) => x.id === a) && listBoardMirror().some((x) => x.id === b),
      6000
    )

    // Draw the orchestration cable A→B (same store path as the real connect gesture), then
    // wait for the renderer to mirror it to MAIN (150ms publish debounce).
    await ctx.evalIn(
      `window.__canvasE2E.addConnector(${JSON.stringify(a)}, ${JSON.stringify(b)}, 'orchestration')`
    )
    const cableMirrored = await ctx.poll(
      async () =>
        listConnectors().some(
          (c) => c.kind === 'orchestration' && c.sourceId === a && c.targetId === b
        ),
      6000
    )

    // (a) 🔒 no cable B→A → relay rejected (direction matters; the cable is the auth).
    let noCableRejected = false
    try {
      await orch.relayPrompt(b, a, 'echo nope')
    } catch {
      noCableRejected = true
    }

    // (b) happy path — relay A→B along the cable; the text must land in B (the target).
    const SENT = 'CANVAS_E2E_RELAY'
    let relayResolved = false
    let relayErr = ''
    const rp = orch
      .relayPrompt(a, b, `echo ${SENT}`)
      .then(() => {
        relayResolved = true
      })
      .catch((e) => {
        relayErr = (e as Error).message
      })
    const modalShown = await ctx.poll(() => ctx.evalIn<boolean>(MODAL), 8000)
    if (modalShown) await ctx.evalIn(APPROVE_BTN)
    await rp
    const landedInB = await ctx.poll(async () => {
      const t = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(b)})`
      )
      return typeof t === 'string' && t.includes(SENT)
    }, 10000)
    const dispatchedAudited = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.api.mcp.readAudit({ limit: 50 }).then((es) => es.some((e) =>` +
            ` e.type === 'relay_prompt' && e.targetId === ${JSON.stringify(b)} && e.status === 'dispatched'))`
        ),
      4000
    )

    // Restore the baseline: drain + removeBoard both (the incident cable is dropped on remove).
    for (const id of [a, b]) {
      await drainPty(id)
      await sendMcpCommand(ipcMain, () => ctx.win, { type: 'removeBoard', id })
    }
    const restored = await ctx.poll(
      () => ctx.evalIn<boolean>('window.__canvasE2E.getBoards().length === 4'),
      4000
    )

    const ok =
      present &&
      shellUp &&
      inMirror &&
      cableMirrored &&
      noCableRejected &&
      modalShown &&
      relayResolved &&
      landedInB &&
      dispatchedAudited &&
      restored
    return {
      name: 'dispatch-relay',
      ok,
      detail: ok
        ? 'cable A→B mirrored; B→A rejected; confirm→relay→lands in B→relay_prompt/dispatched audit; baseline 4'
        : JSON.stringify({
            present,
            shellUp,
            inMirror,
            cableMirrored,
            relayErr,
            noCableRejected,
            modalShown,
            relayResolved,
            landedInB,
            dispatchedAudited,
            restored
          })
    }
  }
}
