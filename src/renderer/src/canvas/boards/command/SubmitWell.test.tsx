// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SubmitWell } from './SubmitWell'

// RTL auto-cleanup is not wired in this project's vitest setup — unmount each render explicitly.
afterEach(cleanup)

const well = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText(/Describe a task to dispatch/) as HTMLTextAreaElement

/**
 * The submit well is a chat-style multi-line input: Enter dispatches, Shift+Enter inserts a newline,
 * and a submit clears the field. fireEvent.keyDown returns false when a handler called preventDefault
 * (the event was cancelled) — so a `true` return proves the browser's default newline was left to run.
 */
describe('SubmitWell — Enter dispatches, Shift+Enter newlines', () => {
  it('Enter dispatches the (multi-line) value with the default composition, then clears', () => {
    const onSubmit = vi.fn()
    render(<SubmitWell onSubmit={onSubmit} />)
    const ta = well()
    fireEvent.change(ta, { target: { value: 'refactor auth\n- add tests' } })
    const ran = fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ran).toBe(false) // preventDefault'd — dispatch owns Enter
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('refactor auth\n- add tests', {
      planning: false,
      browser: false
    })
    expect(ta.value).toBe('') // cleared after dispatch
  })

  it('Shift+Enter does NOT dispatch (the browser default newline runs)', () => {
    const onSubmit = vi.fn()
    render(<SubmitWell onSubmit={onSubmit} />)
    const ta = well()
    fireEvent.change(ta, { target: { value: 'first line' } })
    const ran = fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(ran).toBe(true) // not cancelled → the newline is inserted
  })

  it('Enter mid-IME-composition does NOT dispatch', () => {
    const onSubmit = vi.fn()
    render(<SubmitWell onSubmit={onSubmit} />)
    const ta = well()
    fireEvent.change(ta, { target: { value: 'partial candidate' } })
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not dispatch an empty / whitespace-only task', () => {
    const onSubmit = vi.fn()
    render(<SubmitWell onSubmit={onSubmit} />)
    const ta = well()
    fireEvent.change(ta, { target: { value: '   ' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('the Dispatch button submits too, carrying the chosen composition', () => {
    const onSubmit = vi.fn()
    render(<SubmitWell onSubmit={onSubmit} />)
    fireEvent.change(well(), { target: { value: 'do a thing' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Planning' }))
    fireEvent.click(screen.getByRole('button', { name: /Dispatch/ }))
    expect(onSubmit).toHaveBeenCalledWith('do a thing', { planning: true, browser: false })
  })
})
