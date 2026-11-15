// 15.11 (7.09 slice B, 7.31): the liquid layers a client ADT authors, read the way Wow.exe reads them.
//
// The dataset's `.map` files carry a height and a type per cell and nothing else. The client's own
// ADT carries, per chunk and per layer, what the original draws with: the vertex format, the heights,
// a depth byte per vertex (water) or the texture coordinates (magma and slime), and the masks. This
// reader turns one ADT into that, in the tile's own cell grid, for `/liquid/adt` (see
// `tools/generate-adt-liquid.mjs`). Pure: bytes in, an object out.
//
// The grid. A tile is 16 x 16 chunks of 8 x 8 cells; a chunk's index is `i * 16 + j`, `i` along the
// tile's rows (world X falling) and `j` along its columns (world Y falling), the order of the MCNK
// chunks and of the MH2O headers. Wow.exe's own lookup 0x007a0820 indexes them so (X picks the row
// block, Y the column block), and TrinityCore's extractor writes the `.map` this client already draws
// in the same order — so a cell here is the cell `#waterGeometrySteps` builds. Inside a layer, `x`
// runs along the columns and `y` along the rows (0x007c5690: +0x38/+0x40 from the instance's bytes
// +0x0c/+0x0e, +0x34/+0x3c from +0x0d/+0x0f; 0x007ce1f0 tests column against the first pair).
// Vertices are row-major, `(w + 1) * (h + 1)` of them (0x008a3280).
//
// MH2O (0x007c5690, second loop): 256 headers of { u32 ofsInstances, u32 layers, u32 ofsAttributes };
// an instance is { u16 LiquidType, u16 vertex format, f32 min, f32 max, u8 x, y, w, h, u32 ofsMask,
// u32 ofsVertex } — the format is the file's own word (+2 -> instance +8), and 0x007ce390 takes a
// format-1 vertex's texture coordinates from the file. The vertex block (0x008a3130, 0x008a3160,
// 0x008a31b0): format 0 heights f32[n] then depth u8[n]; format 1 heights f32[n] then (u16 s, u16 t)[n];
// format 2 depth u8[n] only (an absent block reads depth 255). Format 3 is read by none of the three.
// The mask is w*h bits, low bit first, row-major (TrinityCore reads it so; an absent mask is all set).
// The attributes are two 64-bit cell masks, fishable and deep.
//
// MCLQ (0x007c5690, first loop): inside MCNK, one layer per flag 0x04, 0x08, 0x10, 0x20 in that
// order, each { f32 min, f32 max, 81 vertices of 8 bytes, 64 cell bytes, 84 bytes of flow } (0xc9
// dwords). The layer's LiquidType is 1 to 4 by the flag — water, ocean, magma, slime — except that on
// map 530 the magma flag is 15 "Green Lava" (the `DAT_00adfbc4 == 0x212` test); its vertex format is
// its LiquidMaterial's: 0 for water and ocean, 1 for magma, slime and green lava in this client. A
// vertex is { u8 depth, u8 flow, u8 flow, u8 pad, f32 height } in format 0 and { u16 s, u16 t, f32
// height } in format 1 (0x008a3200, 0x008a3220, 0x008a3250). A cell byte's low nibble is 0x0f for
// "no liquid here", 0x40 fishable, 0x80 fatigue (0x007ce180).

/** The version of the answer `/liquid/adt` serves; the route and the browser name it. */
export const ADT_LIQUID_VERSION = 1;

/** Wow.exe 0x007c5690: the MCNK flags of the four old-format layers, in the order they are stored. */
const MCLQ_FLAGS = [0x04, 0x08, 0x10, 0x20];
const MCLQ_LAYER_BYTES = 0xc9 * 4;
const MCNK_HEADER_BYTES = 0x80;
const OUTLAND = 530;
const GREEN_LAVA = 15;

function tag(data, offset) {
  return data.toString("latin1", offset, offset + 4);
}

/** Heights to a tenth of a millimetre: the file's floats, without twenty digits apiece in the JSON. */
function height(value) {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : 0;
}

function u64Hex(data, offset) {
  const low = data.readUInt32LE(offset).toString(16).padStart(8, "0");
  const high = data.readUInt32LE(offset + 4).toString(16).padStart(8, "0");
  return `${high}${low}`;
}

/** The MH2O instances of one chunk header. */
function readMh2oChunk(data, body, end, chunk, layers) {
  const header = body + chunk * 12;
  const ofsInstances = data.readUInt32LE(header);
  const count = data.readUInt32LE(header + 4);
  if (ofsInstances === 0 || count === 0) return;
  for (let layer = 0; layer < count; layer++) {
    const at = body + ofsInstances + layer * 24;
    if (at + 24 > end) break;
    const type = data.readUInt16LE(at);
    const format = data.readUInt16LE(at + 2);
    const x = data[at + 12], y = data[at + 13], w = data[at + 14], h = data[at + 15];
    if (w === 0 || h === 0 || x + w > 8 || y + h > 8) continue;
    const ofsMask = data.readUInt32LE(at + 16);
    const ofsVertex = data.readUInt32LE(at + 20);
    const n = (w + 1) * (h + 1);
    const entry = {
      chunk, source: "mh2o", type, format, x, y, w, h,
      min: height(data.readFloatLE(at + 4)), max: height(data.readFloatLE(at + 8)),
    };
    // The cells the layer covers. An absent mask is every cell (TrinityCore's reading of the same file).
    const exists = [];
    for (let cell = 0; cell < w * h; cell++) {
      exists.push(ofsMask === 0 ? 1 : (data[body + ofsMask + (cell >> 3)] >> (cell & 7)) & 1);
    }
    entry.exists = exists;
    const block = body + ofsVertex;
    if (ofsVertex !== 0 && (format === 0 || format === 1) && block + n * 4 <= end) {
      entry.heights = Array.from({ length: n }, (_, i) => height(data.readFloatLE(block + i * 4)));
    }
    if (ofsVertex !== 0 && format === 0 && block + n * 5 <= end) {
      entry.depths = Array.from({ length: n }, (_, i) => data[block + n * 4 + i]);
    } else if (format === 2) {
      entry.depths = ofsVertex === 0 || block + n > end
        ? new Array(n).fill(255)
        : Array.from({ length: n }, (_, i) => data[block + i]);
    }
    if (ofsVertex !== 0 && format === 1 && block + n * 8 <= end) {
      const uv = [];
      for (let i = 0; i < n; i++) uv.push(data.readUInt16LE(block + n * 4 + i * 4), data.readUInt16LE(block + n * 4 + i * 4 + 2));
      entry.uv = uv;
    }
    layers.push(entry);
  }
}

/** The MCLQ layers of one MCNK (`body` is the MCNK's data, after its tag and size). */
function readMclqChunk(data, body, size, map, layers) {
  const flags = data.readUInt32LE(body);
  if ((flags & 0x3c) === 0) return;
  const indexX = data.readUInt32LE(body + 4);
  const indexY = data.readUInt32LE(body + 8);
  const chunk = indexY * 16 + indexX;
  // The header's MCLQ offset (+0x60, from the MCNK's tag) when it names the tag; this client's files
  // leave it 0, so otherwise the tag is looked for after the header, as env4's probe found all 461
  // of Shadowmoon Valley's chunks (`.runtime/re-2026-11-11/env4/mclq-uv.mjs`).
  const end = body + size;
  const named = data.readUInt32LE(body + 0x60);
  let liquid = -1;
  if (named >= 8 + MCNK_HEADER_BYTES && body - 8 + named + 8 <= end && tag(data, body - 8 + named) === "QLCM") {
    liquid = body - 8 + named + 8;
  } else {
    const found = data.indexOf("QLCM", body + MCNK_HEADER_BYTES, "latin1");
    if (found >= 0 && found + 8 <= end) liquid = found + 8;
  }
  if (liquid < 0) return;
  for (let slot = 0; slot < 4; slot++) {
    if (!(flags & MCLQ_FLAGS[slot])) continue;
    if (liquid + MCLQ_LAYER_BYTES > data.length) break;
    const type = map === OUTLAND && slot === 2 ? GREEN_LAVA : slot + 1;
    const format = slot >= 2 ? 1 : 0;
    const entry = {
      chunk, source: "mclq", type, format, x: 0, y: 0, w: 8, h: 8,
      min: height(data.readFloatLE(liquid)), max: height(data.readFloatLE(liquid + 4)),
    };
    const heights = [];
    const extra = [];
    for (let v = 0; v < 81; v++) {
      const vertex = liquid + 8 + v * 8;
      heights.push(height(data.readFloatLE(vertex + 4)));
      if (format === 1) extra.push(data.readUInt16LE(vertex), data.readUInt16LE(vertex + 2));
      else extra.push(data[vertex]);
    }
    entry.heights = heights;
    if (format === 1) entry.uv = extra;
    else entry.depths = extra;
    const cells = [];
    for (let cell = 0; cell < 64; cell++) cells.push(data[liquid + 8 + 81 * 8 + cell]);
    entry.cells = cells;
    entry.exists = cells.map((value) => ((value & 0x0f) === 0x0f ? 0 : 1));
    layers.push(entry);
    liquid += MCLQ_LAYER_BYTES;
  }
}

/**
 * Every liquid layer of one ADT. `map` is the Map.dbc id (it decides map 530's green lava).
 * `layers` are ordered by chunk, then as the file stores them; `attributes` maps an MH2O chunk to its
 * fishable and deep masks (16 hex digits each, high word first).
 */
export function readAdtLiquid(data, map) {
  const layers = [];
  const attributes = {};
  for (let at = 0; at + 8 <= data.length;) {
    const name = tag(data, at);
    const size = data.readUInt32LE(at + 4);
    const body = at + 8;
    const end = Math.min(data.length, body + size);
    if (name === "O2HM") {
      for (let chunk = 0; chunk < 256 && body + chunk * 12 + 12 <= end; chunk++) {
        readMh2oChunk(data, body, end, chunk, layers);
        const ofsAttributes = data.readUInt32LE(body + chunk * 12 + 8);
        const count = data.readUInt32LE(body + chunk * 12 + 4);
        if (count > 0 && ofsAttributes !== 0 && body + ofsAttributes + 16 <= end) {
          attributes[chunk] = { fishable: u64Hex(data, body + ofsAttributes), deep: u64Hex(data, body + ofsAttributes + 8) };
        }
      }
    } else if (name === "KNCM") {
      readMclqChunk(data, body, end - body, map, layers);
    }
    at = body + size;
  }
  layers.sort((a, b) => a.chunk - b.chunk);
  return { version: ADT_LIQUID_VERSION, layers, attributes };
}
