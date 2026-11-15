import { game } from "./Context.js";
import { settings, settingOn } from "../ui/Settings.js";
import { settingNumber } from "../ui/SettingsModel.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState, WorldPosition } from "../../world/WorldState.js";
import { CameraTerrainTilt, type TerrainTiltSubject } from "./CameraTerrainTilt.js";
import { CameraBob, cameraBobInput } from "./CameraBob.js";
import { CameraPivot, cameraPivotAllowed } from "./CameraPivot.js";
import { CAMERA_WATER_NONE, cameraWaterNod, cameraWaterState, cameraWaterSurface } from "./CameraWater.js";
import { CAMERA_AXIS_PITCH, cameraViews } from "./CameraViews.js";
import { cameraFollow } from "./CameraFollow.js";
import { vehicleCamera } from "./VehicleCamera.js";
import { characterMotion } from "../input/Movement.js";
import { moverGuid } from "../input/Mover.js";
import { viewIsOut, viewSubject } from "./ViewSubject.js";
import { resultUnitHeight } from "../RenderResults.js";
import { cameraSteerInputs, type CameraSteerWater } from "./CameraSteerPitch.js"; // 5.14 (15.11)
import { readByte, readField } from "../../world/Fields.js"; // 5.14 (15.11)

/** TYPEID_PLAYER. */
const TYPEID_PLAYER = 4;

/**
 * 5.14 (11.11): the three stock camera options and the water nod on the page's one camera, once a frame from the render
 * loop (Loop.ts, before the boom): the terrain tilt (CameraTerrainTilt.ts → `rig.terrainTilt`), the smart pivot
 * (CameraPivot.ts → the lens pitch), the head bob (CameraBob.ts → the eye height and the lens across the ground) and
 * the pitch the camera glides to as the character surfaces or dives (CameraWater.cameraWaterNod). The mouse look asks
 * {@link cameraPivotLook} (input/Controls.ts). The vehicle's lens (VehicleCamera.ts) is written first each frame; these
 * add to it, and reach the renderer through the same `setCameraLens`.
 */

const DEG = Math.PI / 180;
/** UNIT_FLAG_TAXI_FLIGHT. */
const TAXI = 0x100000;
/** The base speeds, yards a second, until the server says otherwise. */
const WALK = 2.5;
const RUN = 7;
const RUN_BACK = 4.5;

const tilt = new CameraTerrainTilt();
const bob = new CameraBob();
const pivot = new CameraPivot();
let lastWorld: unknown;
let waterState = CAMERA_WATER_NONE;
let lensDirty = false;
/** 3.11 (15.11): the world and subject the follow's spline hold belongs to. */
let heldWorld: unknown;
let heldGuid: bigint | undefined;

function isUnit(subject: WorldObjectState | undefined): boolean {
  return subject !== undefined && (subject.typeId === 3 || subject.typeId === 4);
}

function unitFlags(subject: WorldObjectState): number {
  return subject.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset) ?? 0;
}

/** 0x00987570 for a unit on the ground: its walk, back or run speed while a move bit is set, else 0. */
function groundSpeed(subject: WorldObjectState): number {
  const flags = subject.movementFlags;
  if ((flags & 0xc0000f) === 0) return 0;
  const speeds = subject.speeds;
  const run = speeds?.get("run") ?? subject.runSpeed ?? RUN;
  if ((flags & 0x100) !== 0) {
    const walk = speeds?.get("walk") ?? WALK;
    return walk < run ? walk : run;
  }
  const back = speeds?.get("runBack") ?? RUN_BACK;
  return (flags & 2) !== 0 && back <= run ? back : run;
}

/** The camera's own pitch in Wow.exe's sign (positive looks down): this rig's is the other way. */
function wowPitch(): number {
  return -game.camera.pitch;
}

function pivotAllowedFor(subject: WorldObjectState | undefined): boolean {
  return cameraPivotAllowed({
    enabled: settingOn("cameraPivot"), unit: isUnit(subject), movementFlags: subject?.movementFlags ?? 0,
    pitch: wowPitch(), boom: game.camera.boomHit ?? 0,
  });
}

/**
 * 0x006020b0's share of a mouse move for the smart pivot: `yaw` and `pitch` are the move's turns in radians, `pitch`
 * positive looking down (mouseInvertPitch in it). Answers the part the camera's own pitch takes, same sign.
 */
export function cameraPivotLook(yaw: number, pitch: number): number {
  const subject = viewSubject(game.world);
  const delta = pivot.look(yaw, pitch, pivotAllowedFor(subject), wowPitch(),
    cameraViews.cvarNumber("cameraPivotDXMax"), cameraViews.cvarNumber("cameraPivotDYMin"), performance.now());
  applyPivotLens();
  cameraSteerInputs.pivotTurn = pivot.turn; // 5.14 (15.11)
  return delta;
}

/**
 * 5.14 (15.11): what the right-button steer reads besides the camera's pitch (CameraSteerPitch.ts, Wow.exe 0x006023d0): the
 * smart pivot's turn and the subject's water, for Movement.ts to ask while steering.
 */
function updateSteerInputs(subject: WorldObjectState | undefined): void {
  cameraSteerInputs.pivotTurn = pivot.turn;
  const water = steerWater;
  water.state = waterState;
  water.dive = cameraViews.cvarNumber("cameraDive") !== 0;
  water.surfacePitch = cameraViews.cvarNumber("cameraSurfacePitch");
  water.submergePitch = cameraViews.cvarNumber("cameraSubmergePitch");
  water.drunk = subject !== undefined && subject.typeId === TYPEID_PLAYER && playerDrunk(subject);
  cameraSteerInputs.water = water;
}

const steerWater: { -readonly [K in keyof CameraSteerWater]: CameraSteerWater[K] } = {
  state: CAMERA_WATER_NONE, dive: true, surfacePitch: 0, submergePitch: 0, drunk: false,
};

/**
 * 0x004f7290 ≠ 0: PLAYER_BYTES_3's inebriation byte or PLAYER_FAKE_INEBRIATION (+0x2b8), the larger, 100 at most (its low
 * byte when the fake one is the larger) — as FrameXmlUnitTooltipFacts.frameXmlDrunkLevelDrop reads the same function.
 */
function playerDrunk(subject: WorldObjectState): boolean {
  const drunk = readByte(subject, "PLAYER_BYTES_3", 1) ?? 0;
  const fake = (readField(subject, "PLAYER_FAKE_INEBRIATION") ?? 0) | 0;
  if ((drunk >= fake ? drunk : fake) >= 100) return true;
  return (fake < drunk ? drunk : fake & 0xff) !== 0;
}

function applyPivotLens(): void {
  const lens = vehicleCamera.lens.pitch - pivot.turn;
  if (game.camera.lensPitch !== lens) {
    game.camera.lensPitch = lens;
    lensDirty = true;
  }
}

/** One frame of the options, after the views' glide and before the boom (Loop.ts). */
export function advanceCameraOptions(now: number, subject: WorldObjectState | undefined, position: WorldPosition): void {
  const rig = game.camera;
  const world = game.world;
  if (world !== lastWorld) {
    lastWorld = world;
    tilt.reset();
    bob.reset();
    pivot.reset();
    waterState = CAMERA_WATER_NONE;
  }
  // 3.11 (15.11): a new world or a new subject is a new camera: no yaw held from the last one's spline.
  if (world !== heldWorld || subject?.guid !== heldGuid) {
    heldWorld = world;
    heldGuid = subject?.guid;
    cameraFollow.spline(false, 0, rig, now, cameraViews, undefined);
  }
  const unit = isUnit(subject);
  const flags = subject?.movementFlags ?? 0;
  const taxi = subject !== undefined && (unitFlags(subject) & TAXI) !== 0;
  const values = settings();

  // The terrain tilt (0x00603a10, 0x00601b70).
  const map = world?.mapId;
  const collision = game.collision?.world;
  const terrain = game.terrain;
  const tiltSubject: TerrainTiltSubject | undefined = subject === undefined ? undefined : {
    unit, x: position.x, y: position.y, z: position.z, facing: position.orientation, movementFlags: flags, taxi,
    // camera+0x98 bit 0x1000 (0x00602eb0): the unit on a server spline that is not a taxi's.
    fear: subject.motion !== undefined && !taxi,
  };
  rig.terrainTilt = tilt.frame(now, tiltSubject, {
    enabled: settingOn("cameraTerrainTilt"),
    style: settingNumber(values, "cameraSmoothStyle"),
    cvar: (name) => cameraViews.cvarNumber(name),
    world: {
      firstHit: collision ? (from, to) => collision.firstHit(from, to)?.t : undefined,
      floorUnder: collision ? (x, y, fromZ, toZ) => collision.floorUnder(x, y, fromZ, toZ) : undefined,
      heightAt: terrain && map !== undefined ? (x, y) => terrain.heightAt(map, x, y) : undefined,
    },
  });

  // The nod as the character surfaces or dives (0x006049c0, 0x00606f90), its own water only.
  const own = world !== undefined && subject !== undefined && subject.guid === moverGuid(world);
  const height = subject === undefined ? undefined : resultUnitHeight(game.renderer?.results, subject.guid);
  const surface = own ? cameraWaterSurface(characterMotion().liquid, position.x, position.y) : undefined;
  const state = unit && height !== undefined ? cameraWaterState(position.z, surface, height) : CAMERA_WATER_NONE;
  const nod = settingOn("cameraWaterCollision") ? cameraWaterNod(waterState, state,
    cameraViews.cvarNumber("cameraSurfaceFinalPitch"), cameraViews.cvarNumber("cameraSubmergeFinalPitch")) : undefined;
  waterState = state;
  if (nod !== undefined) {
    if (cameraViews.freelooking) {
      rig.pitch = -nod * DEG;
      cameraViews.stopAxis(CAMERA_AXIS_PITCH);
    } else {
      cameraViews.glideAxis(CAMERA_AXIS_PITCH, -nod * DEG, 0, 1, (settingNumber(values, "cameraYawSmoothSpeed") / 4) * DEG,
        now, rig);
    }
  }

  // 3.11 (15.11): the yaw held in the world while the subject is on a server spline (0x00602eb0, CameraFollow.spline) — the
  // same test the terrain tilt's Fear makes above. Before the boom, as in 0x00606f90.
  const yawSpeed = settingNumber(values, "cameraYawSmoothSpeed");
  cameraFollow.spline(unit && subject !== undefined && subject.motion !== undefined && !taxi, position.orientation, rig,
    now, cameraViews, subject === undefined || viewIsOut(world) ? undefined
      : { style: settingNumber(values, "cameraSmoothStyle"), yawSpeed, pitchSpeed: yawSpeed / 4, subject });
  // 11.02 (15.11, vehicle8): a FlagsB 0x1 seat keeps the passenger's view still in the world (VehicleCamera.ts `seatYawTurn`).
  const seatTurn = vehicleCamera.seatYawTurn(position.orientation,
    subject !== undefined && subject.guid === world?.state.selfGuid, cameraFollow.held, now);
  if (seatTurn !== 0) cameraViews.turnYaw(seatTurn, rig);

  // The smart pivot's way home (0x00606f90 → 0x00602600).
  pivot.frame(now, pivotAllowedFor(subject));
  applyPivotLens();
  updateSteerInputs(subject); // 5.14 (15.11)

  // The head bob (0x00600090 on the input word, 0x00602f30).
  bob.input(cameraBobInput(cameraFollow.word), now);
  const offset = bob.frame(now, subject === undefined ? undefined : {
    arm: rig.distance, unit, enabled: settingOn("cameraBobbing"), movementFlags: flags,
    mounted: (subject.fields.get(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset) ?? 0) !== 0, taxi,
    facing: position.orientation, speed: groundSpeed(subject),
  });
  rig.eyeHeight += offset.z;
  const lensX = vehicleCamera.lens.x + offset.x;
  const lensY = vehicleCamera.lens.y + offset.y;
  if (rig.lensX !== lensX || rig.lensY !== lensY) {
    rig.lensX = lensX;
    rig.lensY = lensY;
    lensDirty = true;
  }
  if (lensDirty) {
    lensDirty = false;
    game.renderer?.setCameraLens?.(rig.lensYaw ?? 0, rig.lensPitch ?? 0, rig.lensX ?? 0, rig.lensY ?? 0);
  }
}
