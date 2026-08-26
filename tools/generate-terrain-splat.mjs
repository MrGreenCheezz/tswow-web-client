// Terrain splat data for one ADT tile.
//
// The old path baked the whole tile into one 1024x1024 picture: 1.9 pixels per metre, with each
// ground texture stretched flat across a 33 metre chunk instead of tiling inside it. That is why
// the ground looked like a low resolution photograph. This ships the ingredients instead — the
// ground textures at their own resolution, the per-chunk layer list and the alpha maps — and lets
// the fragment shader blend them, so sharpness is limited only by the source art.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { MCLY_ALPHA_COMPRESSED, MPHD_BIG_ALPHA, alphaNeedsEdgeFix, decodeAlpha, mapChunkAlpha, mapChunkColours, mapChunkDetail, mapChunkGrid } from "./adt-alpha.mjs";
import { encodeGroundCover } from "./ground-cover.mjs";
import { decodeBlp } from "./blp.mjs";
import { openDbcFile } from "./dbc.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { sourceStamp, stampGenerated, stampIsCurrent, writeSourceStamp } from "./source-stamp.mjs";

/** Every ground texture is republished at this size so they can share one GPU texture array. */
export const LAYER_SIZE = 256;
const ALPHA_SIDE = 64;
const CHUNKS_PER_SIDE = 16;
/** The vertex grid the browser rebuilds a tile on: 16 chunks of 8 cells, plus the closing row. */
const VERTEX_SIDE = CHUNKS_PER_SIDE * 8 + 1;
/** `MCCV` is a two-times multiplier, so an unpainted vertex is 127 and not 255. */
const MCCV_NEUTRAL = 127;
/** A tile may not use more distinct ground textures than one array can hold. */
const MAX_LAYERS = 32;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapId = Number.parseInt(process.argv[2] ?? "", 10);
const gridX = Number.parseInt(process.argv[3] ?? "", 10);
const gridY = Number.parseInt(process.argv[4] ?? "", 10);
if (![mapId, gridX, gridY].every(Number.isInteger) || mapId < 0 || gridX < 0 || gridX > 63 || gridY < 0 || gridY > 63) {
  throw new Error("Usage: node tools/generate-terrain-splat.mjs <map> <grid-x> <grid-y>");
}

const textureDirectory = resolve(root, process.env.TERRAIN_TEXTURE_DIR ?? "data/terrain-textures", String(mapId));
// Ground textures are shared between neighbouring tiles, so they live in one flat directory
// keyed by content: the browser then downloads each of them exactly once.
const layerDirectory = resolve(root, process.env.TERRAIN_LAYER_DIR ?? "data/terrain-layers");

const mapName = await internalMapName(dbcDirectory(), mapId);
if (!mapName) throw new Error(`Map.dbc has no map ${mapId}`);

const archives = await clientArchives(clientDirectory());
{
  const adtPath = `World\\Maps\\${mapName}\\${mapName}_${gridY}_${gridX}.adt`;
  const adt = await archives.read(adtPath);
  if (!adt) throw new Error(`${adtPath} is not in the client`);
  const bigAlpha = mapUsesBigAlpha(await archives.read(`World\\Maps\\${mapName}\\${mapName}.wdt`));
  const parsed = parseAdt(adt, bigAlpha);
  if (parsed.textures.length > MAX_LAYERS) throw new Error(`ADT uses ${parsed.textures.length} ground textures, more than the ${MAX_LAYERS} one array holds`);

  await mkdir(layerDirectory, { recursive: true });
  const missingTextures = [];
  const layers = [];
  for (let index = 0; index < parsed.textures.length; index++) {
    const id = createHash("sha1").update(`terrain-layer-v1\0${parsed.textures[index].toLowerCase()}`).digest("hex");
    layers.push(id);
    const destination = join(layerDirectory, `${id}.png`);
    // Skipped because it is still the same picture, not merely because a file with that name is
    // there. The id is the hash of the BLP's path, so a module that replaces the path's content
    // publishes under the same name: `access` alone would step over the stale grass every time
    // the tile around it was rebuilt, and nothing else in the machine ever rewrites a layer —
    // `/terrain-layer` cannot, since an id does not say which path it came from.
    if (await stampIsCurrent(destination, archives, { paths: [parsed.textures[index]] })) continue;
    let decoded;
    const blp = await archives.read(parsed.textures[index]);
    try {
      if (blp) decoded = decodeBlp(blp);
    } catch (error) {
      missingTextures.push(`${parsed.textures[index]} (${error instanceof Error ? error.message : error})`);
    }
    // A ground texture that will not decode becomes a flat colour rather than a hole, which is
    // right for the render but invisible in the log unless it is named here.
    if (!decoded) missingTextures.push(parsed.textures[index]);
    await writeFile(destination, PNG.sync.write(layerPng(decoded, index), { colorType: 6 }));
    await stampGenerated(destination, archives, { paths: [parsed.textures[index]] });
  }

  // One 1024x1024 picture holds every chunk's three overlay alpha maps in its colour channels,
  // laid out exactly like the terrain UVs, so the shader reads it with the mesh's own coordinates.
  // The 16x16 companion names the four ground textures each chunk draws with, one per channel and
  // offset by one so that zero means "this chunk has no such layer". It is deliberately a picture
  // too: loaded the same way as the alpha map, it cannot end up flipped relative to it.
  //
  // A chunk goes in at row `chunk.row`, column `chunk.column` — which is MCNK `IndexY` down and
  // `IndexX` across, not the other way round. Measured on Azeroth_31_49: holding IndexY fixed and
  // walking IndexX 0 -> 15 moves the stored chunk position from y=533.3 to y=33.3 at constant
  // x=-9066.7, so IndexX runs east; holding IndexX fixed and walking IndexY moves x from -9066.7
  // to -9566.7, so IndexY runs south. The mesh's UVs are (east, 1 - south), so south is the row.
  // Writing them the other way transposed every tile about its own diagonal: scored against
  // Blizzard's minimap bake of that tile, the transposed layout correlates 0.088 and this one
  // 0.467. Snow hid it in Dun Morogh; in Elwynn it put dirt where the roads are not.
  const alpha = new PNG({ width: ALPHA_SIDE * CHUNKS_PER_SIDE, height: ALPHA_SIDE * CHUNKS_PER_SIDE });
  const index = new PNG({ width: CHUNKS_PER_SIDE, height: CHUNKS_PER_SIDE });
  for (const chunk of parsed.chunks) {
    const entry = (chunk.row * CHUNKS_PER_SIDE + chunk.column) * 4;
    for (let slot = 0; slot < 4; slot++) {
      const layer = chunk.layers[slot];
      index.data[entry + slot] = layer === undefined || layer.texture >= layers.length ? 0 : layer.texture + 1;
    }
    for (let y = 0; y < ALPHA_SIDE; y++) {
      for (let x = 0; x < ALPHA_SIDE; x++) {
        const source = y * ALPHA_SIDE + x;
        const target = ((chunk.row * ALPHA_SIDE + y) * alpha.width + chunk.column * ALPHA_SIDE + x) * 4;
        alpha.data[target] = chunk.layers[1]?.alpha?.[source] ?? 0;
        alpha.data[target + 1] = chunk.layers[2]?.alpha?.[source] ?? 0;
        alpha.data[target + 2] = chunk.layers[3]?.alpha?.[source] ?? 0;
        alpha.data[target + 3] = 255;
      }
    }
  }

  // The painted colours, on the one grid the browser rebuilds the ground on: 129 x 129 vertices,
  // which is exactly the chunks' own 9x9 corners with their duplicated edges collapsed. Measured
  // across 18,960,480 shared vertices, neighbouring chunks write byte-identical values there and
  // so do neighbouring tiles, so there is no seam to stitch and either chunk may answer.
  const painted = parsed.chunks.some((chunk) => chunk.colours);
  const colours = painted ? new PNG({ width: VERTEX_SIDE, height: VERTEX_SIDE }) : undefined;
  if (colours) {
    for (let row = 0; row < VERTEX_SIDE; row++) {
      const chunkRow = Math.min(row >> 3, CHUNKS_PER_SIDE - 1);
      for (let column = 0; column < VERTEX_SIDE; column++) {
        const chunkColumn = Math.min(column >> 3, CHUNKS_PER_SIDE - 1);
        const chunk = parsed.chunks.find((candidate) => candidate.row === chunkRow && candidate.column === chunkColumn);
        const entry = ((row - chunkRow * 8) * 17 + (column - chunkColumn * 8)) * 4;
        const target = (row * VERTEX_SIDE + column) * 4;
        // Stored B, G, R; neutral where the chunk was left unpainted.
        colours.data[target] = chunk?.colours?.[entry + 2] ?? MCCV_NEUTRAL;
        colours.data[target + 1] = chunk?.colours?.[entry + 1] ?? MCCV_NEUTRAL;
        colours.data[target + 2] = chunk?.colours?.[entry] ?? MCCV_NEUTRAL;
        colours.data[target + 3] = 255;
      }
    }
  }

  // What grows on this tile, as a recipe rather than as placements: four `GroundEffectTexture`
  // ids, the 8x8 map of which of them grows on each detail cell and the 8x8 mask of the cells
  // where nothing does. Written for every tile including the ones that grow nothing, so that a
  // missing file means "published before this existed" — see tools/ground-cover.mjs.
  const cover = encodeGroundCover(parsed.chunks);

  await mkdir(textureDirectory, { recursive: true });
  await writeFile(join(textureDirectory, `${gridX}-${gridY}.alpha.png`), PNG.sync.write(alpha, { colorType: 2 }));
  await writeFile(join(textureDirectory, `${gridX}-${gridY}.index.png`), PNG.sync.write(index, { colorType: 6 }));
  if (colours) await writeFile(join(textureDirectory, `${gridX}-${gridY}.mccv.png`), PNG.sync.write(colours, { colorType: 2 }));
  await writeFile(join(textureDirectory, `${gridX}-${gridY}.cover.bin`), cover);
  await writeFile(join(textureDirectory, `${gridX}-${gridY}.splat.json`), JSON.stringify({ layers, ...(colours ? { mccv: true } : {}) }));
  // Five files from one read of the tile, so all five carry the same stamp: each is served under
  // its own URL and each has to be able to say for itself whether it is still current.
  const stamp = await sourceStamp(archives, {
    paths: [adtPath, `World\\Maps\\${mapName}\\${mapName}.wdt`, ...parsed.textures],
  });
  for (const part of ["alpha.png", "index.png", ...(colours ? ["mccv.png"] : []), "cover.bin", "splat.json"]) {
    await writeSourceStamp(join(textureDirectory, `${gridX}-${gridY}.${part}`), stamp);
  }
  const growing = parsed.chunks.reduce((count, chunk) => count + chunk.layers.filter((layer) => layer.effectId !== 0).length, 0);
  console.log(`Generated terrain splat ${mapId}/${gridX}/${gridY}: ${mapName}, ${layers.length} ground textures, ${parsed.chunks.length} chunks, ${bigAlpha ? "8 bit" : "4 bit"} alpha maps, ${growing} layers with a ground effect`);
  if (missingTextures.length > 0) console.warn(`  ${missingTextures.length} ground texture(s) fell back to flat colour: ${missingTextures.join("; ")}`);
}
archives.close();

/** Rescales a decoded BLP to the common layer size; a missing texture becomes a flat colour. */
function layerPng(decoded, seed) {
  const png = new PNG({ width: LAYER_SIZE, height: LAYER_SIZE });
  if (!decoded || !decoded.width || !decoded.height) {
    const colour = [48 + seed * 31 % 80, 68 + seed * 17 % 70, 42 + seed * 13 % 55];
    for (let pixel = 0; pixel < LAYER_SIZE * LAYER_SIZE; pixel++) {
      png.data[pixel * 4] = colour[0];
      png.data[pixel * 4 + 1] = colour[1];
      png.data[pixel * 4 + 2] = colour[2];
      png.data[pixel * 4 + 3] = 255;
    }
    return png;
  }
  for (let y = 0; y < LAYER_SIZE; y++) {
    const sourceY = Math.min(decoded.height - 1, Math.floor(y * decoded.height / LAYER_SIZE));
    for (let x = 0; x < LAYER_SIZE; x++) {
      const sourceX = Math.min(decoded.width - 1, Math.floor(x * decoded.width / LAYER_SIZE));
      const source = (sourceY * decoded.width + sourceX) * 4;
      const target = (y * LAYER_SIZE + x) * 4;
      png.data[target] = decoded.data[source];
      png.data[target + 1] = decoded.data[source + 1];
      png.data[target + 2] = decoded.data[source + 2];
      png.data[target + 3] = 255;
    }
  }
  return png;
}

/** The internal directory name of a map, e.g. 0 -> "Azeroth". */
async function internalMapName(directory, id) {
  const maps = await openDbcFile(directory, "Map");
  const row = maps.rowOf(id);
  return row === undefined ? undefined : maps.string(row, "Directory");
}

function mapUsesBigAlpha(wdt) {
  if (!wdt) return false;
  for (let offset = 0; offset + 8 <= wdt.length;) {
    const size = wdt.readUInt32LE(offset + 4);
    if (reversedTag(wdt, offset) === "MPHD") return (wdt.readUInt32LE(offset + 8) & MPHD_BIG_ALPHA) !== 0;
    offset += 8 + size;
  }
  return false;
}


function parseAdt(data, bigAlpha) {
  const chunks = [];
  let textures = [];
  for (let offset = 0; offset + 8 <= data.length;) {
    const tag = reversedTag(data, offset);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > data.length) throw new Error(`Truncated ADT ${tag} chunk`);
    if (tag === "MTEX") textures = data.subarray(start, end).toString("latin1").split("\0").filter(Boolean);
    else if (tag === "MCNK") chunks.push(parseMapChunk(data, start, size, bigAlpha));
    offset = end;
  }
  if (textures.length === 0 || chunks.length === 0) throw new Error("ADT has no terrain textures or chunks");
  return { textures, chunks };
}

function parseMapChunk(data, start, size, bigAlpha) {
  const { column, row } = mapChunkGrid(data, start);
  const layerCount = data.readUInt32LE(start + 12);
  const layerOffset = data.readUInt32LE(start + 28);
  if (column > 15 || row > 15 || layerCount === 0 || layerCount > 4) throw new Error("Invalid ADT map chunk header");
  const { flags, alphaOffset, alphaSize } = mapChunkAlpha(data, start, size);
  if (start + layerOffset + layerCount * 16 > start + size) throw new Error("ADT map chunk data is truncated");
  const fixEdges = alphaNeedsEdgeFix(flags);
  const layers = [];
  for (let index = 0; index < layerCount; index++) {
    const offset = start + layerOffset + index * 16;
    layers.push({
      texture: data.readUInt32LE(offset),
      flags: data.readUInt32LE(offset + 4),
      alphaOffset: data.readUInt32LE(offset + 8),
      // MCLY is sixteen bytes and this is the last four of them. Nothing in this repository read
      // it until the ground-cover slice, which is why the ground was bare: it is the
      // `GroundEffectTexture` id, and 1,749,939 of the world's 2,055,671 layers carry one.
      effectId: data.readUInt32LE(offset + 12),
    });
  }
  for (let index = 1; index < layers.length; index++) {
    const layer = layers[index];
    const next = layers[index + 1];
    const end = Math.min(next ? next.alphaOffset : alphaSize, alphaSize);
    if (!alphaOffset || end <= layer.alphaOffset) continue;
    const payload = data.subarray(start + alphaOffset + layer.alphaOffset, start + alphaOffset + end);
    layer.alpha = decodeAlpha(payload, { compressed: (layer.flags & MCLY_ALPHA_COMPRESSED) !== 0, bigAlpha, fixEdges });
  }
  return { column, row, layers, detail: mapChunkDetail(data, start, size), colours: mapChunkColours(data, start, size) };
}

function reversedTag(data, offset) {
  return [...data.subarray(offset, offset + 4)].reverse().map((value) => String.fromCharCode(value)).join("");
}
