// The ground-cover recipe: what grows on a tile, in forty bytes a chunk.
//
// Publishing the doodads themselves is not possible and that was measured: the live gateway
// answers `/visual/environment/0/49/31` with 2,941,558 bytes for 7,940 objects — 370.5 bytes per
// placement — and the Goldshire tile carries 101,036 ground doodads at the density its own tables
// ask for, which is 37.4 MB for one tile and 337 MB over the nine-tile ring the client streams.
// So the tile publishes the *recipe* the client's own artists wrote and the browser scatters from
// it: 10,248 bytes for a whole tile, written by the generator that already parses every MCNK.
//
// THE LAYOUT, frozen. Little-endian throughout.
//
//   0x00  char[4]  "WGC1"     the magic and the version in one: a later layout is "WGC2", so a
//                             reader that does not know it refuses the file instead of guessing
//   0x04  uint8    version    1, repeated as a number so a bump can be tested for numerically
//   0x05  uint8    stride     40, the size of one chunk record
//   0x06  uint16   chunks     256, always — see "absence" below
//   0x08  256 records of 40 bytes, in order `row * 16 + column`, where the row is MCNK `IndexY`
//         (running south, -X) and the column is MCNK `IndexX` (running east, -Y) — the same order
//         the `index.png` of this family is written in
//
//   record +0x00  uint32 effect[4]    MCLY +12, the `GroundEffectTexture` id of each of the
//                                     chunk's four layers; 0 where the chunk has no such layer
//          +0x10  uint16 winner[8]    MCNK 0x40: row `r`, two bits per column at bit `c * 2`
//          +0x20  uint8  noDoodad[8]  MCNK 0x50: row `r`, one bit per column at bit `c`
//
// WHAT ABSENCE MEANS. The file is written for every tile, including a tile where every effect id
// is zero and nothing grows at all. A missing `<x>-<y>.cover.bin` therefore means "this tile was
// published before ground cover existed" and never "nothing here", which is what lets the gateway
// rebuild it on ENOENT without a cache version key and without anybody deleting a directory by
// hand. A chunk the ADT does not carry — a tile is allowed fewer than 256 — is left as forty zero
// bytes, which reads as "no layers, nothing grows", the same as an empty chunk.
//
// THE SECOND CONSUMER, checked before the layout was frozen. Footstep sounds need the terrain type
// under a foot: `GroundEffectTexture`'s last field, reached through the per-layer `effectId`,
// "which is not in
// the published tile". It is now: the four ids are the first sixteen bytes of every record, and
// the winner map says which of the four the foot is standing on, to the same 4.16667-yard cell
// the cover is scattered over. That consumer needs no new file and no new field — only the id of
// the row, which it looks up in `/dbc/ground-effects` exactly as the scatter does. The mask is
// the one thing it must *not* read: a road is walked on and grows nothing.

/** The first four bytes of the file, and the whole of its version. */
export const GROUND_COVER_MAGIC = "WGC1";
export const GROUND_COVER_VERSION = 1;
/** Bytes per chunk record. */
export const GROUND_COVER_STRIDE = 40;
/** Bytes before the first record. */
export const GROUND_COVER_HEADER = 8;
/** A tile is 16x16 chunks, and the file always carries all of them. */
export const GROUND_COVER_CHUNKS = 256;
export const GROUND_COVER_SIZE = GROUND_COVER_HEADER + GROUND_COVER_CHUNKS * GROUND_COVER_STRIDE;

/**
 * Assembles one tile's recipe from the chunks the splat generator has already parsed.
 *
 * Each chunk needs `row`, `column`, its `layers` (each with an `effectId`) and the `winner` and
 * `noDoodad` arrays `mapChunkDetail` read out of its header. Anything missing is written as zero,
 * which is the "nothing grows" value for every field in the record.
 */
export function encodeGroundCover(chunks) {
  const data = Buffer.alloc(GROUND_COVER_SIZE);
  data.write(GROUND_COVER_MAGIC, 0, "latin1");
  data.writeUInt8(GROUND_COVER_VERSION, 4);
  data.writeUInt8(GROUND_COVER_STRIDE, 5);
  data.writeUInt16LE(GROUND_COVER_CHUNKS, 6);
  for (const chunk of chunks) {
    if (chunk.row > 15 || chunk.column > 15) throw new Error(`Ground cover: chunk ${chunk.column}/${chunk.row} is outside the tile`);
    const at = GROUND_COVER_HEADER + (chunk.row * 16 + chunk.column) * GROUND_COVER_STRIDE;
    for (let slot = 0; slot < 4; slot++) data.writeUInt32LE(chunk.layers[slot]?.effectId ?? 0, at + slot * 4);
    for (let row = 0; row < 8; row++) {
      data.writeUInt16LE(chunk.detail?.winner[row] ?? 0, at + 0x10 + row * 2);
      data.writeUInt8(chunk.detail?.noDoodad[row] ?? 0, at + 0x20 + row);
    }
  }
  return data;
}
