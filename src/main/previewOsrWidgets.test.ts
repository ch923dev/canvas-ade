import { describe, it, expect, vi } from 'vitest'
import {
  sanitizeDownloadName,
  uniqueSavePath,
  parseWidgetPayload,
  isAutoDialog,
  dispatchCdpMessage,
  applyOsrMuted,
  clampVolume,
  applyOsrVolume,
  respondOsrDialog,
  setOsrWidgetValue,
  registerOsrDownloads,
  isRevealableOsrDownload,
  type CdpMessageActions
} from './previewOsrWidgets'

describe('sanitizeDownloadName', () => {
  it('strips path traversal to a basename', () => {
    expect(sanitizeDownloadName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeDownloadName('C:\\Windows\\evil.exe')).toBe('evil.exe')
  })
  it('drops control + reserved chars', () => {
    expect(sanitizeDownloadName('re*p:o<rt>.csv')).toBe('report.csv')
  })
  it('falls back to "download" when emptied', () => {
    expect(sanitizeDownloadName('')).toBe('download')
    expect(sanitizeDownloadName('***')).toBe('download')
    expect(sanitizeDownloadName('...')).toBe('download')
  })
  it('caps length', () => {
    expect(sanitizeDownloadName('a'.repeat(500)).length).toBe(180)
  })
})

describe('uniqueSavePath', () => {
  it('returns the plain path when nothing exists', () => {
    expect(uniqueSavePath('/dl', 'a.csv', () => false).replace(/\\/g, '/')).toBe('/dl/a.csv')
  })
  it('de-collides with " (n)" before the extension', () => {
    const taken = new Set(['/dl/a.csv', '/dl/a (1).csv'])
    const out = uniqueSavePath('/dl', 'a.csv', (p) => taken.has(p.replace(/\\/g, '/')))
    expect(out.replace(/\\/g, '/')).toBe('/dl/a (2).csv')
  })
})

describe('parseWidgetPayload', () => {
  it('parses a select payload + caps options', () => {
    const opts = Array.from({ length: 300 }, (_, i) => ({
      label: 'x'.repeat(400),
      value: String(i),
      selected: i === 0,
      disabled: false
    }))
    const info = parseWidgetPayload(
      JSON.stringify({
        kind: 'select',
        rect: { x: 1, y: 2, width: 3, height: 4 },
        value: '0',
        options: opts
      })
    )
    expect(info?.kind).toBe('select')
    expect(info?.options).toHaveLength(256) // MAX_OPTIONS
    expect(info?.options?.[0].label.length).toBe(256) // MAX_LABEL
  })
  it('parses a date payload (no options)', () => {
    const info = parseWidgetPayload(
      JSON.stringify({
        kind: 'date',
        rect: { x: 0, y: 0, width: 10, height: 10 },
        value: '2026-06-18'
      })
    )
    expect(info).toEqual({
      kind: 'date',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      value: '2026-06-18'
    })
  })
  it('rejects junk / unknown kind / non-object / non-finite rect coerced to 0', () => {
    expect(parseWidgetPayload('not json')).toBeNull()
    expect(parseWidgetPayload(JSON.stringify({ kind: 'iframe', rect: {} }))).toBeNull()
    expect(parseWidgetPayload(JSON.stringify(42))).toBeNull()
    const info = parseWidgetPayload(
      JSON.stringify({
        kind: 'color',
        rect: { x: 'NaN', y: null, width: 5, height: 5 },
        value: '#fff'
      })
    )
    expect(info?.rect).toEqual({ x: 0, y: 0, width: 5, height: 5 })
  })
})

describe('isAutoDialog', () => {
  it('auto-handles beforeunload only', () => {
    expect(isAutoDialog('beforeunload')).toBe(true)
    expect(isAutoDialog('confirm')).toBe(false)
    expect(isAutoDialog('alert')).toBe(false)
  })
})

describe('dispatchCdpMessage', () => {
  const make = (): CdpMessageActions & { calls: Record<string, unknown[]> } => {
    const calls: Record<string, unknown[]> = { auto: [], dialog: [], file: [], popup: [] }
    return {
      calls,
      acceptAutoDialog: () => calls.auto.push(true),
      onDialog: (i) => calls.dialog.push(i),
      onFileChooser: (p) => calls.file.push(p),
      onPopup: (i) => calls.popup.push(i)
    }
  }
  it('routes a confirm dialog to onDialog', () => {
    const a = make()
    dispatchCdpMessage('Page.javascriptDialogOpening', { type: 'confirm', message: 'ok?' }, a)
    expect(a.calls.dialog).toEqual([{ dialogType: 'confirm', message: 'ok?', defaultPrompt: '' }])
  })
  it('auto-accepts beforeunload (no modal)', () => {
    const a = make()
    dispatchCdpMessage('Page.javascriptDialogOpening', { type: 'beforeunload' }, a)
    expect(a.calls.auto).toEqual([true])
    expect(a.calls.dialog).toEqual([])
  })
  it('coerces an unknown dialog type to alert', () => {
    const a = make()
    dispatchCdpMessage('Page.javascriptDialogOpening', { type: 'weird', message: 'x' }, a)
    expect((a.calls.dialog[0] as { dialogType: string }).dialogType).toBe('alert')
  })
  it('routes a file chooser + a valid widget binding', () => {
    const a = make()
    dispatchCdpMessage('Page.fileChooserOpened', { backendNodeId: 7, mode: 'selectSingle' }, a)
    expect(a.calls.file).toHaveLength(1)
    dispatchCdpMessage(
      'Runtime.bindingCalled',
      { name: '__osrWidget', payload: JSON.stringify({ kind: 'select', rect: {}, value: '' }) },
      a
    )
    expect(a.calls.popup).toHaveLength(1)
  })
  it('ignores an unrelated binding + unknown method', () => {
    const a = make()
    dispatchCdpMessage('Runtime.bindingCalled', { name: 'other', payload: '{}' }, a)
    dispatchCdpMessage('Network.requestWillBeSent', {}, a)
    expect(a.calls.popup).toEqual([])
  })
})

describe('per-call CDP actions', () => {
  const mkCdp = () => ({
    debugger: {
      isAttached: () => true,
      sendCommand: vi.fn(async (_method: string, _params?: Record<string, unknown>) => undefined)
    }
  })

  it('applyOsrMuted calls setAudioMuted', () => {
    const wc = { setAudioMuted: vi.fn() }
    applyOsrMuted(wc, true)
    expect(wc.setAudioMuted).toHaveBeenCalledWith(true)
  })

  it('respondOsrDialog sends handleJavaScriptDialog with prompt text on accept', () => {
    const wc = mkCdp()
    respondOsrDialog(wc, true, 'hello')
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', {
      accept: true,
      promptText: 'hello'
    })
  })
  it('respondOsrDialog omits promptText on cancel', () => {
    const wc = mkCdp()
    respondOsrDialog(wc, false, 'ignored')
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', {
      accept: false
    })
  })

  it('setOsrWidgetValue JSON-encodes the value into the evaluate expression', () => {
    const wc = mkCdp()
    setOsrWidgetValue(wc, 'a"b\nc')
    const [method, params] = wc.debugger.sendCommand.mock.calls[0]
    expect(method).toBe('Runtime.evaluate')
    expect((params as { expression: string }).expression).toBe(
      'window.__osrSetWidgetValue("a\\"b\\nc")'
    )
  })
})

describe('clampVolume', () => {
  it('passes through an in-range level', () => {
    expect(clampVolume(0)).toBe(0)
    expect(clampVolume(0.5)).toBe(0.5)
    expect(clampVolume(1)).toBe(1)
  })
  it('clamps out-of-range to [0,1]', () => {
    expect(clampVolume(-0.3)).toBe(0)
    expect(clampVolume(2)).toBe(1)
  })
  it('defaults non-finite / non-number to 1 (full)', () => {
    expect(clampVolume(NaN)).toBe(1)
    expect(clampVolume(Infinity)).toBe(1)
    expect(clampVolume(undefined)).toBe(1)
    expect(clampVolume('0.4' as unknown)).toBe(1)
  })
})

describe('applyOsrVolume', () => {
  it('injects the clamped level + media apply when below full, and installs the observer', () => {
    const wc = { executeJavaScript: vi.fn(async (_code: string) => undefined) }
    applyOsrVolume(wc, 0.4)
    const code = wc.executeJavaScript.mock.calls[0][0] as string
    expect(code).toContain('window.__osrVol = 0.4')
    expect(code).toContain("querySelectorAll('audio,video')")
    expect(code).toContain('MutationObserver')
  })
  it('clamps an out-of-range level before injecting', () => {
    const wc = { executeJavaScript: vi.fn(async (_code: string) => undefined) }
    applyOsrVolume(wc, 5)
    expect(wc.executeJavaScript.mock.calls[0][0] as string).toContain('window.__osrVol = 1')
  })
  it('swallows an executeJavaScript rejection (navigated away / window gone)', () => {
    const wc = { executeJavaScript: vi.fn(async () => Promise.reject(new Error('gone'))) }
    expect(() => applyOsrVolume(wc, 0.5)).not.toThrow()
  })
})

describe('registerOsrDownloads', () => {
  // Minimal fakes for a Session + DownloadItem.
  const mkSession = (): {
    on: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
    fire: (item: unknown) => void
  } => {
    let handler: ((ev: { preventDefault: () => void }, item: unknown) => void) | null = null
    return {
      on: vi.fn((_e: string, cb: (ev: { preventDefault: () => void }, item: unknown) => void) => {
        handler = cb
      }),
      removeListener: vi.fn(),
      fire: (item) => handler?.({ preventDefault: vi.fn() }, item)
    }
  }
  const mkItem = (
    name: string
  ): {
    getFilename: () => string
    getTotalBytes: () => number
    getReceivedBytes: () => number
    setSavePath: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
    emitDone: (state: string) => void
  } => {
    let doneCb: ((e: unknown, s: string) => void) | null = null
    return {
      getFilename: () => name,
      getTotalBytes: () => 100,
      getReceivedBytes: () => 50,
      setSavePath: vi.fn(),
      on: vi.fn(),
      once: vi.fn((_e: string, cb: (e: unknown, s: string) => void) => {
        doneCb = cb
      }),
      emitDone: (state) => doneCb?.(null, state)
    }
  }

  it('saves + emits start then done', () => {
    const emit = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = mkSession() as any
    registerOsrDownloads(session, {
      getDownloadsDir: () => '/dl',
      ensureDir: () => {},
      exists: () => false,
      allow: () => true,
      emit
    })
    const item = mkItem('report.csv')
    session.fire(item)
    expect(item.setSavePath).toHaveBeenCalledWith(expect.stringContaining('report.csv'))
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'start', name: 'report.csv' })
    )
    item.emitDone('completed')
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'done', name: 'report.csv' })
    )
  })

  it('throttles over-budget downloads (preventDefault + throttled emit, no save)', () => {
    const emit = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = mkSession() as any
    registerOsrDownloads(session, {
      getDownloadsDir: () => '/dl',
      ensureDir: () => {},
      exists: () => false,
      allow: () => false,
      emit
    })
    const item = mkItem('x.zip')
    session.fire(item)
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ state: 'throttled' }))
  })

  it('emits fail on a non-completed done', () => {
    const emit = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = mkSession() as any
    registerOsrDownloads(session, {
      getDownloadsDir: () => '/dl',
      ensureDir: () => {},
      exists: () => false,
      allow: () => true,
      emit
    })
    const item = mkItem('y.bin')
    session.fire(item)
    item.emitDone('cancelled')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ state: 'fail' }))
  })

  it('allowlists a completed download for reveal — exact path, not a live-dir prefix', () => {
    const emit = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = mkSession() as any
    registerOsrDownloads(session, {
      getDownloadsDir: () => '/projectA/.canvas/downloads',
      ensureDir: () => {},
      exists: () => false,
      allow: () => true,
      emit
    })
    session.fire(mkItem('report.csv'))
    const started = emit.mock.calls.map((c) => c[0]).find((i) => i.state === 'start')
    const savePath = started.savePath as string
    // Not revealable until the download actually completes...
    expect(isRevealableOsrDownload(savePath)).toBe(false)
    // ...and only the EXACT saved path is — never an arbitrary location the renderer might echo back.
    expect(isRevealableOsrDownload('/etc/passwd')).toBe(false)
  })

  it('reveals the exact saved path after completion (survives a later project switch)', () => {
    const emit = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = mkSession() as any
    registerOsrDownloads(session, {
      getDownloadsDir: () => '/projectA/.canvas/downloads',
      ensureDir: () => {},
      exists: () => false,
      allow: () => true,
      emit
    })
    const item = mkItem('saved.bin')
    session.fire(item)
    item.emitDone('completed')
    const started = emit.mock.calls.map((c) => c[0]).find((i) => i.state === 'start')
    // The allowlist holds the save-time path, so reveal works even though the "current" download dir
    // is now a different project — the exact bug a live `getDownloadsDir()` prefix check would miss.
    expect(isRevealableOsrDownload(started.savePath)).toBe(true)
  })
})
