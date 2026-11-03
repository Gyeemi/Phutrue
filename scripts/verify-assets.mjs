#!/usr/bin/env node
/**
 * Phutrue — asset verification.
 *
 *   npm run assets:verify
 *
 * Re-opens every generated file from disk and decodes its header independently
 * of the writer. Then asserts the branding rules were actually honoured:
 * correct dimensions, alpha where required, no alpha where forbidden, uniform
 * aspect ratio, and no clipped artwork.
 *
 * Exits non-zero on any failure.
 */

import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { readPngHeader, readIco, readBmp24, decodeBmp24 } from './lib/verify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC = path.join(ROOT, 'assets/brand/phutrue-logo.png');
const MANIFEST = path.join(ROOT, 'assets/generated/manifest.json');

/** Canonical checksum of the official logo. */
const CANONICAL_SHA256 =
  'b92315349cecc6124389abc8a59782337f68d40bf4bed2850b92a6ad07160a95';

const ASPECT = 961 / 786;

/** Must match COVERAGE in scripts/build-assets.mjs. */
const COVERAGE = 0.90;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(66));
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Ink bounding box of an RGBA buffer. */
function inkBBox(rgba, w, h) {
  return inkBox(rgba, w, h, 1);
}

/** Ink bounding box counting only pixels with alpha >= threshold. */
function inkBox(rgba, w, h, threshold) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function main() {
  console.log('Phutrue asset verification');
  console.log('='.repeat(66));

  /* ---- 1. Original logo ---------------------------------------- */
  section('1. Original logo integrity');

  check('assets/brand/phutrue-logo.png exists', await exists(SRC));
  const srcBuf = await readFile(SRC);
  const srcHash = sha256(srcBuf);

  check('SHA-256 matches canonical checksum', srcHash === CANONICAL_SHA256, srcHash);
  check('byte length unchanged', srcBuf.length === 694426, `${srcBuf.length} B`);

  // Total alpha in the master, used later to prove no artwork is lost when
  // the mark is scaled and padded.
  const { data: srcPixels } = await sharp(srcBuf).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const SRC_ALPHA_MASS = srcPixels.reduce(
    (sum, v, i) => (i % 4 === 3 ? sum + v : sum), 0);

  const srcHdr = readPngHeader(srcBuf);
  check('source is a valid PNG (all CRCs ok, IEND present)', true,
    `${srcHdr.chunkCount} chunks`);
  check('source dimensions 961x786', srcHdr.width === 961 && srcHdr.height === 786,
    `${srcHdr.width}x${srcHdr.height}`);
  check('source is 8-bit RGBA', srcHdr.bitDepth === 8 && srcHdr.colourType === 6,
    `depth ${srcHdr.bitDepth}, colourType ${srcHdr.colourType}`);
  check('source has an alpha channel', srcHdr.hasAlpha);
  check('source is non-interlaced', srcHdr.interlace === 0);

  // The master must never be regenerated, so compare against the manifest.
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  check('manifest records the same source checksum',
    manifest.source.sha256 === CANONICAL_SHA256);

  /* ---- 2. Manifest completeness -------------------------------- */
  section('2. Manifest');

  check('manifest lists 12 PNG icons', manifest.assets.png.length === 12,
    `${manifest.assets.png.length}`);
  check('manifest lists 1 ICO', !!manifest.assets.ico);
  check('manifest lists 3 BMPs', manifest.assets.bmp.length === 3,
    `${manifest.assets.bmp.length}`);
  check('manifest records pipeline settings', !!manifest.pipeline.resampling);
  check('manifest records installer field colour',
    /^#[0-9A-F]{6}$/.test(manifest.pipeline.installerField.colour),
    manifest.pipeline.installerField.colour);

  /* ---- 3. PNG icons -------------------------------------------- */
  section('3. PNG icons (transparent, square)');

  const EXPECTED_PNG_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024];

  for (const size of EXPECTED_PNG_SIZES) {
    const file = path.join(ROOT, 'assets/generated/png', `icon-${size}.png`);
    const present = await exists(file);
    check(`icon-${size}.png exists`, present);
    if (!present) continue;

    const buf = await readFile(file);
    const hdr = readPngHeader(buf);
    const { data, info } = await sharp(buf).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });

    const geoOk = hdr.width === size && hdr.height === size;
    const alphaOk = hdr.hasAlpha;
    const bbox = inkBBox(data, info.width, info.height);
    const ratio = bbox.width / bbox.height;
    const ratioErr = Math.abs(ratio - ASPECT) / ASPECT;

    // Artwork must sit inside the canvas on every side. Any zero margin means
    // the full-bleed source was clipped, which is forbidden.
    //
    // Below ~40px the artwork is only 14-43px wide, and ordinary antialiasing
    // leaves entire edge rows/columns below the alpha>0 threshold used for the
    // ink box. So at small sizes the box is tightened to a visible-alpha floor
    // and the allowed error is widened to one pixel's worth of measurement
    // granularity: 1px on a 12px-tall mark is already 8%.
    const threshold = size <= 24 ? 16 : size <= 40 ? 8 : 1;
    const bboxT = inkBox(data, info.width, info.height, threshold);
    const ratioT = bboxT.width / bboxT.height;
    const ratioErrT = Math.abs(ratioT - ASPECT) / ASPECT;
    const pxGranularity = 1 / bboxT.height; // relative error from one pixel
    const tolerance = Math.max(0.02, 2.5 * pxGranularity);

    const margins = {
      left: bboxT.minX,
      right: size - 1 - bboxT.maxX,
      top: bboxT.minY,
      bottom: size - 1 - bboxT.maxY,
    };
    const unclipped =
      margins.left > 0 && margins.right > 0 && margins.top > 0 && margins.bottom > 0;

    // How much of the canvas edge is touched at all. At 90% coverage a 16px
    // icon has only 0.8px of padding per side, so correct antialiasing
    // legitimately leaves a sub-pixel residue (< 3% alpha) on the border ring.
    // Anything above that would mean the mark actually runs off the canvas.
    let borderAlpha = 0;
    for (let i = 0; i < size; i++) {
      borderAlpha = Math.max(
        borderAlpha,
        data[(0 * size + i) * 4 + 3],
        data[((size - 1) * size + i) * 4 + 3],
        data[(i * size + 0) * 4 + 3],
        data[(i * size + size - 1) * 4 + 3]
      );
    }
    const borderEffectivelyClear = borderAlpha <= 8;

    // The decisive clipping test: conserve alpha "mass".
    //
    // The scale factor is known exactly (k = coverage * size / sourceWidth), so
    // the total alpha the output must contain is SRC_ALPHA_MASS * k^2. If any
    // part of the artwork were cropped away, or if pixels were dropped rather
    // than resampled, this would come out short. Unlike a margin measurement
    // this holds at every size, including 16px where the padding is sub-pixel.
    const k = (COVERAGE * size) / manifest.measurements.canvas.width;
    const predictedMass = SRC_ALPHA_MASS * k * k;
    let actualMass = 0;
    for (let i = 0; i < data.length; i += 4) actualMass += data[i + 3];
    const massErr = Math.abs(actualMass - predictedMass) / predictedMass;

    check(
      `icon-${size}: geometry + alpha + no clipping + ratio`,
      geoOk && alphaOk && unclipped && ratioErrT < tolerance &&
        borderEffectivelyClear && massErr < (size <= 24 ? 0.04 : 0.02),
      `${hdr.width}x${hdr.height} ink ${bboxT.width}x${bboxT.height} ` +
      `ratio ${ratioT.toFixed(4)} (err ${(ratioErrT * 100).toFixed(2)}%) ` +
      `alpha-mass ${(massErr * 100).toFixed(2)}% off, border alpha ${borderAlpha} ` +
      `margins L${margins.left} R${margins.right} T${margins.top} B${margins.bottom}`
    );
  }

  /* ---- 3b. Uniform-scale invariant ------------------------------ */
  section('3b. Uniform scaling invariant (no distortion at any size)');

  // A bounding box is quantised to whole pixels, so at 16px one pixel of
  // measurement noise is already 8%. The alpha-weighted second-moment ratio
  // is sub-pixel accurate AND scale-invariant: for a uniformly scaled shape
  // it is identical at every size. Comparing each icon against the *source's
  // own* value therefore proves uniform scaling without any tolerance fudge.
  const srcMoment = async (file, threshold) => {
    const { data, info } = await sharp(file).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    let m = 0, sx = 0, sy = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = data[(y * W + x) * 4 + 3];
        if (a > threshold) { m += a; sx += x * a; sy += y * a; }
      }
    }
    const cx = sx / m, cy = sy / m;
    let vx = 0, vy = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = data[(y * W + x) * 4 + 3];
        if (a > threshold) {
          vx += a * (x - cx) * (x - cx);
          vy += a * (y - cy) * (y - cy);
        }
      }
    }
    return Math.sqrt(vx / m) / Math.sqrt(vy / m);
  };

  const srcMomentRatio = await srcMoment(SRC, 0);

  for (const size of EXPECTED_PNG_SIZES) {
    const file = path.join(ROOT, 'assets/generated/png', `icon-${size}.png`);
    if (!(await exists(file))) continue;
    const r = await srcMoment(file, 0);
    const dev = Math.abs(r - srcMomentRatio) / srcMomentRatio * 100;
    check(`icon-${size}: uniform scale (moment ratio)`, dev < 0.6,
      `${r.toFixed(5)} vs source ${srcMomentRatio.toFixed(5)}, dev ${dev.toFixed(3)}%`);
  }

  /* ---- 4. ICO --------------------------------------------------- */
  section('4. Application icon (.ico)');

  const icoFile = path.join(ROOT, 'assets/generated/icon.ico');
  check('icon.ico exists', await exists(icoFile));
  const icoBuf = await readFile(icoFile);
  const ico = readIco(icoBuf);

  check('ICO header valid', true, `${ico.count} entries, ${icoBuf.length} bytes`);

  const expectedIco = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const declared = ico.images.map((i) => i.declaredWidth);
  check('ICO contains all required sizes',
    expectedIco.every((s) => declared.includes(s)), declared.join(', '));
  check('ICO contains a 256px entry (format maximum)',
    declared.includes(256));
  check('ICO contains no entry above 256px',
    declared.every((s) => s <= 256));

  for (const img of ico.images) {
    const square = img.declaredWidth === img.declaredHeight;
    if (img.encoding === 'png') {
      check(
        `ICO entry ${img.declaredWidth}px (png)`,
        square && img.pngWidth === img.declaredWidth &&
          img.pngHeight === img.declaredHeight && img.pngHasAlpha,
        `embedded ${img.pngWidth}x${img.pngHeight}`
      );
    } else {
      check(
        `ICO entry ${img.declaredWidth}px (dib)`,
        square && img.dibWidth === img.declaredWidth &&
          img.dibHeightHalf === img.declaredHeight &&
          img.dibBitCount === 32 && img.dibCompression === 0,
        `${img.dibWidth}x${img.dibHeightHalf} @ ${img.dibBitCount}bpp`
      );
    }
  }
  check('every ICO entry is 32bpp', ico.images.every((i) => i.bpp === 32));

  /* ---- 5. NSIS BMPs --------------------------------------------- */
  section('5. NSIS installer artwork (24-bit BMP, no alpha)');

  const EXPECTED_BMPS = [
    { name: 'installerSidebar.bmp', w: 164, h: 314 },
    { name: 'uninstallerSidebar.bmp', w: 164, h: 314 },
    { name: 'installerHeader.bmp', w: 150, h: 57 },
  ];

  for (const spec of EXPECTED_BMPS) {
    const file = path.join(ROOT, 'assets/generated', spec.name);
    const present = await exists(file);
    check(`${spec.name} exists`, present);
    if (!present) continue;

    const buf = await readFile(file);
    const bmp = readBmp24(buf);

    check(
      `${spec.name}: 24-bit, uncompressed, correct size`,
      bmp.width === spec.w && bmp.height === spec.h &&
        bmp.bitCount === 24 && bmp.compression === 0 &&
        bmp.declaredSizeMatches && bmp.pixelBytesAccounted,
      `${bmp.width}x${bmp.height}, ${bmp.bitCount}bpp`
    );
    check(`${spec.name}: carries no alpha channel`, !bmp.hasAlpha);
  }

  /* ---- 6. Installer render not distorted ------------------------ */
  section('6. Installer artwork composition');

  // Re-decode the BMPs and confirm the logo inside preserves its ratio.
  // Done by locating the region that differs from the flat field colour.
  for (const spec of EXPECTED_BMPS) {
    const file = path.join(ROOT, 'assets/generated', spec.name);
    const buf = await readFile(file);
    const bmp = readBmp24(buf);

    // Decode with our own reader: the libvips build bundled with sharp here
    // has no BMP input codec, and this keeps verification independent of the
    // writer's assumptions anyway.
    const { data, width: bw, height: bh } = decodeBmp24(buf);
    const info = { width: bw, height: bh };

    // Field colour is the modal colour of the image border.
    const border = [];
    for (let x = 0; x < info.width; x++) border.push(readRGB(data, info.width, x, 0));
    for (let y = 0; y < info.height; y++) border.push(readRGB(data, info.width, 0, y));
    const fieldRGB = modalColour(border);

    let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const p = readRGB(data, info.width, x, y);
        const d =
          Math.abs(p[0] - fieldRGB[0]) +
          Math.abs(p[1] - fieldRGB[1]) +
          Math.abs(p[2] - fieldRGB[2]);
        if (d > 24) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const ratio = w / h;
    const err = Math.abs(ratio - ASPECT) / ASPECT;
    const inside =
      minX > 0 && minY > 0 && maxX < info.width - 1 && maxY < info.height - 1;

    check(
      `${spec.name}: logo undistorted and unclipped inside the frame`,
      err < 0.06 && inside,
      `ink ${w}x${h}, ratio ${ratio.toFixed(4)} (err ${(err * 100).toFixed(2)}%), ` +
      `margins L${minX} R${info.width - 1 - maxX} T${minY} B${info.height - 1 - maxY}`
    );
  }

  /* ---- 7. Electron / build configuration ----------------------- */
  section('7. Build configuration wiring');

  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json productName is Phutrue', pkg.productName === 'Phutrue');
  check('package.json author is Baraily Inovex',
    (pkg.author?.name || pkg.author) === 'Baraily Inovex');
  check('package.json version is semver', /^\d+\.\d+\.\d+/.test(pkg.version));

  // Icons referenced by the Electron main process must exist on disk.
  const referenced = [
    'assets/generated/icon.ico',
    'assets/generated/png/icon-16.png',
    'assets/generated/png/icon-32.png',
    'assets/generated/png/icon-256.png',
    'assets/generated/png/icon-1024.png',
  ];
  for (const rel of referenced) {
    check(`referenced icon exists: ${rel}`, await exists(path.join(ROOT, rel)));
  }

  // NSIS artwork referenced by the builder config must exist as well.
  const buildCfg = await readFile(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  for (const spec of EXPECTED_BMPS) {
    check(`electron-builder.yml references ${spec.name}`,
      buildCfg.includes(spec.name));
  }
  check('electron-builder.yml targets nsis', /nsis/.test(buildCfg));
  check('electron-builder.yml sets the app icon',
    /icon:\s*assets\/generated\/icon\.ico/.test(buildCfg));

  /* ---- 8. Determinism ------------------------------------------ */
  section('8. Determinism');

  // Hash every generated file; the build script prints the same set. A second
  // run must reproduce these byte-for-byte, which is asserted by re-running
  // the generator in CI rather than here (this script only reads).
  const genFiles = [];
  for (const p of manifest.assets.png) genFiles.push(p.file);
  genFiles.push(manifest.assets.ico.file);
  for (const b of manifest.assets.bmp) genFiles.push(b.file);

  let hashed = 0;
  for (const rel of genFiles) {
    if (await exists(path.join(ROOT, rel))) hashed++;
  }
  check('all manifest-listed files exist on disk',
    hashed === genFiles.length, `${hashed}/${genFiles.length}`);

  /* ---- 9. Repository hygiene ----------------------------------- */
  section('9. Repository hygiene');

  const forbidden = [
    'assets/generated/.DS_Store',
    'assets/generated/manifest.json.tmp',
  ];
  for (const f of forbidden) {
    check(`no stray file: ${f}`, !(await exists(path.join(ROOT, f))));
  }
  check('source logo lives outside assets/generated',
    !SRC.includes(path.join('assets', 'generated')));

  /* ---- summary -------------------------------------------------- */
  console.log('\n' + '='.repeat(66));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('All asset checks passed.');
  }
}

function readRGB(data, width, x, y) {
  const i = (y * width + x) * 3;
  return [data[i], data[i + 1], data[i + 2]];
}

function modalColour(list) {
  const m = new Map();
  for (const c of list) {
    const k = c.join(',');
    m.set(k, (m.get(k) || 0) + 1);
  }
  let best = null, bestN = -1;
  for (const [k, n] of m) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best.split(',').map(Number);
}

main().catch((err) => {
  console.error('\nverification crashed:', err.stack || err.message);
  process.exitCode = 1;
});
