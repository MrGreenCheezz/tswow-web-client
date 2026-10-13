/**
 * 6.11а (line A7a, slice H, 05.10): what a creature's display record changes about its look beyond
 * the model and the skins — `CreatureModelAlpha`, `CreatureGeosetData` and `ParticleColorID` — as
 * Wow.exe 3.3.5a 12340 applies them. Pure functions; the renderer only calls them (`05.10-A7a-H`
 * hooks in `WorldRenderer3D.ts`).
 *
 * Geosets — 0x004e7790, called with the unit's model and its display record right after the model
 * is set up (0x0073e410 region, beside 0x004f20c0 which fills skins 11..13): when the word is not
 * zero, for group g = 100, 200 … 800 it takes the next four bits, lowest first; a non-zero value v
 * hides the whole range g … g+99 (0x0082c7c0(g, g+99, 0)) and shows g+v (0x0082c7c0(g+v, g+v, 1)).
 * That is the decoding in `CreatureGeosetData.ts`. One deliberate difference: Wow.exe hides the
 * group even when the model carries no g+v, which would empty the group; the visual DBC overlay
 * holds rows from a later client whose ids the 3.3.5 models here lack (bogbeast2, the tuskarr and
 * their backpacks, the blood elf guard, the drakes — `.runtime/re-2026-10-05/A7a-A-review/`), so a
 * group is only rewritten when its chosen id exists in the model.
 *
 * Particle colours — 0x004ea9e0: for i = 0..2 the model gets colour set 11+i = (Start[i], Mid[i],
 * End[i]) of the `ParticleColor.dbc` row (columns 1+i, 4+i, 7+i); 0x00825410 gives the set to every
 * emitter whose `particleColorIndex` (record +0x2a) equals 11+i, and 0x0097a990 stores the three
 * colours' red, green and blue bytes as that emitter's colour override (flag 0x10). The alpha byte is
 * not read: the emitter's own opacity ramp stays. Where on the particle's life the middle colour sits
 * was not traced; an authored three-key colour ramp keeps its own times, any other shape gets
 * 0, ½, 1. 13.10 6.11: traced — `particleColourOverride` (0x0097d370, 0x0097aff0, 0x00979d60, 0x009795d0).
 *
 * Alpha — `CreatureModelAlpha / 255` multiplies the unit's existing opacity (spawn fade, stealth,
 * ghost); where Wow.exe applies the column was not traced in this slice.
 *
 * Per-frame cost: `creatureDisplayAlpha` is a property read and two compares; `particleColouredWvm`
 * is two map lookups for a unit whose display names a colour row and nothing otherwise; the geoset
 * choice is made once per build.
 */
import type { GeosetChoice } from "./ModelBuild.js";
import { geosetList, geosetVisible } from "./ModelBuild.js";
import type { WvmModel, WvmParticleEmitter, WvmRamp } from "./Wvm.js";
import { creatureGeosetDataGeosets } from "./CreatureGeosetData.js";

/** The display's own opacity factor: `alpha` when it is a fraction in [0, 1], else opaque. */
export function creatureDisplayAlpha(metadata: { readonly alpha?: number | undefined } | undefined): number {
  const alpha = metadata?.alpha;
  return alpha !== undefined && alpha >= 0 && alpha <= 1 ? alpha : 1;
}

/**
 * The geosets a creature draws once its display's `CreatureGeosetData` is applied on top of `base`
 * (what `worldCharacterGeosets` chose). `base` itself when the word says nothing this model can show.
 */
export function creatureGeosetChoice(model: Pick<WvmModel, "submeshes">, base: GeosetChoice,
  geosetData: number | undefined): GeosetChoice {
  const wanted = creatureGeosetDataGeosets(geosetData);
  if (wanted.length === 0) return base;
  const present = new Set<number>();
  for (const submesh of model.submeshes) present.add(submesh.geosetId);
  const chosen = new Map<number, number>();
  for (const id of wanted) if (present.has(id)) chosen.set(Math.floor(id / 100), id);
  if (chosen.size === 0) return base;
  const ids: number[] = [];
  for (const id of present) {
    const pick = id >= 100 ? chosen.get(Math.floor(id / 100)) : undefined;
    if (pick !== undefined ? id === pick : geosetVisible(id, base)) ids.push(id);
  }
  return geosetList(ids);
}

export { isParticleColours } from "./CreatureGeosetData.js";

/** Emitter colour slots 11, 12, 13 (Wow.exe 0x004ea9e0). */
const FIRST_PARTICLE_COLOUR_SLOT = 11;
const PARTICLE_COLOUR_SETS = 3;

function channel(word: number, shift: number): number {
  return ((word >>> shift) & 0xff) / 255;
}

/** Start, middle and end of set `set` as a three-key RGB ramp, on the authored times when it has three. */
export function particleColourRamp(colours: readonly number[], set: number, authored: WvmRamp | undefined): WvmRamp {
  const times = authored && authored.times.length === 3 ? authored.times : Float32Array.from([0, 0.5, 1]);
  const values = new Float32Array(9);
  for (let key = 0; key < 3; key++) {
    const word = colours[key * PARTICLE_COLOUR_SETS + set] ?? 0;
    values[key * 3] = channel(word, 16);
    values[key * 3 + 1] = channel(word, 8);
    values[key * 3 + 2] = channel(word, 0);
  }
  return { components: 3, times, values };
}

/**
 * 13.10 6.11: the middle time of Wow.exe's three-segment particle table, or undefined when the emitter does not
 * get one. 0x0097d370 builds the table (emitter +0x11c, flag 0x1000000) only when colour, opacity and scale have
 * one to three keys, the cell ramps at most four (four only with equal second and third times), lifespanVary is
 * zero, the scale is uniform with no scale vary, and not a random cell with an empty head ramp; its middle
 * (+0x118) is the second key time of the first three-key ramp of colour, opacity, scale, head cell (more than two
 * keys), tail cell, which every other such ramp must share — 0 when none has three.
 */
export function particleTableMiddle(emitter: WvmParticleEmitter): number | undefined {
  const count = (ramp: WvmRamp | undefined): number => ramp?.times.length ?? 0;
  const colour = count(emitter.color);
  const opacity = count(emitter.opacity);
  const scale = count(emitter.scale);
  const head = count(emitter.headCell);
  const tail = count(emitter.tailCell);
  if (colour < 1 || colour > 3 || opacity < 1 || opacity > 3 || scale < 1 || scale > 3) return undefined;
  for (const [ramp, keys] of [[emitter.headCell, head], [emitter.tailCell, tail]] as const) {
    if (keys > 4 || (keys === 4 && ramp!.times[1] !== ramp!.times[2])) return undefined;
  }
  if (emitter.lifespanVary !== 0) return undefined;
  const cells = Math.max(1, emitter.textureRows) * Math.max(1, emitter.textureColumns);
  if (head === 0 && (emitter.flags & 0x10000) !== 0 && cells > 1) return undefined; // 0x00978e30's random cell
  if ((emitter.scaleVary?.[0] ?? 0) !== 0 || (emitter.scaleVary?.[1] ?? 0) !== 0) return undefined;
  const scaleValues = emitter.scale!.values;
  if ((emitter.scale!.components ?? 1) >= 2) {
    for (let key = 0; key + 1 < scaleValues.length; key += 2) if (scaleValues[key] !== scaleValues[key + 1]) return undefined;
  }
  const middleOf = (ramp: WvmRamp | undefined): number => ramp!.times[1]!;
  const middle = colour === 3 ? middleOf(emitter.color) : opacity === 3 ? middleOf(emitter.opacity)
    : scale === 3 ? middleOf(emitter.scale) : head > 2 ? middleOf(emitter.headCell)
      : tail > 2 ? middleOf(emitter.tailCell) : 0;
  if (opacity === 3 && middleOf(emitter.opacity) !== middle) return undefined;
  if (scale === 3 && middleOf(emitter.scale) !== middle) return undefined;
  if (head > 2 && middleOf(emitter.headCell) !== middle) return undefined;
  if (tail > 2 && middleOf(emitter.tailCell) !== middle) return undefined;
  return middle;
}

/**
 * 13.10 6.11: an emitter's colour ramp with the display's three colours, placed where Wow.exe places them.
 * With the table (`particleTableMiddle`, sampled by 0x00979d60): start at 0, middle at the table's middle, end
 * at 1 (0x0097aff0 fills it from the override 0x0097a990 stored). Without it (0x00979e90 → 0x009795d0): the
 * emitter's own key times, key k taking colour k — start, middle, end, and the end for any key past the third —
 * and a one-key ramp keeps its own colour, as 0x009795d0 never reaches the override for it.
 */
export function particleColourOverride(colours: readonly number[], set: number, emitter: WvmParticleEmitter): WvmRamp {
  const three = particleColourRamp(colours, set, undefined).values;
  const middle = particleTableMiddle(emitter);
  if (middle !== undefined) return { components: 3, times: Float32Array.from([0, middle, 1]), values: three };
  const authored = emitter.color;
  const keys = authored?.times.length ?? 0;
  if (!authored || keys <= 1) return authored ?? particleColourRamp(colours, set, undefined);
  const values = new Float32Array(keys * 3);
  for (let key = 0; key < keys; key++) values.set(three.subarray(Math.min(key, 2) * 3, Math.min(key, 2) * 3 + 3), key * 3);
  return { components: 3, times: authored.times, values };
}

const coloured = new WeakMap<object, Map<readonly number[], object>>();

/**
 * `wvm` with the colour ramp of each emitter on slots 11..13 replaced by the display's
 * `ParticleColor` row. Memoised on the model and the row array, so the effect cache, which rebuilds
 * when the model it was built from changes identity, sees one stable model per (file, row).
 */
export function particleColouredWvm<T extends Pick<WvmModel, "particleEmitters">>(wvm: T,
  colours: readonly number[] | undefined): T {
  if (!colours) return wvm;
  let byRow = coloured.get(wvm);
  const known = byRow?.get(colours);
  if (known) return known as T;
  let changed = false;
  const emitters = wvm.particleEmitters.map((emitter): WvmParticleEmitter => {
    const set = emitter.particleColorIndex - FIRST_PARTICLE_COLOUR_SLOT;
    if (set < 0 || set >= PARTICLE_COLOUR_SETS) return emitter;
    changed = true;
    return { ...emitter, color: particleColourOverride(colours, set, emitter) }; // 13.10 6.11: Wow.exe's placement
  });
  const result = changed ? { ...wvm, particleEmitters: emitters } : wvm;
  if (!byRow) coloured.set(wvm, byRow = new Map());
  byRow.set(colours, result);
  return result;
}
