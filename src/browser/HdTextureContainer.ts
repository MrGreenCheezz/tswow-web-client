// 23.10 (7.48): the `WHT1` container the world HD set is stored and served in (tools/hd-texture-bc7.mjs writes it;
// a test holds the two in agreement): BC7 levels of one texture, largest first, sRGB colour.
//
//   0 "WHT1"  4 format (1 = BC7 sRGB)  8 width  12 height  16 levels  20 flags (bit 0: opaque)
//   24 levels × { u32 offset, u32 byteLength }, then the level data.
//
// Parsing is strict: a wrong magic, format, size or table is `undefined`, so a PNG (the original, answered when the
// gateway holds no HD copy) and anything malformed take the original path.

export const HD_TEXTURE_MAGIC = "WHT1";
export const HD_TEXTURE_FORMAT_BC7_SRGB = 1;
const HEADER_BYTES = 24;
const FLAG_OPAQUE = 1;
/** The largest side and level count the container may claim (an HD world texture is at most 1024). */
const MAX_SIDE = 4096;
const MAX_LEVELS = 13;

export interface HdTextureLevel {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface HdCompressedTexture {
  readonly format: "bc7-srgb";
  readonly width: number;
  readonly height: number;
  readonly opaque: boolean;
  /** Level 0 first; a full chain down to 1×1. */
  readonly levels: readonly HdTextureLevel[];
  /** Bytes of every level together (what the GPU holds). */
  readonly byteLength: number;
}

/** Bytes of one BC7 level: 16 a 4×4 block, partial blocks rounded up. */
export function bc7LevelBytes(width: number, height: number): number {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
}

/** Whether `bytes` start with the container's magic (a cheap sniff before parsing). */
export function isHdTextureContainer(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x57 && bytes[1] === 0x48 && bytes[2] === 0x54 && bytes[3] === 0x31;
}

/** The container's levels as views into `buffer`, or undefined when it is not a well-formed `WHT1` BC7 texture. */
export function parseHdTexture(buffer: ArrayBuffer | Uint8Array): HdCompressedTexture | undefined {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < HEADER_BYTES || !isHdTextureContainer(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint32(4, true);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  const flags = view.getUint32(20, true);
  if (format !== HD_TEXTURE_FORMAT_BC7_SRGB) return undefined;
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || count < 1 || count > MAX_LEVELS) return undefined;
  // A full chain: the level count the sides imply, so the texture is complete under mipmapped filtering.
  if (count !== Math.floor(Math.log2(Math.max(width, height))) + 1) return undefined;
  if (bytes.length < HEADER_BYTES + count * 8) return undefined;
  const levels: HdTextureLevel[] = [];
  let byteLength = 0;
  for (let index = 0; index < count; index++) {
    const offset = view.getUint32(HEADER_BYTES + index * 8, true);
    const length = view.getUint32(HEADER_BYTES + index * 8 + 4, true);
    const levelWidth = Math.max(1, width >> index);
    const levelHeight = Math.max(1, height >> index);
    if (length !== bc7LevelBytes(levelWidth, levelHeight) || offset + length > bytes.length || offset < HEADER_BYTES) return undefined;
    levels.push({ width: levelWidth, height: levelHeight, data: bytes.subarray(offset, offset + length) });
    byteLength += length;
  }
  return { format: "bc7-srgb", width, height, opaque: (flags & FLAG_OPAQUE) !== 0, levels, byteLength };
}
