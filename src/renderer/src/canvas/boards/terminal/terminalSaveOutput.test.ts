// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  serializeTerminalText,
  buildTerminalSaveName,
  runTerminalSave,
  type TerminalBufferLike
} from './terminalSaveOutput'

// Toast is a side-effect channel — mock it so we can assert the success/error/cancel branches
// without standing up the real store.
const showToast = vi.fn()
vi.mock('../../../store/toastStore', () => ({ showToast: (t: unknown) => showToast(t) }))

/** A fake active buffer from an array of row strings (each already trailing-trimmed). */
function buf(rows: string[]): TerminalBufferLike {
  return {
    length: rows.length,
    getLine: (i) => (i < rows.length ? { translateToString: () => rows[i] } : undefined)
  }
}

describe('serializeTerminalText', () => {
  it('joins rows with newlines and a trailing newline', () => {
    expect(serializeTerminalText(buf(['a', 'b', 'c']))).toBe('a\nb\nc\n')
  })

  it('drops blank trailing rows (the padded buffer tail) but keeps interior blanks', () => {
    expect(serializeTerminalText(buf(['a', '', 'b', '', '']))).toBe('a\n\nb\n')
  })

  it('is empty (no stray newline) for an all-blank / empty buffer', () => {
    expect(serializeTerminalText(buf([]))).toBe('')
    expect(serializeTerminalText(buf(['', '', '']))).toBe('')
  })

  it('tolerates a null line', () => {
    const b: TerminalBufferLike = {
      length: 2,
      getLine: (i) => (i === 0 ? undefined : { translateToString: () => 'x' })
    }
    expect(serializeTerminalText(b)).toBe('\nx\n')
  })
})

describe('buildTerminalSaveName', () => {
  const at = new Date(2026, 5, 26, 9, 4, 7) // 2026-06-26 09:04:07 (month is 0-based)

  it('stamps untitled terminals as terminal-<YYYYMMDD-HHmmss>.txt', () => {
    expect(buildTerminalSaveName(undefined, at)).toBe('terminal-20260626-090407.txt')
    expect(buildTerminalSaveName('', at)).toBe('terminal-20260626-090407.txt')
  })

  it('slugs a board title and prefixes it', () => {
    expect(buildTerminalSaveName('Build Agent', at)).toBe('build-agent-20260626-090407.txt')
    expect(buildTerminalSaveName('  API  server!!  ', at)).toBe('api-server-20260626-090407.txt')
  })

  it('caps an over-long slug and trims a trailing dash', () => {
    const name = buildTerminalSaveName('x'.repeat(80), at)
    expect(name.endsWith('-20260626-090407.txt')).toBe(true)
    expect(name).not.toMatch(/--/)
  })
})

describe('runTerminalSave', () => {
  beforeEach(() => {
    showToast.mockClear()
  })

  function mkTerm(rows: string[]): Terminal {
    return { buffer: { active: buf(rows) } } as unknown as Terminal
  }
  function stubApi(saveOutput: ReturnType<typeof vi.fn>): void {
    ;(window as unknown as { api: unknown }).api = { terminal: { saveOutput } }
  }

  it('serializes the buffer and passes it to the IPC, toasting success on ok', async () => {
    const saveOutput = vi.fn(async (_args: { text: string; suggestedName: string }) => ({
      ok: true,
      path: 'C:/tmp/out.txt'
    }))
    stubApi(saveOutput)
    const res = await runTerminalSave(mkTerm(['hello', 'world']), 'My Board', 'b1')
    expect(saveOutput).toHaveBeenCalledTimes(1)
    expect(saveOutput.mock.calls[0][0]).toMatchObject({ text: 'hello\nworld\n' })
    expect(saveOutput.mock.calls[0][0].suggestedName).toMatch(/^my-board-\d{8}-\d{6}\.txt$/)
    expect(res).toEqual({ ok: true, path: 'C:/tmp/out.txt' })
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok' }))
  })

  it('stays silent on a user cancel', async () => {
    stubApi(vi.fn(async () => ({ ok: false, canceled: true })))
    await runTerminalSave(mkTerm(['x']), undefined, 'b1')
    expect(showToast).not.toHaveBeenCalled()
  })

  it('toasts a sticky error on a genuine write failure', async () => {
    stubApi(vi.fn(async () => ({ ok: false, error: 'EACCES' })))
    await runTerminalSave(mkTerm(['x']), undefined, 'b1')
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', sticky: true }))
  })

  it('toasts an error when the IPC throws', async () => {
    stubApi(
      vi.fn(async () => {
        throw new Error('bridge down')
      })
    )
    const res = await runTerminalSave(mkTerm(['x']), undefined, 'b1')
    expect(res.ok).toBe(false)
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
  })
})
