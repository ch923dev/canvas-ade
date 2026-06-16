// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { WorkerConfigDialog } from './WorkerConfigDialog'

// The dialog's Modal portals to document.body; unmount each render so the portal can't leak into the
// next test (duplicate test-ids). RTL auto-cleanup is not wired in this project's vitest setup.
afterEach(cleanup)

/**
 * The C2d/C2f worker-config dialog: it seeds the engineered prompt + a default Claude command WITH
 * `--dangerously-skip-permissions` on (so the worker boots past the first-run trust gate), lets the
 * user edit both, and on Dispatch returns `{launchCommand, prompt, config}` (config is remembered to
 * pre-fill the next dispatch).
 */
describe('WorkerConfigDialog', () => {
  it('seeds the engineered prompt + default claude command (skip-permissions on); Dispatch returns them', () => {
    const onDispatch = vi.fn()
    render(
      <WorkerConfigDialog
        zoneName="Project Analysis"
        engineeredPrompt="Analyze the repo and summarize it."
        initial={null}
        onDispatch={onDispatch}
        onCancel={() => {}}
      />
    )
    const prompt = screen.getByTestId('worker-prompt') as HTMLTextAreaElement
    expect(prompt.value).toBe('Analyze the repo and summarize it.')
    const command = screen.getByTestId('worker-command') as HTMLInputElement
    // First-dispatch default: Claude with the trust-clearing skip flag.
    expect(command.value).toBe('claude --dangerously-skip-permissions')

    fireEvent.change(prompt, { target: { value: 'Do it carefully.' } })
    fireEvent.click(screen.getByTestId('worker-dispatch'))

    expect(onDispatch).toHaveBeenCalledWith({
      launchCommand: 'claude --dangerously-skip-permissions',
      prompt: 'Do it carefully.',
      config: { presetId: 'claude', values: { 'skip-permissions': true }, rawOverride: null }
    })
  })

  it('pre-fills the command from a prior config (initial wins over the default)', () => {
    render(
      <WorkerConfigDialog
        zoneName="Z"
        engineeredPrompt="p"
        initial={{ presetId: 'claude', values: {}, rawOverride: 'claude --permission-mode plan' }}
        onDispatch={() => {}}
        onCancel={() => {}}
      />
    )
    expect((screen.getByTestId('worker-command') as HTMLInputElement).value).toBe(
      'claude --permission-mode plan'
    )
  })

  it('Cancel invokes onCancel without dispatching', () => {
    const onCancel = vi.fn()
    const onDispatch = vi.fn()
    render(
      <WorkerConfigDialog
        zoneName="Z"
        engineeredPrompt="p"
        initial={null}
        onDispatch={onDispatch}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByTestId('worker-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(onDispatch).not.toHaveBeenCalled()
  })
})
