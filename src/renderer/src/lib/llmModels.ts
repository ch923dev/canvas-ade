/** Renderer-side mirror of main's DEFAULT_MODELS (cheap/fast tier). Kept in sync by hand —
 *  the source of truth is src/main/llmConfig.ts; this avoids a renderer→main import. */
export const DEFAULT_MODELS = {
  openrouter: 'google/gemini-2.0-flash-001',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  local: 'local-model'
} as const
