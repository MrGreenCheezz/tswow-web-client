// BLP2 decoder for the 3.3.5a client, replacing the per-texture `blpconverter.exe` spawn.
//
// Layout (all little endian):
//   0  char[4]  "BLP2"
//   4  uint32   type, 0 means JPEG content
//   8  uint8    encoding: 1 palette, 2 DXT, 3 raw BGRA
//   9  uint8    alphaDepth: 0, 1, 4 or 8 bits per pixel
//  10  uint8    alphaEncoding: 0 DXT1, 1 DXT3, 7 DXT5
//  11  uint8    mip levels present
//  12  uint32   width
//  16  uint32   height
//  20  uint32   mipOffsets[16]
//  84  uint32   mipSizes[16]
// 148  uint32   palette[256], stored blue, green, red, alpha
//
// Only mip 0 is decoded: that is what the asset pipeline consumes.

const HEADER_SIZE = 148;
const PALETTE_SIZE = 256 * 4;

export const BLP_ENCODING_PALETTE = 1;
export const BLP_ENCODING_DXT = 2;
export const BLP_ENCODING_RAW = 3;

export class BlpError extends Error {}

export function readBlpHeader(data) {
  if (data.length < HEADER_SIZE) throw new BlpError("BLP file is shorter than its header");
  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (magic !== "BLP2") throw new BlpError(`Unsupported BLP magic ${JSON.stringify(magic)}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = {
    type: view.getUint32(4, true),
    encoding: data[8],
    alphaDepth: data[9],
    alphaEncoding: data[10],
    hasMips: data[11],
    width: view.getUint32(12, true),
    height: view.getUint32(16, true),
    mipOffsets: [],
    mipSizes: [],
  };
  for (let level = 0; level < 16; level++) {
    header.mipOffsets.push(view.getUint32(20 + level * 4, true));
    header.mipSizes.push(view.getUint32(84 + level * 4, true));
  }
  if (header.type === 0) throw new BlpError("JPEG content BLP is not supported");
  if (header.width === 0 || header.height === 0) throw new BlpError("BLP has an empty mip level");
  return header;
}

/** Decodes mip 0 into straight RGBA. Returns `{ width, height, data }`. */
export function decodeBlp(data) {
  const header = readBlpHeader(data);
  const { width, height } = header;
  const offset = header.mipOffsets[0];
  const size = header.mipSizes[0];
  if (!offset || offset + size > data.length) throw new BlpError("BLP mip 0 lies outside the file");
  const mip = data.subarray(offset, offset + size);
  const out = new Uint8Array(width * height * 4);

  if (header.encoding === BLP_ENCODING_PALETTE) decodePalette(header, data, mip, out);
  else if (header.encoding === BLP_ENCODING_DXT) decodeDxt(header, mip, out);
  else if (header.encoding === BLP_ENCODING_RAW) decodeRaw(header, mip, out);
  else throw new BlpError(`Unsupported BLP encoding ${header.encoding}`);

  return { width, height, data: out };
}

function decodePalette(header, data, mip, out) {
  const { width, height, alphaDepth } = header;
  const palette = data.subarray(HEADER_SIZE, HEADER_SIZE + PALETTE_SIZE);
  if (palette.length < PALETTE_SIZE) throw new BlpError("BLP palette is truncated");
  const pixels = width * height;
  if (mip.length < pixels) throw new BlpError("BLP palette indices are truncated");
  for (let index = 0; index < pixels; index++) {
    const entry = mip[index] * 4;
    out[index * 4] = palette[entry + 2];
    out[index * 4 + 1] = palette[entry + 1];
    out[index * 4 + 2] = palette[entry];
    out[index * 4 + 3] = 255;
  }
  if (alphaDepth === 0) return;
  const alpha = mip.subarray(pixels);
  if (alphaDepth === 8) {
    for (let index = 0; index < pixels && index < alpha.length; index++) out[index * 4 + 3] = alpha[index];
  } else if (alphaDepth === 4) {
    for (let index = 0; index < pixels; index++) {
      const byte = alpha[index >> 1];
      if (byte === undefined) break;
      out[index * 4 + 3] = ((index & 1 ? byte >> 4 : byte & 0x0f) * 17) & 0xff;
    }
  } else if (alphaDepth === 1) {
    for (let index = 0; index < pixels; index++) {
      const byte = alpha[index >> 3];
      if (byte === undefined) break;
      out[index * 4 + 3] = byte & (1 << (index & 7)) ? 255 : 0;
    }
  } else {
    throw new BlpError(`Unsupported BLP alpha depth ${alphaDepth}`);
  }
}

function decodeRaw(header, mip, out) {
  const pixels = header.width * header.height;
  if (mip.length < pixels * 4) throw new BlpError("BLP raw pixels are truncated");
  for (let index = 0; index < pixels; index++) {
    out[index * 4] = mip[index * 4 + 2];
    out[index * 4 + 1] = mip[index * 4 + 1];
    out[index * 4 + 2] = mip[index * 4];
    out[index * 4 + 3] = header.alphaDepth === 0 ? 255 : mip[index * 4 + 3];
  }
}

/** Which DXT variant the header asks for. The alpha encoding wins; depth only picks DXT1. */
export function dxtFormat(header) {
  if (header.alphaEncoding === 7) return 5;
  if (header.alphaEncoding === 1) return 3;
  return header.alphaDepth > 1 ? 3 : 1;
}

const expand5 = (value) => (value << 3) | (value >> 2);
const expand6 = (value) => (value << 2) | (value >> 4);

function decodeDxt(header, mip, out) {
  const format = dxtFormat(header);
  const { width, height } = header;
  const blocksWide = Math.ceil(width / 4);
  const blocksHigh = Math.ceil(height / 4);
  const blockBytes = format === 1 ? 8 : 16;
  if (mip.length < blocksWide * blocksHigh * blockBytes) throw new BlpError("BLP DXT blocks are truncated");

  const colour = new Uint8Array(16 * 4);
  const alpha = new Uint8Array(16);
  for (let blockY = 0; blockY < blocksHigh; blockY++) {
    for (let blockX = 0; blockX < blocksWide; blockX++) {
      const block = (blockY * blocksWide + blockX) * blockBytes;
      if (format === 1) alpha.fill(255);
      else if (format === 3) decodeDxt3Alpha(mip, block, alpha);
      else decodeDxt5Alpha(mip, block, alpha);
      decodeColourBlock(mip, format === 1 ? block : block + 8, format === 1, colour, alpha);

      for (let row = 0; row < 4; row++) {
        const y = blockY * 4 + row;
        if (y >= height) break;
        for (let column = 0; column < 4; column++) {
          const x = blockX * 4 + column;
          if (x >= width) break;
          const source = (row * 4 + column) * 4;
          const target = (y * width + x) * 4;
          out[target] = colour[source];
          out[target + 1] = colour[source + 1];
          out[target + 2] = colour[source + 2];
          out[target + 3] = alpha[row * 4 + column];
        }
      }
    }
  }
}

// `punchThrough` is DXT1's 1 bit alpha mode, selected by the endpoint ordering.
function decodeColourBlock(mip, offset, punchThrough, colour, alpha) {
  const first = mip[offset] | (mip[offset + 1] << 8);
  const second = mip[offset + 2] | (mip[offset + 3] << 8);
  const red = [expand5(first >> 11), expand5(second >> 11), 0, 0];
  const green = [expand6((first >> 5) & 0x3f), expand6((second >> 5) & 0x3f), 0, 0];
  const blue = [expand5(first & 0x1f), expand5(second & 0x1f), 0, 0];
  const transparent = punchThrough && first <= second;
  if (transparent) {
    red[2] = (red[0] + red[1]) >> 1;
    green[2] = (green[0] + green[1]) >> 1;
    blue[2] = (blue[0] + blue[1]) >> 1;
    red[3] = green[3] = blue[3] = 0;
  } else {
    red[2] = (red[0] * 2 + red[1]) / 3 | 0;
    green[2] = (green[0] * 2 + green[1]) / 3 | 0;
    blue[2] = (blue[0] * 2 + blue[1]) / 3 | 0;
    red[3] = (red[0] + red[1] * 2) / 3 | 0;
    green[3] = (green[0] + green[1] * 2) / 3 | 0;
    blue[3] = (blue[0] + blue[1] * 2) / 3 | 0;
  }
  for (let pixel = 0; pixel < 16; pixel++) {
    const bits = (mip[offset + 4 + (pixel >> 2)] >> ((pixel & 3) * 2)) & 3;
    colour[pixel * 4] = red[bits];
    colour[pixel * 4 + 1] = green[bits];
    colour[pixel * 4 + 2] = blue[bits];
    if (transparent && bits === 3) alpha[pixel] = 0;
  }
}

function decodeDxt3Alpha(mip, offset, alpha) {
  for (let pixel = 0; pixel < 16; pixel++) {
    const byte = mip[offset + (pixel >> 1)];
    alpha[pixel] = ((pixel & 1 ? byte >> 4 : byte & 0x0f) * 17) & 0xff;
  }
}

function decodeDxt5Alpha(mip, offset, alpha) {
  const first = mip[offset];
  const second = mip[offset + 1];
  const table = [first, second, 0, 0, 0, 0, 0, 0];
  if (first > second) for (let step = 1; step < 7; step++) table[step + 1] = ((7 - step) * first + step * second) / 7 | 0;
  else {
    for (let step = 1; step < 5; step++) table[step + 1] = ((5 - step) * first + step * second) / 5 | 0;
    table[6] = 0;
    table[7] = 255;
  }
  let bits = 0n;
  for (let byte = 0; byte < 6; byte++) bits |= BigInt(mip[offset + 2 + byte]) << BigInt(byte * 8);
  for (let pixel = 0; pixel < 16; pixel++) alpha[pixel] = table[Number((bits >> BigInt(pixel * 3)) & 7n)];
}
