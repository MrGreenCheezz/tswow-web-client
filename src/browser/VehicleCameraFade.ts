import { CAMERA_SUBJECT_FADE_END, CAMERA_SUBJECT_FADE_START, cameraFadeOpacity } from "./game/CameraClip.js";
import type { VehicleCatalog } from "../world/VehicleDbc.js";
import { isVehicleCarrierGuid } from "../world/VehicleSeatModel.js";
import type { WorldObjectState } from "../world/WorldState.js";

/**
 * 11.02 (26.10): the camera fading a vehicle as it closes in on it — Wow.exe 0x00606f90's fade loop (CameraClip.ts
 * ports its plain case). Starting at the camera's subject, a vehicle or a unit seated in one stands for that
 * vehicle; when the vehicle's row has Flags 0x80000 and its model is in, the band is CameraFadeDistScalarMax ×
 * the model's radius (whole) down to CameraFadeDistScalarMin × radius (gone), measured from the camera to the
 * model; then the loop climbs to the vehicle that vehicle rides, if any, and the most faded answer wins. 193 of
 * the dataset's 412 vehicles carry the flag (siege engines, demolishers, drakes): from the driver's seat they
 * otherwise fill the screen.
 *
 * Every unit the loop passed through is given the answer (`faded`); Wow.exe hands it to the world frame
 * (0x004f8660). Review: which models the world frame applies it to is not read; the subject and its vehicles are
 * the ones that can stand in front of the camera here. Also not read: Wow.exe skips the vehicle band while the
 * player's own passenger state is entering or leaving (a camera mid-transition shows the vehicle whole); this
 * client has no such state and keeps the band. The radius is the model's built bounds times its display scale
 * (Wow.exe: sequence 0's bounds radius — review the scale).
 */

/** Vehicle Flags bit 0x80000 (unnamed in VehicleDefines.h): the camera fades the vehicle's model (0x00606f90). Here, not in
 * game/VehicleCamera.ts, which the render worker may not import. */
export const VEHICLE_FLAG_CAMERA_FADE = 0x0008_0000;

/** Where a unit's model stands (world yards) and its radius, or undefined while it is not in. */
export interface FadeModel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

/** The camera, in world yards, and the numbers the plain fade reads. */
export interface FadeCamera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The drawn arm (`view`), the plain fade's distance. */
  readonly view: number;
  /** This client's pitch (positive looks up). */
  readonly pitch: number;
  readonly pivotHeight: number;
}

/** How many vehicles the loop climbs at most (a vehicle on a vehicle on a vehicle is the deepest seen). */
const MAX_CHAIN = 4;

function vehicleOf(objects: ReadonlyMap<bigint, WorldObjectState>, guid: bigint, catalog: VehicleCatalog | undefined) {
  const id = objects.get(guid)?.vehicleId;
  return id ? catalog?.vehicle(id) : undefined;
}

/** The vehicle a unit is seated in, or undefined. */
function carrierOf(objects: ReadonlyMap<bigint, WorldObjectState>, guid: bigint, catalog: VehicleCatalog | undefined): bigint | undefined {
  const transport = objects.get(guid)?.transport;
  if (transport === undefined || !isVehicleCarrierGuid(transport.guid)) return undefined;
  return vehicleOf(objects, transport.guid, catalog) !== undefined ? transport.guid : undefined;
}

/**
 * The subject's opacity, 0…1, with the vehicles it is in or is; `faded` is filled with every guid given it (the
 * subject first). Without a catalog or a vehicle this is exactly `cameraSubjectOpacity`.
 */
export function cameraChainFade(
  subject: bigint,
  objects: ReadonlyMap<bigint, WorldObjectState>,
  catalog: VehicleCatalog | undefined,
  modelOf: (guid: bigint) => FadeModel | undefined,
  camera: FadeCamera,
  faded: bigint[],
): number {
  faded.length = 0;
  faded.push(subject);
  let fade = 1;
  let unit: bigint | undefined = subject;
  for (let step = 0; unit !== undefined && step < MAX_CHAIN; step++) {
    let start = CAMERA_SUBJECT_FADE_START;
    let end = CAMERA_SUBJECT_FADE_END;
    let distance = camera.view;
    // A seated unit stands for its vehicle.
    const vehicleGuid: bigint | undefined = vehicleOf(objects, unit, catalog) !== undefined ? unit : carrierOf(objects, unit, catalog);
    if (vehicleGuid !== undefined) {
      unit = vehicleGuid;
      if (!faded.includes(unit)) faded.push(unit);
      const row = vehicleOf(objects, unit, catalog);
      const model = row !== undefined && (row.flags & VEHICLE_FLAG_CAMERA_FADE) !== 0 ? modelOf(unit) : undefined;
      if (row !== undefined && model !== undefined && model.radius > 0 && Number.isFinite(model.radius)) {
        end = (Number.isFinite(row.cameraFadeDistScalarMin) ? row.cameraFadeDistScalarMin : 0) * model.radius;
        start = (Number.isFinite(row.cameraFadeDistScalarMax) ? row.cameraFadeDistScalarMax : 0) * model.radius;
        distance = Math.hypot(camera.x - model.x, camera.y - model.y, camera.z - model.z);
      }
    }
    const value = cameraFadeOpacity(distance, camera.pitch, camera.pivotHeight, start, end);
    if (value < fade) fade = value;
    unit = carrierOf(objects, unit, catalog);
  }
  return fade;
}
