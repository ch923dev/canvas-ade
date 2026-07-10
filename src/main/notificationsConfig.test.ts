import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readNotificationsConfig,
  writeNotificationsConfig,
  sanitizeNotificationsConfig,
  gateNotification,
  DEFAULT_NOTIFICATIONS,
  type NotificationsConfig
} from './notificationsConfig'
import type { LifecycleEvent } from './agentLifecycle'

describe('notificationsConfig I/O', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notifycfg-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns DEFAULT_NOTIFICATIONS when no file exists', () => {
    expect(readNotificationsConfig(dir)).toEqual(DEFAULT_NOTIFICATIONS)
  })

  it('round-trips a written config', () => {
    const cfg: NotificationsConfig = {
      enabled: false,
      onDone: false,
      onInput: true,
      onError: true,
      onlyWhenUnfocused: true
    }
    writeNotificationsConfig(dir, cfg)
    expect(readNotificationsConfig(dir)).toEqual(cfg)
    expect(existsSync(join(dir, 'notifications-config.json'))).toBe(true)
  })

  it('repairs missing/non-boolean fields back to their defaults', () => {
    writeFileSync(
      join(dir, 'notifications-config.json'),
      JSON.stringify({ enabled: 'yes', onDone: false }),
      'utf8'
    )
    const cfg = readNotificationsConfig(dir)
    expect(cfg.enabled).toBe(DEFAULT_NOTIFICATIONS.enabled) // coerced from 'yes'
    expect(cfg.onDone).toBe(false) // valid boolean kept
    expect(cfg.onInput).toBe(DEFAULT_NOTIFICATIONS.onInput) // missing → default
  })

  it('falls back to defaults on corrupt JSON', () => {
    writeFileSync(join(dir, 'notifications-config.json'), '{ "enabled": tr', 'utf8')
    expect(readNotificationsConfig(dir)).toEqual(DEFAULT_NOTIFICATIONS)
  })

  it('sanitizes an arbitrary payload (never trust the wire shape)', () => {
    expect(sanitizeNotificationsConfig(null)).toEqual(DEFAULT_NOTIFICATIONS)
    expect(sanitizeNotificationsConfig({ onlyWhenUnfocused: 1 }).onlyWhenUnfocused).toBe(false)
  })
})

describe('gateNotification', () => {
  const all: NotificationsConfig = {
    enabled: true,
    onDone: true,
    onInput: true,
    onError: true,
    onlyWhenUnfocused: false
  }
  const gate = (
    over: Partial<NotificationsConfig>,
    extra: {
      event?: LifecycleEvent
      windowFocused?: boolean
      monitored?: boolean
    } = {}
  ) =>
    gateNotification({
      event: extra.event ?? 'done',
      config: { ...all, ...over },
      windowFocused: extra.windowFocused ?? false,
      monitored: extra.monitored ?? true
    })

  it('delivers everything when all switches are on and the board is monitored', () => {
    expect(gate({})).toEqual({ deliver: true, os: true })
  })

  it('is fully silent when the board opted out of monitoring', () => {
    expect(gate({}, { monitored: false })).toEqual({ deliver: false, os: false })
  })

  it('is fully silent when the master switch is off', () => {
    expect(gate({ enabled: false })).toEqual({ deliver: false, os: false })
  })

  it('is fully silent when the per-event switch is off', () => {
    expect(gate({ onDone: false }, { event: 'done' })).toEqual({ deliver: false, os: false })
    expect(gate({ onInput: false }, { event: 'needs-input' })).toEqual({
      deliver: false,
      os: false
    })
    expect(gate({ onError: false }, { event: 'error' })).toEqual({ deliver: false, os: false })
  })

  it('keeps an unrelated event firing when only one per-event switch is off', () => {
    expect(gate({ onDone: false }, { event: 'error' })).toEqual({ deliver: true, os: true })
  })

  it('suppresses ONLY the OS layer when onlyWhenUnfocused && focused', () => {
    expect(gate({ onlyWhenUnfocused: true }, { windowFocused: true })).toEqual({
      deliver: true,
      os: false
    })
  })

  it('keeps the OS layer when onlyWhenUnfocused && NOT focused', () => {
    expect(gate({ onlyWhenUnfocused: true }, { windowFocused: false })).toEqual({
      deliver: true,
      os: true
    })
  })
})
