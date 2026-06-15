/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OS-3 Phase 5: the offscreen-render → <canvas> preview path is the DEFAULT engine.
   *  Set to '0' to fall back to the legacy native WebContentsView path (escape hatch,
   *  removed in 5C). Any other value (incl. unset) = OSR. */
  readonly VITE_PREVIEW_OSR?: string
}
