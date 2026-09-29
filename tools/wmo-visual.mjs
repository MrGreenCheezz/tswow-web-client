/** A MOPY triangle whose material is this belongs to the collision hull and is never drawn. */
const MOPY_MATERIAL_COLLISION_ONLY = 0xff;

/** MOMT material flags. Only the one that changes what three.js does is named. */
export const WMO_MATERIAL_UNCULLED = 0x04;

export function wmoDependencies(root, rootPath) {
  const chunks = chunkMap(root);
  const header = chunks.get("MOHD");
  if (!header || header.length < 64) throw new Error("WMO root has no valid MOHD chunk");
  const groupCount = header.readUInt32LE(4);
  if (groupCount === 0 || groupCount > 512) throw new Error(`WMO group count ${groupCount} is invalid`);
  const base = rootPath.replace(/\.wmo$/i, "");
  const materials = wmoMaterials(chunks.get("MOMT"), chunks.get("MOTX"));
  const materialTextures = materials.map((material) => material.texture);
  return {
    groups: Array.from({ length: groupCount }, (_, index) => `${base}_${String(index).padStart(3, "0")}.wmo`),
    texture: materialTextures.find(Boolean) ?? firstString(chunks.get("MOTX")),
    materialTextures,
    materials,
  };
}

/**
 * MOGP, the 68 bytes every group file opens with.
 *
 * Only three fields are read, and the offsets matter enough to write down: the flags word is at
 * 0x08, not 0x0C. Reading it at 0x0C lands on the first float of the bounding box, and every bit
 * then appears set on about half the groups — which is what a float looks like to a bit test, and
 * is how the mistake announces itself.
 */
const MOGP_FLAGS = 0x08;
const MOGP_BOUNDING_BOX = 0x0c;
const MOGP_PORTAL_START = 0x24;
const MOGP_PORTAL_COUNT = 0x26;
/**
 * The three words that split MOBA into transition, interior and exterior batches, in that order.
 *
 * They partition the batch list exactly — measured on the Goldshire Inn, Northshire Abbey and
 * Stormwind, `MOBA.length / 24` equals their sum on every one of the 306 groups between them.
 */
const MOGP_TRANSITION_BATCHES = 0x28;
const MOGP_INTERIOR_BATCHES = 0x2a;
const MOGP_EXTERIOR_BATCHES = 0x2c;
/**
 * Which of the root's MFOG records this group stands in — four one-byte indices, not four words.
 *
 * The width is the trap, and the reference client wrote it down after falling into it:
 * `wowee/src/pipeline/wmo_loader.cpp:474-478`, "fogIndices: 4 × uint8 (4 bytes total, NOT 4 ×
 * uint32)". Read as words it still fits the 68-byte header and is silently wrong: the first
 * "index" is all four bytes packed together and the other three are the group's liquid type, its
 * unique id and its second flags word. That 0x30 is the right offset is measured rather than
 * assumed — across the 9,346 group files under `World\wmo\`, not one group read here names a
 * record its own root does not have.
 */
const MOGP_FOG_IDS = 0x30;

/**
 * Which light a run of triangles is drawn in.
 *
 * Not the group's own indoor flag, and the difference is most of a city. 118 of Stormwind's 278
 * indoor groups hold exterior batches — 175,137 triangles, a quarter of the whole model, which are
 * the outward faces of rooms — and 2 of its outdoor groups hold interior ones. Lighting by the
 * group flag would draw every one of those in the wrong light: a wall facing the street shaded as
 * if it were in a windowless room, with no sun on it at all.
 *
 * A transition batch is counted as interior. It is the boundary geometry the client fades between
 * the two, and the fade factor it would need is MOCV's alpha — which cannot be trusted here: it is
 * 0 on 86% of the Goldshire Inn's coloured vertices and 255 on 90% of Stormwind's, so the two
 * files disagree about which end of the fade zero means. Interior keeps a doorway's frame lit like
 * the room it belongs to, which is where it is seen from.
 */
export const WMO_LIGHT_EXTERIOR = 0;
export const WMO_LIGHT_INTERIOR = 1;
export const WMO_LIGHT_TRANSITION = 2;

/**
 * `MOGP.flags` bit 13: this group is indoors.
 *
 * It is what separates a building's inside from its porch and its roof, which are groups of the
 * same model. Measured on Stormwind, 278 of 286 groups carry it — a city is mostly interior — and
 * on the Goldshire inn 6 of 8.
 */
export const WMO_GROUP_INDOOR = 0x2000;
/**
 * Bit 2: the group carries baked vertex colours.
 *
 * Verified rather than assumed: across Stormwind's 286 groups this bit is set on exactly the 192
 * that contain a MOCV chunk, with one colour per vertex on all 192 and not a single disagreement
 * either way. 190 of those 192 are also indoor.
 */
export const WMO_GROUP_HAS_COLOURS = 0x04;

/** MOGI, the root's own copy of each group's flags and box. 32 bytes: flags, box, name offset. */
const MOGI_SIZE = 32;
/** MOPT: a portal is a polygon in MOPV plus the plane it lies in. */
const MOPT_SIZE = 20;
/** MOPR: which portal joins which group, and which side of it that group is on. */
const MOPR_SIZE = 8;

/**
 * The ambient light the model carries for its own interiors, as `MOHD.ambColor`.
 *
 * Stored BGRA. Whether it is light *on top of* the baked colours or light already *inside* them
 * depends on the model's render path — see {@link wmoRenderFlags}.
 */
function wmoAmbient(mohd) {
  if (!mohd || mohd.length < 32) return [0, 0, 0];
  const packed = mohd.readUInt32LE(28);
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

/**
 * `MOHD.flags`, the u16 at 60: which of the client's two WMO pipelines draws this model.
 *
 * Bit 0x2 picks `Shaders\Effects\MapObjU.wfx` (unified) over `MapObj.wfx` (classic), and the two
 * disagree about MOCV: the classic vertex shader `MapObjDiffuse_T1` multiplies it into the light,
 * the unified `MapObjUDiffuse_T1` adds it, and the classic load step
 * (`CMapObjGroup::FixColorVertexAlpha`) takes `ambColor` back out of MOCV because the classic
 * tool baked it in. Bit 0x8 skips that load step. Measured over the stock client's 1,985 root
 * WMOs: 1,823 classic (0x0 ×1,066, 0x5 ×440, 0x1 ×317) and 162 unified (0xF ×124 — Stormwind,
 * Dalaran, Icecrown — 0x7 ×19, 0x3 ×19). The bake shows in the data: Gundrak's 171,138 vertices
 * sit at or above its ambient (64, 50, 61) in every channel on 98.5% and exactly on it on 35.4%,
 * Stormwind's are above its (33, 33, 33) on 19.5% and on it on none. Undefined on a short header.
 */
function wmoRenderFlags(mohd) {
  if (!mohd || mohd.length < 62) return undefined;
  return mohd.readUInt16LE(60);
}

/**
 * MOLT, the lamps the artist hung inside the building. 48 bytes each.
 *
 * These are what the baked colours are dark *because of*. Measured across Stormwind's 184 interior
 * groups, not one has a median baked luminance above 64 out of 255 and most are under 20 — and the
 * 95 groups that carry light references are the darker half (median 14 against 24). A room with
 * lamps in it is painted dim on purpose, because the lamps are meant to light it.
 *
 * The layout is read off the data rather than assumed: type is 0 on all 616 records in the two
 * buildings measured, which is an omni light; byte 1 is the attenuation switch and is 1 on every
 * one; the colour is BGRA and comes out as candle-warm 255,219,173; the position lies inside the
 * model box; the float at 20 ranges 0.10 to 1.40, which is an intensity; and the pair at 40 and 44
 * runs 0.22 to 7.78 and 2.50 to 16.67 with the second always the larger, which is a radius in
 * yards where the light starts and stops falling off. The four floats between them are -1, -0.5
 * and zeroes on every record in both buildings and are not read.
 */
const MOLT_SIZE = 48;

function wmoLights(data) {
  if (!data) return [];
  const lights = [];
  for (let at = 0; at + MOLT_SIZE <= data.length; at += MOLT_SIZE) {
    const position = [data.readFloatLE(at + 8), data.readFloatLE(at + 12), data.readFloatLE(at + 16)];
    const intensity = data.readFloatLE(at + 20);
    const attenuationStart = data.readFloatLE(at + 40);
    const attenuationEnd = data.readFloatLE(at + 44);
    const finite = [...position, intensity, attenuationStart, attenuationEnd].every(Number.isFinite);
    // MOLR addresses the source table by ordinal. Preserve a damaged optional record as an inert
    // light instead of dropping it and shifting every later reference onto the wrong lamp.
    lights.push(finite && intensity >= 0 && attenuationStart >= 0
      && attenuationEnd >= attenuationStart ? {
      type: data[at],
      attenuates: data[at + 1] !== 0,
      colour: [data[at + 6], data[at + 5], data[at + 4]],
      position,
      intensity,
      attenuationStart,
      attenuationEnd,
    } : {
      type: data[at], attenuates: false, colour: [0, 0, 0], position: [0, 0, 0],
      intensity: 0, attenuationStart: 0, attenuationEnd: 0,
    });
  }
  return lights;
}

/**
 * MFOG, the fog the artist put inside the building. 48 bytes each.
 *
 * This is the chunk that answers «зашёл внутрь, туман остался уличный». Every one of the 1,985
 * root WMOs under `World\wmo\` carries one — 2,463 records between them — and nothing in this
 * repository read a byte of it until now, so a tavern and a sewer were both drawn in whatever fog
 * `Light.dbc` says the zone outside has.
 *
 * The layout, and what the corpus says about each field. Flags at 0, and bit 0 is «no radius»:
 * 198 records across 172 roots carry it, and such a record holds wherever its group is rather
 * than within a sphere. The word is kept whole because 8 records set something above bit 0.
 * Position at 4 and the two radii at 16 and 20, in the model's own yards. Then the same three
 * fields twice — end distance, the fraction of it the fog starts at, and a BGRA colour — once for
 * a camera in air at 24 and once for a camera in water at 36.
 *
 * Two measurements decide how much of this is worth believing. The land colour is pure white on
 * 1,811 of the 2,463 records, which is the neutral that changes nothing, so a renderer must treat
 * the chunk as «most buildings say nothing and a few say something» rather than as a fog every
 * model wants. And the underwater half is not authored in this data at all: 2,429 of the 2,463
 * records carry a negative water start scale, which would put the fog's near plane behind the
 * camera. It travels because it is the record's own shape and a round trip that dropped it would
 * be lying about what the file holds — not because anything should read it as a distance.
 */
const MFOG_SIZE = 48;

function wmoFogs(data) {
  if (!data) return [];
  const fogs = [];
  for (let at = 0; at + MFOG_SIZE <= data.length; at += MFOG_SIZE) {
    const half = (offset) => ({
      end: data.readFloatLE(at + offset),
      scale: data.readFloatLE(at + offset + 4),
      // Stored BGRA like every other colour in a WMO. The alpha byte is not read: it is 255 on
      // all 2,463 records of the corpus, in both halves, so it carries nothing.
      colour: [data[at + offset + 10], data[at + offset + 9], data[at + offset + 8]],
    });
    const land = half(24);
    const water = half(36);
    if (![land.end, land.scale, water.end, water.scale].every(Number.isFinite)) continue;
    fogs.push({
      flags: data.readUInt32LE(at),
      position: [data.readFloatLE(at + 4), data.readFloatLE(at + 8), data.readFloatLE(at + 12)],
      innerRadius: data.readFloatLE(at + 16),
      outerRadius: data.readFloatLE(at + 20),
      land,
      water,
    });
  }
  return fogs;
}

/**
 * The portal graph: the polygons, and which pair of groups each one joins.
 *
 * Carried whole because it is small and because the renderer cannot ask for a piece of it: 319
 * portals and 627 references on Stormwind is 11 KB, against the 22 MB of geometry they decide the
 * visibility of.
 */
function wmoPortals(top) {
  const vertexData = top.get("MOPV");
  const definitionData = top.get("MOPT");
  const referenceData = top.get("MOPR");
  const vertices = [];
  if (vertexData) {
    for (let at = 0; at + 12 <= vertexData.length; at += 12) {
      vertices.push(vertexData.readFloatLE(at), vertexData.readFloatLE(at + 4), vertexData.readFloatLE(at + 8));
    }
  }
  const definitions = [];
  if (definitionData) {
    for (let at = 0; at + MOPT_SIZE <= definitionData.length; at += MOPT_SIZE) {
      definitions.push({
        startVertex: definitionData.readUInt16LE(at),
        vertexCount: definitionData.readUInt16LE(at + 2),
      });
    }
  }
  const references = [];
  if (referenceData) {
    for (let at = 0; at + MOPR_SIZE <= referenceData.length; at += MOPR_SIZE) {
      references.push({
        portal: referenceData.readUInt16LE(at),
        group: referenceData.readUInt16LE(at + 2),
        side: referenceData.readInt16LE(at + 4),
      });
    }
  }
  return { vertices, definitions, references };
}

export function parseWmoVisual(root, groups, rootPath) {
  const dependencies = wmoDependencies(root, rootPath);
  if (groups.length !== dependencies.groups.length) throw new Error("WMO group files are incomplete");
  const vertices = [];
  const uvs = [];
  const indices = [];
  const triangleMaterials = [];
  const triangleLighting = [];
  const parsedNormals = [];
  // Per group, so a city can be drawn a room at a time rather than as one merged shell. Stormwind
  // is 286 groups, 761,902 vertices and 727,741 triangles; merged and drawn whole it is 22.2 MB of
  // artifact and every interior visible through every wall.
  const groupRecords = [];
  const colours = [];
  const rootChunks = chunkMap(root);
  /** MODD record → the artifact groups whose MODR names it, in group order. */
  const doodadOwners = new Map();
  for (const group of groups) {
    const top = chunkMap(group);
    const mogp = top.get("MOGP");
    if (!mogp || mogp.length < 68) continue;
    const groupFlags = mogp.readUInt32LE(MOGP_FLAGS);
    const box = [];
    for (let axis = 0; axis < 6; axis++) box.push(mogp.readFloatLE(MOGP_BOUNDING_BOX + axis * 4));
    const boundsValid = box.every(Number.isFinite)
      && box[0] <= box[3] && box[1] <= box[4] && box[2] <= box[5];
    const vertexStart = vertices.length / 3;
    const indexStart = indices.length;
    const chunks = chunkMap(mogp.subarray(68));
    const vertexData = chunks.get("MOVT");
    const uvData = chunks.get("MOTV");
    const indexData = chunks.get("MOVI");
    const materialData = chunks.get("MOPY");
    const batchData = chunks.get("MOBA");
    const colourData = chunks.get("MOCV");
    const normalData = chunks.get("MONR");
    // MOLR: which of the model's lamps light this group. Flag 0x200 says the chunk is there, and
    // it agrees exactly — 111 groups of Stormwind and 2 of the Goldshire Inn, both ways.
    const lightData = chunks.get("MOLR");
    if (!vertexData || !indexData || vertexData.length % 12 !== 0 || indexData.length % 6 !== 0) continue;
    // MODR: the doodads this room owns, by MODD record, numbered like the artifact's own groups.
    const doodadData = chunks.get("MODR");
    for (let at = 0; doodadData && at + 2 <= doodadData.length; at += 2) {
      const record = doodadData.readUInt16LE(at);
      const rooms = doodadOwners.get(record);
      if (!rooms) doodadOwners.set(record, [groupRecords.length]);
      else if (rooms.at(-1) !== groupRecords.length) rooms.push(groupRecords.length);
    }
    const vertexCount = vertexData.length / 12;
    // MONR is optional in older WMOs. Treat it as authored only when the chunk is exactly one
    // finite model-space float3 per MOVT vertex; a partial or non-finite chunk is not a usable
    // normal stream and must not leak into the renderer as a partially trusted attribute.
    let groupNormals;
    if (normalData && normalData.length === vertexCount * 12) {
      groupNormals = [];
      for (let offset = 0; offset < normalData.length; offset += 4) {
        const value = normalData.readFloatLE(offset);
        if (!Number.isFinite(value)) {
          groupNormals = undefined;
          break;
        }
        groupNormals.push(value);
      }
    }
    if (groupNormals) parsedNormals.push(...groupNormals);
    const base = vertices.length / 3;
    for (let index = 0; index < vertexCount; index++) {
      const offset = index * 12;
      vertices.push(vertexData.readFloatLE(offset), vertexData.readFloatLE(offset + 4), vertexData.readFloatLE(offset + 8));
      const uvOffset = index * 8;
      uvs.push(uvData && uvOffset + 8 <= uvData.length ? uvData.readFloatLE(uvOffset) : 0, uvData && uvOffset + 8 <= uvData.length ? uvData.readFloatLE(uvOffset + 4) : 0);
      // Stored BGRA, kept RGBA. A group without them gets white, which multiplies to nothing.
      const colourOffset = index * 4;
      const hasColour = colourData !== undefined && colourOffset + 4 <= colourData.length;
      colours.push(
        hasColour ? colourData[colourOffset + 2] : 255,
        hasColour ? colourData[colourOffset + 1] : 255,
        hasColour ? colourData[colourOffset] : 255,
        hasColour ? colourData[colourOffset + 3] : 255);
    }
    const triangleCount = indexData.length / 6;
    // Appended one at a time throughout: a spread passes the whole array as call arguments, and a
    // WMO group can hold more indices than the engine's argument limit (Stormwind's largest is
    // 87,774, close enough to the ~100k limit measured here to be worth avoiding).
    const emit = (triangle, material, lighting) => {
      const offset = triangle * 6;
      const a = indexData.readUInt16LE(offset);
      const b = indexData.readUInt16LE(offset + 2);
      const c = indexData.readUInt16LE(offset + 4);
      if (a >= vertexCount || b >= vertexCount || c >= vertexCount) return;
      indices.push(base + a, base + b, base + c);
      triangleMaterials.push(material);
      triangleLighting.push(lighting);
    };

    // MOBA is the render list. Each batch names an index range and the material it draws with,
    // and between them the batches cover exactly the triangles whose MOPY material is not 0xFF.
    //
    // Selecting triangles from the MOPY flags instead threw most of every building away, because
    // F_DETAIL (0x04) does not mean "not drawn" — it means "not part of the collision hull", and
    // the artists set it on ordinary walls. Of the Goldshire Inn's 26,222 triangles, 24,274 are
    // drawn by its batches and 21,108 carry F_DETAIL; keeping only `F_RENDER && !F_DETAIL` left
    // 3,166, so seven eighths of the inn was missing and the rest was see-through.
    //
    // The order of the batches is also what says which light each one is drawn in: the first
    // `transition` of them are the boundary ones, the next `interior` are lit by what the artist
    // baked, and the rest by the sun.
    const transitionBatches = mogp.readUInt16LE(MOGP_TRANSITION_BATCHES);
    const interiorBatches = mogp.readUInt16LE(MOGP_INTERIOR_BATCHES);
    if (batchData && batchData.length >= 24) {
      let batch = 0;
      for (let offset = 0; offset + 24 <= batchData.length; offset += 24, batch++) {
        const start = batchData.readUInt32LE(offset + 12);
        const count = batchData.readUInt16LE(offset + 16);
        const material = batchData[offset + 23];
        const lighting = batch < transitionBatches ? WMO_LIGHT_TRANSITION
          : batch < transitionBatches + interiorBatches ? WMO_LIGHT_INTERIOR : WMO_LIGHT_EXTERIOR;
        if (count % 3 !== 0 || start + count > triangleCount * 3) continue;
        for (let index = start; index + 3 <= start + count; index += 3) emit(index / 3, material, lighting);
      }
    } else {
      // No batches: fall back to every triangle the collision hull does not own outright, lit by
      // the only thing left to go on, which is the group.
      const lighting = (groupFlags & WMO_GROUP_INDOOR) !== 0 ? WMO_LIGHT_INTERIOR : WMO_LIGHT_EXTERIOR;
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        const material = materialData?.[triangle * 2 + 1] ?? 0;
        if (material === MOPY_MATERIAL_COLLISION_ONLY) continue;
        emit(triangle, material, lighting);
      }
    }

    const lightRefs = [];
    if (lightData) for (let at = 0; at + 2 <= lightData.length; at += 2) lightRefs.push(lightData.readUInt16LE(at));

    groupRecords.push({
      flags: groupFlags,
      indoor: (groupFlags & WMO_GROUP_INDOOR) !== 0,
      lightRefs,
      min: box.slice(0, 3),
      max: box.slice(3, 6),
      ...(boundsValid ? {} : { boundsValid: false }),
      vertexStart,
      vertexCount,
      indexStart,
      indexCount: indices.length - indexStart,
      portalStart: mogp.readUInt16LE(MOGP_PORTAL_START),
      portalCount: mogp.readUInt16LE(MOGP_PORTAL_COUNT),
      // All four, because a group really can stand in more than one fog: 366 of the 9,346 groups
      // measured fill a slot past the first, and in none of them is it a repeat of the first —
      // Stormwind's `magic05`, `ThroneRoom05` and `TreeFacades02` each name records 1 and 2, two
      // 40.14/51.19-yard teal spheres 32.91 yards apart, and which of the two the player is in is
      // a question only their radii can answer. 1,596 of the 9,346 groups name something other
      // than record 0 in slot 0.
      fogIds: [0, 1, 2, 3].map((slot) => mogp[MOGP_FOG_IDS + slot]),
      ...(groupNormals ? { normals: groupNormals } : {}),
    });
  }
  if (vertices.length === 0 || indices.length === 0 || vertices.length / 3 > 1_000_000 || indices.length > 6_000_000) throw new Error("WMO visual geometry is empty or too large");
  return {
    vertices, uvs, indices,
    ...(groupRecords.length > 0 && groupRecords.every((group) => group.normals)
      ? { normals: parsedNormals }
      : {}),
    texture: dependencies.texture,
    materialTextures: dependencies.materialTextures, materials: dependencies.materials, triangleMaterials,
    triangleLighting, colours, wmoGroups: groupRecords,
    ambient: wmoAmbient(rootChunks.get("MOHD")),
    renderFlags: wmoRenderFlags(rootChunks.get("MOHD")),
    lights: wmoLights(rootChunks.get("MOLT")),
    fogs: wmoFogs(rootChunks.get("MFOG")),
    portals: wmoPortals(rootChunks),
    doodadRooms: wmoDoodadRooms(rootChunks, doodadOwners),
  };
}

/**
 * Cuts a parsed WMO into self-contained groups, each with its triangles sorted into runs.
 *
 * A run is a texture *and* the state that texture is drawn with *and* the light it is drawn in,
 * because those are three different things: the same wall texture appears on an opaque material in
 * one building and on an alpha-key one in another, and the same material appears on the inside and
 * the outside of the same room. Only the texture used to survive this step, so every surface
 * reached the browser with no idea whether it was glass, a cut-out or a solid wall, and one fixed
 * `alphaTest` was applied to all of them — which erased 65% to 93% of the Goldshire Inn's outer
 * walls, whose textures carry an 8-bit alpha channel that is a specular mask and not opacity.
 *
 * Sorting per group rather than over the whole model is what makes a city deliverable. Merged
 * runs are one index list whose order is the model's, and a group's triangles are then scattered
 * through all of it; a group whose triangles are its own can be sent, drawn or left behind on its
 * own. Groups share no vertices — measured on both buildings, the group vertex counts sum to the
 * model's exactly — so a group's indices are rebased to its own vertices and it needs nothing else.
 */
export function wmoGroupMeshes(model) {
  if (model.indices.length / 3 !== model.triangleMaterials.length) throw new Error("WMO material assignments do not match its triangles");
  const materials = model.materials ?? model.materialTextures.map((texture) => ({ texture, flags: 0, blendMode: 0 }));
  const textureIndexes = new Map();
  const textures = [];
  const textureIndexOf = (path) => {
    const key = (path ?? "").toLowerCase();
    let index = textureIndexes.get(key);
    if (index === undefined) {
      index = textures.length;
      textureIndexes.set(key, index);
      textures.push(path ?? "");
    }
    return index;
  };

  const groups = [];
  for (const record of model.wmoGroups) {
    const { vertexStart, vertexCount } = record;
    const positions = new Float32Array(model.vertices.slice(vertexStart * 3, (vertexStart + vertexCount) * 3));
    const uvs = new Float32Array(model.uvs.slice(vertexStart * 2, (vertexStart + vertexCount) * 2));
    const colours = new Uint8Array(model.colours.slice(vertexStart * 4, (vertexStart + vertexCount) * 4));

    const bucketIndexes = new Map();
    const buckets = [];
    const firstTriangle = record.indexStart / 3;
    const lastTriangle = (record.indexStart + record.indexCount) / 3;
    for (let triangle = firstTriangle; triangle < lastTriangle; triangle++) {
      const material = materials[model.triangleMaterials[triangle]] ?? { texture: "", flags: 0, blendMode: 0 };
      const texture = textureIndexOf(material.texture);
      const lighting = model.triangleLighting?.[triangle] ?? WMO_LIGHT_EXTERIOR;
      const key = `${texture}|${material.blendMode}|${material.flags}|${lighting}`;
      let bucket = bucketIndexes.get(key);
      if (bucket === undefined) {
        bucket = buckets.length;
        bucketIndexes.set(key, bucket);
        buckets.push({
          material: texture, blendMode: material.blendMode ?? 0, materialFlags: material.flags ?? 0,
          lighting, indices: [],
        });
      }
      const offset = triangle * 3;
      // Rebased: the parse numbers vertices across the whole model, a group's own mesh from zero.
      for (let corner = 0; corner < 3; corner++) buckets[bucket].indices.push(model.indices[offset + corner] - vertexStart);
    }

    const indices = new Uint32Array(record.indexCount);
    const runs = [];
    let cursor = 0;
    for (const bucket of buckets) {
      if (bucket.indices.length === 0) continue;
      runs.push({
        start: cursor, count: bucket.indices.length, material: bucket.material,
        blendMode: bucket.blendMode, materialFlags: bucket.materialFlags, lighting: bucket.lighting,
      });
      for (const index of bucket.indices) indices[cursor++] = index;
    }
    groups.push({
      flags: record.flags, indoor: record.indoor, min: record.min, max: record.max,
      ...(record.boundsValid === false ? { boundsValid: false } : {}),
      portalStart: record.portalStart, portalCount: record.portalCount,
      lightRefs: record.lightRefs ?? [], fogIds: record.fogIds ?? [],
      positions, uvs, colours, indices, runs,
      ...(record.normals && record.normals.length === vertexCount * 3
        ? { normals: new Float32Array(record.normals) }
        : {}),
    });
  }
  return {
    textures, ambient: model.ambient ?? [0, 0, 0], lights: model.lights ?? [], groups,
    fogs: model.fogs ?? [], portals: model.portals,
    ...(Number.isInteger(model.renderFlags) ? { renderFlags: model.renderFlags } : {}),
    doodadRooms: model.doodadRooms ?? [],
  };
}

/**
 * Doodads owned by an indoor group which carries authored vertex lighting.
 *
 * `MODR` is the only reliable ownership relation in the 3.3.5 files. `MOLR` is commonly empty
 * even in lit rooms and the original client does not expose a stable MODD-to-MOLT relation, so this
 * deliberately classifies the placement without inventing a nearest-light direction.
 */
function wmoLocallyLitDoodads(groups) {
  const locallyLit = new Set();
  if (!Array.isArray(groups)) return locallyLit;
  for (const group of groups) {
    try {
      const mogp = chunkMap(group).get("MOGP");
      if (!mogp || mogp.length < 68 || (mogp.readUInt32LE(MOGP_FLAGS) & WMO_GROUP_INDOOR) === 0) continue;
      const chunks = chunkMap(mogp.subarray(68));
      // The reference path gates local doodad light on actual vertex-colour data, not only a flag.
      const references = chunks.get("MODR");
      if (!chunks.has("MOCV") || !references) continue;
      for (let at = 0; at + 2 <= references.length; at += 2) locallyLit.add(references.readUInt16LE(at));
    } catch {
      // Group lighting is optional enrichment. One malformed group must not discard the root's
      // otherwise valid doodad set or assign a guessed room to it.
    }
  }
  return locallyLit;
}

function wmoDoodadTable(root, groups) {
  const chunks = chunkMap(root);
  const sets = chunks.get("MODS");
  const names = chunks.get("MODN");
  const placements = chunks.get("MODD");
  if (!sets || !names || !placements) return undefined;
  if (sets.length % 32 !== 0 || placements.length % 40 !== 0) throw new Error("WMO doodad tables are misaligned");
  return { sets, names, placements, locallyLit: wmoLocallyLitDoodads(groups) };
}

function parseWmoDoodadSet(table, requestedSet) {
  const { sets, names, placements, locallyLit } = table;
  const setCount = sets.length / 32;
  if (setCount === 0) return [];
  const set = Number.isInteger(requestedSet) && requestedSet >= 0 && requestedSet < setCount ? requestedSet : 0;
  const setOffset = set * 32;
  const first = sets.readUInt32LE(setOffset + 20);
  const count = sets.readUInt32LE(setOffset + 24);
  if (count > 100_000 || first + count > placements.length / 40) throw new Error("WMO doodad set is invalid");
  const result = [];
  for (let index = first; index < first + count; index++) {
    const offset = index * 40;
    const record = keptDoodadRecord(names, placements, index);
    if (!record) continue;
    const { name, values } = record;
    const localLight = [
      placements[offset + 38], placements[offset + 37], placements[offset + 36], placements[offset + 39],
    ];
    result.push({
      name,
      x: values[0], y: values[1], z: values[2],
      quaternionX: values[3], quaternionY: values[4], quaternionZ: values[5], quaternionW: values[6],
      scale: values[7],
      // The final MODD word is BGRA room illumination, reordered to display-order RGBA. It is not
      // an albedo tint, so expose it only when group ownership proves this is the indoor M2 path.
      // Its fourth byte is stored colour alpha, never mesh opacity.
      ...(locallyLit.has(index) ? { localLight } : {}),
    });
  }
  return result;
}

/**
 * One MODD record as the tiles place it, or undefined for one they skip.
 *
 * The single filter both the tile generator's doodad list and {@link wmoDoodadRooms} walk: the
 * tiles number a building's doodads by their position in that list (ids -(placement * 1e6 +
 * ordinal + 1) in `generate-visual-tile.mjs`), so the room table has to skip exactly the records
 * the list skips or every ordinal after the first gap would name the wrong room.
 */
function keptDoodadRecord(names, placements, index) {
  const offset = index * 40;
  const nameOffset = placements.readUInt32LE(offset) & 0x00ffffff;
  const name = stringAt(names, nameOffset).replace(/\.(mdx|mdl)$/i, ".m2");
  if (!name) return undefined;
  const values = [];
  for (let field = 1; field <= 8; field++) values.push(placements.readFloatLE(offset + field * 4));
  if (!values.every(Number.isFinite) || values[7] <= 0) return undefined;
  return { name, values };
}

/**
 * Which rooms own each doodad a tile places, per doodad set, in the tile's own numbering.
 *
 * MODR is the only ownership the files state. Over Gundrak, Stormwind, the Goldshire Inn, the
 * Deadmines and the Undercity all 10,910 MODD records are named by at least one group and 168 by
 * more than one (Gundrak's #113 by four rooms), so a doodad keeps every room that names it and is
 * drawn while any of them is. Per set: `offsets[k]..offsets[k + 1]` indexes `groups` for ordinal k.
 * An unusable table answers no sets rather than a guessed room.
 */
function wmoDoodadRooms(rootChunks, owners) {
  const sets = rootChunks.get("MODS");
  const names = rootChunks.get("MODN");
  const placements = rootChunks.get("MODD");
  if (!sets || !names || !placements || sets.length % 32 !== 0 || placements.length % 40 !== 0) return [];
  const result = [];
  for (let set = 0; set < sets.length / 32; set++) {
    const first = sets.readUInt32LE(set * 32 + 20);
    const count = sets.readUInt32LE(set * 32 + 24);
    if (count > 100_000 || first + count > placements.length / 40) return [];
    const offsets = [0];
    const groups = [];
    for (let index = first; index < first + count; index++) {
      if (!keptDoodadRecord(names, placements, index)) continue;
      for (const group of owners.get(index) ?? []) groups.push(group);
      offsets.push(groups.length);
    }
    result.push({ offsets, groups });
  }
  return result;
}

export function parseWmoDoodads(root, requestedSet = 0, groups = []) {
  const table = wmoDoodadTable(root, groups);
  return table ? parseWmoDoodadSet(table, requestedSet) : [];
}

/** All authored doodad sets, parsing the potentially large group files only once. */
export function parseWmoDoodadSets(root, groups = []) {
  const table = wmoDoodadTable(root, groups);
  if (!table) return [];
  return Array.from({ length: table.sets.length / 32 }, (_, set) => parseWmoDoodadSet(table, set));
}

/** Strict validation for the persistent JSON form used by visual-tile generation. */
export function validParsedWmoDoodadSets(value) {
  if (!Array.isArray(value)) return false;
  for (const set of value) {
    if (!Array.isArray(set)) return false;
    for (const candidate of set) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const doodad = candidate;
      if (typeof doodad.name !== "string" || doodad.name.length === 0) return false;
      const transform = [
        doodad.x, doodad.y, doodad.z,
        doodad.quaternionX, doodad.quaternionY, doodad.quaternionZ, doodad.quaternionW,
        doodad.scale,
      ];
      if (!transform.every((number) => typeof number === "number" && Number.isFinite(number))) return false;
      if (doodad.scale <= 0) return false;
      if (doodad.localLight !== undefined) {
        if (!Array.isArray(doodad.localLight) || doodad.localLight.length !== 4) return false;
        if (!doodad.localLight.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return false;
      }
    }
  }
  return true;
}

function chunkMap(data) {
  const result = new Map();
  for (let offset = 0; offset + 8 <= data.length;) {
    const tag = [...data.subarray(offset, offset + 4)].reverse().map((value) => String.fromCharCode(value)).join("");
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > data.length) throw new Error(`Truncated WMO ${tag} chunk`);
    if (!result.has(tag)) result.set(tag, data.subarray(start, end));
    offset = end;
  }
  return result;
}

function firstString(data) {
  if (!data) return "";
  for (let offset = 0; offset < data.length;) {
    const end = data.indexOf(0, offset);
    const value = data.subarray(offset, end < 0 ? data.length : end).toString("utf8").replaceAll("/", "\\");
    if (value.toLowerCase().endsWith(".blp")) return value;
    if (end < 0) break;
    offset = end + 1;
  }
  return "";
}

/**
 * The MOMT table: what each material draws with and how.
 *
 * `flags` at 0, `blendMode` at 8 and the diffuse texture's MOTX offset at 12. Only the texture was
 * read before, and without the blend mode nothing downstream could tell an opaque wall from a
 * pane of glass.
 */
function wmoMaterials(materials, names) {
  if (!materials || !names || materials.length % 64 !== 0) return [];
  const result = [];
  for (let offset = 0; offset < materials.length; offset += 64) {
    result.push({
      flags: materials.readUInt32LE(offset),
      blendMode: materials.readUInt32LE(offset + 8),
      texture: stringAt(names, materials.readUInt32LE(offset + 12)),
    });
  }
  return result;
}

function stringAt(data, offset) {
  if (offset >= data.length) return "";
  const end = data.indexOf(0, offset);
  return data.subarray(offset, end < 0 ? data.length : end).toString("utf8").replaceAll("/", "\\");
}
