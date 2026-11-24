import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

export interface PdfLogo {
  width: number;
  height: number;
  compressedRgb: Buffer;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SOURCE_PIXELS = 12_000_000;
const MAX_LOGO_WIDTH = 640;
const MAX_LOGO_HEIGHT = 320;
let cachedLogo: PdfLogo | null = null;

/**
 * PNG Paeth filter predictor.
 * @param {number} a Pixel to the left.
 * @param {number} b Pixel above.
 * @param {number} c Pixel above-left.
 * @return {number} Predictor byte.
 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Unfilters 8/16-bit and packed PNG rows.
 * @param {Buffer} compressed Inflated PNG image rows.
 * @param {number} height Row count.
 * @param {number} stride Number of packed bytes per row.
 * @param {number} bpp Bytes per pixel used by the PNG filter.
 * @return {Buffer} Pixel rows without row filters.
 */
function unfilter(
  compressed: Buffer,
  height: number,
  stride: number,
  bpp: number,
): Buffer {
  if (compressed.length !== (stride + 1) * height) {
    throw new Error("PolymApp-Logo: Ungültige PNG-Bilddaten.");
  }

  const result = Buffer.alloc(stride * height);
  let sourceIndex = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = compressed[sourceIndex++];
    if (filter > 4) {
      throw new Error("PolymApp-Logo: Unbekannter PNG-Filter.");
    }

    for (let i = 0; i < stride; i += 1) {
      const x = compressed[sourceIndex++];
      const offset = row * stride + i;
      const a = i >= bpp ? result[offset - bpp] : 0;
      const b = row > 0 ? result[offset - stride] : 0;
      const c = row > 0 && i >= bpp ? result[offset - stride - bpp] : 0;
      const predictor = filter === 1 ? a :
        filter === 2 ? b :
          filter === 3 ? Math.floor((a + b) / 2) :
            filter === 4 ? paeth(a, b, c) : 0;
      result[offset] = (x + predictor) & 255;
    }
  }
  return result;
}

/**
 * Returns an unpacked sample (0..65535) from a PNG row.
 * @param {Buffer} pixels Unfiltered pixel rows.
 * @param {number} offset Row offset.
 * @param {number} sample Sample index within the row.
 * @param {number} bitDepth PNG bit depth.
 * @return {number} Raw sample.
 */
function readSample(
  pixels: Buffer,
  offset: number,
  sample: number,
  bitDepth: number,
): number {
  if (bitDepth === 16) {
    return pixels.readUInt16BE(offset + sample * 2);
  }
  if (bitDepth === 8) {
    return pixels[offset + sample];
  }
  const bitIndex = sample * bitDepth;
  const byte = pixels[offset + Math.floor(bitIndex / 8)];
  const shift = 8 - bitDepth - (bitIndex % 8);
  return (byte >>> shift) & ((1 << bitDepth) - 1);
}

/**
 * Converts a PNG to a compact opaque RGB image for PDF embedding.
 * Transparent pixels are composited on white.
 * @param {Buffer} file Original PNG bytes.
 * @return {PdfLogo} Resized image bytes.
 */
export function decodeInvoiceLogoPng(file: Buffer): PdfLogo {
  if (file.length < 33 || !file.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("PolymApp-Logo: Die Datei ist kein gültiges PNG.");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const imageChunks: Buffer[] = [];

  let offset = 8;
  while (offset + 12 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const begin = offset + 8;
    const end = begin + length;
    if (end + 4 > file.length) {
      throw new Error("PolymApp-Logo: Beschädigter PNG-Chunk.");
    }
    const chunk = file.subarray(begin, end);
    if (type === "IHDR") {
      if (chunk.length !== 13) {
        throw new Error("PolymApp-Logo: Ungültiger PNG-Header.");
      }
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      if (chunk[10] !== 0 || chunk[11] !== 0) {
        throw new Error("PolymApp-Logo: Unbekanntes PNG-Format.");
      }
      interlace = chunk[12];
    } else if (type === "PLTE") {
      palette = chunk;
    } else if (type === "tRNS") {
      transparency = chunk;
    } else if (type === "IDAT") {
      imageChunks.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }

  const channels: Record<number, number> = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
  const channelCount = channels[colorType];
  const supportedDepth = colorType === 0 || colorType === 3 ?
    [1, 2, 4, 8, 16].includes(bitDepth) :
    [8, 16].includes(bitDepth);
  if (
    !width || !height || width * height > MAX_SOURCE_PIXELS ||
    !channelCount || !supportedDepth || interlace !== 0 ||
    imageChunks.length === 0 ||
    (colorType === 3 && (!palette || bitDepth === 16))
  ) {
    throw new Error(
      "PolymApp-Logo: PNG-Format nicht unterstützt. " +
      "Bitte als normales RGB/RGBA-PNG ohne Interlacing speichern.",
    );
  }

  const stride = Math.ceil(width * channelCount * bitDepth / 8);
  const bytesPerPixel = Math.max(1, Math.ceil(channelCount * bitDepth / 8));
  const pixels = unfilter(
    zlib.inflateSync(Buffer.concat(imageChunks)),
    height,
    stride,
    bytesPerPixel,
  );

  const scale = Math.min(
    1,
    MAX_LOGO_WIDTH / width,
    MAX_LOGO_HEIGHT / height,
  );
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const rgb = Buffer.alloc(targetWidth * targetHeight * 3);
  const maximumSample = (2 ** bitDepth) - 1;
  const sampleToByte = (sample: number): number =>
    Math.round(sample * 255 / maximumSample);

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y + 0.5) / scale));
    const rowOffset = sourceY * stride;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) / scale));
      const sample = sourceX * channelCount;
      let r = 255;
      let g = 255;
      let b = 255;
      let a = 255;

      if (colorType === 0 || colorType === 4) {
        const rawGray = readSample(pixels, rowOffset, sample, bitDepth);
        r = sampleToByte(rawGray);
        g = r;
        b = r;
        if (colorType === 4) {
          a = sampleToByte(readSample(pixels, rowOffset, sample + 1, bitDepth));
        } else if (transparency && transparency.length >= 2 &&
          rawGray === transparency.readUInt16BE(0)) {
          a = 0;
        }
      } else if (colorType === 3) {
        const index = readSample(pixels, rowOffset, sample, bitDepth);
        const indexOffset = index * 3;
        if (!palette || indexOffset + 3 > palette.length) {
          throw new Error("PolymApp-Logo: Ungültige PNG-Palette.");
        }
        r = palette[indexOffset];
        g = palette[indexOffset + 1];
        b = palette[indexOffset + 2];
        a = transparency && index < transparency.length ?
          transparency[index] : 255;
      } else {
        const rawR = readSample(pixels, rowOffset, sample, bitDepth);
        const rawG = readSample(pixels, rowOffset, sample + 1, bitDepth);
        const rawB = readSample(pixels, rowOffset, sample + 2, bitDepth);
        r = sampleToByte(rawR);
        g = sampleToByte(rawG);
        b = sampleToByte(rawB);
        if (colorType === 6) {
          a = sampleToByte(readSample(pixels, rowOffset, sample + 3, bitDepth));
        } else if (transparency && transparency.length >= 6 &&
          rawR === transparency.readUInt16BE(0) &&
          rawG === transparency.readUInt16BE(2) &&
          rawB === transparency.readUInt16BE(4)) {
          a = 0;
        }
      }

      const dest = (y * targetWidth + x) * 3;
      rgb[dest] = Math.round((r * a + 255 * (255 - a)) / 255);
      rgb[dest + 1] = Math.round((g * a + 255 * (255 - a)) / 255);
      rgb[dest + 2] = Math.round((b * a + 255 * (255 - a)) / 255);
    }
  }

  return {
    width: targetWidth,
    height: targetHeight,
    compressedRgb: zlib.deflateSync(rgb),
  };
}

/**
 * Loads the bundled PolymApp logo from Firebase Functions/assets.
 * @return {PdfLogo} Image to embed in the PDF.
 */
export function loadInvoiceLogo(): PdfLogo {
  if (cachedLogo) {
    return cachedLogo;
  }

  const candidates = [
    path.join(process.cwd(), "assets", "logo_black.png"),
    path.resolve(__dirname, "../../assets/logo_black.png"),
  ];
  const filename = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filename) {
    throw new Error(
      "PolymApp-Rechnung: functions/assets/logo_black.png fehlt. " +
      "Die Originaldatei aus images/ dorthin kopieren und neu deployen.",
    );
  }
  cachedLogo = decodeInvoiceLogoPng(fs.readFileSync(filename));
  return cachedLogo;
}
