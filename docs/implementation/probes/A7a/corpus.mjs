// A7a census helper (05.10): walk the M2 corpus of the F:/Circle MPQ chain, one model at a time, in one process.
// `walkM2(visit, { roots, budgetMs, withSkin, sample })` calls `visit(path, model, skin)`; skin is `<stem>00.skin` or null.
// `sample` (0..1) takes a deterministic fraction; `budgetMs` stops early and the result says so.
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";

export const ROOTS = ["World\\", "Spells\\", "Creature\\", "Item\\", "Dungeons\\", "Character\\", "Environments\\", "Particles\\", "Interface\\"];

export async function archives() {
  return clientArchives(clientDirectory());
}

export async function walkM2(visit, { roots = ROOTS, budgetMs = 600_000, withSkin = false, sample = 1 } = {}) {
  const chain = await archives();
  const all = [];
  for (const root of roots) for (const p of await chain.list(root)) if (/\.m2$/i.test(p)) all.push(p);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const picked = sample >= 1 ? all : all.filter(() => rnd() < sample);
  const start = Date.now();
  let read = 0, failed = 0, stopped = false;
  for (const path of picked) {
    if (Date.now() - start > budgetMs) { stopped = true; break; }
    try {
      const model = await chain.read(path);
      if (!model || model.byteLength < 0x130 || model.toString("latin1", 0, 4) !== "MD20") { failed++; continue; }
      let skin = null;
      if (withSkin) {
        try { skin = await chain.read(`${path.slice(0, -3)}00.skin`); } catch { skin = null; }
        if (skin && skin.toString("latin1", 0, 4) !== "SKIN") skin = null;
      }
      read++;
      await visit(path, model, skin);
    } catch { failed++; }
  }
  return { listed: all.length, picked: picked.length, read, failed, stopped, ms: Date.now() - start };
}

/** Top-level family of a path: spells, item, creature, world, character, … */
export function family(path) {
  return path.split(/[\\/]/)[0].toLowerCase();
}

export function arr(buf, at) {
  return { count: buf.readUInt32LE(at), offset: buf.readUInt32LE(at + 4) };
}

export function fits(buf, block, stride) {
  return block.offset + block.count * stride <= buf.length;
}

export function lookup(model, at) {
  const b = arr(model, at);
  if (b.count > 100_000 || !fits(model, b, 2)) return [];
  return Array.from({ length: b.count }, (_, i) => model.readUInt16LE(b.offset + i * 2));
}

export function geosets(skin) {
  const b = arr(skin, 0x1c);
  const out = new Set();
  if (!fits(skin, b, 48)) return out;
  for (let i = 0; i < b.count; i++) out.add(skin.readUInt16LE(b.offset + i * 48));
  return out;
}

/** Raw skin batches (24 bytes each). */
export function skinBatches(skin) {
  const b = arr(skin, 0x24);
  if (!fits(skin, b, 24)) return [];
  const out = [];
  for (let i = 0; i < b.count; i++) {
    const at = b.offset + i * 24;
    out.push({
      flags: skin.readUInt8(at), priorityPlane: skin.readInt8(at + 1), shaderId: skin.readUInt16LE(at + 2),
      submesh: skin.readUInt16LE(at + 4), geosetIndex: skin.readUInt16LE(at + 6), colorIndex: skin.readUInt16LE(at + 8),
      materialIndex: skin.readUInt16LE(at + 10), materialLayer: skin.readUInt16LE(at + 12), textureCount: skin.readUInt16LE(at + 14),
      textureComboIndex: skin.readUInt16LE(at + 16), textureCoordComboIndex: skin.readUInt16LE(at + 18),
      textureWeightComboIndex: skin.readUInt16LE(at + 20), textureTransformComboIndex: skin.readUInt16LE(at + 22),
    });
  }
  return out;
}

export function materials(model) {
  const b = arr(model, 0x70);
  if (b.count > 10_000 || !fits(model, b, 4)) return [];
  return Array.from({ length: b.count }, (_, i) => ({ flags: model.readUInt16LE(b.offset + i * 4), blendMode: model.readUInt16LE(b.offset + i * 4 + 2) }));
}

/** Texture filenames (empty string for a replaceable texture). */
export function textureNames(model) {
  const b = arr(model, 0x50);
  if (b.count > 10_000 || !fits(model, b, 16)) return [];
  const out = [];
  for (let i = 0; i < b.count; i++) {
    const at = b.offset + i * 16;
    const len = model.readUInt32LE(at + 8), off = model.readUInt32LE(at + 12);
    out.push(len && off + len <= model.length ? model.subarray(off, off + len).toString("latin1").replace(/\0+$/, "") : "");
  }
  return out;
}

export function inc(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

export function top(map, n = 12) {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}x${v}`).join(" ");
}
