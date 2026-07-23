import { describe, it, expect } from 'vitest'
import {
  createOpenAiSpeak,
  CloudSpeakError,
  type SpeakFetch,
  type SpeakResponse
} from './openaiSpeak'

async function* gen(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c
}

/** Capture the last request + return a canned streamed/error response. */
function fakeFetch(res: { ok: boolean; status: number; chunks?: Uint8Array[]; body?: string }): {
  fetch: SpeakFetch
  last: () => { url: string; init: Parameters<SpeakFetch>[1] } | null
} {
  let last: { url: string; init: Parameters<SpeakFetch>[1] } | null = null
  const fetch: SpeakFetch = async (url, init) => {
    last = { url, init }
    const r: SpeakResponse = {
      ok: res.ok,
      status: res.status,
      body: res.chunks ? gen(res.chunks) : null,
      text: async () => res.body ?? ''
    }
    return r
  }
  return { fetch, last: () => last }
}

const abortErr = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })
/** A fetch that rejects with AbortError the moment its (combined) signal fires. */
const abortableFetch: SpeakFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(abortErr()), { once: true })
  })

describe('createOpenAiSpeak — request shape + streaming', () => {
  it('POSTs the pcm speech request and streams the audio to onAudio', async () => {
    const cap = fakeFetch({
      ok: true,
      status: 200,
      chunks: [Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6)]
    })
    const speak = createOpenAiSpeak({
      getKey: () => 'sk-test',
      getModel: () => 'gpt-4o-mini-tts',
      getVoice: () => 'alloy',
      fetch: cap.fetch
    })
    const got: number[] = []
    await speak({ text: 'hello world', onAudio: (p) => got.push(...p) })
    expect(got).toEqual([1, 2, 3, 4, 5, 6])

    const req = cap.last()!
    expect(req.url).toBe('https://api.openai.com/v1/audio/speech')
    expect(req.init.method).toBe('POST')
    expect(req.init.headers.Authorization).toBe('Bearer sk-test')
    expect(req.init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(req.init.body)).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'hello world',
      voice: 'alloy',
      response_format: 'pcm'
    })
  })

  it('keeps 16-bit-sample alignment across chunk boundaries (an odd split carries over)', async () => {
    // A=[1,2,3] → emit [1,2], hold 3; B=[4,5,6] joins the carry → [3,4,5,6] → emit whole.
    const cap = fakeFetch({
      ok: true,
      status: 200,
      chunks: [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)]
    })
    const speak = createOpenAiSpeak({
      getKey: () => 'k',
      getModel: () => 'm',
      getVoice: () => 'v',
      fetch: cap.fetch
    })
    const emitted: number[][] = []
    await speak({ text: 't', onAudio: (p) => emitted.push([...p]) })
    expect(emitted).toEqual([
      [1, 2],
      [3, 4, 5, 6]
    ])
  })

  it('honours a base-URL override (e2e fake vendor) and strips a trailing slash', async () => {
    const cap = fakeFetch({ ok: true, status: 200, chunks: [] })
    const speak = createOpenAiSpeak({
      getKey: () => 'k',
      getModel: () => 'm',
      getVoice: () => 'v',
      getBaseUrl: () => 'http://127.0.0.1:9999/v1/',
      fetch: cap.fetch
    })
    await speak({ text: 't', onAudio: () => {} })
    expect(cap.last()!.url).toBe('http://127.0.0.1:9999/v1/audio/speech')
  })
})

describe('createOpenAiSpeak — failures are fail-visible + classified', () => {
  it('rejects with reason no-key when no key is present (no network call)', async () => {
    let called = false
    const speak = createOpenAiSpeak({
      getKey: () => undefined,
      getModel: () => 'm',
      getVoice: () => 'v',
      fetch: async () => {
        called = true
        return { ok: true, status: 200, body: null, text: async () => '' }
      }
    })
    await expect(speak({ text: 't', onAudio: () => {} })).rejects.toMatchObject({
      reason: 'no-key'
    })
    expect(called).toBe(false)
  })

  it.each([
    [401, '', 'unauthorized'],
    [403, '', 'unauthorized'],
    [429, '', 'rate-limited'],
    [402, '', 'quota'],
    [429, 'You exceeded your current quota', 'quota'],
    [500, '', 'server'],
    [503, '', 'server'],
    [400, 'bad', 'bad-response']
  ])('maps HTTP %i → reason %s', async (status, body, reason) => {
    const cap = fakeFetch({ ok: false, status, body })
    const speak = createOpenAiSpeak({
      getKey: () => 'k',
      getModel: () => 'm',
      getVoice: () => 'v',
      fetch: cap.fetch
    })
    await expect(speak({ text: 't', onAudio: () => {} })).rejects.toMatchObject({ reason })
  })

  it('maps the internal timeout abort to reason timeout', async () => {
    const speak = createOpenAiSpeak({
      getKey: () => 'k',
      getModel: () => 'm',
      getVoice: () => 'v',
      timeoutMs: 5,
      fetch: abortableFetch // never settles until the timeout aborts it
    })
    await expect(speak({ text: 't', onAudio: () => {} })).rejects.toMatchObject({
      reason: 'timeout'
    })
  })

  it('re-throws AbortError (a cancel, NOT a CloudSpeakError) when the caller aborts', async () => {
    const ac = new AbortController()
    const speak = createOpenAiSpeak({
      getKey: () => 'k',
      getModel: () => 'm',
      getVoice: () => 'v',
      fetch: abortableFetch
    })
    const p = speak({ text: 't', onAudio: () => {}, signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    await p.catch((e) => expect(e).not.toBeInstanceOf(CloudSpeakError))
  })

  it('maps a non-abort throw to network, and a mid-stream body error to network', async () => {
    const netDown = createOpenAiSpeak({
      getKey: () => 'k',
      getModel: () => 'm',
      getVoice: () => 'v',
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    await expect(netDown({ text: 't', onAudio: () => {} })).rejects.toMatchObject({
      reason: 'network'
    })

    async function* broken(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.of(1, 2)
      throw new Error('stream broke')
    }
    const midFail = createOpenAiSpeak({
      getKey: () => 'k',
      getModel: () => 'm',
      getVoice: () => 'v',
      fetch: async () => ({ ok: true, status: 200, body: broken(), text: async () => '' })
    })
    const got: number[] = []
    await expect(midFail({ text: 't', onAudio: (p) => got.push(...p) })).rejects.toMatchObject({
      reason: 'network'
    })
    expect(got).toEqual([1, 2]) // the pre-error chunk was still delivered
  })
})
