# Phutrue Windows installer

| | |
|---|---|
| File | `Phutrue-Setup-0.1.0-x64.exe` |
| Size | 125544113 bytes |
| SHA-256 | `9F842C8C868718BFF86BC53252E5A213C616C958D0886DEDCB6324916724E84F` |
| Commit | `1017cbe974008ee6d23c8b27638e6778e59ad946` |
| Built and verified on | windows-latest, x64 |
| Verified | the packaged app **and** the silently-installed app both rendered the account setup screen |

## Downloading it

The installer is too large for a git branch (GitHub caps files at 100 MB),
so it is delivered as a workflow artifact:

https://github.com/Gyeemi/Phutrue/actions/runs/41802376996

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
