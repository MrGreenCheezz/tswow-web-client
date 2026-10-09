/**
 * 6.18 (line A7a, slice G, 05.10): which geosets a figure outside the world draws — the
 * character-select and creation backdrop (glue/GlueCharacterScene.ts), every Model widget the glue
 * stage draws including the dressing room (glue/GlueModelStage.ts), the character lab and the
 * bench harness.
 *
 * The world builds its characters with `worldCharacterGeosets`, which checks the gateway's boot
 * choice against the model that actually arrived (patch-W bodies whose ordinary boot reaches only
 * the ankle). These figures used to hand the gateway's list straight to `buildModel`, so the same
 * character could stand in different boots on the select screen and in the world. With an
 * appearance the answer is now the world's; without one it is every authored geoset, as before.
 * The portrait and the paper-doll need nothing here: they borrow the world unit's own build.
 *
 * `override` is the lab's `geosets=` parameter: an explicit list typed by whoever is looking, taken
 * as written.
 */
import type { CharacterAppearance } from "./CharacterAtlas.js";
import { EVERY_GEOSET, geosetList, worldCharacterGeosets, type GeosetChoice } from "./ModelBuild.js";
import type { WvmModel } from "./Wvm.js";

export function figureGeosets(
  model: WvmModel,
  appearance: CharacterAppearance | undefined,
  override?: Iterable<number>,
): GeosetChoice {
  if (override) return geosetList(override);
  return appearance ? worldCharacterGeosets(model, appearance, true) : EVERY_GEOSET;
}
