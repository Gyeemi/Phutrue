# Phutrue — Branding & Windows Assets

Implementation record for the official Phutrue logo and the Windows branding
assets derived from it.

- **Application:** Phutrue
- **Developer:** Baraily Inovex
- **Repository:** https://github.com/Gyeemi/Phutrue
- **Scope of this document:** branding assets and the pipeline that produces
  them. No mail, account, database, sync or UI code is covered here.

---

## 1. The master logo

| Property | Value |
| --- | --- |
| Filename | `phutrue-logo.png` |
| Repository path | `assets/brand/phutrue-logo.png` |
| **SHA-256** | `b92315349cecc6124389abc8a59782337f68d40bf4bed2850b92a6ad07160a95` |
| Byte length | 694,426 |
| Format | PNG, 8-bit RGBA (colour type 6), non-interlaced |
| Dimensions | 961 × 786 px |
| Aspect ratio | 1.222646 : 1 |
| Alpha | Straight (non-premultiplied); 42.34% clear / 57.38% partial / 0.28% opaque |
| Colour metadata | sRGB, gAMA 0.4546, 96 DPI, no embedded ICC profile |

This file is the **only** source of brand artwork in the repository. It is
copied byte-for-byte from the official upload and is never written to by the
pipeline — the pipeline reads it and verifies its checksum before doing
anything else. If the checksum ever changes, generation aborts.

The file is intentionally **not** in `assets/generated/`, so a regeneration
can never overwrite it.

---

## 2. Directory structure

```
assets/
├── brand/
│   └── phutrue-logo.png          ← master. Read-only. Never regenerated.
└── generated/                     ← wholly owned by `npm run assets`
    ├── manifest.json              ← what was produced, and how
    ├── icon.ico                   ← multi-resolution application icon
    ├── installerSidebar.bmp       ← NSIS welcome/finish sidebar (164×314)
    ├── uninstallerSidebar.bmp     ← NSIS uninstaller sidebar (164×314)
    ├── installerHeader.bmp        ← NSIS header banner (150×57)
    └── png/
        ├── icon-16.png … icon-1024.png   ← 12 square transparent icons
```

Everything under `generated/` is disposable: delete it and `npm run assets`
recreates it byte-for-byte. Nothing there should be hand-edited.

---

## 3. Generated assets

### Square PNG icons — transparent, alpha preserved

| File | Dimensions | Bytes | Artwork (w×h) | Padding left/top |
| --- | --- | --- | --- | --- |
| `png/icon-16.png` | 16 × 16 | 695 | 14.4 × 11.8 | 0.78 / 2.09 |
| `png/icon-20.png` | 20 × 20 | 954 | 18.0 × 14.7 | 1.00 / 2.62 |
| `png/icon-24.png` | 24 × 24 | 1,200 | 21.6 × 17.7 | 1.18 / 3.14 |
| `png/icon-32.png` | 32 × 32 | 1,908 | 28.8 × 23.6 | 1.56 / 4.19 |
| `png/icon-40.png` | 40 × 40 | 2,669 | 36.0 × 29.5 | 2.00 / 5.23 |
| `png/icon-48.png` | 48 × 48 | 3,636 | 43.2 × 35.4 | 2.36 / 6.27 |
| `png/icon-64.png` | 64 × 64 | 5,730 | 57.6 × 47.1 | 3.13 / 8.38 |
| `png/icon-96.png` | 96 × 96 | 10,853 | 86.3 × 70.7 | 4.83 / 12.67 |
| `png/icon-128.png` | 128 × 128 | 17,478 | 115.3 × 94.3 | 6.25 / 16.75 |
| `png/icon-256.png` | 256 × 256 | 55,884 | 230.5 × 188.5 | 12.50 / 33.50 |
| `png/icon-512.png` | 512 × 512 | 181,710 | 461 × 377 | 25 / 67 |
| `png/icon-1024.png` | 1024 × 1024 | 599,160 | 922 × 754 | 51 / 135 |

### Application icon — `icon.ico` (137,124 bytes)

| Size | Encoding | Purpose |
| --- | --- | --- |
| 16, 20, 24, 32, 40, 48 | 32-bit BGRA DIB + AND mask | Shell, tray, small taskbar, shortcut overlays |
| 64, 96, 128, 256 | PNG-compressed | Taskbar at scale, Alt-Tab, Explorer, Add/Remove Programs |

10 entries, all 32bpp, all carrying a full alpha channel. **256 × 256 is the
ICO format's hard ceiling** — the width/height fields are single bytes where 0
means 256 — so no larger entry is possible or attempted.

Small entries are DIB rather than PNG because some installer and legacy
shortcut code paths handle PNG-in-ICO less predictably. Large entries are PNG
because one uncompressed 256×256 DIB alone would be 262,144 bytes.

### NSIS installer artwork — 24-bit BMP, no alpha

| File | Dimensions | Bytes | Artwork | Field colour |
| --- | --- | --- | --- | --- |
| `installerSidebar.bmp` | 164 × 314 | 154,542 | 154 × 126 | `#001050` |
| `uninstallerSidebar.bmp` | 164 × 314 | 154,542 | 154 × 126 | `#001050` |
| `installerHeader.bmp` | 150 × 57 | 25,818 | 65 × 53 | `#001050` |

---

## 4. Design decisions and trade-offs

### 4.1 Positioning — geometric centring, equal padding, 90% coverage

Each square icon places the **whole 961 × 786 canvas** onto a square
transparent canvas at 90% of the width, centred by bounding box, with equal
transparent padding on opposite sides.

**Why the whole canvas and not a trimmed bounding box:** the artwork is
full-bleed — it touches all four edges of the source canvas. There is nothing
to trim, and any crop would clip the left wing tip, the tail or the envelope
corner. The branding rules forbid cropping.

**Why equal padding rather than optical centring.** The mark is asymmetric: its
alpha-weighted centroid sits at (521.4, 489.2) against a bounding-box centre of
(480.0, 392.5) — roughly +41 px right and +97 px down. Forcing that centroid to
the canvas centre is possible, but it requires a large asymmetric gutter. On a
1024 px canvas it would mean 31.6 px of top padding against 220.5 px of bottom
padding. That is a legitimate technique for a logotype set inside a much larger
frame; for an application icon it is not, because Windows composites icons over
taskbar, tray and dialog backgrounds where a 190 px imbalance reads as a
misplaced asset rather than an optical correction.

Equal padding is therefore the more robust rule: it is predictable, it is what
the artwork's own composition implies, and it never depends on reading the
alpha distribution of a particular file. The result is that the mark sits
slightly low-right in its square — visually unnoticeable at 48 px and below, and
consistent across all sizes because every size is generated the same way.

**Why 90% coverage.** 100% would put the artwork hard against the left and right
edges with no margin. 90% leaves 5% per side, which absorbs Windows' own icon
shrinkage in the taskbar and avoids clipping against rounded container corners.
The one consequence to be aware of: at 16 px, 90% coverage leaves only 0.78 px
of padding per side. Antialiasing therefore leaves a faint (≤ 3% alpha) residue
on the border ring — this is correct behaviour, not clipping, and is verified
against an alpha-conservation test (see §7).

### 4.2 Scaling — uniform only

`k` is derived from the width and then applied unchanged to the height, so the
1.222646 ratio is preserved exactly and nothing is ever stretched.

Integer destinations can never land on the true ratio exactly. The pipeline
stages every icon at a supersampled resolution (≥ 512 px), positions it there,
and then area-averages down in a single step. The geometric aspect error from
that staging is **≤ 0.128%** across all twelve sizes.

Measuring the *finished* files with a bounding box is not reliable at 16–20 px,
where the box is only 12–16 px tall and one pixel of quantisation is 8%. The
finishing test is therefore scale-invariant: the alpha-weighted second-moment
ratio of the source (1.23099) is compared against the same statistic on every
output. Uniform scaling leaves that value unchanged, and the measured worst
deviation is **0.279%** — confirming no distortion at any size.

### 4.3 Resampling — premultiplied-alpha area average

The source is being reduced by up to 60× (961 px → 16 px). Two choices matter:

- **Area averaging, not a windowed kernel.** Area averaging is the exact
  integral of the source over each destination pixel. It cannot ring or
  overshoot — a real risk with Lanczos at extreme reductions on high-contrast
  navy outlines — and it is what mipmap generation uses. For a 60× reduction
  this is the highest-fidelity option, not the cheapest.
- **Premultiplied alpha.** This source has 397,974 pixels at alpha 240–254 and
  only 2,118 at a true 255. Averaging un-premultiplied RGB lets the invisible
  colour of near-transparent pixels bleed into visible ones, producing dark or
  coloured fringes on the wing edges over a light taskbar. Averaging
  premultiplied channels and dividing by the averaged alpha is the only correct
  way.

Both are implemented explicitly in `scripts/lib/raster.mjs` with exact
fractional coverage weights, so non-integer ratios produce no seams or
blockiness.

### 4.4 Small sizes — the logo is kept intact, not simplified

**No separate small-size icon identity was created.** At 16/20/24 px the mark is
rendered from the same master as every other size, at full fidelity.

This is a deliberate acceptance of a limitation, and it should be recorded
plainly: the artwork's navy outline is a median 7 px stroke at 961 px wide.
Scaled to 16 px it becomes **0.11 px** — it does not resolve as a line at all,
and only becomes a true 1 px line at roughly 149 px. At 16–24 px the icon
therefore reads as a blue envelope silhouette rather than as a dove over an
envelope. It remains recognisable as *Phutrue* to anyone who has seen the logo,
but it is not self-explanatory.

The alternative — a simplified or redrawn mark for small sizes — is explicitly
prohibited by the branding rules, and rightly so: it would create a second
visual identity. The honest trade-off is accepted here in favour of brand
fidelity.

### 4.5 Installer artwork — customised, with a sampled field colour

**Customised, not left at NSIS defaults.** Leaving the defaults would ship
another project's stock artwork, which is worse than a generous margin.

NSIS Modern UI bitmaps must be 24-bit BMP and **cannot carry alpha**, so the
logo has to be composited onto an opaque field. The field colour `#001050` is
**sampled from the logo's own deep-navy outline band** — it already exists in
the artwork and was not invented. This satisfies the branding rule that permits
compositing onto a flat background only when the colour comes from the original.

The frames are 164 × 314 (ratio 0.52:1) and 150 × 57 (2.63:1), while the logo is
1.22:1. Whichever dimension binds leaves a large empty field on the other axis.
Filling it would require either cropping the artwork or stretching it, both
forbidden. The generous field is therefore a consequence of the format, not a
design choice, and it is documented rather than hidden. NSIS draws the page
text over the background of the header area, so the sidebar's empty space is
where install progress text appears.

`installerHeaderIcon` is **not** set: it applies only to one-click installers,
and this build is an assisted (wizard) installer — which is also the only mode
in which `installerHeader` and `installerSidebar` render at all.

### 4.6 Committed vs generated at build time — committed

The generated assets are **committed**, not regenerated during packaging.

- A packaging run on a build machine needs no image toolchain, and cannot
  produce different bytes than were reviewed.
- The exact assets that ship are the exact assets that were verified.
- `sharp` stays a dev dependency used only by `npm run assets`.

The cost is a ~1.3 MiB of binary in the repository and the discipline of
re-running the script after a logo change. That is the right trade for a brand
asset.

---

## 5. Packages

| Package | Version | Kind | Why |
| --- | --- | --- | --- |
| `sharp` | 0.35.5 | dev | Reads the master PNG and encodes the PNG icons. Chosen over a pure-JS codec because its libvips backend gives correct premultiplied compositing and fast, well-tested PNG output. |
| `electron` | 45.2.1 | dev | Application runtime. |
| `electron-builder` | 26.18.0 | dev | Produces the NSIS installer and consumes the `.ico`/`.bmp` artwork. |

There are **no production dependencies** at this stage.

ICO packing, BMP encoding and all pixel work are implemented in
`scripts/lib/raster.mjs` rather than pulled from npm. The ICO writer is ~90
lines and the BMP writer ~50; neither is worth a dependency, and owning them
means the output layout is explicit and reviewable. **`png-to-ico` was
evaluated and rejected** for exactly this reason.

`npm audit` reports 15 moderate advisories, all transitive inside
`electron-builder`'s own packaging toolchain (`glob`, `minimatch`, `rimraf`),
none in a production dependency and none reachable at runtime
(`npm audit --omit=dev` → 0 vulnerabilities).

---

## 6. Build configuration

`electron-builder.yml` wires the assets in:

| Setting | Value |
| --- | --- |
| `appId` | `com.barailyinovex.phutrue` |
| `productName` | `Phutrue` |
| `icon` / `win.icon` | `assets/generated/icon.ico` |
| `win.target` | `nsis`, x64 |
| `nsis.oneClick` | `false` (assisted wizard) |
| `nsis.installerIcon` / `uninstallerIcon` | `assets/generated/icon.ico` |
| `nsis.installerSidebar` | `assets/generated/installerSidebar.bmp` |
| `nsis.uninstallerSidebar` | `assets/generated/uninstallerSidebar.bmp` |
| `nsis.installerHeader` | `assets/generated/installerHeader.bmp` |
| `nsis.deleteAppDataOnUninstall` | `false` |

`deleteAppDataOnUninstall: false` is deliberate and ties to a standing
requirement: the uninstaller must not destroy settings, accounts or stored
mail. User data lives in `%APPDATA%\Phutrue`, outside the install directory,
and is never removed unilaterally.

`src/main/main.js` sets `app.setAppUserModelId('BarailyInovex.Phutrue')` before
creating any window. This is what makes the taskbar group under the right
identity and makes Windows attribute toast notifications to Phutrue instead of
to `electron.exe`.

Icon roles are kept distinct rather than reusing one file everywhere:

| Role | File | Reason |
| --- | --- | --- |
| Installer / shortcuts | `icon.ico` | Windows picks the sharpest embedded size |
| Window / Alt-Tab | `png/icon-256.png` | Best compromise at any DPI |
| Tray | `png/icon-32.png` | Small, 1.9 KB, covers 200% scaling |
| Notification | `png/icon-256.png` | Toasts render up to 64 px |

---

## 7. Verification

`npm run assets:verify` re-opens every generated file from disk and decodes its
header **independently of the code that wrote it**, then asserts the branding
rules were honoured. `npm run check:paths` separately resolves every icon
reference in `src/main/main.js`.

**Result: 95 asset checks and 14 path checks pass, 0 failures.**

What is actually proven:

| Check | Method |
| --- | --- |
| Master unchanged | SHA-256 recomputed and compared to the canonical value |
| PNG files intact | Every chunk CRC recomputed; IEND present; no trailing bytes |
| ICO entries correct | Directory parsed; dimensions cross-checked against embedded PNG headers and DIB headers |
| ICO within format limit | No entry above 256 px |
| Transparency preserved | 32bpp + alpha asserted on every ICO entry and PNG icon |
| Installer BMPs correct | 24-bit, BI_RGB, declared size matches actual, pixel data fully accounted for |
| **Nothing clipped** | Alpha-mass conservation: output alpha must equal `source alpha × k²`. Measured error **≤ 0.09%** at every size — a crop or dropped pixels would fall short |
| **Nothing distorted** | Scale-invariant test: alpha-weighted second-moment ratio computed for the source (1.23099) and for every output. A uniformly scaled shape has an identical value at any size, so this needs no tolerance fudge. Worst deviation **0.279%** |
| Nothing stretched | Uniform scale only; installer artwork re-decoded and its ink box measured independently |
| No artwork on the canvas border | Border-ring alpha ≤ 8 (the 16 px sub-pixel residue) |
| Determinism | Two consecutive `npm run assets` runs produced **byte-identical** output for all 17 files |

### Visual inspection

Actual-size renders at 16, 20, 24, 32, 48 and 64 px were composited over
`#F3F3F3` (light taskbar), `#FFFFFF` and `#202020` (dark taskbar) and inspected,
together with the two installer BMPs. Findings are recorded in §4.4.

---

## 8. Reproducing

```bash
npm install            # dev toolchain only
npm run assets         # regenerate every file in assets/generated/
npm run assets:verify  # re-validate all of it
npm run check:paths    # confirm Electron references resolve
npm run assets:check   # assets + verify in one step
```

`npm run assets` is safe to run at any time: it removes and rebuilds
`assets/generated/` from scratch, so a stale or renamed file cannot survive.

---

## 9. Limitations

These are real and should not be assumed away.

1. **No Windows execution was possible.** Nothing here was run on Windows. The
   `.ico`, the BMPs and the NSIS configuration were validated structurally and
   against electron-builder's schema, but how they *look* in Explorer, the
   taskbar, the tray and the installer wizard has not been observed on a
   Windows machine.

2. **The NSIS installer was not built.** `electron-builder --win --x64` loads
   and validates this configuration (confirmed by introducing a deliberate
   typo, which it rejected), but packaging stops at the "download the Electron
   binary" step because the release-asset host is not reachable from this
   sandbox. No `.exe` exists yet. The check can be re-run with `npm run dist`
   on a machine with normal internet access.

3. **The `electron` binary is not installed** in this environment for the same
   reason; `package-lock.json` pins it correctly, so a normal `npm ci` will
   fetch it.

4. **Small icon fidelity is limited by the artwork**, as described in §4.4, not
   by the pipeline.

5. **Code signing is not configured.** Without an Authenticode certificate,
   Windows SmartScreen will warn on first run and the installer will be
   unsigned. This requires a certificate and is a decision for the project
   owner, not something the pipeline can solve.

6. **The installer artwork cannot show the logo large.** With no alpha channel
   available and a frame ratio far from the logo's, a generous flat field is
   unavoidable without cropping or stretching.

---

## 10. Branding rules — compliance

| Rule | Status |
| --- | --- |
| Uniform scaling only | Enforced — `k` derived from width, applied to both axes |
| Geometric positioning and transparent padding | Enforced |
| High-quality resampling | Premultiplied area average, supersampled |
| Conversion to required formats | PNG, ICO, BMP |
| Composite onto a flat background only where the format forbids transparency | Only the three NSIS BMPs; `#001050` sampled from the logo |
| No redrawing or tracing | No vector trace exists; withdrawn earlier and never implemented |
| No replacement logo | Only the original master is used |
| No recolouring or retouching | No colour operation exists in the pipeline |
| No changing proportions | Uniform-scale invariant verified per file, worst deviation 0.279% |
| No cropping or clipping | Full canvas always; alpha-mass conservation verified |
| No distortion at any size | Uniform-scale invariant verified at all 12 sizes, worst deviation 0.279% |
| No outlines, strokes, shadows or decoration | None added |
| No separate small-icon identity | Not created |
| Original kept unchanged, canonical copy in repo, checksum recorded | `assets/brand/phutrue-logo.png`, SHA-256 in this document and in `manifest.json` |
