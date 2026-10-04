// MCAL alpha-map decoding for ADT v18 (WoW 3.3.5a).
//
// Three storage formats and two correctness traps, all measured against the retail
// 3.3.5a data in the local client rather than taken from documentation:
//
//   * `MCNK.sizeAlpha` (header offset 0x28) is authoritative for the size of the MCAL
//     sub-chunk. The sub-chunk's own TLV length field is zero in every Northrend tile
//     sampled - 183 of the 190 textured chunks in Northrend_31_29 - so trusting it
//     silently drops the last alpha layer and leaves only the base texture.
//   * `MCNK.flags & 0x8000` is `do_not_fix_alpha_map`. When it is NOT set the alpha map
//     is really 63x63 and the last row and column hold garbage: mean |row63 - row62|
//     measures 47-52 across sampled Azeroth and Kalimdor chunks against an inner
//     baseline of 15-19. When it IS set the last row already matches its neighbour
//     (delta 0.00-0.02 on Azeroth/Kalimdor) or carries real data (Outland 4.4,
//     Northrend 7.3), so the correction has to stay conditional on the flag.
//
// Note that `@wowserhq/format` checks bit 0x200 for this instead, which is never set in
// any of the 12288 chunks sampled - it therefore always applies the correction and would
// flatten the genuine last row of Outland and Northrend tiles.

export const ALPHA_SIDE = 64;
export const ALPHA_SIZE = ALPHA_SIDE * ALPHA_SIDE;

/** MCNK header flag: the alpha maps are already 64x64 and need no edge correction. */
export const MCNK_DO_NOT_FIX_ALPHA_MAP = 0x8000;
/** MCLY layer flag: this layer's alpha map is RLE compressed. */
export const MCLY_ALPHA_COMPRESSED = 0x200;
/** WDT MPHD flag: alpha maps are stored as 4096 bytes at 8 bit instead of 2048 at 4 bit. */
export const MPHD_BIG_ALPHA = 0x4;

const MCNK_OFFSET_FLAGS = 0x00;
const MCNK_OFFSET_INDEX_X = 0x04;
const MCNK_OFFSET_INDEX_Y = 0x08;
const MCNK_OFFSET_ALPHA = 0x24;
const MCNK_OFFSET_ALPHA_SIZE = 0x28;
/** `uint16[8]`: two bits per detail cell naming which of the chunk's four layers grows there. */
const MCNK_OFFSET_DETAIL_LAYER = 0x40;
/** `uint8[8]`: one bit per detail cell, set where the artist wanted nothing to grow. */
const MCNK_OFFSET_NO_DOODAD = 0x50;
/** Where the pair ends, which is what `mapChunkDetail` needs to be inside the chunk. */
const MCNK_DETAIL_END = MCNK_OFFSET_NO_DOODAD + 8;

/** A chunk is 8x8 detail cells, each 533.33333/16/8 = 4.16667 yards across. */
export const DETAIL_CELLS_PER_SIDE = 8;

/**
 * Where a map chunk sits in its tile, named for the direction each index moves in rather than for
 * the letter the header gives it.
 *
 * `IndexX` runs east across the tile and `IndexY` runs south down it. Measured on Azeroth_31_49:
 * with `IndexY` held fixed, walking `IndexX` from 0 to 15 takes the chunk's own stored position
 * from y=533.3 to y=33.3 while x stays at -9066.7; with `IndexX` held fixed, walking `IndexY`
 * takes x from -9066.7 to -9566.7 while y stays put. The terrain mesh's UVs are (east, 1 - south),
 * so south is the image row — using `IndexX` for it transposes the whole tile about its diagonal.
 */
export function mapChunkGrid(data, start) {
  return { column: data.readUInt32LE(start + MCNK_OFFSET_INDEX_X), row: data.readUInt32LE(start + MCNK_OFFSET_INDEX_Y) };
}

/**
 * The two header fields that decide where ground cover grows, which nothing in this tree read
 * until the ground-cover slice: an 8x8 map of which layer grows on each detail cell, and an 8x8
 * mask of the cells where nothing does.
 *
 * Both are indexed the same way the alpha map and the chunk grid are — the row index runs along
 * -X (south) and the column index along -Y (east) — and both readings were measured on this
 * machine rather than taken from documentation:
 *
 *   * `winner[row]` holds two bits per column at bit `column * 2`. Scored against the layer the
 *     MCAL alpha maps make dominant on the same cell, that reading agrees on 86.8% of
 *     Azeroth_31_49's 16,384 cells and its transpose on 51.1%. The 13% it does not agree on is
 *     what makes this authored data rather than something derivable.
 *   * `noDoodad[row]` holds one bit per column at bit `column`. Read that way, 642 of Goldshire's
 *     1,119 masked cells sit on `ElwynnCobbleStoneBase.blp` against 5 of the 15,265 unmasked ones
 *     — it is the road. Read with the bits the other way round it is 313 against 334, which is no
 *     road at all. All 24 cells inside an ADT hole are masked either way.
 *
 * Returned as plain arrays of eight so the caller can write them straight out; the chunk is
 * checked to be long enough rather than read past its end.
 */
export function mapChunkDetail(data, start, size = data.length - start) {
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(size) || size < MCNK_DETAIL_END
    || start + size > data.length || start + MCNK_DETAIL_END > data.length) {
    throw new Error("ADT map chunk header is truncated");
  }
  const winner = [];
  const noDoodad = [];
  for (let row = 0; row < DETAIL_CELLS_PER_SIDE; row++) {
    winner.push(data.readUInt16LE(start + MCNK_OFFSET_DETAIL_LAYER + row * 2));
    noDoodad.push(data.readUInt8(start + MCNK_OFFSET_NO_DOODAD + row));
  }
  return { winner, noDoodad };
}

function tagAt(data, offset) {
  return String.fromCharCode(data[offset + 3], data[offset + 2], data[offset + 1], data[offset]);
}

/** Expands the 2048 byte 4 bit format, low nibble first, to a full 64x64 map. */
export function expandAlpha4Bit(data) {
  const output = new Uint8Array(ALPHA_SIZE);
  const pairs = Math.min(ALPHA_SIZE / 2, data.length);
  for (let index = 0; index < pairs; index++) {
    output[index * 2] = (data[index] & 0x0f) * 17;
    output[index * 2 + 1] = (data[index] >> 4) * 17;
  }
  return output;
}

/** Copies the 4096 byte 8 bit format, padding a short buffer with zeroes. */
export function readAlpha8Bit(data) {
  const output = new Uint8Array(ALPHA_SIZE);
  output.set(data.subarray(0, Math.min(ALPHA_SIZE, data.length)));
  return output;
}

/** Decodes the run-length format: control byte, bit 7 fill, bits 0-6 run length. */
export function decompressAlpha(data) {
  const output = new Uint8Array(ALPHA_SIZE);
  let source = 0;
  let target = 0;
  while (source < data.length && target < ALPHA_SIZE) {
    const control = data[source++];
    const run = control & 0x7f;
    const count = Math.min(run, ALPHA_SIZE - target);
    if (control & 0x80) {
      if (source >= data.length) break;
      output.fill(data[source++], target, target + count);
    } else {
      output.set(data.subarray(source, source + count), target);
      source += run;
    }
    target += count;
  }
  return output;
}

/** Replaces the garbage last row and column with copies of their neighbours, in place. */
export function fixAlphaEdges(alpha) {
  const last = ALPHA_SIDE - 1;
  for (let index = 0; index < ALPHA_SIDE; index++) {
    alpha[index * ALPHA_SIDE + last] = alpha[index * ALPHA_SIDE + last - 1];
    alpha[last * ALPHA_SIDE + index] = alpha[(last - 1) * ALPHA_SIDE + index];
  }
  alpha[last * ALPHA_SIDE + last] = alpha[(last - 1) * ALPHA_SIDE + last - 1];
  return alpha;
}

/**
 * Decodes one layer's alpha map to 64x64 8 bit values.
 * `compressed` comes from the MCLY layer flags, `bigAlpha` from the WDT MPHD flags and
 * `fixEdges` from the absence of `do_not_fix_alpha_map` in the MCNK header flags.
 */
export function decodeAlpha(data, { compressed = false, bigAlpha = false, fixEdges = false } = {}) {
  const alpha = compressed ? decompressAlpha(data) : bigAlpha ? readAlpha8Bit(data) : expandAlpha4Bit(data);
  return fixEdges ? fixAlphaEdges(alpha) : alpha;
}

/**
 * `MCCV`: the colour the artist painted onto this chunk's own vertices, 145 of them in the same
 * 9x9 + 8x8 interleave the heights use.
 *
 * The offset at header 0x74 is counted from the chunk's data rather than from its tag, so the tag
 * sits at `data + ofs - 8`: checked on Northrend_28_21, that reading finds `MCCV` on 256 of 256
 * chunks and the other one on none of them. An entry is B, G, R, A with the alpha always 255, and
 * the neutral value is 127 — 511,154 of the client's 561,664 painted chunks are uniformly that.
 *
 * Only WotLK maps carry it: 2,194 of the world's 5,744 tiles, none of them in Azeroth, Kalimdor or
 * Outland, and the WDT's own `MPHD` bit 0x02 says so per map.
 */
export function mapChunkColours(data, start, size) {
  const offset = data.readUInt32LE(start + 0x74);
  if (!offset || offset + 580 > size + 8) return undefined;
  const at = start + offset - 8;
  if (at + 8 + 580 > data.length || tagAt(data, at) !== "MCCV") return undefined;
  return data.subarray(at + 8, at + 8 + 580);
}

/** True when the MCNK header flags ask for the 63x63 edge correction. */
export function alphaNeedsEdgeFix(chunkFlags) {
  return (chunkFlags & MCNK_DO_NOT_FIX_ALPHA_MAP) === 0;
}

/**
 * Locates the MCAL payload of one map chunk. `data` is the whole ADT buffer, `start` the
 * first byte of the MCNK payload and `size` its declared length. Returns byte offsets
 * relative to `start`, with `alphaSize` clamped to what the chunk actually contains.
 */
export function mapChunkAlpha(data, start, size) {
  const flags = data.readUInt32LE(start + MCNK_OFFSET_FLAGS);
  const alphaOffset = data.readUInt32LE(start + MCNK_OFFSET_ALPHA);
  if (!alphaOffset || alphaOffset > size) return { flags, alphaOffset: 0, alphaSize: 0 };
  const declared = data.readUInt32LE(start + MCNK_OFFSET_ALPHA_SIZE);
  const tagOffset = start + alphaOffset - 8;
  const framed = alphaOffset >= 8 && tagOffset + 8 <= data.length && tagAt(data, tagOffset) === "MCAL";
  const fallback = framed ? data.readUInt32LE(tagOffset + 4) : 0;
  const preferred = declared >= 8 ? declared - 8 : 0;
  const available = size - alphaOffset;
  return { flags, alphaOffset, alphaSize: Math.max(0, Math.min(available, preferred || fallback)) };
}

/**
 * Whether a tile's ground can be published as a splat (7.23).
 *
 * `none` — nothing to paint: the ADT has no MTEX, no MCNK, or not one chunk with a layer. Measured
 *          over the 5,774 ADTs of this client (`docs/implementation/probes/A10/probe-723-census`):
 *          598 tiles are such stubs (every Gundrak tile, the flat planes under dungeons) and 30
 *          Kalimdor tiles have no MTEX/MCNK. The route answers 404 for them, once and for good.
 * `partial` — some chunks carry no layer. 404 real tiles do this (Northrend 21/40 has one bare
 *          chunk); such a chunk is published with an empty layer list and the shader draws its
 *          fallback colour there.
 * `ok` — every chunk has at least one layer.
 *
 * More than four layers is a broken chunk and stays an error, as it was.
 */
export function adtSplatVerdict(layerCounts, textureCount) {
  let bare = 0;
  for (const count of layerCounts) {
    if (!Number.isInteger(count) || count < 0 || count > 4) throw new Error("Invalid ADT map chunk header");
    if (count === 0) bare++;
  }
  if (textureCount === 0 || layerCounts.length === 0 || bare === layerCounts.length) return "none";
  return bare > 0 ? "partial" : "ok";
}
