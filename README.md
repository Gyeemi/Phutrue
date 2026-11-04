# Phutrue

A native Windows desktop email client.

- **Application:** Phutrue
- **Developer:** Baraily Inovex
- **Repository:** https://github.com/Gyeemi/Phutrue
- **Platform:** Windows x64 · Electron · NSIS installer

---

## Status

Phutrue is **under active development**. It is not yet usable as a mail client.

| Milestone | Scope | State |
| --- | --- | --- |
| — | Branding, logo pipeline, installer assets | **Complete** and verified |
| M1 | Architecture, secure IPC, local database, app shell | **Complete** and verified |
| M2 | Database-backed settings, secure credential storage | Partly complete — the storage layer exists; the settings UI does not |
| — | Windows verification checkpoint (diagnostics screen) | **Complete** — awaiting verification on Windows |
| M3 | Account setup and authentication (Gmail/Microsoft OAuth, IMAP+SMTP) | **Not started** |
| M4 | Folders, message list, reading pane | **Not started** |
| M5 | Compose, drafts, send, attachments | **Not started** |
| M6 | Sync, search, advanced operations | **Not started** |
| M7 | Accessibility, security audit, installer validation | **Not started** |

### What actually works today

The application starts, creates a hardened window, and renders a real screen
whose values are read from the main process over the IPC bridge. Behind that
screen the following are implemented and covered by tests:

- A single validated IPC door with a channel allowlist, trusted-sender checks,
  schema validation and non-leaking error handling.
- A local SQLite database (`node:sqlite`) with forward-only migrations, WAL,
  foreign keys, transactions, FTS5 search indexing and typed repositories for
  accounts, folders, messages, drafts and settings.
- Credential storage through `safeStorage` (DPAPI on Windows), storing only
  ciphertext, with **no** plaintext fallback.
- A hardened `BrowserWindow` (context isolation, sandbox, no Node, web security
  on, no webview, navigation and popup lockdown) and a restrictive CSP applied
  as a response header.
- A custom `app://` renderer origin with a traversal-guarded file handler,
  including the Windows-specific trailing-dot/space/ADS cases.
- A CSP verified for internal consistency by test: restrictive on scripts,
  no remote origins, no network egress from the renderer, and identical to the
  `<meta>` fallback.

There is also an in-app **diagnostics screen**, reached from the boot screen. It
is a development aid, not a product feature: it lets a Windows tester confirm
inside the real Electron process that `node:sqlite` works, the database is
writable and migrated, DPAPI credential encryption is genuinely available, and
the preload bridge answers. It never displays or logs a credential, token or
message body. See **[docs/windows-verification.md](docs/windows-verification.md)**
for the full Windows test checklist.

The email feature set — accounts, sync, reading, composing, sending — is **not
implemented yet**. Channels for those operations exist in the contract, and
calling one returns an explicit "not available in this build" error rather than
pretending to work.

## Getting started

```bash
npm install
npm run assets        # regenerate branding assets from the master logo
npm run verify        # typecheck, tests, asset and path checks
npm run build         # bundle into dist/
npm start             # build and launch (needs the Electron binary)
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
| `npm run build` | Bundle main, preload and renderer into `dist/` |
| `npm run build:watch` | Same, rebuilding on change |
| `npm run typecheck` | `tsc --noEmit` over the whole project |
| `npm run test` | Run the Vitest suite |
| `npm run verify` | Typecheck + tests + asset and path checks |
| `npm run assets` | Regenerate all branding assets from the master logo |
| `npm run assets:verify` | Validate every generated asset |
| `npm run check:paths` | Check the entry point and its icon references resolve |
| `npm run assets:check` | Regenerate, verify and path-check the assets |
| `npm start` | Build, then launch Electron (requires the Electron binary) |
| `npm run dist` | Build the Windows x64 NSIS installer into `release/` |

## Requirements

- Node.js 22.5 or newer, because the main process uses `node:sqlite`. Electron
  45 embeds Node 24, which is what the bundles target; the Node requirement
  above is only for running the toolchain and the tests.
- For `npm run dist`: Windows, or a Linux/macOS host with internet access and
  Wine — electron-builder needs to download the Electron binary and the NSIS
  toolchain.

See **[docs/architecture.md](docs/architecture.md)** for the process layout,
the security model and the reasoning behind each technical choice.

## Licence

Proprietary. © 2026 Baraily Inovex. All rights reserved.
