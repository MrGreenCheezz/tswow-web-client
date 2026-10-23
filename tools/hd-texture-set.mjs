// 23.10 (7.48): which client textures an HD set covers, and how each one has to be cut before it is upscaled.
//
// A set is a list of `{ path, grids, wrap }` entries:
// - `path` — the texture's path in the archives, backslashed and lowercased (the `/texture` route's key);
// - `grids` — every rows×columns flip-book layout something draws the texture with (particle and ribbon
//   emitters). A sheet is upscaled cell by cell so no cell bleeds into its neighbour (hd-texture-image.mjs);
// - `wrap` — whether anything samples it with repeat wrapping (an M2 texture's flags 0x1/0x2), so the edges
//   are padded from the opposite side and the HD copy tiles as seamlessly as the original.
//
// Sets:
// - `effects` (this step): every texture of every spell model — the `spells\*.m2` files plus whatever
//   `SpellVisualEffectName.dbc` names elsewhere — mesh, particle and ribbon slots alike. Character, creature
//   and item textures are never in it (character models and their skins are not touched), even when a spell
//   model borrows one.
// - `world` (a later step, not run yet): small terrain tilesets and WMO textures; enumerated here so the tool
//   can take it, but the owner has not asked for it to be generated.

const TEXTURE_SIZE = 16;
const HEADER_TEXTURES = 0x50;
const HEADER_RIBBONS = 0x120;
const HEADER_PARTICLES = 0x128;
const PARTICLE_SIZE = 0x1dc;
const RIBBON_SIZE = 0xb0;
/** `M2Texture.flags`: wrap in x / in y. */
const TEXTURE_WRAP = 0x01 | 0x02;
/** `M2Texture.type` 0: the file name is in the model; every other type is filled in at run time (skins, hair). */
const TEXTURE_TYPE_OWN = 0;

/** The subtrees that hold character, creature and item art: never part of an HD set (owner, 23.10). */
const NEVER_UPSCALED = ["character\\", "creature\\", "item\\"];

export const SET_NAMES = ["effects", "world"];

/**
 * The folders effect art lives in. The `effects` set keeps only these: a spell model that borrows a building's
 * or a dungeon's texture (468 of the 1,269 textures spell models name sit under `world\`, 41 under
 * `dungeons\`) draws scenery, which is the later `world` step. The browser asks for HD copies of exactly these
 * paths (`src/browser/HdTextures.ts`, a test holds the two lists equal).
 */
export const EFFECT_TEXTURE_PREFIXES = ["spells\\", "particles\\"];

/** The route's key for a texture path. */
export function textureKey(path) {
  return path.replaceAll("/", "\\").toLowerCase();
}

function array(buffer, at) {
  if (at + 8 > buffer.length) return { count: 0, offset: 0 };
  return { count: buffer.readUInt32LE(at), offset: buffer.readUInt32LE(at + 4) };
}

function fits(buffer, block, stride) {
  return block.count === 0 || (block.offset > 0 && block.offset + block.count * stride <= buffer.length);
}

function readName(buffer, block) {
  if (block.count === 0 || block.offset + block.count > buffer.length) return "";
  let end = block.offset;
  while (end < block.offset + block.count && buffer[end] !== 0) end++;
  return buffer.toString("latin1", block.offset, end);
}

/**
 * Every own texture of one MD20 model with how it is drawn: `[{ path, wrap, grids: [[rows, columns]] }]`.
 * A model that does not parse yields nothing rather than throwing — a set is built over thousands of files.
 */
export function modelTextureUses(model) {
  if (model.length < HEADER_PARTICLES + 8 || model.subarray(0, 4).toString("latin1") !== "MD20") return [];
  const table = array(model, HEADER_TEXTURES);
  if (table.count > 4096 || !fits(model, table, TEXTURE_SIZE)) return [];
  const slots = [];
  for (let index = 0; index < table.count; index++) {
    const at = table.offset + index * TEXTURE_SIZE;
    const type = model.readUInt32LE(at);
    const flags = model.readUInt32LE(at + 4);
    const path = type === TEXTURE_TYPE_OWN ? readName(model, array(model, at + 8)) : "";
    slots.push(path && /\.blp$/i.test(path) ? { path: textureKey(path), wrap: (flags & TEXTURE_WRAP) !== 0, grids: [] } : undefined);
  }
  const grid = (slot, rows, columns) => {
    const use = slots[slot];
    if (!use || rows < 1 || columns < 1 || rows > 64 || columns > 64 || (rows === 1 && columns === 1)) return;
    if (!use.grids.some(([r, c]) => r === rows && c === columns)) use.grids.push([rows, columns]);
  };
  const particles = array(model, HEADER_PARTICLES);
  if (particles.count <= 512 && fits(model, particles, PARTICLE_SIZE)) {
    for (let index = 0; index < particles.count; index++) {
      const at = particles.offset + index * PARTICLE_SIZE;
      grid(model.readUInt16LE(at + 0x16), model.readUInt16LE(at + 0x30), model.readUInt16LE(at + 0x32));
    }
  }
  const ribbons = array(model, HEADER_RIBBONS);
  if (ribbons.count <= 256 && fits(model, ribbons, RIBBON_SIZE)) {
    for (let index = 0; index < ribbons.count; index++) {
      const at = ribbons.offset + index * RIBBON_SIZE;
      const textures = array(model, at + 0x14);
      if (textures.count > 256 || !fits(model, textures, 2)) continue;
      for (let slot = 0; slot < textures.count; slot++) {
        grid(model.readUInt16LE(textures.offset + slot * 2), model.readUInt16LE(at + 0x80), model.readUInt16LE(at + 0x82));
      }
    }
  }
  return slots.filter((use) => use !== undefined);
}

/** The model file names a `SpellVisualEffectName.dbc` (WDBC, 3.3.5a: ID, Name, FileName, …) lists, as `.m2`. */
export function spellVisualModelPaths(dbc) {
  if (!dbc || dbc.length < 20 || dbc.toString("latin1", 0, 4) !== "WDBC") return [];
  const records = dbc.readUInt32LE(4);
  const fields = dbc.readUInt32LE(8);
  const recordSize = dbc.readUInt32LE(12);
  const stringSize = dbc.readUInt32LE(16);
  const strings = 20 + records * recordSize;
  if (fields < 3 || strings + stringSize > dbc.length) return [];
  const paths = new Set();
  for (let row = 0; row < records; row++) {
    const offset = dbc.readUInt32LE(20 + row * recordSize + 8);
    if (offset === 0 || offset >= stringSize) continue;
    let end = strings + offset;
    while (end < strings + stringSize && dbc[end] !== 0) end++;
    const name = dbc.toString("latin1", strings + offset, end).trim();
    if (/\.(?:mdx|mdl|m2)$/i.test(name)) paths.add(textureKey(name).replace(/\.(?:mdx|mdl)$/, ".m2"));
  }
  return [...paths];
}

/** Whether a texture may ever be in an HD set (never character, creature or item art). */
export function upscalable(path) {
  const key = textureKey(path);
  return /\.blp$/.test(key) && !NEVER_UPSCALED.some((prefix) => key.startsWith(prefix));
}

/**
 * Folds texture uses from many models into one entry per texture: grids united, `wrap` if any model wraps it.
 * Returned sorted by path, so a set is the same list on every run.
 */
export function mergeUses(useLists) {
  const byPath = new Map();
  for (const uses of useLists) {
    for (const use of uses) {
      if (!upscalable(use.path)) continue;
      let entry = byPath.get(use.path);
      if (!entry) byPath.set(use.path, entry = { path: use.path, wrap: false, grids: [] });
      entry.wrap ||= use.wrap;
      for (const [rows, columns] of use.grids) {
        if (!entry.grids.some(([r, c]) => r === rows && c === columns)) entry.grids.push([rows, columns]);
      }
    }
  }
  for (const entry of byPath.values()) entry.grids.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The `effects` set out of an open archive chain (tools/mpq.mjs): the models first, then their textures.
 * `report` is told how many models were read and how many failed to parse.
 */
export async function effectsSet(archives, report = () => undefined) {
  const models = new Set();
  for (const path of await archives.list("spells\\")) if (path.endsWith(".m2")) models.add(path);
  const dbc = await archives.read("DBFilesClient\\SpellVisualEffectName.dbc");
  for (const path of spellVisualModelPaths(dbc)) models.add(path);
  const lists = [];
  let read = 0;
  let missing = 0;
  for (const path of [...models].sort()) {
    const model = await archives.read(path);
    if (!model) {
      missing++;
      continue;
    }
    read++;
    lists.push(modelTextureUses(model));
  }
  report({ models: models.size, read, missing });
  return mergeUses(lists).filter((entry) => EFFECT_TEXTURE_PREFIXES.some((prefix) => entry.path.startsWith(prefix)));
}

/** The `world` set (later step): terrain tilesets and WMO textures, no grids, wrapped. Not generated yet. */
export async function worldSet(archives) {
  const paths = [];
  for (const prefix of ["tileset\\", "world\\"]) {
    for (const path of await archives.list(prefix)) if (path.endsWith(".blp") && upscalable(path)) paths.push(path);
  }
  return paths.sort().map((path) => ({ path, wrap: true, grids: [] }));
}
