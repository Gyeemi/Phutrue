/**
 * Compile-time constants injected by esbuild (`define` in scripts/build.mjs).
 *
 * Declared here so TypeScript accepts the identifiers. At runtime they are
 * replaced by literals, so this file emits nothing.
 */

/** SHA-256 prefix over the emitted renderer files. `'dev'` in watch mode. */
declare const __BUILD_STAMP__: string;
