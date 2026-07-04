/**
 * Maps a drilled `SettingsSectionId` to its detail pane. Kept SEPARATE from `settingsSections.ts`
 * (which stays pure metadata — label/icon/blurb/group — so its committed unit tests don't churn and
 * so the metadata registry doesn't pull every heavy pane into the tile grid's module). `SettingsPanel`
 * renders this once, for the active section.
 *
 * `onClose` reaches the panes that must dismiss the whole panel (Orchestration opens onboarding
 * modals that can't stack over this one). `onSignIn` reaches Account's signed-out CTA.
 */
import { type ReactElement } from 'react'
import { SettingsVoiceSection } from '../SettingsVoiceSection'
import type { SettingsSectionId } from './settingsSections'
import { AccountPane } from './panes/AccountPane'
import { BillingPane } from './panes/BillingPane'
import { AppearancePane } from './panes/AppearancePane'
import { TerminalPane } from './panes/TerminalPane'
import { LlmPane } from './panes/LlmPane'
import { OrchestrationPane } from './panes/OrchestrationPane'
import { McpPane } from './panes/McpPane'
import { AboutPane } from './panes/AboutPane'

export function SettingsSectionBody({
  id,
  onClose,
  onSignIn
}: {
  id: SettingsSectionId
  onClose: () => void
  onSignIn?: () => void
}): ReactElement {
  switch (id) {
    case 'account':
      return <AccountPane onSignIn={onSignIn} />
    case 'billing':
      return <BillingPane />
    case 'appearance':
      return <AppearancePane />
    case 'terminal':
      return <TerminalPane />
    case 'voice':
      // SettingsVoiceSection renders its own leading divider + "Voice dictation" head, and renders
      // nothing at all when window.api.voice is absent (non-electron test runtimes).
      return <SettingsVoiceSection />
    case 'llm':
      return <LlmPane />
    case 'orchestration':
      return <OrchestrationPane onClose={onClose} />
    case 'mcp':
      return <McpPane />
    case 'about':
      return <AboutPane />
  }
}
