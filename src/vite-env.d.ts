/// <reference types="vite/client" />

/** package.json version, set by vite.config.ts `define`. */
declare const __APP_VERSION__: string;

/** The demo passphrase, in the `npm run preview:demo` build only; null in every real build. */
declare const __TJ_DEMO_PASSPHRASE__: string | null;
