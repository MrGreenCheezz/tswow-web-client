const WORLD_MID = 0.5 * 64 * 533.33333333;

export function parseAdtPlacements(data) {
  const chunks = new Map();
  for (let offset = 0; offset + 8 <= data.length;) {
    const tag = [...data.subarray(offset, offset + 4)].reverse().map((value) => String.fromCharCode(value)).join("");
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > data.length) throw new Error(`Truncated ADT ${tag} chunk`);
    chunks.set(tag, data.subarray(start, end));
    offset = end;
  }
  const m2Names = names(chunks.get("MMDX"), chunks.get("MMID"));
  const wmoNames = names(chunks.get("MWMO"), chunks.get("MWID"));
  const objects = [
    ...placements(chunks.get("MDDF"), 36, "m2", m2Names),
    ...placements(chunks.get("MODF"), 64, "wmo", wmoNames),
  ];
  if (objects.length > 10_000) throw new RangeError(`ADT contains too many visual objects: ${objects.length}`);
  return objects;
}

/**
 * The placements of a WDT that carries a global map object (MPHD flag 0x1), or undefined.
 *
 * A WDT's MWMO/MODF are the ADT's own chunks (no MWID — the name list is read in order, which is
 * what `parseAdtPlacements` does without one), so the placements come out in the same shape.
 */
export function globalMapObjects(wdt) {
  for (let offset = 0; offset + 8 <= wdt.length;) {
    const tag = [...wdt.subarray(offset, offset + 4)].reverse().map((value) => String.fromCharCode(value)).join("");
    const size = wdt.readUInt32LE(offset + 4);
    if (tag === "MPHD") {
      if (size < 4 || (wdt.readUInt32LE(offset + 8) & 0x1) === 0) return undefined;
      const placements = parseAdtPlacements(wdt).filter((object) => object.kind === "wmo").map(centreGlobalObject);
      return placements.length > 0 ? placements : undefined;
    }
    offset += 8 + size;
  }
  return undefined;
}

/**
 * A global object's MODF names its position with x = z = 0, which in an ADT's convention would put
 * it in the map's far corner. The vmap extractor TrinityCore's collision is built from reads that
 * pair as the middle of the map (`vmap4_extractor/wmo.cpp` `MapObject::Extract`: "if (x == 0 && z ==
 * 0) position.x = position.z = 533.33333f * 32"), and every one of the 39 such maps here sits at
 * world (0, 0) in its `.vmtree`. The same shift is applied to the record's box, which the extractor
 * leaves in the same space as the position. A global object placed anywhere else is left as read.
 */
function centreGlobalObject(object) {
  if (object.x !== WORLD_MID || object.y !== WORLD_MID) return object;
  const bounds = object.bounds && {
    minX: object.bounds.minX - WORLD_MID, maxX: object.bounds.maxX - WORLD_MID,
    minY: object.bounds.minY - WORLD_MID, maxY: object.bounds.maxY - WORLD_MID,
    minZ: object.bounds.minZ, maxZ: object.bounds.maxZ,
  };
  return { ...object, x: 0, y: 0, ...(bounds ? { bounds } : {}) };
}

/** The edge of one ADT cell in yards. */
const CELL = 533.33333333;

/**
 * Whether a placement's box reaches cell (gridX, gridY), the cell the browser's `terrainGrid`
 * puts a world point in: gridX = ⌊32 − x/533⅓⌋, gridY = ⌊32 − y/533⅓⌋.
 */
export function placementReachesCell(placement, gridX, gridY) {
  const box = placement.bounds ?? { minX: placement.x, maxX: placement.x, minY: placement.y, maxY: placement.y };
  return box.maxX >= (32 - gridX - 1) * CELL && box.minX <= (32 - gridX) * CELL
    && box.maxY >= (32 - gridY - 1) * CELL && box.minY <= (32 - gridY) * CELL;
}

function names(strings, indices) {
  if (!strings) return [];
  const offsets = [];
  if (indices) {
    if (indices.length % 4 !== 0) throw new Error("ADT name index chunk is misaligned");
    for (let offset = 0; offset < indices.length; offset += 4) offsets.push(indices.readUInt32LE(offset));
  } else {
    for (let offset = 0; offset < strings.length;) {
      offsets.push(offset);
      const end = strings.indexOf(0, offset);
      if (end < 0) break;
      offset = end + 1;
    }
  }
  return offsets.map((offset) => cString(strings, offset));
}

/**
 * The world-space box a WMO placement occupies, from bytes 32..55 of its MODF record.
 *
 * A building is not its origin. Stormwind's placement point is one spot near the Valley of
 * Heroes and its box spans 1488 by 1488 by 376 yards, so anything that ranks the city by the
 * distance to that point loses it from five of its seven districts: Old Town is 260 metres away,
 * the Dwarven District 508. The box travels so that the distance can be measured to the building
 * rather than to the pin.
 *
 * Converted the same way the position above it is — the axes are swapped and two of them
 * negated, so the minimum of one is the maximum of another.
 */
function extents(data, at) {
  const values = [];
  for (let index = 0; index < 6; index++) values.push(data.readFloatLE(at + index * 4));
  const [lowX, lowY, lowZ, highX, highY, highZ] = values;
  if (!values.every(Number.isFinite)) return undefined;
  return {
    minX: WORLD_MID - highZ, maxX: WORLD_MID - lowZ,
    minY: WORLD_MID - highX, maxY: WORLD_MID - lowX,
    minZ: lowY, maxZ: highY,
  };
}

function placements(data, stride, kind, modelNames) {
  if (!data) return [];
  if (data.length % stride !== 0) throw new Error(`ADT ${kind} placement chunk is misaligned`);
  const result = [];
  for (let offset = 0; offset < data.length; offset += stride) {
    const id = data.readUInt32LE(offset);
    let name = modelNames[id];
    if (!name) continue;
    name = name.replaceAll("/", "\\");
    if (kind === "m2") name = name.replace(/\.(mdx|mdl)$/i, ".m2");
    const rawX = data.readFloatLE(offset + 8);
    const rawY = data.readFloatLE(offset + 12);
    const rawZ = data.readFloatLE(offset + 16);
    result.push({
      id: data.readUInt32LE(offset + 4),
      kind,
      name,
      x: WORLD_MID - rawZ,
      y: WORLD_MID - rawX,
      z: rawY,
      rotationX: data.readFloatLE(offset + 20),
      rotationY: data.readFloatLE(offset + 24),
      rotationZ: data.readFloatLE(offset + 28),
      scale: kind === "m2" ? data.readUInt16LE(offset + 32) / 1024 : 1,
      ...(kind === "wmo" ? { doodadSet: data.readUInt16LE(offset + 58), bounds: extents(data, offset + 32) } : {}),
    });
  }
  return result;
}

function cString(data, offset) {
  if (offset < 0 || offset >= data.length) return "";
  const end = data.indexOf(0, offset);
  return data.subarray(offset, end < 0 ? data.length : end).toString("utf8");
}
