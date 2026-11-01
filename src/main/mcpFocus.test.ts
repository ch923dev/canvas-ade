import { describe, expect, it } from 'vitest'
import { toolErrorCodeOf } from '@expanse-ade/mcp'
import { createFocusMethod } from './mcpFocus'
import type { McpCommand, McpCommandAck } from './mcpCommand'

/**
 * H1 focus_viewport — the camera-focus loopback (the tidy-method sibling). Pure host module: assert
 * the forwarded `focusCamera` envelope, the ack→outcome mapping, the at-most-one-target guard at the
 * trust boundary, and the D1 gate (a lead/connected `sourceBoardId` ⇒ ONE human confirm first).
 */

const BOARDS = [
  { id: 'lead-1', type: 'terminal', title: 'Lead agent' },
  { id: 'b-1', type: 'planning', title: 'Roadmap' }
]

function recorder(
  ack: McpCommandAck = { ok: true, type: 'focusCamera' },
  approve = true
): {
  sent: McpCommand[]
  confirms: Array<{ title: string; body: string }>
  method: ReturnType<typeof createFocusMethod>
} {
  const sent: McpCommand[] = []
  const confirms: Array<{ title: string; body: string }> = []
  const method = createFocusMethod({
    sendCommand: async (cmd) => {
      sent.push(cmd)
      return ack
    },
    confirm: async (req) => {
      confirms.push(req)
      return { approved: approve }
    },
    listBoards: () => BOARDS,
    listGroups: () => [{ id: 'g-1', name: 'Checkout flow' }]
  })
  return { sent, confirms, method }
}

describe('createFocusMethod (H1 focus_viewport loopback)', () => {
  it('forwards a boardId target and maps the ok ack to { focused: "board", id }', async () => {
    const { sent, method } = recorder()
    const out = await method.focusViewport({ boardId: 'b-1' })
    expect(sent).toEqual([{ type: 'focusCamera', boardId: 'b-1' }])
    expect(out).toEqual({ focused: 'board', id: 'b-1' })
  })

  it('forwards a groupId target and maps to { focused: "group", id }', async () => {
    const { sent, method } = recorder()
    const out = await method.focusViewport({ groupId: 'g-1' })
    expect(sent).toEqual([{ type: 'focusCamera', groupId: 'g-1' }])
    expect(out).toEqual({ focused: 'group', id: 'g-1' })
  })

  it('no target ⇒ fit-all: an EMPTY envelope (no undefined keys over IPC) + { focused: "all" }', async () => {
    const { sent, method } = recorder()
    const out = await method.focusViewport({})
    expect(sent).toEqual([{ type: 'focusCamera' }])
    expect(out).toEqual({ focused: 'all' })
  })

  it('🔒 rejects boardId AND groupId together BEFORE sending (trust-boundary re-check)', async () => {
    const { sent, method } = recorder()
    await expect(method.focusViewport({ boardId: 'b', groupId: 'g' })).rejects.toThrow(
      /at most one/i
    )
    expect(sent).toHaveLength(0)
  })

  it('treats an empty-string / non-string id as absent (fit-all, not a forged target)', async () => {
    const { sent, method } = recorder()
    const out = await method.focusViewport({
      boardId: '' as string,
      groupId: 42 as unknown as string
    })
    expect(sent).toEqual([{ type: 'focusCamera' }])
    expect(out).toEqual({ focused: 'all' })
  })

  it('a failed ack (unknown id) surfaces as a thrown error with the applier reason', async () => {
    const { method } = recorder({ ok: false, error: 'focusCamera: board not found: nope' })
    await expect(method.focusViewport({ boardId: 'nope' })).rejects.toThrow(/board not found/i)
  })

  it('a failed ack is not mistaken for a classified error (maps to internal)', async () => {
    const { method } = recorder({ ok: false, error: 'renderer gone' })
    const err = await method.focusViewport({}).catch((e: unknown) => e)
    expect(toolErrorCodeOf(err)).toBe('internal')
  })
})

describe('focus_viewport D1 gate (lead / connected ⇒ one human confirm)', () => {
  it('orchestrator tier (no sourceBoardId) stays UN-GATED — no confirm, the camera moves', async () => {
    const { sent, confirms, method } = recorder()
    await method.focusViewport({ boardId: 'b-1' })
    expect(confirms).toHaveLength(0)
    expect(sent).toEqual([{ type: 'focusCamera', boardId: 'b-1' }])
  })

  it('a lead/connected caller APPROVED: ONE confirm naming caller + target, then the camera moves', async () => {
    const { sent, confirms, method } = recorder()
    const out = await method.focusViewport({ boardId: 'b-1', sourceBoardId: 'lead-1' })
    expect(confirms).toHaveLength(1)
    expect(confirms[0].body).toContain('"Lead agent"')
    expect(confirms[0].body).toContain('"Roadmap"')
    expect(sent).toEqual([{ type: 'focusCamera', boardId: 'b-1' }])
    expect(out).toEqual({ focused: 'board', id: 'b-1' })
  })

  it('names a group target by its Named-Group name, and fit-all as the whole canvas', async () => {
    const { confirms, method } = recorder()
    await method.focusViewport({ groupId: 'g-1', sourceBoardId: 'lead-1' })
    await method.focusViewport({ sourceBoardId: 'lead-1' })
    expect(confirms[0].body).toContain('"Checkout flow"')
    expect(confirms[1].body).toContain('the whole canvas')
  })

  it('🔒 DENIED: a `declined` tool error and NO focusCamera command is sent', async () => {
    const { sent, confirms, method } = recorder(undefined, false)
    const err = await method
      .focusViewport({ boardId: 'b-1', sourceBoardId: 'lead-1' })
      .catch((e: unknown) => e)
    expect(confirms).toHaveLength(1)
    expect(toolErrorCodeOf(err)).toBe('declined')
    expect(sent).toHaveLength(0)
  })

  it('🔒 an EMPTY sourceBoardId still gates (fail closed), with a generic caller label', async () => {
    const { sent, confirms, method } = recorder(undefined, false)
    const err = await method.focusViewport({ sourceBoardId: '' }).catch((e: unknown) => e)
    expect(confirms).toHaveLength(1)
    expect(confirms[0].body).toContain('A terminal agent')
    expect(toolErrorCodeOf(err)).toBe('declined')
    expect(sent).toHaveLength(0)
  })

  it('both targets are rejected as invalid_input BEFORE any confirm', async () => {
    const { confirms, method } = recorder()
    const err = await method
      .focusViewport({ boardId: 'b-1', groupId: 'g-1', sourceBoardId: 'lead-1' })
      .catch((e: unknown) => e)
    expect(toolErrorCodeOf(err)).toBe('invalid_input')
    expect(confirms).toHaveLength(0)
  })
})
