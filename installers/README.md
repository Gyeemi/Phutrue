# Phutrue Windows installer

| | |
|---|---|
| File | `Phutrue-Setup-0.1.0-x64.exe` |
| Size | 125544394 bytes |
| SHA-256 | `CEF7F4E21069D018B5F86A1781A549717309391A0567B3097D41E7E6C659815E` |
| Commit | `76d4d8b8bb2bf43cffee71e73e033a8ea8666e4f` |
| Built and verified on | windows-latest, x64 |
| Verified | the packaged app **and** the silently-installed app both rendered the account setup screen |
| Recovery verified | starts normally on a database left behind by a failed migration, setting it aside intact |

## Downloading it

The installer is too large for a git branch (GitHub caps files at 100 MB),
so it is delivered as a workflow artifact:

https://github.com/Gyeemi/Phutrue/actions/runs/41810086236

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
