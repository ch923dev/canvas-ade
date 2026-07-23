// Shared HTTP plumbing for the STT eval engine adapters.
//
// Node 22 ships fetch/FormData/Blob/AbortSignal natively, so this harness pulls in no
// dependencies — deliberate: it must stay runnable from a bare checkout without touching
// the (junction-shared) node_modules.

/** A vendor call that failed in a way worth printing verbatim in the report. */
export class EngineError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'EngineError'
    this.status = status
    // Truncated: some vendors return an HTML error page, and a 40 KB blob in a JSON
    // results file helps nobody.
    this.body = typeof body === 'string' ? body.slice(0, 600) : body
  }
}

/**
 * fetch with a hard timeout. Vendors occasionally accept the connection and then hang;
 * without this the whole matrix stalls on one bad call.
 */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 60_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new EngineError(`timed out after ${timeoutMs}ms`)
    }
    throw new EngineError(`network error: ${err?.message ?? String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Retry ONCE on a transient failure (429 / 5xx / timeout). Deliberately not a general
 * backoff loop: this is an offline benchmark, and silently retrying a rate-limited call
 * many times would distort the latency numbers the harness exists to measure.
 */
export async function withRetry(fn, { retries = 1, delayMs = 1500 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const transient =
        err instanceof EngineError &&
        (err.status === 429 || (err.status >= 500 && err.status < 600) || err.status === undefined)
      if (!transient || attempt === retries) break
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

/** Read a response body as JSON, surfacing the raw text when the vendor lies about content-type. */
export async function readJson(res, what) {
  const text = await res.text()
  if (!res.ok) {
    throw new EngineError(`${what} failed: HTTP ${res.status}`, { status: res.status, body: text })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new EngineError(`${what}: response was not JSON`, { status: res.status, body: text })
  }
}

/** Wrap a WAV buffer as a multipart file field (the OpenAI-shaped upload every vendor copies). */
export function wavFormData(wav, filename = 'utterance.wav', extra = {}) {
  const fd = new FormData()
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), filename)
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') fd.append(k, String(v))
  }
  return fd
}

/** Milliseconds elapsed around an awaited call — the harness's latency measurement. */
export async function timed(fn) {
  const started = performance.now()
  const value = await fn()
  return { value, ms: Math.round(performance.now() - started) }
}
