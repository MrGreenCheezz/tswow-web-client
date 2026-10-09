// 6.22 (05.10-A7a-F2): the shader id a batch is drawn with, resolved the way Wow.exe resolves it
// when it loads a model — not the raw u16 the .skin stores.
//
// Read off Wow.exe 3.3.5a (12340), `Wow.exe.clean`, function at va 0x836980 (entry 0x836990 is
// inside it), run once per batch of a skin profile at load; notes under
// `.runtime/re-2026-10-05/A7a-F2/`. Described here in our own words:
//
// * A raw id with bit 0x8000 is left exactly as stored. Those are the client's special effect ids
//   (153 of the 154 two-unit `creature\` batches in models without header flag 0x08 store 0x8001).
// * Header flag 0x08 clear (the classic models): the raw id is thrown away. Stage 0 becomes
//   Opaque when the batch's material is opaque and Mod otherwise; it is a sphere-map stage when the
//   texture-coord combo of unit 0 is above 2 (the file's −1); a coord of exactly 1 sets 0x4000.
//   Stage 1 is never looked at: its nibble stays 0.
// * Header flag 0x08 set: the raw id is an index into `texture_combiner_combos` (M2Array<u16> at
//   header 0x130). Unit n's operation is `combos[raw + n]`; unit 0 is forced to Opaque on an opaque
//   material; each unit whose coord combo is above 2 is a sphere-map stage (`| 8`); 0x4000 is set
//   when the *last* unit's coord is exactly 1.
// * Either way the id is `(stage0 << 4) | stage1`, plus 0x4000.
//
// The copy pass at va 0x837680 (a batch with the same material as the one before it takes that
// batch's shader id, texture count, texture combo and transform combo, chained; the same pass also
// fuses an opaque batch with a following one-texture sphere-mapped layer into the 0x8000 effects)
// is **not** emulated: the 05.10 census found it changes 4 batches in one model (`kiljaeden.m2`,
// transform combo only). Recorded in docs/implementation/line-A7a.ru.md, 6.22.

/** `texture_combiner_combos` operations, in the order the client's table uses them. */
export const COMBINER_OPS = ["Opaque", "Mod", "Decal", "Add", "Mod2x", "Fade", "Mod2xNA", "AddNA"];
/** Header flag: the model carries `texture_combiner_combos` and its shader ids index it. */
export const M2_FLAG_COMBINER_COMBOS = 0x08;
/** The resolved id's "sphere-map stage" bit, inside one stage nibble. */
export const STAGE_SPHERE_MAP = 0x8;
/** The resolved id says the last unit reads the second UV set. */
export const SHADER_LAST_UNIT_UV2 = 0x4000;
/** A raw id the loader leaves alone: one of the client's special effects. */
export const SHADER_SPECIAL = 0x8000;

/**
 * One batch's resolved shader id.
 *
 * `coords` are the raw u16 entries of the texture-coord combo table for this batch's units, in
 * unit order (0xFFFF stays 0xFFFF — it is "above 2", which is what makes it a sphere map).
 * `combiners` is the model's `texture_combiner_combos`, or undefined when header flag 0x08 is clear.
 */
export function resolveShaderId({ rawShaderId, textureCount, coords, opaque, combiners }) {
  if ((rawShaderId & SHADER_SPECIAL) !== 0) return rawShaderId & 0xffff;
  if (!combiners) {
    const coord = coords[0] ?? 0;
    let stage = opaque ? 0 : 1;
    if (coord > 2) stage |= STAGE_SPHERE_MAP;
    return (stage << 4) | (coord === 1 ? SHADER_LAST_UNIT_UV2 : 0);
  }
  const stages = [0, 0];
  let id = 0;
  // The client keeps two stage slots; a third unit would land past them. None of the corpus's
  // flagged batches reaches it in a way that matters (the renderer draws two units at most).
  const units = Math.min(textureCount, 2);
  for (let unit = 0; unit < textureCount; unit++) {
    let op = combiners[rawShaderId + unit] ?? 0;
    if (unit === 0 && opaque) op = 0;
    const coord = coords[unit] ?? 0;
    if (unit < units) stages[unit] = (op & 0xffff) | (coord > 2 ? STAGE_SPHERE_MAP : 0);
    if (coord === 1 && unit + 1 === textureCount) id |= SHADER_LAST_UNIT_UV2;
  }
  return (id | ((stages[0] & 0xfff) << 4) | (stages[1] & 0xffff)) & 0xffff;
}

/** The header's `texture_combiner_combos`, or undefined when flag 0x08 is clear or the array is bad. */
export function readCombinerCombos(model) {
  if (model.length < 0x138 || (model.readUInt32LE(0x10) & M2_FLAG_COMBINER_COMBOS) === 0) return undefined;
  const count = model.readUInt32LE(0x130);
  const offset = model.readUInt32LE(0x134);
  if (count > 100_000 || offset + count * 2 > model.length) return undefined;
  const values = new Uint16Array(count);
  for (let index = 0; index < count; index++) values[index] = model.readUInt16LE(offset + index * 2);
  return values;
}
