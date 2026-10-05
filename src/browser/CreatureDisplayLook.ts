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
 * 0, ½, 1.
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
    return { ...emitter, color: particleColourRamp(colours, set, emitter.color) };
  });
  const result = changed ? { ...wvm, particleEmitters: emitters } : wvm;
  if (!byRow) coloured.set(wvm, byRow = new Map());
  byRow.set(colours, result);
  return result;
}
