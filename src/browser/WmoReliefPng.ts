/**
 * 22.10 (7.47 stage 2): the WMO texture PNGs read back to their exact RGBA bytes, for the relief
 * derivation.
 *
 * A 2D canvas cannot do this: it stores premultiplied colour, so wherever a texture's alpha is low —
 * and an opaque WMO texture's alpha is its specular or environment mask, not opacity — `getImageData`
 * returns the colour already multiplied away. The gateway's PNGs are `blpToPng`'s (pngjs: 8-bit,
 * not interlaced, RGBA), so this reads exactly that family — 8-bit grey, grey+alpha, RGB and RGBA —
 * and refuses anything else (no relief for that texture, never a wrong one). The inflate is the
 * platform's `DecompressionStream`, in the worker and in Node alike.
 */

export interface DecodedRgba {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Bytes per pixel by PNG colour type at bit depth 8. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };
/** 22.10 (7.47 stage 2): a larger picture is refused (the WMO textures are at most 1024², a few 2048). */
export const WMO_RELIEF_PNG_MAX_SIDE = 4096;

/** 22.10 (7.47 stage 2): one PNG's pixels as RGBA8, row 0 at the top; throws on anything it does not read. */
export async function decodePngRgba(bytes: Uint8Array): Promise<DecodedRgba> {
  if (bytes.length < 33 || SIGNATURE.some((value, index) => bytes[index] !== value)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Uint8Array[] = [];
  let total = 0;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const start = offset + 8;
    if (start + length > bytes.length) throw new Error("truncated PNG");
    if (type === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const depth = bytes[start + 8]!;
      const colour = bytes[start + 9]!;
      const interlace = bytes[start + 12]!;
      channels = CHANNELS[colour] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
      if (width < 1 || height < 1 || width > WMO_RELIEF_PNG_MAX_SIDE || height > WMO_RELIEF_PNG_MAX_SIDE) throw new Error("PNG size out of range");
    } else if (type === "IDAT") {
      parts.push(bytes.subarray(start, start + length));
      total += length;
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }
  if (channels === 0 || parts.length === 0) throw new Error("PNG has no image");
  const compressed = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { compressed.set(part, at); at += part.length; }
  const stride = width * channels;
  const raw = await inflate(compressed, (stride + 1) * height);
  return { data: unfilter(raw, width, height, channels), width, height };
}

async function inflate(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length < expected) throw new Error("PNG image data is short");
  return out;
}

/** Undoes the per-row filters and widens to RGBA (alpha 255 where the PNG has none). */
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[base + 1 + x]!;
      const left = x >= channels ? current[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      current[x] = (value + predicted) & 255;
    }
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const source = x * channels;
      const target = row + x * 4;
      if (channels >= 3) {
        out[target] = current[source]!;
        out[target + 1] = current[source + 1]!;
        out[target + 2] = current[source + 2]!;
        out[target + 3] = channels === 4 ? current[source + 3]! : 255;
      } else {
        const grey = current[source]!;
        out[target] = grey;
        out[target + 1] = grey;
        out[target + 2] = grey;
        out[target + 3] = channels === 2 ? current[source + 1]! : 255;
      }
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
