/**
 * Jarvis brain — the OpenAI-compatible shape (openrouter / openai / local providers of the
 * shared Context·LLM config). jarvisBrain.ts owns the Anthropic Messages shape and the
 * streaming turn loop; this module owns the pure converters (system/messages/tools →
 * chat/completions payload pieces) and the incremental chat-completions SSE parser. The
 * parser NORMALIZES to jarvisBrain's SseEvent union — including the Anthropic stop_reason
 * vocabulary ('tool_use' / 'end_turn') — so jarvisIpc's turn loop stays shape-agnostic.
 * BUG-003 discipline holds here too: error frames surface a type/code only, never the body.
 */
import type { JarvisContentBlock, JarvisMessage } from './jarvisPersona'
import type { JarvisToolDef } from './jarvisTools'
import type { SseEvent } from './jarvisBrain'

/** One chat/completions message. The tool round-trip uses assistant.tool_calls + role:'tool'. */
export type OpenAiChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Anthropic tool def → chat/completions function def (same JSON Schema, different wrapper). */
export function toOpenAiTools(
  tools: JarvisToolDef[]
): Array<{ type: 'function'; function: Record<string, unknown> }> {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }))
}

/**
 * (system blocks, turn messages) → the chat/completions `messages` array. The Anthropic
 * system array folds into ONE leading system message (cache_control has no OpenAI-shape
 * equivalent — providers cache implicitly). Turn blocks map 1:1:
 *   assistant text+tool_use → one assistant message with `tool_calls`
 *   user tool_result[]      → one role:'tool' message PER result (the required shape;
 *                             an error result is prefixed so the model still sees it —
 *                             chat/completions has no is_error flag)
 */
export function toOpenAiMessages(
  system: JarvisContentBlock[],
  messages: JarvisMessage[]
): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = []
  const systemText = system.map((b) => b.text).join('\n\n')
  if (systemText.trim().length > 0) out.push({ role: 'system', content: systemText })
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.role === 'assistant') out.push({ role: 'assistant', content: m.content })
      else out.push({ role: 'user', content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
      const toolCalls: OpenAiToolCall[] = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) }
        }))
      out.push({
        role: 'assistant',
        content: text.trim().length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      })
      continue
    }
    // user block array: tool results (each its own role:'tool' message), then any text.
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: b.is_error ? `ERROR: ${b.content}` : b.content
        })
      }
    }
    const userText = m.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
    if (userText.trim().length > 0) out.push({ role: 'user', content: userText })
  }
  return out
}

/**
 * Incremental chat/completions SSE parser — jarvisBrain.createSseParser's twin for the
 * OpenAI shape, emitting the SAME SseEvent union so the stream consumer never branches.
 * Statefulness beyond the cross-chunk remainder: streamed tool calls arrive as indexed
 * fragments (`delta.tool_calls[{index, id?, function:{name?, arguments+}}]`), so the parser
 * tracks the open tool index and closes it (tool_stop) when the index moves on or the
 * choice finishes. finish_reason maps to the Anthropic vocabulary: 'tool_calls' → a
 * stop_reason of 'tool_use', anything else → 'end_turn'; the '[DONE]' sentinel → 'stop'.
 */
export function createOpenAiSseParser(): { push: (chunk: string) => SseEvent[] } {
  let buf = ''
  let openToolIndex: number | null = null
  const closeOpenTool = (events: SseEvent[]): void => {
    if (openToolIndex !== null) {
      events.push({ kind: 'tool_stop' })
      openToolIndex = null
    }
  }
  const parseFrame = (frame: string, events: SseEvent[]): void => {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('')
    if (!data) return
    if (data === '[DONE]') {
      closeOpenTool(events)
      events.push({ kind: 'stop' })
      return
    }
    let j: Record<string, unknown>
    try {
      j = JSON.parse(data) as Record<string, unknown>
    } catch {
      return // partial/garbled frame — skip, never throw mid-stream
    }
    if (j.error) {
      // BUG-003: surface the machine code/type only — provider error messages can quote
      // request detail (and on auth failures, key material).
      const err = j.error as { type?: string; code?: unknown }
      const label =
        typeof err.type === 'string'
          ? err.type
          : typeof err.code === 'string' || typeof err.code === 'number'
            ? String(err.code)
            : 'unknown'
      events.push({ kind: 'error', message: `stream error: ${label}` })
      return
    }
    const choice = (j.choices as Array<Record<string, unknown>> | undefined)?.[0]
    if (!choice) return
    const delta = choice.delta as
      | {
          content?: unknown
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      | undefined
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      events.push({ kind: 'delta', text: delta.content })
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = typeof tc.index === 'number' ? tc.index : 0
      if (index !== openToolIndex) {
        closeOpenTool(events)
        // A new call must open with its id+name; fragments for a call we never saw open
        // (id-less first frame — nonconformant server) are dropped rather than guessed.
        if (typeof tc.id === 'string' && typeof tc.function?.name === 'string') {
          events.push({ kind: 'tool_start', id: tc.id, name: tc.function.name })
          openToolIndex = index
        }
      }
      if (
        index === openToolIndex &&
        typeof tc.function?.arguments === 'string' &&
        tc.function.arguments.length > 0
      ) {
        events.push({ kind: 'tool_input', partial: tc.function.arguments })
      }
    }
    const finish = choice.finish_reason
    if (typeof finish === 'string' && finish.length > 0) {
      closeOpenTool(events)
      events.push({
        kind: 'stop_reason',
        reason: finish === 'tool_calls' ? 'tool_use' : 'end_turn'
      })
    }
  }
  return {
    push(chunk: string): SseEvent[] {
      buf += chunk.replace(/\r\n/g, '\n')
      const events: SseEvent[] = []
      let idx = buf.indexOf('\n\n')
      while (idx >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        parseFrame(frame, events)
        idx = buf.indexOf('\n\n')
      }
      return events
    }
  }
}
