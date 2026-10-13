// 13.10 6.11: the mount's own display record changes its look the way a creature's does.
//
// Wow.exe 0x0073d5d0 (the unit's mount, UNIT_FIELD_MOUNTDISPLAYID) builds the mount model from the mount's
// CreatureDisplayInfo row and then, on that model, calls 0x004e7790(mountModel, mountDisplay) — the
// CreatureGeosetData walk (`CreatureDisplayLook.creatureGeosetChoice`) — and 0x004f20c0(mountModel, display,
// modelData), the three skins and, through 0x004ea9e0, the ParticleColor sets (`particleColouredWvm`). The
// renderer built mounts with the file's geosets only, so a drake whose display picks its own horns and armour
// pieces wore every variant at once (or none); the geoset choice is now the display's, and it rides the build key
// since two mount displays of one model and skins may differ in CreatureGeosetData alone.

import type { GeosetChoice } from "./ModelBuild.js";
import type { WvmModel } from "./Wvm.js";
import { creatureGeosetChoice } from "./CreatureDisplayLook.js";

/** The mount's build key: the model and skins, and the display's geoset word when it has one. */
export function mountBuildKey(base: string, geosetData: number | undefined): string {
  return geosetData !== undefined && geosetData !== 0 ? `${base}#g${geosetData}` : base;
}

/** The geosets the mount draws: `base` with the display's CreatureGeosetData applied (0x004e7790). */
export function mountGeosets(model: Pick<WvmModel, "submeshes">, base: GeosetChoice, geosetData: number | undefined): GeosetChoice {
  return creatureGeosetChoice(model, base, geosetData);
}
