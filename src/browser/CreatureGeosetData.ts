/**
 * 6.11а (line A7a, 05.10-A7a-A): `CreatureDisplayInfo.CreatureGeosetData` as geoset ids.
 *
 * One nibble per geoset group, the lowest nibble being group 1, up to eight groups; a non-zero
 * value `v` in group `g` selects geoset `g·100 + v`, a zero nibble selects nothing for that group.
 * Settled by the census `docs/implementation/probes/A7a/probe-geosets.mjs` (05.10): in the dataset
 * all 39 displays carrying the field wear `Creature\IronDwarf\IronDwarf.m2` (geosets 0, 101–104,
 * 201–202, 301–303, 401–402) and this reading lands on an existing geoset for every one of them
 * (0x1111 → 101/201/301/401, 0x1213 → 103/201/302/401), while the reverse nibble order misses on 6.
 * The installed visual DBC overlay carries 216 such displays over 11 models with up to eight
 * groups (0x22222211). 05.10 review (`.runtime/re-2026-10-05/A7a-A-review/probe-overlay-geosetdata.mjs`):
 * measured against the 00.skin of those models in the F:/Circle chain, this reading fits only the
 * 39 IronDwarf rows; it misses on every row of bogbeast2 (38), tuskarrmale_hd and its backpacks
 * (112), BloodElfMale_Guard (1), netherdrakeNoArmorPreview2 (6) and 12 of netherdrake2's 20. No
 * other tried reading fits everything either (high nibble first: the 6 preview rows and 3 more,
 * but 6 IronDwarf misses; groups from 0 with value − 1: 18 netherdrake rows, no IronDwarf; none
 * fits bogbeast2, the tuskarr or the guard). Those rows come from a later client's DBC; the
 * consumer must not hide a group on an id the model lacks.
 *
 * 05.10-A7a-H: confirmed against Wow.exe — 0x004e7790 reads the word four bits at a time, lowest
 * first, for groups 100..800, hiding g..g+99 and showing g+v for every non-zero v. The consumer is
 * `CreatureDisplayLook.creatureGeosetChoice`; this is the decoding alone.
 */
export const CREATURE_GEOSET_GROUPS = 8;

/** The geoset ids a display's `geosetData` selects, in group order; empty for 0 or a non-integer. */
export function creatureGeosetDataGeosets(geosetData: number | undefined): number[] {
  if (geosetData === undefined || !Number.isInteger(geosetData) || geosetData === 0) return [];
  const geosets: number[] = [];
  for (let group = 1; group <= CREATURE_GEOSET_GROUPS; group++) {
    const value = (geosetData >>> ((group - 1) * 4)) & 0xf;
    if (value !== 0) geosets.push(group * 100 + value);
  }
  return geosets;
}

/**
 * 05.10-A7a-H 6.11а: the wire shape of `CreatureModelMetadata.particleColors` — absent, or the
 * `ParticleColor.dbc` row's nine `0xAARRGGBB` words. Here rather than in `CreatureDisplayLook.ts` so
 * `CreatureModelClient` can check an answer without loading the model builder.
 */
export function isParticleColours(value: unknown): value is readonly number[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length === 9
    && value.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff));
}
