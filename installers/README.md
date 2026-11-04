# Phutrue Windows installer

| | |
|---|---|
| File | `Phutrue-Setup-0.1.0-x64.exe` |
| Size | 125544396 bytes |
| SHA-256 | `350A463722917B72599983D39E82377DFB10FCE3B6FA24C91D77C47E1000D74A` |
| Commit | `6e8e89b80b08b0e64e5de10da9e73a342c65e2b7` |
| Built and verified on | windows-latest, x64 |
| Verified | the packaged app **and** the silently-installed app both rendered the account setup screen |

## Downloading it

The installer is too large for a git branch (GitHub caps files at 100 MB),
so it is delivered as a workflow artifact:

https://github.com/Gyeemi/Phutrue/actions/runs/41809187701

Open that run and download **phutrue-windows-installer** from the
Artifacts section at the bottom.

## Verifying the download

`powershell
Get-FileHash -Algorithm SHA256 ".\Phutrue-Setup-0.1.0-x64.exe"
`

Compare against the SHA-256 above. They must match exactly.

## Installing

The installer is unsigned, so Windows SmartScreen shows
"Windows protected your PC" on first run. Choose **More info** then
**Run anyway**. This is expected — no Authenticode certificate is
configured yet (see docs/branding.md).

The assisted installer offers a welcome page, install location and
finish page. It installs per-user, so no administrator prompt.

The application then opens on the account setup screen with Gmail and
Microsoft cards. Sign-in itself needs PHUTRUE_GOOGLE_CLIENT_ID or
PHUTRUE_MICROSOFT_CLIENT_ID set, and OAuth has not yet been tested
against a real provider.
