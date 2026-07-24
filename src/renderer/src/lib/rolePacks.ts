/**
 * Re-export shim — the role-pack module moved to `src/shared/rolePacks.ts` at orchestration S1
 * so MAIN's swarm chat loop (swarmTools) can compose role briefs without importing renderer
 * code (the src/shared cross-process leaf pattern — boardTitle/closeGuardTypes precedent).
 * Every existing `import { … } from '../lib/rolePacks'` consumer is unchanged.
 */
export * from '../../../shared/rolePacks'
