/// <reference types="vite/client" />

// Phase 1 accounts: build-time gate constant (electron.vite.config.ts renderer `define`).
// true → hard-gate the app behind <SignInView/>; default false → sign-in optional (local-first).
declare const __REQUIRE_ACCOUNT__: boolean
