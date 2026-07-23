import { describe, it, expect } from 'vitest'
import { createOpenAiTranscribe, type TranscribeFetch } from './openaiTranscribe'

const WAV = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])

/** Capture the last request + return a canned response. */
function fakeFetch(res: { ok: boolean; status: number; body: string }): {
  fetch: TranscribeFetch
  last: () => { url: string; init: Parameters<TranscribeFetch>[1] } | null
} {
  let last: { url: string; init: Parameters<TranscribeFetch>[1] } | null = null
  const fetch: TranscribeFetch = async (url, init) => {
    last = { url, init }
    return { ok: res.ok, status: res.status, text: async () => res.body }
  }
  return { fetch, last: () => last }
}

describe('createOpenAiTranscribe — request shape', () => {
  it('sends the measured OpenAI multipart request and returns the trimmed text', async () => {
    const cap = fakeFetch({
      ok: true,
      status: 200,
      body: JSON.stringify({ text: '  hello world  ' })
    })
    const transcribe = createOpenAiTranscribe({
      getKey: () => 'sk-test',
      getModel: () => 'gpt-4o-transcribe',
      fetch: cap.fetch
    })
    const out = await transcribe({ wav: WAV, keyterms: ['contextIsolation', 'add_card'] })
    expect(out).toBe('hello world')

    const req = cap.last()!
    expect(req.url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(req.init.method).toBe('POST')
    expect(req.init.headers.Authorization).toBe('Bearer sk-test')
    const fd = req.init.body
    expect(fd.get('model')).toBe('gpt-4o-transcribe')
    expect(fd.get('response_format')).toBe('json')
    expect(fd.get('temperature')).toBe('0')
    expect(fd.get('language')).toBe('en')
    expect(fd.get('prompt')).toBe('Technical vocabulary: contextIsolation, add_card.')
    expect(fd.get('file')).toBeInstanceOf(Blob)
  })

  it('omits the prompt when there are no keyterms', async () => {
    const cap = fakeFetch({ ok: true, status: 200, body: JSON.stringify({ text: 'x' }) })
    const transcribe = createOpenAiTranscribe({
      getKey: () => 'k',
      getModel: () => 'm',
      fetch: cap.fetch
    })
    await transcribe({ wav: WAV, keyterms: [] })
    expect(cap.last()!.init.body.get('prompt')).toBeNull()
  })

  it('honours a base-URL override (e2e fake vendor) and strips a trailing slash', async () => {
    const cap = fakeFetch({ ok: true, status: 200, body: JSON.stringify({ text: 'x' }) })
    const transcribe = createOpenAiTranscribe({
      getKey: () => 'k',
      getModel: () => 'm',
      getBaseUrl: () => 'http://127.0.0.1:9999/v1/',
      fetch: cap.fetch
    })
    await transcribe({ wav: WAV, keyterms: [] })
    expect(cap.last()!.url).toBe('http://127.0.0.1:9999/v1/audio/transcriptions')
  })
})

describe('createOpenAiTranscribe — failures are fail-visible + classified', () => {
  it('rejects with reason no-key when no key is present (no network call)', async () => {
    let called = false
    const transcribe = createOpenAiTranscribe({
      getKey: () => undefined,
      getModel: () => 'm',
      fetch: async () => {
        called = true
        return { ok: true, status: 200, text: async () => '{}' }
      }
    })
    await expect(transcribe({ wav: WAV, keyterms: [] })).rejects.toMatchObject({ reason: 'no-key' })
    expect(called).toBe(false)
  })

  it.each([
    [401, '', 'unauthorized'],
    [403, '', 'unauthorized'],
    [429, '', 'rate-limited'],
    [402, '', 'quota'],
    [429, 'You exceeded your current quota', 'quota'],
    [500, '', 'server'],
    [503, '', 'server']
  ])('maps HTTP %i → reason %s', async (status, body, reason) => {
    const cap = fakeFetch({ ok: false, status, body })
    const transcribe = createOpenAiTranscribe({
      getKey: () => 'k',
      getModel: () => 'm',
      fetch: cap.fetch
    })
    await expect(transcribe({ wav: WAV, keyterms: [] })).rejects.toMatchObject({ reason })
  })

  it('maps a non-JSON body and a missing text field to bad-response', async () => {
    const bad = createOpenAiTranscribe({
      getKey: () => 'k',
      getModel: () => 'm',
      fetch: async () => ({ ok: true, status: 200, text: async () => 'not json' })
    })
    await expect(bad({ wav: WAV, keyterms: [] })).rejects.toMatchObject({ reason: 'bad-response' })
    const noText = createOpenAiTranscribe({
      getKey: () => 'k',
      getModel: () => 'm',
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ x: 1 }) })
    })
    await expect(noText({ wav: WAV, keyterms: [] })).rejects.toMatchObject({
      reason: 'bad-response'
    })
  })

  it('maps an abort to timeout and any other throw to network', async () => {
    const timedOut = createOpenAiTranscribe({
      getKey: () => 'k',
      getModel: () => 'm',
      fetch: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
    })
    await expect(timedOut({ wav: WAV, keyterms: [] })).rejects.toMatchObject({ reason: 'timeout' })
    const netDown = createOpenAiTranscribe({
      getKey: () => 'k',
      getModel: () => 'm',
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    await expect(netDown({ wav: WAV, keyterms: [] })).rejects.toMatchObject({ reason: 'network' })
  })
})
