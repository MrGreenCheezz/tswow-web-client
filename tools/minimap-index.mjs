/**
 * `textures\Minimap\md5translate.trs`: the index that says which BLP holds which minimap tile.
 *
 * Every minimap bake in the archives is stored under an MD5 of its own path, not under the name it
 * was made from, so `textures\Minimap\Azeroth\map31_49.blp` does not exist and
 * `textures\Minimap\<32 hex>.blp` does. This file is the only thing that connects the two, and
 * without it the minimap has 14,420 nameless pictures and no way to pick one.
 *
 * Measured against the archives this project reads (19,090 lines, 445 `dir:` sections, 18,644
 * mappings, 14,420 unique hashes):
 *
 * * The file is CRLF and tab-delimited, with **exactly one tab** on every mapping line.
 * * A key always carries its own directory prefix, so the `dir:` headers are decoration — all
 *   18,644 of them agree with the section they sit in.
 * * There are **no duplicate keys at all**, so nothing here has to decide which of two wins.
 * * A stock tile is `map%02d_%02d.blp`, always two digits on both halves — all 7,534 of them. The
 *   rest of the file is baked WMO and doodad art, which this client does not use.
 */

export const MINIMAP_TRS = "textures\\Minimap\\md5translate.trs";

/**
 * A tile name, split back into its two numbers. Anything else is not a tile.
 *
 * One digit or two, because a custom map's tiles are not written the way the stock ones are. tswow
 * appends its own lines to this file and strips the leading zero from the *first* number on the way
 * in — «md5translate quirk: only y padded with 0 (mapx_0y), we must remove it from x»
 * (BuildMinimaps.ts:123-128) — so a tile at first index 8 is `map8_30.blp`, and the two-digit rule
 * this used to carry dropped it. On a 64×64 grid that is 10 of the 64 possible values, and a custom
 * map narrow enough to live inside them had no minimap at all. Nothing stock is affected: all 7,534
 * tile lines in the file on this machine are two digits on both halves, and the looser pattern
 * matches every one of them and nothing new.
 */
const TILE_NAME = /^map(\d{1,2})_(\d{1,2})\.blp$/i;

/**
 * The whole index, keyed by lower-cased `<directory>\<file>.blp` and holding the bare hash without
 * its extension — which is what a texture path is built from.
 */
export function parseMd5Translate(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer);
  const index = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("dir:")) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const key = line.slice(0, tab).trim().toLowerCase();
    const hash = line.slice(tab + 1).trim();
    if (!key || !hash) continue;
    index.set(key, hash.replace(/\.blp$/i, ""));
  }
  return index;
}

/**
 * The key for one tile of one map, in the stock spelling with both halves padded.
 *
 * Nothing calls this: both minimap generators enumerate a map with `tilesOfMap` rather than ask for
 * one tile at a time, and that is just as well, because a custom map's tiles are written without
 * the padding on the first number (see `TILE_NAME`) and a key built here would not find one. It
 * cannot be made right on its own — from a grid position alone there is no way to know whether the
 * tile is stock or a module's. The ordering of the two numbers is explained on `tilesOfMap`, which
 * is the function that is measured.
 */
export function minimapTileKey(directory, gridX, gridY) {
  return `${directory.toLowerCase()}\\map${pad(gridY)}_${pad(gridX)}.blp`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** Reads the index straight out of an open archive chain. */
export async function loadMinimapIndex(archives) {
  const data = await archives.read(MINIMAP_TRS);
  if (!data) throw new Error(`${MINIMAP_TRS} is not in the client`);
  return parseMd5Translate(data);
}

/**
 * Every tile of one map, as `{ "<gridX>-<gridY>": "<hash>" }` — the repository's own index order,
 * so that nothing downstream ever has to think about the ADT ordering again.
 *
 * The two numbers in a tile's *name* are **not** in that order. A minimap tile is named the way its
 * ADT is — `<Name>_<gridY>_<gridX>.adt`, which is what `generate-terrain-tile.mjs` already builds —
 * because both come out of the same extraction, and swapping them here does not fail: `map31_49`
 * and `map49_31` are both real files in other parts of the world, so the wrong order quietly draws
 * a different continent under the character. `tests/minimap.test.mjs` pins the reading (a tile
 * named `map8_30` is row 8, column 30) and the per-directory counts this client answers with.
 */
export function tilesOfMap(index, directory) {
  const prefix = `${directory.toLowerCase()}\\`;
  const tiles = {};
  for (const [key, hash] of index) {
    if (!key.startsWith(prefix)) continue;
    const name = TILE_NAME.exec(key.slice(prefix.length));
    if (!name) continue;
    const gridY = Number(name[1]);
    const gridX = Number(name[2]);
    tiles[`${gridX}-${gridY}`] = hash;
  }
  return tiles;
}

/** Where a hash lives once it is a texture path the gateway understands. */
export function minimapTexturePath(hash) {
  return `textures\\Minimap\\${hash}.blp`;
}
