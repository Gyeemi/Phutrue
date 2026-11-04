# Windows verification checkpoint — M1/M2 foundation

This is the checklist for verifying, on a real Windows machine, the things that
**cannot** be verified in the Linux sandbox where this code was written.

It covers the four subsystem claims that only exist inside a running Electron
process on Windows:

1. `node:sqlite` opens the application database and executes a query.
2. The database path is writable and migrations complete.
3. `safeStorage.isEncryptionAvailable()` is reported accurately (and is really
   encryption, not a plaintext fallback).
4. The preload bridge is present and IPC answers.

> **Status of these changes.** Everything described here is committed to the
> branch `arena/a2f9f412-phutrue` only once the authorising commit is made. Until
> then the work exists in the sandbox working tree and `git pull` on your machine
> will **not** fetch it. Confirm `git log --oneline -1` shows a commit newer than
> `ff5fb1c` before starting.

---

## 0. Prerequisites

| Requirement | Notes |
| --- | --- |
| Windows 10 1809+ or Windows 11, x64 | The app targets x64 only |
| Node.js 22.5 or newer | `node:sqlite` is used by the main process and the tests |
| Git | To fetch the branch |
| A clean checkout | The build writes to `dist/` and `release/` |

`npm ci` will download the Electron binary (~120 MB) and, for `npm run dist`,
the NSIS toolchain. Both need unrestricted outbound HTTPS.

---

## 1. Install dependencies

```powershell
git fetch origin
git switch arena/a2f9f412-phutrue
git pull

npm ci
```

`npm ci` is used rather than `npm install` so the lockfile is respected exactly.

**Expected:** completes without errors. Warnings about deprecated transitive
packages are expected and harmless.

---

## 2. Run the automated checks

```powershell
npm run verify
```

This runs, in order: `tsc --noEmit`, the Vitest suite, then asset regeneration,
asset verification and the path checks.

**Expected:**

```
Test Files  9 passed (9)
     Tests  246 passed (246)
RESULT: 95 passed, 0 failed      # assets
RESULT: 15 passed, 0 failed      # paths
```

Three `[ipc] <channel> failed (Error)` lines on stderr are **expected** and come
from `test/ipc-router.test.ts`, which deliberately throws inside two handlers to
prove the router converts a throw into a safe `INTERNAL` result. Those lines are
the log-hygiene check working: note they name the channel and the error *class*
only, never the message. The run still exits 0.

If any of these fail on Windows specifically, that is a real finding — please
capture the output. The suite is platform-neutral by design (`process.platform`
is never asserted as `win32`), so a Windows-only failure would indicate a path
handling or line-ending problem.

---

## 3. Build and launch the app

```powershell
npm run build
npm start
```

`npm start` runs `npm run build && electron .`.

**Expected on launch, within a few seconds:**

- A single window, 1280×860, centred.
- The Phutrue logo, the wordmark "Phutrue", and "by Baraily Inovex".
- A facts table: Version `0.1.0`, Electron `45.x`, Chromium `156.x`, Node `24.x`,
  **Secure storage: available**, Theme `system`.
- A "Run diagnostics" button at the bottom of the card.

**Automatic failure if you see:** a blank white or black window, an unstyled
page, or no window at all. A blank window is the specific failure mode the CSP
and `app://` work exists to prevent — see the checks in step 4.

### 3b. If only the logo is visible

That specific symptom — the logo renders but no wordmark, facts or button —
means React mounted (the logo is a data-URI `<img>` rendered by React) but the
interface around it did not. Work through these in order:

1. **Open DevTools (`Ctrl+Shift+I`) → Console.** A `Refused to execute script
   because its MIME type …` or `Refused to apply style …` message means the
   `app://` handler served a wrong Content-Type, which `nosniff` then rejects.
   That was a real defect, fixed by serving from an explicit allowlist.
2. **Network tab → reload.** `app.js` and `app.css` must both be `200` with
   types `text/javascript` and `text/css`. Anything else confirms point 1.
3. If both are correct and the page is still unstyled, check that
   `dist/renderer/app.css` in the install directory is non-trivial in size —
   an empty stylesheet renders the structure with no layout.

Report the exact console text if any of these applies.

### 3a. Confirm the window is not blank and the console is clean

Open DevTools with `Ctrl+Shift+I`, then the **Console** tab.

**Expected:** no messages at all.

**Automatic failure if you see:**

| Message | Meaning |
| --- | --- |
| `Refused to load the script …` or any `Content Security Policy` violation | The CSP rejects a resource — a blank/unstyled window follows |
| `Failed to load resource: net::ERR_FILE_NOT_FOUND` | The `app://` handler resolved the wrong path |
| `Not allowed to load local resource` | The renderer fell back to `file://` |
| `Unable to load preload script` | The preload did not load; diagnostics will say so |

Then the **Network** tab, one reload (`Ctrl+R`): every request should be
`app://phutrue/...`, and there should be exactly three — `index.html`, `app.css`,
`app.js`, plus the inlined logo (no network request, it is a `data:` URI).

---

## 4. Run the in-app diagnostics

Click **Run diagnostics** on the boot screen.

**Expected: all 7 checks PASS** — six produced by the main process (the
`database.*`, `sqlite.*` and `storage.*` rows) and one produced by the renderer
(`bridge.ipc`, which only the renderer can observe).

| Check | Expected detail | What a failure means |
| --- | --- | --- |
| `database.path` | `C:\Users\<user>\AppData\Roaming\Phutrue\phutrue.db` | The user-data folder is not what electron-builder expects |
| `database.writable` | `wrote and removed a probe file; database is N KB` | Folder permissions, antivirus, or a roaming-profile lock |
| `database.schema` | `v1` | The database predates this build or a migration did not commit |
| `database.integrity` | `quick_check: ok` | Actual file corruption — stop and report immediately |
| `sqlite.query` | `SELECT 1 returned 1` | `node:sqlite` is unavailable in this Electron build |
| `storage.encryption` | `round-trip ok; stored form is ciphertext` | DPAPI unavailable, or — worst case — a silent plaintext fallback |
| `bridge.ipc` | `round trip ok; bridge exposes invoke, on, platform` | The preload failed to load, or the bridge leaks an extra member |

`storage.encryption` is the most important row. This build **refuses to store
credentials** if encryption is unavailable; it never falls back to plaintext.
A passing row proves DPAPI encrypted real bytes and that the ciphertext differed
from the plaintext.

### 4a. Confirm the report contains no secrets

Click **Copy report**, paste into Notepad.

**Expected:** the same text that is on screen — check names, statuses, timings
and the redacted path. The user name appears as `<user>`, not your account name.

**Automatic failure if you see:** any password, token, ciphertext, or your actual
Windows account name in the path.

### 4b. Confirm the database file really exists

```powershell
Get-ChildItem "$env:APPDATA\Phutrue"
```

**Expected:** `phutrue.db` plus `phutrue.db-wal` and `phutrue.db-shm` (WAL mode
leaves these alongside the database). A non-zero file size.

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.APPDATA+'\\Phutrue\\phutrue.db');console.log(d.prepare('SELECT version FROM schema_version').get());console.log(d.prepare('PRAGMA journal_mode').get());console.log(d.prepare('PRAGMA foreign_keys').get());"
```

**Expected:** `{ version: 1 }`, `{ journal_mode: 'wal' }`, `{ foreign_keys: 1 }`.

> `journal_mode` is persisted in the file, so it should read `wal` even from this
> separate process. `foreign_keys` is per-connection, so reading `0` here is
> expected and says nothing about the app — the app sets it to `1` on open.

### 4c. Confirm the renderer cannot reach Node

In DevTools, Console:

```js
typeof require            // "undefined"
typeof process            // "undefined"
typeof window.phutrue     // "object"
Object.keys(window.phutrue)  // ["invoke", "on", "platform"]
```

**Automatic failure if** `require` or `process` is defined, or the bridge exposes
anything beyond those three keys.

### 4d. Confirm navigation is locked down

Paste in Console:

```js
window.open('https://example.com')
```

**Expected:** no new window appears; `example.com` opens in your **default
browser** instead. That is the designed behaviour — approved links go to the OS
browser.

### 4e. Confirm a second launch reuses the window

Launch the app again while it is running (Start menu, or `npm start` in a second
terminal).

**Expected:** the existing window is focused. A second window — or a second copy
of the process — is a single-instance bug.

---

## 5. Package the installer

```powershell
npm run dist
```

This runs the asset checks, the build, then `electron-builder --win --x64`.

**Expected:** `release\Phutrue Setup 0.1.0.exe` (electron-builder's default
`artifactName`; if the name differs, use whatever appears in `release\`). Also
`release\win-unpacked\Phutrue.exe`.

The build must not need the network beyond the initial Electron/NSIS download.

### 5a. Check what actually got packed

```powershell
npx asar list "release\win-unpacked\resources\app.asar" | Select-Object -First 40
```

**Expected:**

- entries under `\dist\main`, `\dist\preload`, and `package.json`
- **no** `\src\` entries (source is deliberately excluded from the installer)
- **no** `.map` files

```powershell
Get-ChildItem "release\win-unpacked\resources\app.asar.unpacked\dist\renderer"
Get-ChildItem "release\win-unpacked\resources\assets\generated\png"
```

**Expected:** `index.html`, `app.js`, `app.css` in the first listing (the renderer
is deliberately unpacked so the `app://` handler reads real files); the generated
PNGs in the second.

---

## 6. Install, launch, uninstall

1. Run `release\Phutrue Setup 0.1.0.exe`.
2. Expect the assisted installer: welcome page, install location, install,
   finish — with the Phutrue installer artwork.
3. Install to the default location, launch from the finish page or the Start
   menu shortcut.
4. **Run diagnostics again inside the installed app.** This is the run that
   matters: it exercises the packaged `app://` handler, the packaged window icon,
   and the packaged database path. All 7 checks must pass.
5. Confirm the taskbar icon and the Start menu shortcut icon are the Phutrue
   logo, not the default Electron icon.
6. Close the app. Confirm the process exits (Task Manager shows no `Phutrue.exe`
   left behind).
7. Uninstall from **Settings → Apps → Installed apps → Phutrue**.

**Expected on uninstall:** the uninstaller asks before removing user data,
because `deleteAppDataOnUninstall` is `false`. Either answer is acceptable, but
the prompt itself is the check — silent deletion of mail data would violate a
standing requirement.

```powershell
Test-Path "$env:APPDATA\Phutrue"
```

**Expected:** `True` if you chose to keep the data.

---

## 7. Report back

Please capture, for anything that fails:

- the failing check id from the diagnostics table, or the exact console message;
- `npm run verify` output if it failed;
- `Get-ChildItem "$env:APPDATA\Phutrue"` output;
- Windows version (`winver`) and whether the profile is roaming.

Do **not** paste a copied diagnostics report that contains anything you have not
looked at first — although the report is designed not to contain secrets, that
guarantee is only worth what the tests backing it are worth.

---

## What has already been verified, and where

Recorded so that a Windows result can be interpreted correctly — this table is
where the sandbox ends and your machine begins.

| Claim | Verified here? | How |
| --- | --- | --- |
| TypeScript compiles clean, strict mode | **Yes** | `tsc --noEmit`, 0 errors |
| 246 automated tests pass | **Yes** | `vitest run` (builds first) |
| Database opens, migrates, queries, FTS works | **Yes**, against `node:sqlite` on Node 22 | `test/database.test.ts`, `test/repos.test.ts` |
| Migrations are idempotent and version-guarded | **Yes** | `test/database.test.ts` |
| IPC rejects unknown channels, untrusted senders, malformed payloads | **Yes** | `test/ipc-router.test.ts`, `test/ipc-validation.test.ts` |
| Diagnostics contents never include a secret | **Yes** | `test/diagnostics.test.ts`, including sentinel-injection cases |
| Diagnostics fails loudly on a broken storage stack | **Yes** | 6 degraded-path tests |
| The shell renders in every state, no blank screen | **Yes**, under jsdom | `test/renderer-shell.test.tsx` |
| `app://` path traversal refused, incl. Windows trailing-dot/space/ADS | **Yes**, as unit tests | `test/protocol.test.ts` |
| CSP directives are restrictive and self-consistent | **Yes**, as source assertions | `test/csp.test.ts` |
| Production bundles build and parse | **Yes** | `node scripts/build.mjs` + `node --check` |
| **Electron actually launches** | **No** | Binary cannot be downloaded here |
| **Chromium accepts the CSP / renders the CSS** | **No** | No browser available |
| **`safeStorage` / DPAPI encrypts for real** | **No** | Needs a real Windows Electron process |
| **The packaged `app://` handler reads asar-unpacked files** | **No** | Needs a packaged build |
| **Installer builds, installs, launches, uninstalls** | **No** | Needs Windows |

The rows marked **No** are exactly what sections 3–6 above exist to establish.
No claim in this repository says any of them has been done.
