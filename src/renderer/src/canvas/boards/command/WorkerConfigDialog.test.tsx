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
      config: {
        presetId: 'claude',
        values: { 'skip-permissions': true },
        rawOverride: null,
        rolePackId: null // Custom — the pre-pack default is unchanged
      }
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

  it('a role pack pre-fills the claude command from pack DATA and commits its rolePackId', () => {
    const onDispatch = vi.fn()
    render(
      <WorkerConfigDialog
        zoneName="Recon"
        engineeredPrompt="Find where spawn caps live."
        initial={null}
        onDispatch={onDispatch}
        onCancel={() => {}}
      />
    )
    // Custom is the default; picking Explorer swaps the composed command to the pack's shape.
    expect(screen.getByTestId('worker-role-custom').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('worker-role-explorer'))
    expect((screen.getByTestId('worker-command') as HTMLInputElement).value).toBe(
      'claude --model haiku --effort low --permission-mode plan'
    )
    // Read role → no write-cap warning.
    expect(screen.queryByTestId('worker-role-write-warning')).toBeNull()

    fireEvent.click(screen.getByTestId('worker-dispatch'))
    expect(onDispatch).toHaveBeenCalledWith({
      launchCommand: 'claude --model haiku --effort low --permission-mode plan',
      prompt: 'Find where spawn caps live.',
      config: {
        presetId: 'claude',
        values: { model: 'haiku', effort: 'low', 'permission-mode': 'plan' },
        rawOverride: null,
        rolePackId: 'explorer'
      }
    })
  })

  it('swapping the pack swaps the launch shape — builder vs code-reviewer (data, not a fork)', () => {
    render(
      <WorkerConfigDialog
        zoneName="Z"
        engineeredPrompt="p"
        initial={null}
        onDispatch={() => {}}
        onCancel={() => {}}
      />
    )
    const command = screen.getByTestId('worker-command') as HTMLInputElement
    fireEvent.click(screen.getByTestId('worker-role-builder'))
    expect(command.value).toBe('claude --model sonnet --dangerously-skip-permissions')
    // Write role → the Phase-0 no-isolation cap is DISCLOSED, not silent.
    expect(screen.getByTestId('worker-role-write-warning').textContent).toMatch(/capped at 1/)

    fireEvent.click(screen.getByTestId('worker-role-code-reviewer'))
    expect(command.value).toBe('claude --model opus --permission-mode plan')
    expect(screen.queryByTestId('worker-role-write-warning')).toBeNull()
  })

  it("editing a read pack's command past read-only proof flips the disclosure to write posture", () => {
    // PR #381 review: the pack declares, the ACTUAL editable command decides — mirroring the
    // pump's isWriteRoleTask, which fail-closes the same divergence to write-gated.
    render(
      <WorkerConfigDialog
        zoneName="Z"
        engineeredPrompt="p"
        initial={null}
        onDispatch={() => {}}
        onCancel={() => {}}
      />
    )
    fireEvent.click(screen.getByTestId('worker-role-explorer'))
    expect(screen.queryByTestId('worker-role-write-warning')).toBeNull()
    fireEvent.change(screen.getByTestId('worker-command'), {
      target: { value: 'claude --model haiku --permission-mode bypassPermissions' }
    })
    expect(screen.getByTestId('worker-role-write-warning')).not.toBeNull()
    // Restoring a read-only command restores the exemption.
    fireEvent.change(screen.getByTestId('worker-command'), {
      target: { value: 'claude --model haiku --permission-mode plan' }
    })
    expect(screen.queryByTestId('worker-role-write-warning')).toBeNull()
  })

  it('switching the AGENT preset drops back to Custom (packs are claude-hosted in Phase 0)', () => {
    const onDispatch = vi.fn()
    render(
      <WorkerConfigDialog
        zoneName="Z"
        engineeredPrompt="p"
        initial={null}
        onDispatch={onDispatch}
        onCancel={() => {}}
      />
    )
    fireEvent.click(screen.getByTestId('worker-role-builder'))
    fireEvent.click(screen.getByTestId('worker-preset-codex'))
    expect(screen.getByTestId('worker-role-custom').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('worker-dispatch'))
    expect(onDispatch.mock.calls[0][0].config.rolePackId).toBeNull()
  })

  it('pre-fills the remembered pack from a prior config (initial.rolePackId)', () => {
    render(
      <WorkerConfigDialog
        zoneName="Z"
        engineeredPrompt="p"
        initial={{
          presetId: 'claude',
          values: { model: 'haiku', effort: 'low', 'permission-mode': 'plan' },
          rawOverride: null,
          rolePackId: 'explorer'
        }}
        onDispatch={() => {}}
        onCancel={() => {}}
      />
    )
    expect(screen.getByTestId('worker-role-explorer').getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByTestId('worker-command') as HTMLInputElement).value).toBe(
      'claude --model haiku --effort low --permission-mode plan'
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
