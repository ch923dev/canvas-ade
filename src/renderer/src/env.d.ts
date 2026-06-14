/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** SPIKE (feat/preview-offscreen-spike): '1' routes Browser previews through the
   *  offscreen-render → <canvas> path instead of the native WebContentsView. */
  readonly VITE_PREVIEW_OSR?: string
}
