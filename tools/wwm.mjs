// WWM1/WWM2: one WMO, group by group. WWM2 is selected when authored MONR normals are present.
//
// A building used to publish the way a doodad does — every vertex it has, merged into one mesh,
// one artifact. That works for a tavern and not for a city. Stormwind is 286 groups, 761,902
// vertices and 667,382 drawn triangles: 22.2 MB of artifact with 157 textures of its own beside
// it, all of which had to arrive before anything at all was drawn, and once drawn every interior
// was visible through every wall.
//
// A WMO is already stored as groups — a room, a wing, a floor, each with its own box — which is
// the same shape the collision format uses for the same reason (src/world/CollisionFormat.ts).
// The header carries every group's box, flags and size whether or not its geometry came with it,
// so the browser can decide which handful of a city's rooms it is standing in and ask for only
// those. Measured from Stormwind's five districts with interiors kept to 60 yd and the outdoor
// shell to 250 yd, that is 64 to 108 groups for the room-plus-boundary candidate set rather than
// the full 286-group city. Transition-lit doorway and street seams use the same bounded leash as
// the shell; the group's own AABB still caps the distance test.
//
// Under the triangle budget the whole model travels in the header's own file, which is what
// almost every building is: of the 15 WMOs placed across seven Azeroth and Kalimdor tiles, the
// median is 4,238 triangles in a single group and only Stormwind is over.
//
//   0  char[4] "WWM1" or "WWM2" (WWM2 carries authored MONR normals in flagged blocks)
//   4  u32   groupCount
//   8  u16   textureCount
//  10  u8    ambient red
//  11  u8    ambient green
//  12  u8    ambient blue
//  13  u8    flags: 1 every group's geometry travels here
//  14  u16   lightCount
//  16  u32   total length, so a truncated response is caught before it is decoded
//  20  u32   offset of optional metadata, or zero for a legacy artifact
//  24  the group table, one 40-byte record each:
//         0  f32[6] model-space box, min then max
//        24  u32 MOGP flags — preserved verbatim from the source WMO
//        28  u32 vertexCount
//        32  u32 triangleCount
//        36  u32 the length of this group's block, or zero when it did not travel
//   ..  the texture table: u16 length and bytes each, padded to a multiple of four
//   ..  the light table, one 28-byte record each:
//         0  f32[3] position, in model space
//        12  f32 intensity
//        16  f32 the radius its falloff starts at
//        20  f32 the radius it reaches nothing at
//        24  u8[3] colour
//        27  u8 flags: 1 it falls off at all
//   ..  the blocks of the groups that travelled, in group order
//   ..  optional WME1 metadata at the offset in header word 20: u32 groupCount followed by one
//       exterior byte per group, padded to four bytes. New artifacts append an aligned WME2
//       extension carrying the source WMO's portal graph, and after it an aligned WME3 extension
//       carrying the source WMO's fog. Keeping WME1 first lets old readers accept the artifact and
//       ignore both extensions; each extension states its own length so the next one can be found
//       without understanding it.
//
//   ..  WME3, the MFOG chunk and the groups that stand in it:
//         0  char[4] "WME3"
//         4  u32 groupCount, which must match the header's
//         8  u32 fogCount
//        12  u32 the length of this section
//        16  u8[4] × groupCount: MOGP's own fog indices, verbatim
//        ..  fogCount × 48 bytes:
//              0  u32 flags — bit 0 is "no radius", i.e. it holds wherever its groups are
//              4  f32[3] position, in model space
//             16  f32 the radius the fog begins to take over at
//             20  f32 the radius it holds the view at
//             24  f32 end distance in air, 28 f32 the fraction of it it starts at, 32 u8[3] RGB
//             36  the same three for a camera in water, 44 u8[3] RGB
//       Both tables are multiples of four bytes, so the section needs no padding of its own.
//
// A block is self-contained, and it is the same bytes whether it arrives inside the header's file
// or on its own as `<hash>.g<NNN>.bin`:
//
//   0  u32   vertexCount
//   4  u32   indexCount
//   8  u16   runCount
//  10  u8    bytes per index, 2 or 4
//  11  u8    stream flags: bit 0 means a float3 authored normal stream follows colours
//  12  u16   which group this is, so a stale cache cannot pass one room off as another
//  14  u16   lightRefCount: how many of the model's lamps hang in this group
//  16  f32[3] × vertexCount positions, in model space
//  ..  f32[2] × vertexCount texture coordinates
//  ..  u8[4]  × vertexCount baked colours, RGBA; white where the group has none
//  ..  f32[3] × vertexCount authored normals when block flag bit 0 is set
//  ..  the index list, numbered from this group's own first vertex, padded to a multiple of four
//  ..  the runs, 16 bytes each: u32 start, u32 count, u16 material, u8 blendMode,
//      u8 materialFlags, u8 lighting, u8 reserved, u16 reserved
//  ..  the light references, u16 each, padded to a multiple of four
//
// Three things travel that the geometry cannot be read without, and none of them is applied here.
// The ambient is the model's own `MOHD.ambColor`: Stormwind's interior luminance runs a median of
// 15 out of 255 against an ambient of 33, the Goldshire Inn's a median of 104 against an ambient
// of 19, so no single multiplier serves both. The lamps are `MOLT` and each group's references to
// them are `MOLR`, and they are why a city's rooms are painted so dark to begin with: of
// Stormwind's 184 interior groups not one has a median baked luminance above 64, and the 95 that
// own lamps are the darker half. A room lit by candles is authored as if the candles were lit.
// What the renderer does with the three is its own business; the artifact states them.

const encoder = new TextEncoder();

export const WWM1_MAGIC = "WWM1";
/** WWM2 is the WWM1 envelope plus optional authored MONR normals in each group block. */
export const WWM2_MAGIC = "WWM2";
/** Bit 0 of a group block's byte 11: one finite float3 normal per vertex follows the legacy streams. */
export const WWM_AUTHORED_NORMALS = 0x01;
export const WWM1_HEADER_SIZE = 24;
export const WWM1_GROUP_SIZE = 40;
export const WWM1_BLOCK_HEADER_SIZE = 16;
export const WWM1_RUN_SIZE = 16;
export const WWM1_LIGHT_SIZE = 28;
/** Bit 0 of the header's flags byte: nothing was held back. */
export const WWM1_COMPLETE = 0x01;
/** Header word 20 continues to point at the legacy envelope old WWM1 readers understand. */
export const WWM1_METADATA_MAGIC = "WME1";
export const WWM1_METADATA_HEADER_SIZE = 8;
export const WWM1_EXTENSION_MAGIC = "WME2";
export const WWM1_EXTENSION_HEADER_SIZE = 24;
export const WWM1_METADATA_GROUP_SIZE = 8;
export const WWM1_METADATA_DEFINITION_SIZE = 4;
export const WWM1_METADATA_REFERENCE_SIZE = 8;
export const WWM1_FOG_MAGIC = "WME3";
export const WWM1_FOG_HEADER_SIZE = 16;
export const WWM1_FOG_GROUP_SIZE = 4;
export const WWM1_FOG_SIZE = 48;
/**
 * MOGP addresses fog with a byte and 255 is this section's "no fog", so a model may name 255
 * records however many the chunk holds. Measured over the 1,985 root WMOs under `World\wmo\`, the
 * largest MFOG table is 22 records and 1,709 models carry exactly one, so the bound is the file
 * format's own and not a budget anything in the client is near.
 */
export const WWM1_FOG_LIMIT = 255;

/**
 * How many triangles a model may hold before its groups are published one file at a time.
 *
 * The same 50,000 the collision format uses, and for the same reason: it is well above every
 * ordinary building and well below a city. Of the WMOs placed across the tiles measured, only
 * Stormwind crosses it.
 */
export const WWM_TRIANGLE_BUDGET = 50_000;

function assertFloat32Stream(values, label) {
  for (const value of values) {
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
      throw new Error(`WWM1 group ${label} stream is not Float32-representable`);
    }
  }
}

/** The bytes of one group's geometry, blocked so that the same encoding serves both files. */
export function encodeWwmGroup(group, index) {
  const vertexCount = group.positions.length / 3;
  const indexCount = group.indices.length;
  if (!Number.isInteger(vertexCount) || vertexCount === 0 || vertexCount > 1_000_000) throw new Error("WWM1 group vertex count is invalid");
  if (group.uvs.length !== vertexCount * 2 || group.colours.length !== vertexCount * 4) throw new Error("WWM1 group vertex streams disagree on the vertex count");
  assertFloat32Stream(group.positions, "position");
  assertFloat32Stream(group.uvs, "UV");
  if (indexCount % 3 !== 0 || indexCount > 6_000_000) throw new Error("WWM1 group index list is invalid");
  if (group.runs.length > 65_535 || index > 65_535) throw new Error("WWM1 group run table is too large");
  const lightRefs = group.lightRefs ?? [];
  if (lightRefs.length > 65_535) throw new Error("WWM1 group light reference table is too large");
  const hasNormals = group.normals !== undefined;
  if (hasNormals) {
    if (group.normals.length !== vertexCount * 3) throw new Error("WWM2 group normal stream disagrees with the vertex count");
    for (const value of group.normals) {
      if (!Number.isFinite(Math.fround(value))) throw new Error("WWM2 group normal stream is not Float32-representable");
    }
  }
  const wide = vertexCount > 65_536;
  const indexBytes = wide ? 4 : 2;
  const indexLength = align4(indexCount * indexBytes);
  const runLength = group.runs.length * WWM1_RUN_SIZE;
  const vertexStride = 24 + (hasNormals ? 12 : 0);
  const indexOffset = WWM1_BLOCK_HEADER_SIZE + vertexCount * vertexStride;
  const data = Buffer.alloc(indexOffset + indexLength + runLength + align4(lightRefs.length * 2));
  data.writeUInt32LE(vertexCount, 0);
  data.writeUInt32LE(indexCount, 4);
  data.writeUInt16LE(group.runs.length, 8);
  data.writeUInt8(indexBytes, 10);
  data.writeUInt8(hasNormals ? WWM_AUTHORED_NORMALS : 0, 11);
  data.writeUInt16LE(index, 12);
  data.writeUInt16LE(lightRefs.length, 14);
  let offset = WWM1_BLOCK_HEADER_SIZE;
  for (const value of group.positions) data.writeFloatLE(value, offset), offset += 4;
  for (const value of group.uvs) data.writeFloatLE(value, offset), offset += 4;
  data.set(group.colours, offset);
  offset += vertexCount * 4;
  if (hasNormals) {
    for (const value of group.normals) data.writeFloatLE(value, offset), offset += 4;
  }
  for (const value of group.indices) {
    if (value >= vertexCount) throw new Error("WWM1 group index is out of range");
    if (wide) data.writeUInt32LE(value, offset);
    else data.writeUInt16LE(value, offset);
    offset += indexBytes;
  }
  offset = indexOffset + indexLength;
  for (const run of group.runs) {
    if (run.start + run.count > indexCount || run.count % 3 !== 0) throw new Error("WWM1 run does not fit its group");
    data.writeUInt32LE(run.start, offset);
    data.writeUInt32LE(run.count, offset + 4);
    data.writeUInt16LE(run.material, offset + 8);
    data.writeUInt8(Math.min(255, run.blendMode ?? 0), offset + 10);
    data.writeUInt8(Math.min(255, run.materialFlags ?? 0), offset + 11);
    data.writeUInt8(Math.min(255, run.lighting ?? 0), offset + 12);
    offset += WWM1_RUN_SIZE;
  }
  for (const reference of lightRefs) {
    data.writeUInt16LE(reference, offset);
    offset += 2;
  }
  return data;
}

/**
 * The model, carrying the blocks of the groups named in `include`.
 *
 * `include` of `undefined` means all of them, which is what a model under the budget gets.
 */
export function encodeWwm(model, textureUrls, include) {
  const groups = model.groups;
  if (groups.length === 0 || groups.length > 65_535) throw new Error("WWM1 group count is invalid");
  if (textureUrls.length !== model.textures.length || textureUrls.length > 65_535) throw new Error("WWM1 texture table does not match the model");
  const textures = textureUrls.map((value) => encoder.encode(value));
  if (textures.some((value) => value.length > 1000)) throw new Error("WWM1 texture URL is too long");
  const textureLength = align4(textures.reduce((total, value) => total + 2 + value.length, 0));

  const lights = safeWmoLights(model.lights);
  if (lights.length > 65_535) throw new Error("WWM1 light table is too large");
  // Portal data is an optional optimisation. An unusual/sentinel MOPR record must not turn a WMO
  // whose geometry is perfectly usable into a generator failure; an invalid graph is encoded as
  // an empty one and the browser keeps the distance selector.
  const portalGraph = safePortalGraph(model.portals, groups);
  const portalVertices = portalGraph.vertices;
  const portalDefinitions = portalGraph.definitions;
  const portalReferences = portalGraph.references;
  const portalVertexCount = portalVertices.length / 3;
  const blocks = groups.map((group, index) => (include && !include.has(index) ? undefined : encodeWwmGroup(group, index)));
  // Keep truly legacy artifacts byte-for-byte WWM1-compatible. A root carrying authored MONR
  // streams is WWM2; the block flag remains the source of truth for standalone group responses.
  const wwm2 = groups.some((group) => group.normals !== undefined);
  const bodyLength = blocks.reduce((total, block) => total + (block?.length ?? 0), 0);
  const tableLength = groups.length * WWM1_GROUP_SIZE;
  const lightLength = lights.length * WWM1_LIGHT_SIZE;
  const legacyMetadataLength = align4(WWM1_METADATA_HEADER_SIZE + groups.length);
  const extensionLength = align4(
    WWM1_EXTENSION_HEADER_SIZE
    + groups.length * WWM1_METADATA_GROUP_SIZE
    + portalVertices.length * 4
    + portalDefinitions.length * WWM1_METADATA_DEFINITION_SIZE
    + portalReferences.length * WWM1_METADATA_REFERENCE_SIZE,
  );
  const fogs = safeFogs(model.fogs);
  const fogLength = WWM1_FOG_HEADER_SIZE + groups.length * WWM1_FOG_GROUP_SIZE + fogs.length * WWM1_FOG_SIZE;
  const metadataLength = legacyMetadataLength + extensionLength + fogLength;
  const data = Buffer.alloc(WWM1_HEADER_SIZE + tableLength + textureLength + lightLength + bodyLength + metadataLength);
  data.write(wwm2 ? WWM2_MAGIC : WWM1_MAGIC, 0, "ascii");
  data.writeUInt32LE(groups.length, 4);
  data.writeUInt16LE(textures.length, 8);
  for (let channel = 0; channel < 3; channel++) data.writeUInt8(clampByte(model.ambient?.[channel] ?? 0), 10 + channel);
  data.writeUInt8(include ? 0 : WWM1_COMPLETE, 13);
  data.writeUInt16LE(lights.length, 14);
  data.writeUInt32LE(data.length, 16);

  let offset = WWM1_HEADER_SIZE;
  for (const [index, group] of groups.entries()) {
    for (let axis = 0; axis < 3; axis++) data.writeFloatLE(group.min[axis], offset + axis * 4);
    for (let axis = 0; axis < 3; axis++) data.writeFloatLE(group.max[axis], offset + 12 + axis * 4);
    // This is the source MOGP word, not an artifact-owned bit field. Every bit is meaningful to
    // some WMO generation (including the high bit in real 3.3.5 groups), so keep all 32 bits.
    data.writeUInt32LE(group.flags >>> 0, offset + 24);
    data.writeUInt32LE(group.positions.length / 3, offset + 28);
    data.writeUInt32LE(group.indices.length / 3, offset + 32);
    data.writeUInt32LE(blocks[index]?.length ?? 0, offset + 36);
    offset += WWM1_GROUP_SIZE;
  }
  for (const texture of textures) {
    data.writeUInt16LE(texture.length, offset);
    data.set(texture, offset + 2);
    offset += 2 + texture.length;
  }
  offset = WWM1_HEADER_SIZE + tableLength + textureLength;
  for (const light of lights) {
    for (let axis = 0; axis < 3; axis++) data.writeFloatLE(light.position[axis], offset + axis * 4);
    data.writeFloatLE(light.intensity, offset + 12);
    data.writeFloatLE(light.attenuationStart, offset + 16);
    data.writeFloatLE(light.attenuationEnd, offset + 20);
    for (let channel = 0; channel < 3; channel++) data.writeUInt8(clampByte(light.colour[channel]), offset + 24 + channel);
    data.writeUInt8(light.attenuates ? 1 : 0, offset + 27);
    offset += WWM1_LIGHT_SIZE;
  }
  for (const block of blocks) {
    if (!block) continue;
    data.set(block, offset);
    offset += block.length;
  }
  // Keep metadata after the legacy body. An older reader can still parse every table and block,
  // then ignore the trailing section; a zero reserved word means an old artifact with no section.
  const metadataOffset = offset;
  data.writeUInt32LE(metadataOffset, 20);
  data.write(WWM1_METADATA_MAGIC, metadataOffset, "ascii");
  data.writeUInt32LE(groups.length, metadataOffset + 4);
  for (const [index, group] of groups.entries()) {
    // `exterior` is the legacy wire name for a long-range street-boundary group. Transition
    // batches are still lit as interior by the renderer, but they commonly hold the doorway/wall
    // seam between a room and the outdoor shell and must not disappear on the 60-yard room leash.
    const exterior = group.exterior === true
      || (group.runs?.some((run) => run.lighting === 0 || run.lighting === 2) ?? false);
    data.writeUInt8(exterior ? 1 : 0, metadataOffset + WWM1_METADATA_HEADER_SIZE + index);
  }

  const extensionOffset = metadataOffset + legacyMetadataLength;
  data.write(WWM1_EXTENSION_MAGIC, extensionOffset, "ascii");
  data.writeUInt32LE(groups.length, extensionOffset + 4);
  data.writeUInt32LE(portalVertexCount, extensionOffset + 8);
  data.writeUInt32LE(portalDefinitions.length, extensionOffset + 12);
  data.writeUInt32LE(portalReferences.length, extensionOffset + 16);
  data.writeUInt32LE(extensionLength, extensionOffset + 20);
  offset = extensionOffset + WWM1_EXTENSION_HEADER_SIZE;
  for (const [index, group] of groups.entries()) {
    const exterior = group.exterior === true
      || (group.runs?.some((run) => run.lighting === 0 || run.lighting === 2) ?? false);
    data.writeUInt8(exterior ? 1 : 0, offset);
    data.writeUInt16LE(portalGraph.ranges[index].count, offset + 2);
    data.writeUInt32LE(portalGraph.ranges[index].start, offset + 4);
    offset += WWM1_METADATA_GROUP_SIZE;
  }
  for (const value of portalVertices) {
    data.writeFloatLE(value, offset);
    offset += 4;
  }
  for (const definition of portalDefinitions) {
    data.writeUInt16LE(definition.startVertex, offset);
    data.writeUInt16LE(definition.vertexCount, offset + 2);
    offset += WWM1_METADATA_DEFINITION_SIZE;
  }
  for (const reference of portalReferences) {
    data.writeUInt16LE(reference.portal, offset);
    data.writeUInt16LE(reference.group, offset + 2);
    data.writeInt16LE(reference.side, offset + 4);
    offset += WWM1_METADATA_REFERENCE_SIZE;
  }

  // The fog section sits after the portal one and states its own length, so a reader that stops at
  // WME2 skips it and a reader that knows WME3 finds it without parsing the graph in between.
  const fogOffset = extensionOffset + extensionLength;
  data.write(WWM1_FOG_MAGIC, fogOffset, "ascii");
  data.writeUInt32LE(groups.length, fogOffset + 4);
  data.writeUInt32LE(fogs.length, fogOffset + 8);
  data.writeUInt32LE(fogLength, fogOffset + 12);
  offset = fogOffset + WWM1_FOG_HEADER_SIZE;
  for (const group of groups) {
    // MOGP's four bytes, each checked against this model's own table. A group whose model has no
    // fog at all therefore writes four 255s, which the decoder reads back as "in no fog".
    for (let slot = 0; slot < WWM1_FOG_GROUP_SIZE; slot++) {
      data.writeUInt8(fogIndex(group.fogIds?.[slot], fogs.length), offset + slot);
    }
    offset += WWM1_FOG_GROUP_SIZE;
  }
  for (const fog of fogs) {
    data.writeUInt32LE(fog.flags >>> 0, offset);
    for (let axis = 0; axis < 3; axis++) data.writeFloatLE(fog.position[axis], offset + 4 + axis * 4);
    data.writeFloatLE(fog.innerRadius, offset + 16);
    data.writeFloatLE(fog.outerRadius, offset + 20);
    for (const [at, half] of [[24, fog.land], [36, fog.water]]) {
      data.writeFloatLE(half.end, offset + at);
      data.writeFloatLE(half.scale, offset + at + 4);
      for (let channel = 0; channel < 3; channel++) data.writeUInt8(clampByte(half.colour[channel]), offset + at + 8 + channel);
    }
    offset += WWM1_FOG_SIZE;
  }
  return data;
}

/** Preserve MOLT ordinals while making malformed optional lights inert for every CPU consumer. */
function safeWmoLights(lights) {
  if (!Array.isArray(lights)) return [];
  return lights.map((light) => {
    const position = light?.position;
    const valid = position?.length === 3
      && [...position, light.intensity, light.attenuationStart, light.attenuationEnd].every(Number.isFinite)
      && light.intensity >= 0 && light.attenuationStart >= 0
      && light.attenuationEnd >= light.attenuationStart;
    return valid ? light : {
      type: light?.type ?? 0,
      attenuates: false,
      colour: [0, 0, 0],
      position: [0, 0, 0],
      intensity: 0,
      attenuationStart: 0,
      attenuationEnd: 0,
    };
  });
}

/**
 * An index that names no record of this model becomes 255, which is past every table the limit
 * allows and is therefore what the decoder's own range check reads as "this slot names nothing".
 */
function fogIndex(value, count) {
  return Number.isInteger(value) && value >= 0 && value < count ? value : 255;
}

/**
 * MFOG records that survive validation, or none.
 *
 * The same rule the portal graph gets, and for the same reason: fog is an optional improvement on
 * a building that is already drawable, so one malformed record must not turn a whole model into a
 * generator failure. A non-finite float here would reach `THREE.Fog` and blank the frame.
 */
function safeFogs(fogs) {
  if (!Array.isArray(fogs) || fogs.length === 0 || fogs.length > WWM1_FOG_LIMIT) return [];
  for (const fog of fogs) {
    if (!Number.isInteger(fog?.flags) || fog.position?.length !== 3) return [];
    const numbers = [...fog.position, fog.innerRadius, fog.outerRadius,
      fog.land?.end, fog.land?.scale, fog.water?.end, fog.water?.scale];
    if (!numbers.every((value) => Number.isFinite(value))) return [];
    if (fog.land?.colour?.length !== 3 || fog.water?.colour?.length !== 3) return [];
  }
  return fogs;
}

/** A malformed optional graph becomes an empty graph; core geometry never depends on it. */
function safePortalGraph(portals, groups) {
  const empty = () => ({
    vertices: [], definitions: [], references: [],
    ranges: groups.map(() => ({ start: 0, count: 0 })),
  });
  if (!portals) return empty();
  const vertices = portals.vertices ?? [];
  const definitions = portals.definitions ?? [];
  const references = portals.references ?? [];
  const vertexCount = vertices.length / 3;
  if (vertices.length === 0 && definitions.length === 0 && references.length === 0) return empty();
  if (vertices.length === 0 || vertices.length % 3 !== 0 || vertexCount > 65_535
    || definitions.length === 0 || definitions.length > 65_535
    || references.length === 0 || references.length > 0xffff_ffff) return empty();
  for (const value of vertices) if (!Number.isFinite(value)) return empty();
  for (const definition of definitions) {
    if (!Number.isInteger(definition.startVertex) || !Number.isInteger(definition.vertexCount)
      || definition.startVertex < 0 || definition.vertexCount < 3
      || definition.startVertex + definition.vertexCount > vertexCount
      || definition.startVertex > 65_535 || definition.vertexCount > 65_535) return empty();
  }
  for (const reference of references) {
    if (!Number.isInteger(reference.portal) || !Number.isInteger(reference.group)
      || !Number.isInteger(reference.side) || reference.portal < 0
      || reference.portal >= definitions.length || reference.portal > 65_535
      || reference.group < 0 || reference.group >= groups.length || reference.group > 65_535
      || reference.side < -32_768 || reference.side > 32_767) return empty();
  }
  const ranges = [];
  const owners = new Uint8Array(references.length);
  for (const group of groups) {
    const start = group.portalStart ?? 0;
    const count = group.portalCount ?? 0;
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0
      || count > 65_535 || start + count > references.length) return empty();
    ranges.push({ start, count });
    for (let at = start; at < start + count; at++) {
      if (owners[at] !== 0) return empty();
      owners[at] = 1;
    }
  }
  if (owners.some((owner) => owner === 0)) return empty();
  return { vertices, definitions, references, ranges };
}

/** Blocks start on a four-byte boundary so a decoder can view their floats without copying. */
function align4(value) {
  return (value + 3) & ~3;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
