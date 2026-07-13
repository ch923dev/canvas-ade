/**
 * LLM key-store + Jarvis brain IPC wiring, extracted from index.ts for the max-lines
 * ratchet (the #340 ↔ J3 umbrella merge put index.ts over the 702 pin; voiceBoot /
 * deepLinkBoot precedent). Pure wiring, no behavior. The two registrations live
 * together because they share the same key slot: Jarvis reads the llmKeyStore
 * `anthropic` entry (llmDataDir + the shared safeStorage encryptor) that the LLM
 * handlers persist. The per-turn workspace manifest reads the AppModel in-process via
 * the lazy MCP boot — ensureMcp is a whenReady-scope closure in index.ts, so it is
 * injected rather than imported (first Jarvis turn pays the one-time ensureMcp, like
 * first orchestration).
 */
import type { BrowserWindow, IpcMain } from 'electron'
import type { AppModel } from './appModel'
import { registerJarvisHandlers, type JarvisIpcDeps } from './jarvisIpc'
import { registerLlmHandlers } from './llmIpc'

interface LlmJarvisBootDeps {
  llmDataDir: string
  llmEncryptor: JarvisIpcDeps['encryptor']
  /** MAIN's getCurrentDir — history keying (null = no project). */
  getCurrentDir: JarvisIpcDeps['getProjectKey']
  /** The memoized lazy MCP boot from index.ts (M11). */
  ensureMcp: () => Promise<{ describeApp(): Promise<AppModel> } | null | undefined>
}

export function wireLlmJarvis(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: LlmJarvisBootDeps
): void {
  registerLlmHandlers(ipcMain, getWin, deps.llmDataDir, undefined, deps.llmEncryptor)
  // Jarvis J3: the voice-brain session. Key = the llmKeyStore `anthropic` slot (same
  // encryptor as the LLM handlers above).
  registerJarvisHandlers(ipcMain, getWin, {
    getUserData: () => deps.llmDataDir,
    encryptor: deps.llmEncryptor,
    getProjectKey: deps.getCurrentDir,
    getAppModel: async () => {
      try {
        return (await deps.ensureMcp())?.describeApp() ?? null
      } catch {
        return null
      }
    }
  })
}
