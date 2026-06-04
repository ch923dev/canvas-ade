/** Renderer-side mirror of main's DEFAULT_MODELS (cheap/fast tier). Kept in sync by hand —
 *  the source of truth is src/main/llmConfig.ts; this avoids a renderer→main import. */
export const DEFAULT_MODELS = {
  openrouter: 'google/gemini-2.5-flash',
  openai: 'gpt-4.1-nano',
  anthropic: 'claude-haiku-4-5',
  local: 'local-model'
} as const
