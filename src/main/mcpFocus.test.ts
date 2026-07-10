import { describe, expect, it } from 'vitest'
import { createFocusMethod } from './mcpFocus'
import type { McpCommand, McpCommandAck } from './mcpCommand'

/**
 * H1 focus_viewport — the un-gated camera-focus loopback (the tidy-method sibling). Pure host
 * module: assert the forwarded `focusCamera` envelope, the ack→outcome mapping, and the
 * at-most-one-target guard at the trust boundary.
 */

function recorder(ack: McpCommandAck = { ok: true, type: 'focusCamera' }): {
  sent: McpCommand[]
  method: ReturnType<typeof createFocusMethod>
} {
  const sent: McpCommand[] = []
  const method = createFocusMethod({
    sendCommand: async (cmd) => {
      sent.push(cmd)
      return ack
    }
  })
  return { sent, method }
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
})
