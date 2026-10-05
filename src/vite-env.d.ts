/// <reference types="vite/client" />

/** package.json version, set by vite.config.ts `define`. */
declare const __APP_VERSION__: string;

/** The trade-history schemas' validators, precompiled by build/validators-plugin.ts. */
declare module "virtual:tj-validators" {
  import type { ValidateFn } from "./core/schema-names";
  export const fills: ValidateFn;
  export const overrides: ValidateFn;
  export const config: ValidateFn;
  export const symbols: ValidateFn;
  export const trades: ValidateFn;
}

/** True only in the public demo build (`vite build --mode demo`); false in every real build, so demo code is dropped. */
declare const __TJ_DEMO__: boolean;

/** The demo passphrase, in the `npm run preview:demo` build only; null in every real build. */
declare const __TJ_DEMO_PASSPHRASE__: string | null;
