/**
 * Audit Phase A follow-up (pkg 0.24.0) END-TO-END: closing a board must tear down that board's
 * LIVE MCP sessions, not just revoke its token. BUG-019 wired `connected.revoke` into
 * `onBoardClosed` (future requests 401), but a session already open — its transport + the
 * board-status listener behind it — would otherwise linger until the package's 30-min idle
 * sweep. `startMcpServer` now also calls the package's `closeSessionsForBoard` there.
 *
 * The unit halves each exist (`makeConnectedTokenTracker` here, `closeSessionsForBoard` in the
 * package's own suite); this test closes the JOIN over the real wire: the REAL package server
 * mounted by `startMcpServer`, a real `close_board` tool call, real sessions observed by raw
 * HTTP. The observable is a WORKER-tier session for the closed board — its token is never
 * revoked (only connected/lead tokens die with the board), so a post-close 404 can only mean
 * the SESSION was closed, not that auth started refusing (that would be 401).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BoardOutput, BoardResult, MemoryDoc } from '@expanse-ade/mcp'
import { startMcpServer, type RunningMcp } from './mcp'
import type { BoardRegistry } from './mcpOrchestrator'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

/** A minimal live-mirror fake: two terminal boards, every command acks, every confirm approves. */
function fakeRegistry(): BoardRegistry {
  return {
    listBoards: () => [
      { id: 't1', type: 'terminal', title: 'Worker 1', status: 'idle' },
      { id: 't2', type: 'terminal', title: 'Worker 2', status: 'idle' }
    ],
    listSessions: () => [],
    readOutput: () => EMPTY_OUTPUT,
    readResult: () => EMPTY_RESULT,
    readMemory: () => EMPTY_MEMORY,
    readSummary: () => EMPTY_MEMORY,
    sendCommand: async (cmd) => ({ ok: true, type: cmd.type }),
    drainPty: async () => {},
    writeToPty: () => true,
    confirm: async () => ({ approved: true }),
    audit: async () => {},
    recordResult: () => {},
    listConnectors: () => [],
    subscribeStatus: () => () => {}
  }
}

/** Raw initialize → the new session id from the response header (body drained). */
async function rawInitialize(url: string, token: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'close-join-test', version: '0.0.0' }
      }
    })
  })
  expect(res.status).toBe(200)
  const sid = res.headers.get('mcp-session-id')
  expect(sid).toBeTruthy()
  await res.body?.cancel()
  return sid as string
}

/** POST tools/list on an existing session; the HTTP status is the whole observation. */
async function reuseStatus(url: string, token: string, sid: string): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'mcp-session-id': sid
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  })
  await res.body?.cancel()
  return res.status
}

/** Call the `close_board` tool on the orchestrator session; resolves once the tool has. */
async function callCloseBoard(
  url: string,
  token: string,
  sid: string,
  boardId: string
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'mcp-session-id': sid
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'close_board', arguments: { id: boardId } }
    })
  })
  return { status: res.status, body: await res.text() }
}

describe("startMcpServer: close_board also closes the board's live sessions (BUG-019 companion)", () => {
  let running: RunningMcp
  let url: string

  beforeAll(async () => {
    const r = await startMcpServer(fakeRegistry())
    expect(r).not.toBeNull() // a bind failure would silently skip the whole join — fail loud
    running = r as RunningMcp
    url = `http://127.0.0.1:${running.port}/mcp`
  })

  afterAll(async () => {
    await running?.close()
  })

  it('t1 close → t1 sessions die (404 on a still-valid token); t2 + the closer survive', async () => {
    // Worker-tier sessions are the observable (token survives the close); the connected-tier
    // session doubles as the BUG-019 token-revoke assertion (401 after close).
    const worker1 = running.mintWorkerToken('t1')
    const worker2 = running.mintWorkerToken('t2')
    const connected1 = running.mintConnectedToken('t1').token
    const sidW1 = await rawInitialize(url, worker1)
    const sidW2 = await rawInitialize(url, worker2)
    const sidC1 = await rawInitialize(url, connected1)
    const sidApp = await rawInitialize(url, running.orchestratorToken)

    expect(await reuseStatus(url, worker1, sidW1)).toBe(200)
    expect(await reuseStatus(url, connected1, sidC1)).toBe(200)

    const closed = await callCloseBoard(url, running.orchestratorToken, sidApp, 't1')
    expect(closed.status).toBe(200)
    expect(closed.body).toContain('closed t1')

    // The session close is fire-and-forget off onBoardClosed — poll to the settled state.
    await vi.waitFor(async () => {
      expect(await reuseStatus(url, worker1, sidW1)).toBe(404) // session gone, token still valid
    })
    expect(await reuseStatus(url, connected1, sidC1)).toBe(401) // BUG-019: token revoked outright
    expect(await reuseStatus(url, worker2, sidW2)).toBe(200) // sibling board untouched
    expect(await reuseStatus(url, running.orchestratorToken, sidApp)).toBe(200) // the closer lives
  })
})
