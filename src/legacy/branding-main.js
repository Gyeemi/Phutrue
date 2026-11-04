/**
 * RETIRED ENTRY POINT — DO NOT USE.
 *
 * This was the branding-era main process. It shipped a single `data:text/html`
 * document containing the logo, the wordmark and "by Baraily Inovex", built so
 * the branding integration (window icon, taskbar identity, tray, toast icon)
 * could be proved before any real UI existed.
 *
 * It was superseded by the TypeScript main process in `src/main/` and kept here
 * for reference.
 *
 * ## Why it now throws instead of rendering
 *
 * It caused a real, expensive false trail. On a Windows machine whose Electron
 * launch resolved to this file instead of `dist/main/index.js`, the app showed a
 * centred logo and nothing else. That is visually almost identical to a
 * renderer that failed to initialise, so the investigation went looking for
 * Content-Type bugs, stale bundles and display faults — none of which existed.
 *
 * The decisive evidence, in hindsight, was this file's own fingerprint:
 *
 *   - the window's only document was a `data:text/html` URL;
 *   - its only subresource was an inlined `data:image/png`;
 *   - it never loaded `app://anything`, so no `index.html`, `app.js` or
 *     `app.css` request ever appeared;
 *   - it never touched the application menu, so Electron's default
 *     File/Edit/View/Window bar stayed visible;
 *   - it registered no `did-fail-load` handler, so the DevTools console stayed
 *     blank and gave no hint anything was wrong.
 *
 * A page that renders successfully while being the wrong page is the worst kind
 * of failure: everything looks healthy. Failing loudly is strictly better than
 * failing convincingly, so this module now throws on load.
 *
 * `test/entry-point.test.ts` asserts that it throws, and that the packaged entry
 * point is `dist/main/index.js` and never this file.
 */

'use strict';

throw new Error(
  '[phutrue] src/legacy/branding-main.js is a retired entry point and must not ' +
    'be launched. The application entry point is dist/main/index.js (built from ' +
    'src/main/index.ts). If Electron started this file, package.json "main", an ' +
    'electron . invocation, or a packaging config is pointing at the wrong path.'
);
