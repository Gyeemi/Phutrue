/**
 * Readers and validators for the asset pipeline's own output.
 *
 * These exist so that verification is independent of the writer: assets are
 * re-opened from disk and their headers decoded again, rather than trusting
 * the values that the build script happened to log.
 */

import { Buffer } from 'node:buffer';

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

/**
 * Parse a PNG's structural chunks and IHDR without decoding pixels.
 * Also walks every chunk's CRC so silent corruption is caught.
 */
export function readPngHeader(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG (bad signature)');
  }
  let pos = 8;
  let ihdr = null;
  let sawIend = false;
  let idatBytes = 0;
  const types = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    types.push(type);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) throw new Error(`truncated chunk ${type}`);

    // CRC over type + data.
    const expected = buf.readUInt32BE(dataEnd);
    const actual = crc32(buf.subarray(pos + 4, dataEnd));
    if ((expected >>> 0) !== (actual >>> 0)) {
      throw new Error(`CRC mismatch in ${type}`);
    }

    if (type === 'IHDR') {
      ihdr = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colourType: buf[dataStart + 9],
        interlace: buf[dataStart + 12],
      };
    }
    if (type === 'IDAT') idatBytes += len;
    if (type === 'IEND') { sawIend = true; pos = dataEnd + 4; break; }
    pos = dataEnd + 4;
  }

  if (!ihdr) throw new Error('no IHDR');
  if (!sawIend) throw new Error('no IEND (truncated file)');
  if (pos !== buf.length) throw new Error(`trailing bytes after IEND: ${buf.length - pos}`);

  return {
    ...ihdr,
    hasAlpha: ihdr.colourType === 4 || ihdr.colourType === 6,
    idatBytes,
    chunks: types,
    chunkCount: types.length,
  };
}

/* ------------------------------------------------------------------ *
 * ICO
 * ------------------------------------------------------------------ */

/**
 * Parse an .ico, returning every directory entry with its decoded geometry.
 * Dimensions are read from the directory (0 means 256), and for PNG-encoded
 * entries the embedded PNG header is cross-checked against the directory.
 */
export function readIco(buf) {
  if (buf.length < 6) throw new Error('too short to be an ICO');
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) throw new Error('not an ICO (bad header)');
  if (count === 0) throw new Error('ICO declares zero images');

  const images = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 16;
    if (p + 16 > buf.length) throw new Error('truncated ICO directory');
    const wByte = buf.readUInt8(p);
    const hByte = buf.readUInt8(p + 1);
    const bpp = buf.readUInt16LE(p + 6);
    const bytes = buf.readUInt32LE(p + 8);
    const offset = buf.readUInt32LE(p + 12);

    if (offset + bytes > buf.length) throw new Error(`ICO entry ${i} runs past EOF`);

    const data = buf.subarray(offset, offset + bytes);
    const isPng = data.length > 8 && data.readUInt32BE(0) === 0x89504e47;

    const entry = {
      index: i,
      declaredWidth: wByte === 0 ? 256 : wByte,
      declaredHeight: hByte === 0 ? 256 : hByte,
      bpp,
      bytes,
      offset,
      encoding: isPng ? 'png' : 'dib',
    };

    if (isPng) {
      const hdr = readPngHeader(data);
      entry.pngWidth = hdr.width;
      entry.pngHeight = hdr.height;
      entry.pngHasAlpha = hdr.hasAlpha;
    } else {
      // BITMAPINFOHEADER: biWidth @4, biHeight @8 (doubled: XOR + AND mask)
      if (bytes < 40) throw new Error(`ICO entry ${i} too small for a DIB`);
      entry.dibWidth = data.readInt32LE(4);
      entry.dibHeightHalf = data.readInt32LE(8) / 2;
      entry.dibBitCount = data.readUInt16LE(14);
      entry.dibCompression = data.readUInt32LE(16);
    }
    images.push(entry);
  }

  return { count, images, byteLength: buf.length };
}

/* ------------------------------------------------------------------ *
 * BMP
 * ------------------------------------------------------------------ */

/** Parse a BMP header and confirm it is 24-bit uncompressed, bottom-up. */
export function readBmp24(buf) {
  if (buf.length < 54) throw new Error('too short to be a BMP');
  if (buf.toString('latin1', 0, 2) !== 'BM') throw new Error('not a BMP (bad magic)');
  const fileSize = buf.readUInt32LE(2);
  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const planes = buf.readUInt16LE(26);
  const bitCount = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);

  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const expected = dataOffset + rowBytes * Math.abs(height);

  return {
    fileSize,
    declaredSizeMatches: fileSize === buf.length,
    actualSize: buf.length,
    dataOffset,
    headerSize,
    width,
    height,
    planes,
    bitCount,
    compression,
    bottomUp: height > 0,
    hasAlpha: bitCount === 32,
    pixelBytesAccounted: expected === buf.length,
  };
}

/**
 * Decode a 24-bit uncompressed BMP to RGB8, top-down.
 *
 * This exists because the libvips build shipped with sharp here has no BMP
 * reader, so the NSIS artwork cannot be validated through it. Decoding the
 * pixels ourselves also keeps verification independent of any decoder quirk
 * in the tool that wrote the file.
 */
export function decodeBmp24(buf) {
  const info = readBmp24(buf);
  const { width, height, dataOffset, bitCount, compression } = info;
  if (bitCount !== 24) throw new Error(`expected 24bpp, got ${bitCount}`);
  if (compression !== 0) throw new Error(`expected BI_RGB, got ${compression}`);

  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y++) {
    // Positive height means rows are stored bottom-up.
    const srcY = info.bottomUp ? height - 1 - y : y;
    const rowStart = dataOffset + srcY * rowBytes;
    for (let x = 0; x < width; x++) {
      const s = rowStart + x * 3;
      const d = (y * width + x) * 3;
      out[d + 0] = buf[s + 2]; // BMP stores BGR
      out[d + 1] = buf[s + 1];
      out[d + 2] = buf[s + 0];
    }
  }
  return { data: out, width, height, channels: 3, info };
}

/* ------------------------------------------------------------------ *
 * CRC-32 (PNG polynomial), table-driven
 * ------------------------------------------------------------------ */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}
