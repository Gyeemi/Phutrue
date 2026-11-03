# Phutrue

A native Windows desktop email client.

- **Application:** Phutrue
- **Developer:** Baraily Inovex
- **Repository:** https://github.com/Gyeemi/Phutrue
- **Platform:** Windows x64 · Electron · NSIS installer

---

## Status

**Branding and asset integration — complete.** No email, account, database,
sync or UI functionality exists yet; that work is a later phase.

## Getting started

```bash
npm install
npm run assets        # regenerate branding assets from the master logo
npm run test          # verify assets and build configuration
```

## Branding assets

The official logo lives at `assets/brand/phutrue-logo.png` and is the single
source of all brand artwork:

```
SHA-256  b92315349cecc6124389abc8a59782337f68d40bf4bed2850b92a6ad07160a95
```

Windows assets are generated from it into `assets/generated/` — a
multi-resolution `.ico`, twelve transparent PNG icons, and three NSIS installer
bitmaps. Nothing is hand-drawn, and the master is never modified.

```bash
npm run assets         # rebuild everything in assets/generated/
npm run assets:verify  # validate dimensions, alpha, aspect and integrity
npm run assets:check   # both, plus Electron path checks
```

See **[docs/branding.md](docs/branding.md)** for the design decisions, the
generation pipeline, verification results and known limitations.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run assets` | Regenerate all branding assets from the master logo |
| `npm run assets:verify` | Validate every generated asset |
| `npm run check:paths` | Check Electron's icon references resolve |
| `npm run test` | Full verification suite |
| `npm start` | Launch the app (requires the Electron binary) |
| `npm run dist` | Build the Windows x64 NSIS installer |

## Requirements

- Node.js 20 or newer
- For `npm run dist`: Windows, or a Linux/macOS host with internet access and
  Wine — electron-builder needs to download the Electron binary and the NSIS
  toolchain.

## Licence

Proprietary. © 2026 Baraily Inovex. All rights reserved.
