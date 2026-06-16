// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { WorkerConfigDialog } from './WorkerConfigDialog'

// The dialog's Modal portals to document.body; unmount each render so the portal can't leak into the
// next test (duplicate test-ids). RTL auto-cleanup is not wired in this project's vitest setup.
afterEach(cleanup)

/**
 * The C2d worker-config dialog: it seeds the engineered prompt + the default `claude` command, lets the
 * user add the trust-skip flag + edit the prompt, and on Dispatch returns `{launchCommand, prompt,
 * config}` (the config is remembered to pre-fill the next dispatch). Reuses the terminal command
 * builder, so the default preset composes to a bare `claude`.
 */
describe('WorkerConfigDialog', () => {
  it('seeds the engineered prompt + default claude command; Dispatch returns the edited values', () => {
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
    expect(command.value).toBe('claude') // default preset, no flags

    // The user adds the trust-skip flag (so the worker boots past the first-run gate) + edits the prompt.
    fireEvent.change(command, { target: { value: 'claude --dangerously-skip-permissions' } })
    fireEvent.change(prompt, { target: { value: 'Do it carefully.' } })
    fireEvent.click(screen.getByTestId('worker-dispatch'))

    expect(onDispatch).toHaveBeenCalledWith({
      launchCommand: 'claude --dangerously-skip-permissions',
      prompt: 'Do it carefully.',
      config: {
        presetId: 'claude',
        values: {},
        rawOverride: 'claude --dangerously-skip-permissions'
      }
    })
  })

  it('pre-fills the command from a prior config (initial)', () => {
    render(
      <WorkerConfigDialog
        zoneName="Z"
        engineeredPrompt="p"
        initial={{
          presetId: 'claude',
          values: {},
          rawOverride: 'claude --dangerously-skip-permissions'
        }}
        onDispatch={() => {}}
        onCancel={() => {}}
      />
    )
    expect((screen.getByTestId('worker-command') as HTMLInputElement).value).toBe(
      'claude --dangerously-skip-permissions'
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
