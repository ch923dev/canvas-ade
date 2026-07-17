// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { ModelCombobox, formatContext, formatAge, formatPrice } from './ModelCombobox'

// `globals: false` → RTL auto-cleanup is not registered; unmount each render's tree by hand.
afterEach(cleanup)

const list = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue({
    ok: true,
    fetchedAt: Date.now(),
    models: [
      {
        id: 'google/gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        contextLength: 1_048_576,
        toolUse: true,
        pricing: { inputPerM: 0.3, outputPerM: 2.5 }
      },
      { id: 'meta-llama/llama-3-8b', contextLength: 8192, toolUse: false },
      { id: 'mock/no-meta' }
    ]
  })
  ;(window as unknown as { api: unknown }).api = { llm: { models: { list } } }
})

/** Stateful host so onChange round-trips into `value` like the real pane. */
function Host({ initial = '' }: { initial?: string }): ReactElement {
  const [value, setValue] = useState(initial)
  return <ModelCombobox provider="openrouter" value={value} onChange={setValue} />
}

const input = (): HTMLInputElement => screen.getByLabelText(/model/i) as HTMLInputElement

it('opens on click, fetches the provider list, renders ctx + tools chips', async () => {
  render(<Host />)
  fireEvent.click(input())
  await waitFor(() => expect(list).toHaveBeenCalledWith({ provider: 'openrouter' }))
  const row = await screen.findByText('google/gemini-2.5-flash')
  expect(row).toBeTruthy()
  expect(screen.getByText('1M ctx')).toBeTruthy()
  expect(screen.getByText('8K ctx')).toBeTruthy()
  // toolUse true → chip; false/unknown → none.
  expect(screen.getAllByText('⚒ tools')).toHaveLength(1)
  // pricing present on one model only → one price chip, input/output per 1M.
  expect(screen.getByText('$0.30/$2.50 /M')).toBeTruthy()
})

it('typing filters the list AND updates the value immediately (free text always valid)', async () => {
  render(<Host />)
  fireEvent.click(input())
  await screen.findByText('google/gemini-2.5-flash')
  fireEvent.change(input(), { target: { value: 'llama' } })
  expect(input().value).toBe('llama') // onChange fired — free text is live before any pick
  await waitFor(() => expect(screen.queryByText('google/gemini-2.5-flash')).toBeNull())
  expect(screen.getByText('meta-llama/llama-3-8b')).toBeTruthy()
})

it('clicking a row picks it (fills the input, closes the list)', async () => {
  render(<Host />)
  fireEvent.click(input())
  const row = await screen.findByText('meta-llama/llama-3-8b')
  fireEvent.click(row)
  expect(input().value).toBe('meta-llama/llama-3-8b')
  expect(document.querySelector('[data-test="model-combobox-list"]')).toBeNull()
})

it('keyboard: ArrowDown highlights, Enter picks, Escape closes without picking', async () => {
  render(<Host initial="keep-me" />)
  fireEvent.keyDown(input(), { key: 'ArrowDown' }) // opens
  await screen.findByText('google/gemini-2.5-flash')
  fireEvent.keyDown(input(), { key: 'ArrowDown' }) // highlight row 0
  fireEvent.keyDown(input(), { key: 'Enter' })
  expect(input().value).toBe('google/gemini-2.5-flash')
  // Reopen → Escape keeps the picked value and closes.
  fireEvent.keyDown(input(), { key: 'ArrowDown' })
  await screen.findByText('meta-llama/llama-3-8b')
  fireEvent.keyDown(input(), { key: 'Escape' })
  expect(document.querySelector('[data-test="model-combobox-list"]')).toBeNull()
  expect(input().value).toBe('google/gemini-2.5-flash')
})

it('Escape with the list open is consumed — it must not reach the window-level Modal handler', async () => {
  const onWindowKey = vi.fn()
  window.addEventListener('keydown', onWindowKey)
  render(<Host />)
  fireEvent.click(input())
  await screen.findByText('google/gemini-2.5-flash')
  onWindowKey.mockClear()
  fireEvent.keyDown(input(), { key: 'Escape' }) // closes the list only
  expect(onWindowKey).not.toHaveBeenCalled()
  // With the list closed, Esc bubbles again (the Settings Modal keeps its close gesture).
  fireEvent.keyDown(input(), { key: 'Escape' })
  expect(onWindowKey).toHaveBeenCalled()
  window.removeEventListener('keydown', onWindowKey)
})

it('Enter with no highlighted row keeps the typed free text and just closes', async () => {
  render(<Host />)
  fireEvent.click(input())
  await screen.findByText('google/gemini-2.5-flash')
  fireEvent.change(input(), { target: { value: 'my/custom-model' } })
  fireEvent.keyDown(input(), { key: 'Enter' })
  expect(input().value).toBe('my/custom-model')
  expect(document.querySelector('[data-test="model-combobox-list"]')).toBeNull()
})

it('a persisted value does NOT filter the reopened list (only typed text filters)', async () => {
  render(<Host initial="google/gemini-2.5-flash" />)
  fireEvent.click(input())
  // All models visible despite the input holding a specific id.
  await screen.findByText('meta-llama/llama-3-8b')
  expect(screen.getByText('mock/no-meta')).toBeTruthy()
})

describe('degraded states', () => {
  it('no-key → hint row, free text untouched', async () => {
    list.mockResolvedValue({ ok: false, reason: 'no-key' })
    render(<Host />)
    fireEvent.click(input())
    const hint = await screen.findByText(/add an api key/i)
    expect(hint).toBeTruthy()
    fireEvent.change(input(), { target: { value: 'still/works' } })
    expect(input().value).toBe('still/works')
  })

  it('no-base-url → local-server hint', async () => {
    list.mockResolvedValue({ ok: false, reason: 'no-base-url' })
    render(<Host />)
    fireEvent.click(input())
    expect(await screen.findByText(/no local server configured/i)).toBeTruthy()
  })

  it('provider-error → generic hint; IPC rejection degrades the same way', async () => {
    list.mockRejectedValue(new Error('channel gone'))
    render(<Host />)
    fireEvent.click(input())
    expect(await screen.findByText(/couldn't load the model list/i)).toBeTruthy()
  })

  it('stale result → offline note in the footer', async () => {
    list.mockResolvedValue({
      ok: true,
      fetchedAt: Date.now() - 7_200_000,
      stale: true,
      models: [{ id: 'cached/model' }]
    })
    render(<Host />)
    fireEvent.click(input())
    await screen.findByText('cached/model')
    expect(screen.getByText(/offline — showing cached list/i)).toBeTruthy()
    expect(screen.getByText(/fetched 2 h ago/i)).toBeTruthy()
  })
})

it('the refresh footer refetches with refresh:true', async () => {
  render(<Host />)
  fireEvent.click(input())
  await screen.findByText('google/gemini-2.5-flash')
  fireEvent.click(screen.getByText(/refresh/i))
  await waitFor(() => expect(list).toHaveBeenCalledWith({ provider: 'openrouter', refresh: true }))
})

it('the FIRST keystroke (no prior click) opens the list WITH the typed filter applied', async () => {
  // Tab-focus-then-type path: the open-on-type must not wipe the keystroke's filter (the
  // openList() setTyped(null) same-batch bug from review #357).
  render(<Host />)
  fireEvent.change(input(), { target: { value: 'llama' } })
  expect(input().value).toBe('llama')
  await screen.findByText('meta-llama/llama-3-8b')
  expect(screen.queryByText('google/gemini-2.5-flash')).toBeNull() // filter survived the open
})

it('a stale fetch for the OLD provider resolving late never overwrites the new list', async () => {
  // Review #357: no request guard → the slow openrouter response landed after a switch to
  // anthropic and replaced anthropic's list. The seq guard must drop the superseded response.
  const resolvers: ((v: unknown) => void)[] = []
  list.mockImplementation(() => new Promise((res) => resolvers.push(res)))
  function SwitchHost(): ReactElement {
    const [provider, setProvider] = useState<'openrouter' | 'anthropic'>('openrouter')
    const [value, setValue] = useState('')
    return (
      <>
        <button onClick={() => setProvider('anthropic')}>switch</button>
        <ModelCombobox provider={provider} value={value} onChange={setValue} />
      </>
    )
  }
  render(<SwitchHost />)
  fireEvent.click(input()) // request 1 (openrouter) — left pending
  fireEvent.click(screen.getByText('switch')) // supersedes request 1, closes the list
  fireEvent.click(input()) // request 2 (anthropic) — pending
  expect(list).toHaveBeenLastCalledWith({ provider: 'anthropic' })
  // Request 2 lands first, then the STALE request 1 lands late.
  resolvers[1]({ ok: true, fetchedAt: Date.now(), models: [{ id: 'claude-haiku-4-5' }] })
  await screen.findByText('claude-haiku-4-5')
  resolvers[0]({ ok: true, fetchedAt: Date.now(), models: [{ id: 'stale/openrouter-model' }] })
  await waitFor(() => expect(screen.queryByText('stale/openrouter-model')).toBeNull())
  expect(screen.getByText('claude-haiku-4-5')).toBeTruthy() // the fresh list survived
})

it('switching provider drops the loaded list; the next open refetches for the new provider', async () => {
  function SwitchHost(): ReactElement {
    const [provider, setProvider] = useState<'openrouter' | 'anthropic'>('openrouter')
    const [value, setValue] = useState('')
    return (
      <>
        <button onClick={() => setProvider('anthropic')}>switch</button>
        <ModelCombobox provider={provider} value={value} onChange={setValue} />
      </>
    )
  }
  render(<SwitchHost />)
  fireEvent.click(input())
  await screen.findByText('google/gemini-2.5-flash')
  fireEvent.click(screen.getByText('switch'))
  expect(document.querySelector('[data-test="model-combobox-list"]')).toBeNull()
  fireEvent.click(input())
  await waitFor(() => expect(list).toHaveBeenCalledWith({ provider: 'anthropic' }))
})

describe('formatters', () => {
  it('formatContext', () => {
    expect(formatContext(1_048_576)).toBe('1M')
    expect(formatContext(2_000_000)).toBe('2M')
    expect(formatContext(1_500_000)).toBe('1.5M')
    expect(formatContext(200_000)).toBe('200K')
    expect(formatContext(8192)).toBe('8K')
    expect(formatContext(512)).toBe('512')
  })

  it('formatAge', () => {
    const now = 10_000_000
    expect(formatAge(now - 30_000, now)).toBe('just now')
    expect(formatAge(now - 120_000, now)).toBe('2 min ago')
    expect(formatAge(now - 7_200_000, now)).toBe('2 h ago')
  })

  it('formatPrice', () => {
    expect(formatPrice(0, 0)).toBe('Free')
    expect(formatPrice(3, 15)).toBe('$3/$15 /M') // whole ≥1 → no decimals
    expect(formatPrice(0.1, 0.4)).toBe('$0.10/$0.40 /M') // sub-$1 → 2 decimals
    expect(formatPrice(0.3, 2.5)).toBe('$0.30/$2.50 /M') // non-integer ≥1 → 2 decimals
    expect(formatPrice(0, 15)).toBe('$0/$15 /M') // one side free
    expect(formatPrice(0.0015, 0.006)).toBe('$0.0015/$0.006 /M') // ultra-cheap keeps precision
    // regression: 0 < v < 0.00005 must not render a dangling "0." (old toFixed(4)+strip bug).
    expect(formatPrice(0.00003, 0.00003)).toBe('$0.00003/$0.00003 /M')
  })
})
