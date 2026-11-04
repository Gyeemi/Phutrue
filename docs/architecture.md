# Phutrue — Architecture

Status: **in progress**. This document is the implementation contract; it is
updated as milestones land. Only verified, implemented behaviour is described
as done.

- Application: Phutrue
- Developer: Baraily Inovex
- Platform: Windows 10/11 x64
- Framework: Electron 45.2.1 (bundles Node 24.22.1, Chromium 156)
- Installer: NSIS `.exe` via electron-builder 26

---

## 1. Non-negotiable constraints

These are settled and are not revisited without a documented reason:

| Constraint | Implementation |
| --- | --- |
| `contextIsolation: true` | All windows |
| `sandbox: true` | All windows |
| `nodeIntegration: false` | All windows |
| `webSecurity: true` | Never disabled, anywhere |
| Renderer has no `fs`, `child_process`, `shell`, or `ipcRenderer` | Only `contextBridge` surface |
| Every IPC request validated | zod schema per channel |
| Secrets never in renderer | Main process only, encrypted at rest |
| No plaintext credentials in SQLite | DPAPI-wrapped blob |
| Email HTML sanitized before render | `sanitize-html`, main process |
| Remote content blocked by default | CSP + sanitizer `img` source rules |
| Restrictive CSP | `default-src 'none'`, explicit allow-list |
| No arbitrary navigation / new windows | `will-navigate` + `setWindowOpenHandler` deny |
| Branding preserved | `assets/generated` untouched |

---

## 2. Process layout

```
┌──────────────────────────────────────────────────────────────┐
│ MAIN (Node, full privilege)                                  │
│  · window lifecycle        · typed IPC router (zod-validated) │
│  · SQLite (node:sqlite)    · secrets (safeStorage/DPAPI)      │
│  · IMAP/SMTP/OAuth          · sync scheduler + backoff        │
│  · MIME build/parse         · HTML sanitization               │
└───────────────▲──────────────────────────┬───────────────────┘
                │ contextBridge (allowlist) │ structured-clone
┌───────────────┴──────────────────────────▼───────────────────┐
│ PRELOAD (sandboxed, isolated world)                          │
│  · exposes `window.phutrue` — an explicit, typed method set   │
│  · contains NO business logic, NO ipcRenderer passthrough     │
└───────────────▲──────────────────────────────────────────────┘
                │ window.phutrue.*
┌───────────────┴──────────────────────────────────────────────┐
│ RENDERER (React 19, no Node)                                 │
│  · UI only. Holds no secrets, no tokens, no raw message HTML  │
└──────────────────────────────────────────────────────────────┘
```

The renderer is served over a **custom `app://` protocol**, not `file://` and
not a `data:` URL. This gives the page a real, stable origin, which makes a
strict CSP meaningful and avoids the class of subresource-blocking bug that
already bit the branding screen.

---

## 3. Directory layout

```
src/
├── shared/               # imported by main, preload AND renderer
│   ├── models.ts         # domain types
│   ├── ipc.ts            # channel names + request/response types
│   └── result.ts         # Result<T, E> — no exceptions across IPC
├── main/
│   ├── index.ts          # entry point
│   ├── windows.ts        # BrowserWindow factory + hardening
│   ├── protocol.ts       # app:// registration
│   ├── ipc/
│   │   ├── router.ts     # typed, zod-validated dispatch
│   │   └── handlers/     # one module per domain
│   ├── db/
│   │   ├── database.ts   # node:sqlite wrapper, WAL, migrations
│   │   ├── migrations/   # ordered, forward-only
│   │   └── repos/        # accounts, folders, messages, drafts, settings
│   ├── secrets/          # safeStorage wrapper (DPAPI on Windows)
│   ├── mail/
│   │   ├── provider.ts   # EmailProvider interface
│   │   ├── imap/         # imapflow adapter
│   │   ├── smtp/         # nodemailer adapter
│   │   ├── oauth/        # Gmail, Microsoft
│   │   ├── mime.ts
│   │   └── sanitize.ts
│   └── sync/             # scheduler, backoff, cancellation
├── preload/
│   └── index.ts          # contextBridge allowlist
└── renderer/
    ├── index.html
    ├── main.tsx
    ├── app/
    ├── components/
    ├── state/
    └── styles/
```

---

## 4. Key technical decisions

### 4.1 SQLite via `node:sqlite`, not a native module

Electron 45.2.1 ships **Node 24.22.1**, which includes the built-in
`node:sqlite` module (SQLite 3.51.3). Using it means:

- **zero native modules**, so no `electron-rebuild`, no ABI mismatch, no
  node-gyp toolchain on the build machine, no prebuilt-binary download;
- the same code runs under `vitest` on plain Node 22+ without an Electron host.

Verified available: `DatabaseSync`, `StatementSync`, `backup`. This is the
single biggest packaging risk removed.

### 4.2 esbuild, not Vite

One bundler for both processes, no dev server, no HMR machinery. Rationale:

- The renderer must run under `app://` in production and in tests; a dev HTTP
  server introduces a second origin and a second CSP.
- esbuild produces the main bundle, preload bundle and renderer bundle in
  well under a second, with no config cascade.
- Fewer transitive dependencies in the build path.

Trade-off accepted: no hot module replacement. A `--watch` rebuild plus app
restart is used instead.

### 4.3 TypeScript everywhere, strict

`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. The IPC
boundary is typed end-to-end from a single `shared/ipc.ts` source of truth, so a
renderer cannot call a channel that does not exist and a handler cannot change a
response shape without the renderer failing to compile.

### 4.4 Secrets: `safeStorage` (DPAPI on Windows)

`safeStorage.encryptString()` uses DPAPI with the user's Windows credentials, so
the ciphertext is bound to that user account on that machine. Only the opaque
ciphertext is stored in SQLite; plaintext lives in memory only while a
connection is open.

`safeStorage.isEncryptionAvailable()` is checked at startup. If unavailable
(rare, e.g. Linux without a keyring), Phutrue **refuses to persist secrets** and
reports it in Settings rather than silently writing plaintext.

### 4.5 Result types across IPC

Handlers return `{ ok: true, value } | { ok: false, error }`. Exceptions never
cross the process boundary, so a renderer cannot leak stack traces and cannot
crash the main process by not catching.

### 4.6 Synchronization

Provider-agnostic. `EmailProvider` exposes `listFolders`, `fetchMessages`,
`fetchMessage`, `setFlags`, `moveMessage`, `deleteMessage`, `appendDraft`,
`send`. IMAP implementation uses `imapflow` (IDLE where supported, UIDVALIDITY +
UIDNEXT cursors, per-folder sync state). Backoff is exponential with jitter and
respects provider rate limits.

---

## 4.7 Diagnostics and Windows verification

Four claims in this document cannot be proven outside a real Electron process on
Windows: that `node:sqlite` opens the database, that the user-data folder is
writable and migrated, that DPAPI credential encryption genuinely works, and that
the preload bridge answers. A fifth — that the packaged `app://` handler reads
the asar-unpacked renderer — needs a packaged build.

To make those verifiable rather than assumed, the app exposes a development-aid
diagnostics screen (`app:diagnostics`), reachable from the boot screen.

Design constraints that shaped it:

- **The report is treated as public.** It is rendered on screen and can be copied
  into a bug report, so `src/main/diagnostics/index.ts` never returns a secret,
  and reduces any thrown error to its class name — a `node:sqlite` error can quote
  the failing SQL and its bound parameters, and a `safeStorage` error can quote
  the ciphertext.
- **The credential check proves encryption, not availability.** It encrypts a
  32-byte random canary, asserts the ciphertext differs from the plaintext, then
  decrypts and compares. A "silent plaintext fallback" would show up as a failure
  rather than a pass. Nothing derived from the canary is returned.
- **Paths are redacted.** The report shows `C:\Users\<user>\...` so it stays
  recognisable without disclosing a Windows account name.
- **The logic is separated from the platform.** `runDiagnostics` takes injected
  dependencies, so all of it — including every redaction rule — is tested under
  plain Node. Only `src/main/diagnostics/electron.ts` touches `node:fs`,
  `node:sqlite` and `safeStorage`, and that is the part requiring Windows.
- **The bridge check lives in the renderer.** The main process cannot observe the
  context boundary from the outside, so the renderer performs it and merges its
  result into the report via the shared `summarise()` helper.
- **Clipboard goes through main.** The window denies every permission request,
  including `clipboard-write`, so `navigator.clipboard` is unavailable by design.
  Copying therefore uses `app:copyToClipboard`, a bounded (≤64 KiB) channel —
  which preserves the permission posture rather than loosening it.

**Deliberately not done in this checkpoint:** no OAuth, IMAP, SMTP, sync or any
other email functionality. The diagnostics screen exists so the foundation can be
proven before those protocols are layered on.

The tester-facing checklist is **[docs/windows-verification.md](windows-verification.md)**.

## 5. Milestones and current status

Status as of the latest checkpoint. "Verified" means covered by tests or checks
that were actually executed; it does not mean the feature was exercised by hand.

| # | Milestone | Acceptance | Status |
| --- | --- | --- | --- |
| M1 | Architecture foundation, build, IPC skeleton | `npm run build` produces main/preload/renderer bundles; app shell renders; typecheck clean | **Verified** |
| M2 | Database, migrations, secure IPC, settings | Schema created and migrated; settings persist across restarts; IPC rejects malformed input | **Verified** — storage, migrations, repos, secret store and validated IPC. The Settings *screen* is not built. |
| M3 | Account setup and authentication | IMAP/SMTP validation against a live test server; OAuth flows wired; secrets encrypted | **Not started** — the account repository and schema exist; no mail service, no OAuth, no UI |
| M4 | Inbox, folders, message reading | Real folders and messages listed; reading pane renders sanitized HTML | **Not started** |
| M5 | Compose, drafts, sending, attachments | Send via SMTP; drafts recovered; attachments round-trip | **Not started** |
| M6 | Sync, search, advanced operations | Incremental sync, full-text search, move/flag/delete | **Not started** — FTS5 index and UIDVALIDITY handling exist at the database layer only |
| M7 | Testing, security hardening, installer | Full suite green; NSIS installer built and smoke-tested | **Not started** |

Dependencies: M2 → M3 → M4 → M5 → M6; M7 runs continuously and closes at the end.

### What exists but is not yet exercised by the app

These are real implementations with test coverage, but nothing in the UI reaches
them yet:

- `src/main/db/**` — schema, migrations, transactions, and repositories for
  accounts, folders, messages, drafts and settings. Covered by `test/database.test.ts`
  and `test/repos.test.ts`.
- `src/main/secrets/store.ts` — DPAPI-backed secret store with a canary probe.
  Its contract is exercised only through the pieces that can run without the
  Electron binary; `safeStorage` itself cannot be tested here (see §7).
- `src/main/ipc/schemas.ts` — a schema for every one of the **26** declared
  channels. Handlers are wired for **six** (`app:info`, `app:diagnostics`,
  `app:copyToClipboard`, `settings:get`, `settings:update`, `accounts:list`); the
  other twenty return a deliberate "This feature is not available in this build"
  `INTERNAL` result from the router, which a test pins.

### Test inventory at this checkpoint

| File | Tests | Covers |
| --- | --- | --- |
| `test/database.test.ts` | 13 | schema, migrations, transactions, WAL, FTS triggers, integrity |
| `test/repos.test.ts` | 25 | repository behaviour, FTS operator injection, pagination, UIDVALIDITY reset, draft round-trip |
| `test/ipc-validation.test.ts` | 34 | every channel has a schema and vice versa; bounds; cross-field account rules |
| `test/ipc-router.test.ts` | 18 | allowlist, sender authorization, validation, error and log hygiene |
| `test/protocol.test.ts` | 24 | `app://` path containment, including Windows trailing-dot/space/ADS cases |
| `test/renderer-shell.test.tsx` | 13 | the shell renders in every state; no blank screen; theme applied |
| `test/diagnostics.test.ts` | 48 | every diagnostics check, every degraded path, and sentinel-injection proof that no secret reaches the report |
| `test/diagnostics-view.test.tsx` | 11 | the renderer half of diagnostics: bridge present, no undocumented members, clipboard routed through main |
| `test/csp.test.ts` | 31 | CSP restrictiveness, header/meta agreement, `app://` loading assumptions |

Total: **217 tests in 9 files.**

Risks tracked in §7.

---

## 6. Testing strategy

- **Unit** (vitest, plain Node): MIME build/parse, sanitizer, DB repositories,
  migrations, validation schemas, sync cursor maths, backoff.
- **IPC**: router rejects unknown channels, malformed payloads, and calls from
  an unregistered sender.
- **Integration**: account setup and message operations against a local mock
  IMAP/SMTP server — no real credentials in CI.
- **UI**: the shell is rendered under jsdom against a mocked IPC bridge, so
  the blank-screen failure mode is caught in CI. Full workflow tests need the
  real app and belong with M4–M5.
- **Packaging**: NSIS build + install/launch/uninstall smoke test on Windows.

### What this environment cannot execute

Recorded here rather than quietly omitted, because a green suite that skipped
something is misleading:

| Not executed | Why |
| --- | --- |
| Launching the Electron app | The Electron binary cannot be downloaded here (`unable to verify the first certificate`, and the GitHub release host is not on the allowlist). There is also no `DISPLAY`. |
| Rendering in a real Chromium | No system browser and no downloadable browser binary. The shell is verified under jsdom instead, which proves the React tree renders but **not** that the CSS, the `app://` origin or the CSP behave as intended in Chromium. A CSP policy that rejects a resource produces a blank or unstyled window, and that class of fault would be invisible to this suite — which is exactly why `require-trusted-types-for 'script'` is not enabled (see `src/main/windows.ts`). |
| `safeStorage` / DPAPI round-trip | Requires a running Electron app on Windows. The store is written to fail closed, and its unavailable path is unit-testable, but the encrypt path is not covered here. The diagnostics screen exists precisely to close this gap — on Windows. |
| NSIS installer build | Requires the Electron binary and the NSIS toolchain from a non-allowlisted host. |
| Install / launch / uninstall on Windows | No Windows host. No claim is made that an installer was built or smoke-tested. |

---

### Packaging layout

`main` in `package.json` is `dist/main/index.js`, which the build emits. The
installer includes only `dist/**` (minus sourcemaps) and `package.json` — the
`src/` tree is deliberately excluded so the renderer cannot reason about the
main-process sources.

The renderer is listed under `asarUnpack` so the `app://` handler reads ordinary
files rather than paths inside the asar archive. Those reads are the one part of
the packaging story that cannot be exercised here.

## 7. Known risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| OAuth requires user-registered client IDs | Gmail/Microsoft setup cannot be end-to-end tested without them | Ship the flow; document that a client ID must be configured; test with mock token endpoints |
| No Windows host in this environment | Installer cannot be built or smoke-tested here | Structure/typecheck everything; run `npm run dist` on Windows; state clearly what is unverified |
| Provider rate limits | Aggressive sync could throttle accounts | Per-account scheduler with backoff and a minimum interval |
| `safeStorage` unavailable | Cannot persist secrets | Detect at startup, refuse plaintext fallback, surface in Settings |
| `node:sqlite` is Node-version-sensitive | Older Electron would lack it | Pinned to Electron 45.2.1; a failed open is reported and the app quits rather than running without storage |
| `minimatch` ReDoS (GHSA-g3hv-75wg-m249) via electron-builder's toolchain | Build-time only: 15 moderate advisories in `@electron/asar`, `app-builder-lib`, `ejs`, `jake`, `temp` | `npm audit --omit=dev` reports **0** vulnerabilities, so nothing vulnerable ships in the app. The only offered fix downgrades electron-builder to 20.x, which is a breaking change and would be downgrading a build tool to silence a dev-only advisory — deliberately not applied |
| Externalled mail libraries are not yet proven to be packaged | `scripts/build.mjs` marks `imapflow`, `nodemailer`, `mailparser` and `sanitize-html` external, so they must be resolved from `node_modules` at runtime | Nothing imports them yet, so today's build is unaffected. **Before M3 ships, confirm the packaged app resolves them** — electron-builder normally includes production dependencies, but `files` in `electron-builder.yml` restricts the app tree, and this cannot be verified without building an installer |
