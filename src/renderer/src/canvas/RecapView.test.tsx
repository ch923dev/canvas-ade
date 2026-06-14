import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { RecapView } from './RecapView'

type Bundle = NonNullable<Awaited<ReturnType<typeof window.api.recap.get>>>

const T0 = new Date(2026, 5, 13, 4, 0).getTime() // local 04:00

function fullBundle(): Bundle {
  return {
    facts: {
      v: 1,
      status: 'waiting-on-you',
      live: false, // dead session whose last recorded state was a question -> Resume offered
      title: 'Housekeeping the Dunly workspace',
      sessionStart: T0,
      lastActivity: T0 + 47 * 60_000,
      turns: { user: 3, agent: 9 },
      lastAsk: 'Does the screenshots really helpful?',
      files: [
        { path: 'Z:\\repo\\CLAUDE.md', op: 'edit', count: 2 },
        { path: 'Z:\\repo\\src\\recapFacts.ts', op: 'write', count: 1 }
      ],
      commands: [{ label: 'git status', count: 1 }],
      generatedAt: T0 + 48 * 60_000
    },
    narrative: {
      now: 'Asked whether to move docs/ or delete the screenshots.',
      next: 'Approve moving docs/ into dunly-backend.',
      beats: [
        { ts: T0 + 21 * 60_000, text: 'Reviewed docs/ + root.', role: 'agent' },
        { ts: T0 + 39 * 60_000, text: 'are the screenshots useful?', role: 'user' }
      ],
      // Fresh recap: asOf == lastActivity, so the staleness guard does NOT suppress it.
      asOf: T0 + 47 * 60_000
    }
  }
}

function setApi(bundle: Bundle | null): {
  get: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
} {
  const get = vi.fn().mockResolvedValue(bundle)
  const refresh = vi.fn().mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = {
    recap: { get },
    memory: { refresh }
  }
  return { get, refresh }
}

describe('RecapView (two-zone face)', () => {
  beforeEach(() => {
    setApi(fullBundle())
  })
  // globals:false → RTL auto-cleanup is off; unmount between tests so renders (and any in-flight
  // auto-refresh setState) can't bleed across cases (repo convention for .tsx tests).
  afterEach(cleanup)

  it('renders the glance zone: status word, title, NOW and NEXT', async () => {
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-status]')).toBeTruthy())
    expect(screen.getByText('waiting on you')).toBeTruthy()
    expect(screen.getByText('Housekeeping the Dunly workspace')).toBeTruthy()
    expect(container.querySelector('[data-test=recap-now]')?.textContent).toContain(
      'Asked whether to move docs/'
    )
    expect(container.querySelector('[data-test=recap-next]')?.textContent).toContain(
      'Approve moving docs/'
    )
    expect(screen.getByText(/47m session/)).toBeTruthy()
    expect(screen.getByText(/as of 04:47/)).toBeTruthy()
  })

  it('STALE narrative (trails live activity): suppressed, stale banner shown, auto-refreshes once', async () => {
    const b = fullBundle()
    b.facts.status = 'running'
    b.facts.live = true
    b.facts.lastActivity = T0 + 60 * 60_000 // live activity 60m in
    if (b.narrative) b.narrative.asOf = T0 + 10 * 60_000 // narrative ~50m behind → stale
    const { refresh } = setApi(b)
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-stale]')).toBeTruthy())
    // the stale (wrong/earlier-session) narrative is NOT presented as current
    expect(container.querySelector('[data-test=recap-now]')).toBeNull()
    // and it auto-refreshes ONCE to regenerate for the live session
    await waitFor(() => expect(refresh).toHaveBeenCalledWith('b1'))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('renders the evidence zone: beats (user-prefixed), chips, last ask', async () => {
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() =>
      expect(container.querySelectorAll('[data-test=recap-beat]')).toHaveLength(2)
    )
    const beats = container.querySelectorAll('[data-test=recap-beat]')
    expect(beats[0].textContent).toContain('04:21')
    expect(beats[1].textContent).toContain('You: ')
    const chips = container.querySelector('[data-test=recap-chips]')
    expect(chips?.textContent).toContain('CLAUDE.md')
    expect(chips?.textContent).toContain('×2')
    expect(chips?.textContent).toContain('recapFacts.ts')
    expect(chips?.textContent).toContain('new') // write op badge
    expect(chips?.textContent).toContain('git status')
    expect(container.querySelector('[data-test=recap-lastask]')?.textContent).toContain(
      'Does the screenshots really helpful?'
    )
  })

  it('facts-only bundle: quiet line + hint + turns row, no NOW block', async () => {
    const b = fullBundle()
    delete (b as { narrative?: unknown }).narrative
    setApi(b)
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() =>
      expect(container.querySelector('[data-test=recap-facts-only]')).toBeTruthy()
    )
    expect(screen.getByText(/No narrative yet/)).toBeTruthy()
    expect(screen.getByText(/12 turns/)).toBeTruthy()
    expect(container.querySelector('[data-test=recap-now]')).toBeNull()
    // facts-mode meta shows activity age instead of the narrative as-of stamp
    expect(screen.getByText(/active /)).toBeTruthy()
  })

  it('empty session renders the empty state', async () => {
    setApi({
      facts: {
        v: 1,
        status: 'idle',
        live: false,
        turns: { user: 0, agent: 0 },
        files: [],
        commands: [],
        generatedAt: T0
      }
    })
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-empty]')).toBeTruthy())
    expect(screen.getByText(/No agent session on this board yet/)).toBeTruthy()
    expect(container.querySelector('[data-test=recap-status]')).toBeNull()
  })

  it('non-zero exit renders the err-class exited label', async () => {
    const b = fullBundle()
    b.facts.status = 'exited'
    ;(b.facts as { exitCode?: number }).exitCode = 1
    setApi(b)
    render(<RecapView boardId="b1" />)
    await waitFor(() => expect(screen.getByText('exited (code 1)')).toBeTruthy())
  })

  it('refresh forces a re-summary then re-reads the bundle', async () => {
    const { get, refresh } = setApi(fullBundle())
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    ;(container.querySelector('button[title="Refresh recap"]') as HTMLButtonElement).click()
    await waitFor(() => expect(refresh).toHaveBeenCalledWith('b1'))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  })

  it('Resume renders only when wired and fires the callback', async () => {
    const onResume = vi.fn()
    const { container, rerender } = render(<RecapView boardId="b1" canResume onResume={onResume} />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-resume]')).toBeTruthy())
    ;(container.querySelector('[data-test=recap-resume]') as HTMLButtonElement).click()
    expect(onResume).toHaveBeenCalledTimes(1)

    rerender(<RecapView boardId="b1" canResume={false} onResume={onResume} />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-resume]')).toBeNull())
  })

  it('hides Resume while the agent is live/running (even with canResume wired)', async () => {
    const b = fullBundle()
    b.facts.status = 'running'
    b.facts.live = true
    setApi(b)
    const { container } = render(<RecapView boardId="b1" canResume onResume={vi.fn()} />)
    // status header still renders; the Resume control is the only thing gated by liveness
    await waitFor(() => expect(container.querySelector('[data-test=recap-status]')).toBeTruthy())
    expect(container.querySelector('[data-test=recap-resume]')).toBeNull()
  })

  it('a dormant RESUMABLE board (sparse facts) surfaces status + Resume, not the empty placeholder', async () => {
    const onResume = vi.fn()
    setApi({
      facts: {
        v: 1,
        status: 'exited',
        exitCode: 0,
        live: false,
        turns: { user: 0, agent: 0 },
        files: [],
        commands: [],
        generatedAt: T0
      }
    })
    const { container } = render(<RecapView boardId="b1" canResume onResume={onResume} />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-status]')).toBeTruthy())
    // NOT the dead-end "no session yet" placeholder — the learned session is surfaced
    expect(container.querySelector('[data-test=recap-empty]')).toBeNull()
    expect(screen.getByText('exited')).toBeTruthy()
    expect(screen.getByText(/is not running/)).toBeTruthy()
    expect(screen.getByText(/Resume to pick the conversation back up/)).toBeTruthy()
    const btn = container.querySelector('[data-test=recap-resume]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    btn.click()
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('a never-ran board (no learned session) still shows the launch-claude placeholder', async () => {
    setApi({
      facts: {
        v: 1,
        status: 'idle',
        live: false,
        turns: { user: 0, agent: 0 },
        files: [],
        commands: [],
        generatedAt: T0
      }
    })
    const { container } = render(<RecapView boardId="b1" onResume={vi.fn()} />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-empty]')).toBeTruthy())
    expect(container.querySelector('[data-test=recap-resume]')).toBeNull()
    // No start affordance wired (canStart absent) -> the passive launch hint, no Start button.
    expect(container.querySelector('[data-test=recap-start]')).toBeNull()
  })

  it('M1: a spawn-failed board with NO learned session surfaces the error, not the empty placeholder', async () => {
    setApi({
      facts: {
        v: 1,
        status: 'spawn-failed',
        live: false,
        turns: { user: 0, agent: 0 },
        files: [],
        commands: [],
        generatedAt: T0
      }
    })
    const { container } = render(<RecapView boardId="b1" />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-status]')).toBeTruthy())
    // The redesign exists to surface this — it must NOT hide under "no session yet".
    expect(container.querySelector('[data-test=recap-empty]')).toBeNull()
    expect(screen.getByText('failed to start')).toBeTruthy()
  })

  it('a startable no-session board offers "Start a new session" and fires onStart', async () => {
    const onStart = vi.fn()
    setApi({
      facts: {
        v: 1,
        status: 'idle',
        live: false,
        turns: { user: 0, agent: 0 },
        files: [],
        commands: [],
        generatedAt: T0
      }
    })
    const { container } = render(<RecapView boardId="b1" canStart onStart={onStart} />)
    await waitFor(() => expect(container.querySelector('[data-test=recap-empty]')).toBeTruthy())
    expect(screen.getByText(/start a new one to begin/)).toBeTruthy()
    const btn = container.querySelector('[data-test=recap-start]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    btn.click()
    expect(onStart).toHaveBeenCalledTimes(1)
  })
})
