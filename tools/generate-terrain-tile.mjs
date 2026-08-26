import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { MCLY_ALPHA_COMPRESSED, MPHD_BIG_ALPHA, alphaNeedsEdgeFix, decodeAlpha, mapChunkAlpha, mapChunkGrid } from "./adt-alpha.mjs";
import { decodeBlp } from "./blp.mjs";
import { openDbcFile } from "./dbc.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { stampGenerated } from "./source-stamp.mjs";

const CHUNK_PIXELS = 64;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapId = Number.parseInt(process.argv[2] ?? "", 10);
const gridX = Number.parseInt(process.argv[3] ?? "", 10);
const gridY = Number.parseInt(process.argv[4] ?? "", 10);
if (![mapId, gridX, gridY].every(Number.isInteger) || mapId < 0 || gridX < 0 || gridX > 63 || gridY < 0 || gridY > 63) {
  throw new Error("Usage: node tools/generate-terrain-tile.mjs <map> <grid-x> <grid-y>");
}

const destination = resolve(root, process.env.TERRAIN_TEXTURE_DIR ?? "data/terrain-textures", String(mapId), `${gridX}-${gridY}.png`);

const mapName = await internalMapName(dbcDirectory(), mapId);
if (!mapName) throw new Error(`Map.dbc has no map ${mapId}`);
const MAP_PATH = `World\\Maps\\${mapName}\\${mapName}`;

const archives = await clientArchives(clientDirectory());
{
  const adtPath = MAP_PATH + `_${gridY}_${gridX}.adt`;
  const adt = await archives.read(adtPath);
  if (!adt) throw new Error(adtPath + " is not in the client");
  const bigAlpha = mapUsesBigAlpha(await archives.read(MAP_PATH + ".wdt"));
  const parsed = parseAdt(adt, bigAlpha);

  const textures = [];
  for (const path of parsed.textures) {
    const blp = await archives.read(path);
    try {
      textures.push(blp ? decodeBlp(blp) : undefined);
    } catch {
      textures.push(undefined);
    }
  }

  const output = new PNG({ width: CHUNK_PIXELS * 16, height: CHUNK_PIXELS * 16 });
  for (const chunk of parsed.chunks) paintChunk(output, chunk, textures);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, PNG.sync.write(output, { colorType: 2 }));
  // The tile, the map's own header — which decides how its alpha maps are read — and every ground
  // texture painted into the picture.
  await stampGenerated(destination, archives, { paths: [adtPath, MAP_PATH + ".wdt", ...parsed.textures] });
  console.log(`Generated terrain texture ${mapId}/${gridX}/${gridY}: ${mapName}, ${parsed.textures.length} BLP textures, ${bigAlpha ? "8 bit" : "4 bit"} alpha maps`);
}
archives.close();

/** The internal directory name of a map, e.g. 0 -> "Azeroth". */
async function internalMapName(directory, id) {
  const maps = await openDbcFile(directory, "Map");
  const row = maps.rowOf(id);
  return row === undefined ? undefined : maps.string(row, "Directory");
}

// Northrend stores 4096 byte alpha maps, the older continents 2048 byte ones. Only the
// WDT says which, so guessing from the payload length mixes the two formats up.
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
  return { column, row, layers };
}

function paintChunk(output, chunk, textures) {
  for (let y = 0; y < CHUNK_PIXELS; y++) {
    for (let x = 0; x < CHUNK_PIXELS; x++) {
      const alphaX = Math.floor(x / CHUNK_PIXELS * 64);
      const alphaY = Math.floor(y / CHUNK_PIXELS * 64);
      const pixel = alphaY * 64 + alphaX;
      const color = sample(textures[chunk.layers[0].texture], x, y, chunk.layers[0].texture);
      for (let layerIndex = 1; layerIndex < chunk.layers.length; layerIndex++) {
        const layer = chunk.layers[layerIndex];
        const alpha = layer.alpha?.[pixel] ?? 0;
        if (alpha === 0) continue;
        const overlay = sample(textures[layer.texture], x, y, layer.texture);
        const inverse = 255 - alpha;
        color[0] = (color[0] * inverse + overlay[0] * alpha) / 255;
        color[1] = (color[1] * inverse + overlay[1] * alpha) / 255;
        color[2] = (color[2] * inverse + overlay[2] * alpha) / 255;
      }
      const targetX = chunk.column * CHUNK_PIXELS + x;
      const targetY = chunk.row * CHUNK_PIXELS + y;
      const target = (targetY * output.width + targetX) * 4;
      output.data[target] = color[0];
      output.data[target + 1] = color[1];
      output.data[target + 2] = color[2];
      output.data[target + 3] = 255;
    }
  }
}

function sample(texture, x, y, seed) {
  if (!texture) return [48 + seed * 31 % 80, 68 + seed * 17 % 70, 42 + seed * 13 % 55];
  const sourceX = Math.floor(x / CHUNK_PIXELS * texture.width) % texture.width;
  const sourceY = Math.floor(y / CHUNK_PIXELS * texture.height) % texture.height;
  const offset = (sourceY * texture.width + sourceX) * 4;
  return [texture.data[offset], texture.data[offset + 1], texture.data[offset + 2]];
}

function reversedTag(data, offset) {
  return [...data.subarray(offset, offset + 4)].reverse().map((value) => String.fromCharCode(value)).join("");
}
