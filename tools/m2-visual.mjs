const encoder = new TextEncoder();

// The M2 half of this file went to tools/m2.mjs, which reads the whole model and opens the
// external .anim files this one could not. What is left is the WMO encoder: WVM1 for a mesh with
// one texture and WVM2 for one with per-material runs, plus the WVM3 skeleton container they grew.

export const TRACK_KINDS = { translation: 0, rotation: 1, scale: 2 };

/**
 * A texture slot of type 0 names its own file. Every other type is a promise that the client will
 * supply one: 1 is the character's body, 6 its hair, 11 to 13 the "monster skin" of a creature.
 * Measured on the live client, half of all creature models and every character model carry no
 * texture of their own and are blank without this substitution.
 */
export const TEXTURE_SLOT_OWN = 0;

export function parseM2Visual(model, skin, options = {}) {
  if (model.subarray(0, 4).toString() !== "MD20" || skin.subarray(0, 4).toString() !== "SKIN") throw new Error("Unsupported M2 or skin header");
  const vertexCount = model.readUInt32LE(60);
  const vertexOffset = model.readUInt32LE(64);
  if (vertexCount === 0 || vertexCount > 1_000_000 || vertexOffset + vertexCount * 48 > model.length) throw new Error("M2 vertex table is invalid");
  const lookupCount = skin.readUInt32LE(4);
  const lookupOffset = skin.readUInt32LE(8);
  const indexCount = skin.readUInt32LE(12);
  const indexOffset = skin.readUInt32LE(16);
  if (lookupCount > 1_000_000 || indexCount > 6_000_000 || indexCount % 3 !== 0
    || lookupOffset + lookupCount * 2 > skin.length || indexOffset + indexCount * 2 > skin.length) {
    throw new Error("M2 skin index tables are invalid");
  }
  const vertices = new Array(vertexCount * 3);
  const uvs = new Array(vertexCount * 2);
  for (let index = 0; index < vertexCount; index++) {
    const offset = vertexOffset + index * 48;
    vertices[index * 3] = model.readFloatLE(offset);
    vertices[index * 3 + 1] = model.readFloatLE(offset + 4);
    vertices[index * 3 + 2] = model.readFloatLE(offset + 8);
    uvs[index * 2] = model.readFloatLE(offset + 32);
    uvs[index * 2 + 1] = model.readFloatLE(offset + 36);
  }
  const lookup = new Array(lookupCount);
  for (let index = 0; index < lookupCount; index++) lookup[index] = skin.readUInt16LE(lookupOffset + index * 2);
  const indices = new Array(indexCount);
  for (let index = 0; index < indexCount; index++) {
    const lookupIndex = skin.readUInt16LE(indexOffset + index * 2);
    const vertex = lookup[lookupIndex];
    if (vertex === undefined || vertex >= vertexCount) throw new Error("M2 skin references an invalid vertex");
    indices[index] = vertex;
  }
  const externalTextures = readExternalTextures(model, options.directory ?? "", options.textures ?? new Map());
  const materials = m2MaterialGroups(model, skin, indices, externalTextures);
  return { vertices, uvs, indices: materials?.indices ?? indices, texture: externalTextures.find(Boolean) ?? "", ...(materials ?? {}) };
}

export function encodeVisualModel(model, textureUrl = "", skeleton = undefined) {
  if (Array.isArray(textureUrl)) {
    return skeleton ? encodeVisualModelV3(model, textureUrl, skeleton) : encodeVisualModelV2(model, textureUrl);
  }
  const texture = encoder.encode(textureUrl);
  if (texture.length > 1000 || model.vertices.length % 3 !== 0 || model.uvs.length / 2 !== model.vertices.length / 3) throw new Error("Visual model data is invalid");
  const data = Buffer.alloc(16 + model.vertices.length * 4 + model.uvs.length * 4 + model.indices.length * 4 + texture.length);
  data.write("WVM1", 0, "ascii");
  data.writeUInt32LE(model.vertices.length / 3, 4);
  data.writeUInt32LE(model.indices.length, 8);
  data.writeUInt16LE(texture.length, 12);
  data.writeUInt16LE(1, 14);
  let offset = 16;
  for (const value of model.vertices) data.writeFloatLE(value, offset), offset += 4;
  for (const value of model.uvs) data.writeFloatLE(value, offset), offset += 4;
  for (const value of model.indices) data.writeUInt32LE(value, offset), offset += 4;
  data.set(texture, offset);
  return data;
}

function encodeVisualModelV2(model, textureUrls) {
  if (!Array.isArray(model.groups) || model.groups.length === 0 || model.groups.length > 1000 || textureUrls.length === 0 || textureUrls.length > 1000
    || model.vertices.length % 3 !== 0 || model.uvs.length / 2 !== model.vertices.length / 3) throw new Error("Visual model material data is invalid");
  const textures = textureUrls.map((value) => encoder.encode(value));
  if (textures.some((value) => value.length > 1000)) throw new Error("Visual model texture URL is too long");
  for (const group of model.groups) {
    if (!Number.isInteger(group.start) || !Number.isInteger(group.count) || !Number.isInteger(group.material)
      || group.start < 0 || group.count <= 0 || group.start + group.count > model.indices.length || group.count % 3 !== 0
      || group.material < 0 || group.material >= textures.length) throw new Error("Visual model material group is invalid");
  }
  const textureBytes = textures.reduce((total, value) => total + 2 + value.length, 0);
  const data = Buffer.alloc(20 + model.vertices.length * 4 + model.uvs.length * 4 + model.indices.length * 4 + model.groups.length * 12 + textureBytes);
  data.write("WVM2", 0, "ascii");
  data.writeUInt32LE(model.vertices.length / 3, 4);
  data.writeUInt32LE(model.indices.length, 8);
  data.writeUInt16LE(textures.length, 12);
  data.writeUInt16LE(model.groups.length, 14);
  data.writeUInt32LE(1, 16);
  let offset = 20;
  for (const value of model.vertices) data.writeFloatLE(value, offset), offset += 4;
  for (const value of model.uvs) data.writeFloatLE(value, offset), offset += 4;
  for (const value of model.indices) data.writeUInt32LE(value, offset), offset += 4;
  for (const group of model.groups) {
    data.writeUInt32LE(group.start, offset);
    data.writeUInt32LE(group.count, offset + 4);
    data.writeUInt16LE(group.material, offset + 8);
    // The two bytes that used to be padding carry the material's own state: the blend mode the
    // artist chose and the MOMT flags, so the browser can draw a wall as a wall and a window as a
    // window instead of alpha-testing everything alike.
    data.writeUInt8(Math.min(255, group.blendMode ?? 0), offset + 10);
    data.writeUInt8(Math.min(255, group.flags ?? 0), offset + 11);
    offset += 12;
  }
  for (const texture of textures) {
    data.writeUInt16LE(texture.length, offset);
    data.set(texture, offset + 2);
    offset += 2 + texture.length;
  }
  return data;
}

/**
 * WVM3 is WVM2 with a skeleton appended: the same mesh body, plus per-vertex skin weights, the
 * bone tree and the keyframes of every exported animation. Word at 16 points at that block, so a
 * reader that only wants the mesh can stop where WVM2 would end.
 */
function encodeVisualModelV3(model, textureUrls, skeleton) {
  const body = encodeVisualModelV2(model, textureUrls);
  const vertexCount = model.vertices.length / 3;
  if (skeleton.skinIndices.length !== vertexCount * 4 || skeleton.skinWeights.length !== vertexCount * 4) {
    throw new Error("Visual model skin weights do not match the vertex table");
  }
  if (skeleton.bones.length === 0 || skeleton.bones.length > 1024 || skeleton.clips.length === 0 || skeleton.clips.length > 64) {
    throw new Error("Visual model skeleton is out of range");
  }

  let size = 4 + vertexCount * 8 + skeleton.bones.length * 16;
  for (const clip of skeleton.clips) {
    size += 12;
    for (const channel of clip.channels) {
      size += 8 + channel.times.length * 4 + channel.values.length * (channel.kind === TRACK_KINDS.rotation ? 2 : 4);
    }
  }

  const block = Buffer.alloc(size);
  let offset = 0;
  block.writeUInt16LE(skeleton.bones.length, offset);
  block.writeUInt16LE(skeleton.clips.length, offset + 2);
  offset += 4;
  block.set(skeleton.skinIndices, offset);
  offset += skeleton.skinIndices.length;
  block.set(skeleton.skinWeights, offset);
  offset += skeleton.skinWeights.length;
  for (const bone of skeleton.bones) {
    block.writeInt16LE(bone.parent, offset);
    block.writeUInt16LE(bone.flags & 0xffff, offset + 2);
    for (let axis = 0; axis < 3; axis++) block.writeFloatLE(bone.pivot[axis], offset + 4 + axis * 4);
    offset += 16;
  }
  for (const clip of skeleton.clips) {
    block.writeUInt16LE(clip.animationId, offset);
    block.writeUInt16LE(clip.looping ? 1 : 0, offset + 2);
    block.writeUInt32LE(clip.duration, offset + 4);
    block.writeUInt32LE(clip.channels.length, offset + 8);
    offset += 12;
    for (const channel of clip.channels) {
      block.writeUInt16LE(channel.bone, offset);
      block.writeUInt8(channel.kind, offset + 2);
      block.writeUInt8(Math.min(255, channel.interpolation), offset + 3);
      block.writeUInt32LE(channel.times.length, offset + 4);
      offset += 8;
      for (const time of channel.times) {
        block.writeUInt32LE(time, offset);
        offset += 4;
      }
      for (const value of channel.values) {
        if (channel.kind === TRACK_KINDS.rotation) block.writeInt16LE(value, offset), offset += 2;
        else block.writeFloatLE(value, offset), offset += 4;
      }
    }
  }
  if (offset !== size) throw new Error("Visual model skeleton block size mismatch");

  const data = Buffer.concat([body, block]);
  data.write("WVM3", 0, "ascii");
  data.writeUInt32LE(body.length, 16);
  return data;
}

function readExternalTextures(model, directory, textures) {
  const count = model.readUInt32LE(80);
  const offset = model.readUInt32LE(84);
  if (count > 1000 || offset + count * 16 > model.length) throw new Error("M2 texture table is invalid");
  const result = [];
  for (let index = 0; index < count; index++) {
    const record = offset + index * 16;
    const type = model.readUInt32LE(record);
    const length = model.readUInt32LE(record + 8);
    const nameOffset = model.readUInt32LE(record + 12);
    if (type === TEXTURE_SLOT_OWN) {
      result.push(length > 0 && nameOffset + length <= model.length
        ? model.subarray(nameOffset, nameOffset + length).toString("utf8").replace(/\0+$/, "").replaceAll("/", "\\")
        : "");
      continue;
    }
    result.push(resolveSlotTexture(textures.get(type) ?? "", directory));
  }
  return result;
}

/**
 * A monster skin arrives as a bare name and lives beside the model; a body or hair texture
 * arrives as a full path. The presence of a directory separator tells the two apart.
 */
export function resolveSlotTexture(value, directory) {
  if (!value) return "";
  if (value.includes("\\")) return /^[A-Za-z0-9_ .&()\\-]{1,240}\.blp$/i.test(value) && !value.includes("..") ? value : "";
  return directory && /^[A-Za-z0-9_ .&()-]{1,120}$/.test(value) ? `${directory}\\${value}.blp` : "";
}

/** Parses the `type:value` list the gateway forwards, e.g. `1:Textures\Baked\x.blp,11:MurlocGreen`. */
export function parseTextureSlots(spec) {
  const slots = new Map();
  for (const entry of (spec ?? "").split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    const type = Number.parseInt(entry.slice(0, separator), 10);
    const value = entry.slice(separator + 1).trim();
    if (Number.isInteger(type) && type > 0 && type < 64 && value) slots.set(type, value);
  }
  return slots;
}

function m2MaterialGroups(model, skin, indices, externalTextures) {
  if (skin.length < 44 || model.length < 136) return undefined;
  const submeshCount = skin.readUInt32LE(28);
  const submeshOffset = skin.readUInt32LE(32);
  const batchCount = skin.readUInt32LE(36);
  const batchOffset = skin.readUInt32LE(40);
  const lookupCount = model.readUInt32LE(128);
  const lookupOffset = model.readUInt32LE(132);
  if (submeshCount === 0 || batchCount === 0 || submeshCount > 10_000 || batchCount > 10_000 || lookupCount > 10_000
    || submeshOffset + submeshCount * 48 > skin.length || batchOffset + batchCount * 24 > skin.length
    || lookupOffset + lookupCount * 2 > model.length) return undefined;
  const textureBySubmesh = new Map();
  for (let index = 0; index < batchCount; index++) {
    const offset = batchOffset + index * 24;
    const submesh = skin.readUInt16LE(offset + 4);
    const textureCombo = skin.readUInt16LE(offset + 16);
    if (submesh >= submeshCount || textureCombo >= lookupCount || textureBySubmesh.has(submesh)) continue;
    const textureIndex = model.readUInt16LE(lookupOffset + textureCombo * 2);
    textureBySubmesh.set(submesh, externalTextures[textureIndex] ?? "");
  }
  const textureIndexes = new Map();
  const textures = [];
  const buckets = [];
  let covered = 0;
  for (let submesh = 0; submesh < submeshCount; submesh++) {
    const offset = submeshOffset + submesh * 48;
    const start = skin.readUInt16LE(offset + 8);
    const count = skin.readUInt16LE(offset + 10);
    if (count === 0) continue;
    if (count % 3 !== 0 || start + count > indices.length) return undefined;
    const texture = textureBySubmesh.get(submesh) ?? "";
    let material = textureIndexes.get(texture.toLowerCase());
    if (material === undefined) {
      material = textures.length;
      textureIndexes.set(texture.toLowerCase(), material);
      textures.push(texture);
      buckets.push([]);
    }
    const target = buckets[material];
    for (let offset = start; offset < start + count; offset++) target.push(indices[offset]);
    covered += count;
  }
  if (covered !== indices.length || textures.length === 0) return undefined;
  const groupedIndices = [];
  const groups = [];
  for (let material = 0; material < buckets.length; material++) {
    const bucket = buckets[material];
    if (bucket.length === 0) continue;
    groups.push({ start: groupedIndices.length, count: bucket.length, material });
    // See the note in wmo-visual.mjs: a bucket can be the model's whole index list.
    for (const index of bucket) groupedIndices.push(index);
  }
  return { indices: groupedIndices, groups, textures };
}
