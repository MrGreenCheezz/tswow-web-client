/**
 * 22.10 (7.36): a city's street lamps as fixture lights, for the cinematic profile only.
 *
 * Stormwind's lamp posts are not doodads: they are the city WMO's own geometry, and their light is
 * the model's `MOLT` table (606 records in `Stormwind.wmo`, 255,187,99 at 0.17 by the trade
 * district's lanterns), which the client bakes into indoor vertex colour and never casts on the
 * street. The doodad census of the city scenario found no outdoor lamp doodad within 150 yards of
 * the bench camera, so without these the cinematic pools had nothing to light in a city.
 *
 * Only a record no room holds is taken (`wmoInteriorGroupAt` -1; an interior-only WMO gives none):
 * a room's lamp is already baked into its walls, and an unshadowed point there would shine out
 * through them. Positions are model-space and turned into the scene once per placement.
 */
import * as THREE from "three";
import type { LocalLightSample } from "./LocalLighting.js";
import { wmoInteriorGroupAt, wmoInteriorOnly, type WmoLight, type WmoModel } from "./WmoModel.js";

/** A fixture pool's reach before the cinematic pool widens it (`CINEMATIC_POOL_REACH`). */
const WMO_LIGHT_RADIUS_MIN = 6;
const WMO_LIGHT_RADIUS_MAX = 12;

const OUTDOOR = new WeakMap<WmoModel, readonly WmoLight[]>();

/** The model's lamps that stand outside every room, with a colour and a strength. Cached per model. */
export function wmoOutdoorLights(model: WmoModel): readonly WmoLight[] {
  let known = OUTDOOR.get(model);
  if (known) return known;
  known = wmoInteriorOnly(model) ? [] : model.lights.filter((light) => light.intensity > 0
    && light.colour.some((channel) => channel > 0)
    && wmoInteriorGroupAt(model, light.position[0], light.position[1], light.position[2]) < 0);
  OUTDOOR.set(model, known);
  return known;
}

/** Scene positions of one placement's outdoor lamps, x/y/z per lamp; computed once per placement. */
const PLACED = new WeakMap<object, Float32Array>();

export function wmoOutdoorLightPositions(
  placement: object,
  lights: readonly WmoLight[],
  modelToWorld: THREE.Matrix4,
): Float32Array {
  let positions = PLACED.get(placement);
  if (positions && positions.length === lights.length * 3) return positions;
  positions = new Float32Array(lights.length * 3);
  const point = new THREE.Vector3();
  lights.forEach((light, index) => {
    point.set(light.position[0], light.position[1], light.position[2]).applyMatrix4(modelToWorld);
    positions![index * 3] = point.x;
    positions![index * 3 + 1] = point.y;
    positions![index * 3 + 2] = point.z;
  });
  PLACED.set(placement, positions);
  return positions;
}

/**
 * One lamp as a heuristic fixture sample: the record's colour, normalised to its brightest
 * channel, a strength between 0.7 and 1.1 by its intensity, and the reach of its attenuation end
 * (6 to 12 yards). No flicker: the record has none to give.
 */
export function sampleWmoLight(light: WmoLight, x: number, y: number, z: number, result: LocalLightSample): boolean {
  const peak = Math.max(light.colour[0], light.colour[1], light.colour[2]);
  if (!(peak > 0)) return false;
  result.position.set(x, y, z);
  result.colour.set(light.colour[0] / peak, light.colour[1] / peak, light.colour[2] / peak);
  result.radius = Math.max(WMO_LIGHT_RADIUS_MIN, Math.min(WMO_LIGHT_RADIUS_MAX, light.attenuationEnd * 1.25));
  result.intensity = 0.7 + 0.4 * Math.min(1, light.intensity / 0.8);
  result.client = false;
  result.halo = false;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}
