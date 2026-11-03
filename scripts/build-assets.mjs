#!/usr/bin/env node
/**
 * Phutrue — Windows branding asset pipeline.
 *
 *   npm run assets
 *
 * Source of truth: assets/brand/phutrue-logo.png
 *
 * This script performs ONLY the operations the branding rules permit:
 * uniform scaling, geometric positioning, transparent padding, high-quality
 * resampling, format conversion, and compositing onto a flat colour sampled
 * from the original (needed only for NSIS BMPs, which cannot carry alpha).
 *
 * It never redraws, recolours, retouches, crops or stretches the artwork.
 *
 * Output is deterministic: same input bytes + same script = same output bytes.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import {
  areaAverageDownsample,
  flattenToRgb,
  writeIco,
  writeBmp24,
  dominantColour,
} from './lib/raster.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC = path.join(ROOT, 'assets/brand/phutrue-logo.png');
const OUT = path.join(ROOT, 'assets/generated');
const OUT_PNG = path.join(OUT, 'png');

/**
 * The exact bytes the pipeline was built against. If the source ever differs,
 * generation aborts rather than silently producing assets from the wrong art.
 */
const EXPECTED_SHA256 =
  'b92315349cecc6124389abc8a59782337f68d40bf4bed2850b92a6ad07160a95';

/* ------------------------------------------------------------------ *
 * Design constants — see docs/branding.md for the reasoning
 * ------------------------------------------------------------------ */

/** Fraction of the square canvas the artwork's width occupies. */
const COVERAGE = 0.90;

/**
 * Fraction of the tighter NSIS frame dimension the artwork fills.
 *
 * These frames are 164x314 (0.52:1) and 150x57 (2.63:1) - neither is close to
 * the logo's 1.22:1 - so whichever dimension binds leaves a large empty field
 * on the other axis. Cropping or stretching to fill it is forbidden, and a
 * taller/narrower mark does not exist, so the field is necessarily generous.
 * 0.94 is as large as the artwork can go while keeping a visible margin that
 * stops the wing tips from touching the frame edge.
 */
const NSIS_COVERAGE = 0.94;

/** Every square icon size produced. 256 is the ICO format ceiling. */
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024];

/** Sizes packed into the .ico. 256 is the format's maximum entry. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** Entries at or above this size are PNG-compressed inside the .ico. */
const ICO_PNG_THRESHOLD = 64;

/** NSIS Modern UI 2 / electron-builder bitmap dimensions. */
const NSIS = {
  sidebar: { w: 164, h: 314 },
  header: { w: 150, h: 57 },
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const log = (...a) => console.log(...a);

function bytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

/**
 * Render the source onto a transparent square canvas at high quality.
 *
 * Renders through a supersampled staging canvas (>= 512px) and then area-
 * averages down to the requested size. This matters for two reasons:
 *
 *  1. Integer pixel dimensions can never represent the artwork's 1.22265 ratio
 *     exactly. Staging at >=512px keeps the rounding error near 0.01%, so the
 *     final small icon is not visibly distorted.
 *  2. Positioning at the staging resolution gives sub-pixel accurate padding,
 *     and the single final box filter integrates the fractional edge coverage,
 *     which is what produces clean antialiasing at 16-32px instead of a
 *     staircase.
 */
function renderSquare(src, sw, sh, side, coverage) {
  const SS = Math.max(512, side);
  const F = Math.max(1, Math.ceil(SS / side));
  const big = side * F;

  const k = (coverage * big) / sw;
  const drawW = Math.max(1, Math.round(sw * k));
  const drawH = Math.max(1, Math.round(sh * k));

  const scaled = areaAverageDownsample(src, sw, sh, drawW, drawH);

  const canvas = Buffer.alloc(big * big * 4); // zero-filled = transparent
  const ox = Math.floor((big - drawW) / 2);
  const oy = Math.floor((big - drawH) / 2);
  for (let y = 0; y < drawH; y++) {
    const from = y * drawW * 4;
    const to = ((oy + y) * big + ox) * 4;
    scaled.copy(canvas, to, from, from + drawW * 4);
  }

  const out = F > 1 ? areaAverageDownsample(canvas, big, big, side, side) : canvas;

  return {
    rgba: out,
    // Reported for verification: how far from the true ratio this size landed.
    aspectError: Math.abs(drawW / drawH - sw / sh) / (sw / sh),
    // Convert staging-canvas coordinates back to final-icon pixels.
    drawW: drawW / F,
    drawH: drawH / F,
    offsetX: ox / F,
    offsetY: oy / F,
  };
}

async function writePng(file, rgba, w, h) {
  const buf = await sharp(Buffer.from(rgba), {
    raw: { width: w, height: h, channels: 4 },
  })
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      // No palette conversion: keeps full 8-bit alpha, matching the source.
      palette: false,
    })
    .toBuffer();
  await writeFile(file, buf);
  return buf.length;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  log('Phutrue asset pipeline');
  log('='.repeat(60));

  // ---- 1. Verify the source -------------------------------------
  if (!existsSync(SRC)) {
    throw new Error(`source logo missing: ${SRC}`);
  }
  const srcBuf = await readFile(SRC);
  const srcHash = sha256(srcBuf);
  if (srcHash !== EXPECTED_SHA256) {
    throw new Error(
      `source checksum mismatch\n  expected ${EXPECTED_SHA256}\n  actual   ${srcHash}`
    );
  }
  log(`source      : ${path.relative(ROOT, SRC)}`);
  log(`sha256      : ${srcHash}`);
  log(`bytes       : ${bytes(srcBuf.length)}`);

  const { data: src, info } = await sharp(srcBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const SW = info.width;
  const SH = info.height;
  log(`decoded     : ${SW} x ${SH}, ${info.channels} channels`);

  if (info.channels !== 4) throw new Error('expected RGBA source');

  // ---- 2. Measure the artwork -----------------------------------
  // These measurements drive nothing about the artwork itself; they are
  // recorded in the manifest so future changes can be compared against them.
  let minX = SW, minY = SH, maxX = -1, maxY = -1;
  let alphaSum = 0, cxSum = 0, cySum = 0, opaque = 0, clear = 0, partial = 0;
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const a = src[(y * SW + x) * 4 + 3];
      if (a === 0) { clear++; continue; }
      if (a === 255) opaque++; else partial++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      alphaSum += a;
      cxSum += x * a;
      cySum += y * a;
    }
  }
  const total = SW * SH;
  const metrics = {
    canvas: { width: SW, height: SH },
    aspectRatio: +(SW / SH).toFixed(6),
    bbox: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
    alpha: {
      clear,
      partial,
      opaque,
      clearPct: +((clear / total) * 100).toFixed(4),
      partialPct: +((partial / total) * 100).toFixed(4),
      opaquePct: +((opaque / total) * 100).toFixed(4),
    },
    centroid: {
      x: +(cxSum / alphaSum).toFixed(2),
      y: +(cySum / alphaSum).toFixed(2),
    },
  };
  log(`bbox        : ${metrics.bbox.width} x ${metrics.bbox.height} ` +
      `(${minX},${minY})-(${maxX},${maxY})`);
  log(`alpha       : ${metrics.alpha.clearPct}% clear / ` +
      `${metrics.alpha.partialPct}% partial / ${metrics.alpha.opaquePct}% opaque`);
  log(`centroid    : (${metrics.centroid.x}, ${metrics.centroid.y})`);

  // ---- 3. Sample the installer field colour ---------------------
  // NSIS BMPs cannot carry alpha. The flat field used behind the logo is
  // therefore looked up in the artwork itself - it is a colour that already
  // exists in the mark, never an invented one.
  const field = dominantColour(
    src,
    total,
    (r, g, b, a) => a >= 250 && Math.max(r, g, b) <= 96,
    8
  );
  const FIELD = [field.r, field.g, field.b];
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  log(`field colour: ${hex(FIELD)} (sampled from the logo's deep-navy outline, ` +
      `${(field.share * 100).toFixed(1)}% of that band)`);

  // ---- 4. Reset generated output --------------------------------
  // Generated assets are wholly owned by this script; removing the directory
  // guarantees no stale size or renamed file can survive a regeneration.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT_PNG, { recursive: true });

  // ---- 5. Square PNG icons --------------------------------------
  log('\nsquare icons (transparent, %d%% coverage):', COVERAGE * 100);
  const pngAssets = [];
  const squareCache = new Map();

  for (const size of ICON_SIZES) {
    const r = renderSquare(src, SW, SH, size, COVERAGE);
    squareCache.set(size, r.rgba);
    const file = path.join(OUT_PNG, `icon-${size}.png`);
    const n = await writePng(file, r.rgba, size, size);
    pngAssets.push({
      file: path.relative(ROOT, file),
      width: size,
      height: size,
      format: 'png',
      hasAlpha: true,
      bytes: n,
      artworkSize: [r.drawW, r.drawH],
      aspectErrorPct: +(r.aspectError * 100).toFixed(4),
      offsetX: +r.offsetX.toFixed(2),
      offsetY: +r.offsetY.toFixed(2),
    });
    log(`  ${String(size).padStart(4)}x${String(size).padEnd(4)} ` +
        `artwork ${r.drawW.toFixed(1)}x${r.drawH.toFixed(1)}  aspect err ${(r.aspectError * 100).toFixed(3)}%  ` +
        `${bytes(n)}`);
  }

  // ---- 6. Application .ico --------------------------------------
  log('\napplication icon (.ico):');
  const icoEntries = [];
  for (const size of ICO_SIZES) {
    if (size > 256) throw new Error('ICO cannot hold entries above 256px');
    const rgba = squareCache.get(size);
    const png = await sharp(Buffer.from(rgba), {
      raw: { width: size, height: size, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    icoEntries.push({ size, rgba, png });
  }
  const icoBuf = writeIco(icoEntries, ICO_PNG_THRESHOLD);
  const icoFile = path.join(OUT, 'icon.ico');
  await writeFile(icoFile, icoBuf);
  log(`  ${ICO_SIZES.join(', ')} px`);
  log(`  entries ${icoEntries.length}  encoding ` +
      icoEntries.map((e) => (e.size >= ICO_PNG_THRESHOLD ? 'png' : 'dib')).join(','));
  log(`  ${bytes(icoBuf.length)}`);

  // ---- 7. NSIS installer artwork --------------------------------
  // Composed onto the opaque field sampled above. The logo is rendered at 90%
  // of whichever dimension is the tighter fit, so it is never clipped and
  // never stretched, and is centred in the remaining space.
  log('\nNSIS installer artwork (24-bit BMP, no alpha):');
  const bmpAssets = [];

  async function makeBmp(file, w, h) {
    const innerW = Math.floor(w * NSIS_COVERAGE);
    const innerH = Math.floor(h * NSIS_COVERAGE);
    // Fit inside the padded box without exceeding it, preserving ratio.
    const k = Math.min(innerW / SW, innerH / SH);
    const drawW = Math.max(1, Math.round(SW * k));
    const drawH = Math.max(1, Math.round(SH * k));

    const scaled = areaAverageDownsample(src, SW, SH, drawW, drawH);
    const canvas = Buffer.alloc(w * h * 4);
    const ox = Math.floor((w - drawW) / 2);
    const oy = Math.floor((h - drawH) / 2);
    for (let y = 0; y < drawH; y++) {
      const from = y * drawW * 4;
      const to = ((oy + y) * w + ox) * 4;
      scaled.copy(canvas, to, from, from + drawW * 4);
    }

    const rgb = flattenToRgb(canvas, w * h, FIELD);
    const bmp = writeBmp24(rgb, w, h);
    await writeFile(file, bmp);
    bmpAssets.push({
      file: path.relative(ROOT, file),
      width: w,
      height: h,
      format: 'bmp',
      bitCount: 24,
      hasAlpha: false,
      bytes: bmp.length,
      artworkSize: [drawW, drawH],
      aspectErrorPct: +(Math.abs(drawW / drawH - SW / SH) / (SW / SH) * 100).toFixed(4),
      background: hex(FIELD),
    });
    log(`  ${path.basename(file).padEnd(26)} ${w}x${h}  ` +
        `artwork ${drawW}x${drawH}  ${bytes(bmp.length)}`);
  }

  await makeBmp(path.join(OUT, 'installerSidebar.bmp'), NSIS.sidebar.w, NSIS.sidebar.h);
  await makeBmp(path.join(OUT, 'uninstallerSidebar.bmp'), NSIS.sidebar.w, NSIS.sidebar.h);
  await makeBmp(path.join(OUT, 'installerHeader.bmp'), NSIS.header.w, NSIS.header.h);

  // ---- 8. Manifest ----------------------------------------------
  const manifest = {
    generatedBy: 'scripts/build-assets.mjs',
    note:
      'All files in assets/generated are produced from assets/brand/phutrue-logo.png. ' +
      'Do not edit them by hand; re-run `npm run assets`.',
    source: {
      file: 'assets/brand/phutrue-logo.png',
      sha256: srcHash,
      bytes: srcBuf.length,
      format: 'png',
    },
    pipeline: {
      scaleMode: 'uniform (width-derived, height follows)',
      positionMode: 'geometric centring, equal transparent padding',
      coverage: COVERAGE,
      nsisCoverage: NSIS_COVERAGE,
      resampling: 'premultiplied-alpha area average, supersampled from >=512px',
      icoPngThreshold: ICO_PNG_THRESHOLD,
      installerField: {
        colour: hex(FIELD),
        reason:
          'NSIS Modern UI bitmaps require 24-bit BMP with no alpha channel. The ' +
          'flat field behind the logo is sampled from the logo\'s own deep-navy ' +
          'outline band, not invented.',
      },
    },
    measurements: metrics,
    assets: {
      png: pngAssets,
      ico: {
        file: path.relative(ROOT, icoFile),
        format: 'ico',
        sizes: ICO_SIZES,
        entries: icoEntries.length,
        bytes: icoBuf.length,
      },
      bmp: bmpAssets,
    },
  };
  await writeFile(
    path.join(OUT, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  const totalBytes =
    pngAssets.reduce((s, a) => s + a.bytes, 0) +
    icoBuf.length +
    bmpAssets.reduce((s, a) => s + a.bytes, 0);

  log('\n' + '='.repeat(60));
  log(`wrote ${pngAssets.length} PNG, 1 ICO, ${bmpAssets.length} BMP`);
  log(`total generated: ${bytes(totalBytes)}`);
  log('done.');
}

main().catch((err) => {
  console.error('\nasset generation failed:', err.message);
  process.exitCode = 1;
});
