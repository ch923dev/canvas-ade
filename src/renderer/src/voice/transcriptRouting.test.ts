/**
 * Voice — segment routing (B0). The leak this pins: a Jarvis utterance cut off by a stop (and every
 * converse teardown is a stop) used to fold its provisional tail into the hidden dictation draft,
 * and a cloud batch final that landed while a conversation was armed was shipped to the brain as a
 * Jarvis turn even though the user had dictated it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCloudFinal, applyFinal, solidifyTail } from './transcriptRouting'
import { setFinalConsumer } from './finalConsumer'
import { useVoiceStore } from '../store/voiceStore'

let release: (() => void) | null = null

beforeEach(() => {
  useVoiceStore.setState({ draft: '', partial: '', capturing: true, composerSuppressed: false })
})
afterEach(() => {
  release?.()
  release = null
})

describe('solidifyTail (the stop finalizes the provisional tail)', () => {
  it('dictation (no consumer): the tail folds into the draft exactly as before', () => {
    useVoiceStore.setState({ draft: 'hello', partial: 'world' })
    solidifyTail()
    expect(useVoiceStore.getState()).toMatchObject({
      draft: 'hello world',
      partial: '',
      capturing: false
    })
  })

  it('converse: the tail goes to the consumer and NEVER reaches the dictation draft', () => {
    const consumer = vi.fn(() => true)
    release = setFinalConsumer(consumer)
    useVoiceStore.setState({ draft: 'earlier dictation', partial: 'jarvis open the' })
    solidifyTail()
    expect(consumer).toHaveBeenCalledWith('jarvis open the')
    expect(useVoiceStore.getState()).toMatchObject({
      draft: 'earlier dictation',
      partial: '',
      capturing: false
    })
  })

  it('a consumer that declines (converse not live) leaves the tail to the draft', () => {
    release = setFinalConsumer(() => false)
    useVoiceStore.setState({ draft: '', partial: 'stray words' })
    solidifyTail()
    expect(useVoiceStore.getState().draft).toBe('stray words')
  })

  it('an empty tail is never offered (no phantom final for the consumer)', () => {
    const consumer = vi.fn(() => true)
    release = setFinalConsumer(consumer)
    useVoiceStore.setState({ partial: '   ' })
    solidifyTail()
    expect(consumer).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().capturing).toBe(false)
  })
})

describe('final routing', () => {
  it('a LOCAL final is offered to the converse consumer first', () => {
    const consumer = vi.fn(() => true)
    release = setFinalConsumer(consumer)
    applyFinal('send the tests')
    expect(consumer).toHaveBeenCalledWith('send the tests')
    expect(useVoiceStore.getState().draft).toBe('')
  })

  it('a CLOUD final is dictation by construction — straight to the draft, even with a consumer armed', () => {
    const consumer = vi.fn(() => true)
    release = setFinalConsumer(consumer)
    applyCloudFinal('dictated before Jarvis armed')
    expect(consumer).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().draft).toBe('dictated before Jarvis armed')
  })
})
