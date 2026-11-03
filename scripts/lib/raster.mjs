/**
 * Raster toolkit for the Phutrue asset pipeline.
 *
 * Deliberately small and explicit. Every operation here is one of the
 * operations permitted by the branding rules:
 *
 *   - uniform scaling
 *   - geometric positioning
 *   - transparent padding
 *   - high-quality resampling
 *   - format conversion
 *   - compositing onto a flat background (only where a format forbids alpha)
 *
 * There is no code in this file (or anywhere in the pipeline) that can redraw,
 * recolour, retouch, crop, stretch or otherwise alter the artwork. The only
 * pixel values that ever reach an output are resampled or composited versions
 * of pixels that exist in the source PNG.
 */

import { Buffer } from 'node:buffer';

/* ------------------------------------------------------------------ *
 * Alpha-correct area-average resampling
 * ------------------------------------------------------------------ */

/**
 * Weighted area-average downsample, performed in premultiplied-alpha space.
 *
 * Why this filter: the source is a 961x786 master being reduced by up to 60x.
 * Area averaging (box filtering) is the exact integral of the source over each
 * destination pixel, so it cannot introduce ringing or overshoot the way a
 * Lanczos window can, and it is what mipmap generation uses. For extreme
 * reductions like this it is the highest-fidelity choice, not the cheapest.
 *
 * Why premultiplied: the source has 397,974 pixels sitting at alpha 240..254
 * and only 2,118 at a true 255. Averaging un-premultiplied RGB lets the
 * *invisible* colour of near-transparent pixels bleed into visible ones, which
 * shows up as dark or coloured fringes on the wing edges on a light taskbar.
 * Averaging premultiplied channels and dividing by the averaged alpha is the
 * only mathematically correct way to do this.
 *
 * Source and destination regions are integrated with exact fractional
 * coverage, so no seams or blocky artefacts appear at non-integer ratios.
 *
 * @param {Uint8Array} src   RGBA8 pixels, length w*h*4
 * @param {number} sw        source width
 * @param {number} sh        source height
 * @param {number} dw        destination width
 * @param {number} dh        destination height
 * @returns {Buffer}         RGBA8 pixels, length dw*dh*4
 */
export function areaAverageDownsample(src, sw, sh, dw, dh) {
  if (!(dw > 0 && dh > 0)) throw new Error('destination must be positive');
  if (src.length !== sw * sh * 4) {
    throw new Error(`source length ${src.length} != ${sw * sh * 4}`);
  }

  // Horizontal pass: sw -> dw, keeping full source height.
  const hPass = new Float64Array(dw * sh * 4);

  // Precompute horizontal coverage weights once.
  const xWeights = buildAxisWeights(sw, dw);

  for (let y = 0; y < sh; y++) {
    const srcRow = y * sw * 4;
    const dstRow = y * dw * 4;
    for (let dx = 0; dx < dw; dx++) {
      const { start, weights } = xWeights[dx];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < weights.length; k++) {
        const p = srcRow + (start + k) * 4;
        const w = weights[k];
        // Premultiply on the fly. Integer alpha / 255 keeps this in 0..1.
        const al = (src[p + 3] / 255) * w;
        r += src[p] * al;
        g += src[p + 1] * al;
        b += src[p + 2] * al;
        a += al;
      }
      const o = dstRow + dx * 4;
      hPass[o] = r;
      hPass[o + 1] = g;
      hPass[o + 2] = b;
      hPass[o + 3] = a;
    }
  }

  // Vertical pass: sh -> dh. Values are still premultiplied sums.
  const out = Buffer.alloc(dw * dh * 4);
  const yWeights = buildAxisWeights(sh, dh);

  for (let dy = 0; dy < dh; dy++) {
    const { start, weights } = yWeights[dy];
    const dstRow = dy * dw * 4;
    for (let dx = 0; dx < dw; dx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < weights.length; k++) {
        const p = (start + k) * dw * 4 + dx * 4;
        const w = weights[k];
        r += hPass[p] * w;
        g += hPass[p + 1] * w;
        b += hPass[p + 2] * w;
        a += hPass[p + 3] * w;
      }
      const o = dstRow + dx * 4;
      if (a <= 0) {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
      } else {
        // Un-premultiply: divide by total alpha contribution.
        out[o] = clamp255(r / a);
        out[o + 1] = clamp255(g / a);
        out[o + 2] = clamp255(b / a);
        out[o + 3] = clamp255(a * 255);
      }
    }
  }
  return out;
}

function clamp255(v) {
  const n = Math.round(v);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * For each destination index, list the contiguous source indices it covers and
 * the exact fractional weight of each, normalised to sum to 1.
 */
function buildAxisWeights(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const out = new Array(dstLen);
  for (let d = 0; d < dstLen; d++) {
    const lo = d * scale;
    const hi = (d + 1) * scale;
    const start = Math.floor(lo);
    const end = Math.min(srcLen, Math.ceil(hi));
    const weights = [];
    let total = 0;
    for (let s = start; s < end; s++) {
      const overlap = Math.min(hi, s + 1) - Math.max(lo, s);
      const w = overlap > 0 ? overlap : 0;
      weights.push(w);
      total += w;
    }
    if (total <= 0) {
      // Degenerate only if hi-lo == 0, which cannot happen for positive sizes.
      weights.fill(1);
      total = weights.length;
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= total;
    out[d] = { start, weights };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Placement: uniform scale + transparent padding, no crop, no stretch
 * ------------------------------------------------------------------ */

/**
 * Compute where the full source canvas lands on a square destination canvas.
 *
 * Uniform scale only: k is derived from width and then applied to height, so
 * the aspect ratio is preserved exactly and nothing is stretched.
 *
 * The whole source canvas is the frame. It is never trimmed or cropped - the
 * artwork is full-bleed (touches all four edges of the 961x786 canvas), so
 * trimming would clip it, which the branding rules forbid.
 *
 * @param {number} sw source width
 * @param {number} sh source height
 * @param {number} side destination square side
 * @param {number} coverage fraction of `side` the artwork width occupies
 * @returns {{k:number, drawW:number, drawH:number, offsetX:number, offsetY:number}}
 */
export function fitSquare(sw, sh, side, coverage) {
  const k = (coverage * side) / sw;
  const drawW = sw * k;
  const drawH = sh * k;
  return {
    k,
    drawW,
    drawH,
    // Equal transparent padding on opposite sides. Geometric, not optical -
    // see docs/branding.md for why equal padding is the right rule here.
    offsetX: (side - drawW) / 2,
    offsetY: (side - drawH) / 2,
  };
}

/**
 * Render the source onto a transparent square canvas.
 *
 * @param {Uint8Array} src     RGBA8
 * @param {number} sw
 * @param {number} sh
 * @param {number} side        output side length in px
 * @param {number} coverage    see fitSquare
 * @returns {Buffer}           RGBA8, side*side*4
 */
export function renderSquare(src, sw, sh, side, coverage) {
  const p = fitSquare(sw, sh, side, coverage);
  const drawW = Math.max(1, Math.round(p.drawW));
  const drawH = Math.max(1, Math.round(p.drawH));

  // Resample the whole canvas in one uniform step. No cropping happens here.
  const scaled = areaAverageDownsample(src, sw, sh, drawW, drawH);

  const out = Buffer.alloc(side * side * 4); // zero-filled = fully transparent
  const ox = Math.round(p.offsetX);
  const oy = Math.round(p.offsetY);

  for (let y = 0; y < drawH; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= side) continue;
    const from = y * drawW * 4;
    const to = (ty * side + ox) * 4;
    scaled.copy(out, to, from, from + drawW * 4);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Compositing onto a flat field (only for formats without alpha)
 * ------------------------------------------------------------------ */

/**
 * Composite RGBA over an opaque flat colour, using correct source-over math.
 *
 * @param {Uint8Array} rgba
 * @param {number} n pixels
 * @param {[number,number,number]} bg
 * @returns {Buffer} RGB8, n*3
 */
export function flattenToRgb(rgba, n, bg) {
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const s = i * 4;
    const a = rgba[s + 3] / 255;
    out[i * 3] = clamp255(rgba[s] * a + bg[0] * (1 - a));
    out[i * 3 + 1] = clamp255(rgba[s + 1] * a + bg[1] * (1 - a));
    out[i * 3 + 2] = clamp255(rgba[s + 2] * a + bg[2] * (1 - a));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ICO writer
 * ------------------------------------------------------------------ */

/**
 * Build a multi-resolution Windows .ico.
 *
 * Windows reads PNG-compressed entries from Vista onward; 256x256 in an .ico
 * has always been the format ceiling (the width/height byte encodes 0 = 256).
 * Small entries are written as 32-bit bottom-up DIBs because a few shell code
 * paths - notably some installer and legacy shortcut contexts - handle PNG
 * entries less predictably than DIB ones. Large entries are PNG-compressed
 * because an uncompressed 256x256 DIB alone is 256 KiB.
 *
 * Each entry is 32bpp BGRA with a full alpha channel, plus the AND mask that
 * the ICO format still requires to be present (zeroed, since alpha carries
 * transparency). This is the layout Windows itself produces.
 *
 * @param {Array<{size:number, rgba:Uint8Array, png:Buffer}>} entries
 *        ordered smallest-first; `png` is used for entries >= pngThreshold
 * @param {number} pngThreshold
 * @returns {Buffer}
 */
export function writeIco(entries, pngThreshold = 64) {
  const prepared = entries.map((e) => {
    const usePng = e.size >= pngThreshold;
    return {
      size: e.size,
      data: usePng ? e.png : encodeDibEntry(e.rgba, e.size),
      isPng: usePng,
    };
  });

  const count = prepared.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const dir = Buffer.alloc(headerSize);

  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type 1 = icon
  dir.writeUInt16LE(count, 4);

  let p = 6;
  for (const e of prepared) {
    // 0 encodes 256; the format stores dimensions in a single byte.
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 0);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);
    dir.writeUInt8(0, p + 2); // palette count, 0 = >= 8bpp
    dir.writeUInt8(0, p + 3); // reserved
    dir.writeUInt16LE(1, p + 4); // colour planes
    dir.writeUInt16LE(32, p + 6); // bits per pixel
    dir.writeUInt32LE(e.data.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.data.length;
    p += 16;
  }

  return Buffer.concat([dir, ...prepared.map((e) => e.data)]);
}

/** 32-bit BGRA bottom-up DIB + 1bpp AND mask, as stored inside an .ico. */
function encodeDibEntry(rgba, size) {
  const header = Buffer.alloc(40);
  const xorSize = size * size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4; // 1bpp, padded to 4 bytes
  const andSize = maskRowBytes * size;

  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight = XOR + AND
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(xorSize + andSize, 20);
  header.writeInt32LE(0, 24);
  header.writeInt32LE(0, 28);
  header.writeUInt32LE(0, 32);
  header.writeUInt32LE(0, 36);

  const xor = Buffer.alloc(xorSize);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d + 0] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s + 0]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  // AND mask: 0 = show pixel. Alpha handles transparency, so it stays zeroed,
  // but the mask must physically exist or some parsers walk off the end.
  const and = Buffer.alloc(andSize);

  return Buffer.concat([header, xor, and]);
}

/* ------------------------------------------------------------------ *
 * BMP writer (24-bit, no alpha) for NSIS MUI artwork
 * ------------------------------------------------------------------ */

/**
 * Encode an uncompressed 24-bit bottom-up BMP.
 *
 * NSIS Modern UI bitmaps must be BMP and must not carry an alpha channel;
 * electron-builder's docs state 24-bit RGB explicitly. Transparency is
 * therefore impossible in these files, which is why the installer artwork is
 * composited onto an opaque field sampled from the logo.
 *
 * @param {Uint8Array} rgb  RGB8, w*h*3
 * @param {number} w
 * @param {number} h
 * @returns {Buffer}
 */
export function writeBmp24(rgb, w, h) {
  const rowBytes = Math.ceil((w * 3) / 4) * 4; // padded to 4-byte boundary
  const pixelBytes = rowBytes * h;
  const fileHeader = Buffer.alloc(14);
  const infoHeader = Buffer.alloc(40);

  fileHeader.write('BM', 0, 'ascii');
  fileHeader.writeUInt32LE(14 + 40 + pixelBytes, 2);
  fileHeader.writeUInt16LE(0, 6);
  fileHeader.writeUInt16LE(0, 8);
  fileHeader.writeUInt32LE(14 + 40, 10);

  infoHeader.writeUInt32LE(40, 0);
  infoHeader.writeInt32LE(w, 4);
  infoHeader.writeInt32LE(h, 8); // positive = bottom-up
  infoHeader.writeUInt16LE(1, 12);
  infoHeader.writeUInt16LE(24, 14);
  infoHeader.writeUInt32LE(0, 16); // BI_RGB
  infoHeader.writeUInt32LE(pixelBytes, 20);
  infoHeader.writeInt32LE(2835, 24); // 72 DPI
  infoHeader.writeInt32LE(2835, 28);
  infoHeader.writeUInt32LE(0, 32);
  infoHeader.writeUInt32LE(0, 36);

  const pixels = Buffer.alloc(pixelBytes);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y; // BMP rows are stored bottom-up
    const rowStart = y * rowBytes;
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * 3;
      const d = rowStart + x * 3;
      pixels[d + 0] = rgb[s + 2]; // B
      pixels[d + 1] = rgb[s + 1]; // G
      pixels[d + 2] = rgb[s + 0]; // R
    }
  }

  return Buffer.concat([fileHeader, infoHeader, pixels]);
}

/* ------------------------------------------------------------------ *
 * Colour sampling from the source artwork
 * ------------------------------------------------------------------ */

/**
 * Find the dominant colour of a specified tonal band in the source artwork.
 *
 * Used only to derive a flat field colour for the installer bitmaps, which
 * cannot carry transparency. The result is always a colour that genuinely
 * occurs in the logo - it is looked up, never invented - which is what the
 * branding rules require for compositing.
 *
 * @param {Uint8Array} rgba
 * @param {number} n           pixel count
 * @param {(r:number,g:number,b:number,a:number)=>boolean} predicate
 * @param {number} bucket      quantisation bucket size
 * @returns {{r:number,g:number,b:number,share:number}}
 */
export function dominantColour(rgba, n, predicate, bucket = 8) {
  const counts = new Map();
  let accepted = 0;
  for (let i = 0; i < n; i++) {
    const s = i * 4;
    const a = rgba[s + 3];
    const r = rgba[s], g = rgba[s + 1], b = rgba[s + 2];
    if (!predicate(r, g, b, a)) continue;
    accepted++;
    const key =
      (Math.round(r / bucket) * bucket) * 65536 +
      (Math.round(g / bucket) * bucket) * 256 +
      (Math.round(b / bucket) * bucket);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!accepted) throw new Error('dominantColour: no pixels matched');

  let bestKey = 0, bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount || (c === bestCount && k < bestKey)) {
      bestKey = k;
      bestCount = c;
    }
  }
  const r = Math.floor(bestKey / 65536);
  const g = Math.floor((bestKey % 65536) / 256);
  const b = bestKey % 256;
  return { r, g, b, share: bestCount / accepted };
}
