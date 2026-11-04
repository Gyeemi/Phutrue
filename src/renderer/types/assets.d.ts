/**
 * Asset module declarations.
 *
 * esbuild's `dataurl` loader turns these imports into strings at build time.
 * The default React 19 JSX runtime does not expose a global `JSX` namespace, so
 * the return type is React.JSX.Element.
 */
declare module '*.png' {
  const dataUrl: string;
  export default dataUrl;
}
declare module '*.svg' {
  const dataUrl: string;
  export default dataUrl;
}
