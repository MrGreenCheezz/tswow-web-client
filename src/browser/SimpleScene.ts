import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { UNIT_FLAGS_UNCLICKABLE } from "../world/FactionRules.js";
import { GO_FLAG_NOT_SELECTABLE, interactiveGameObjectType } from "../world/GameObjectProtocol.js";
import { unit } from "../world/Fields.js";
import { isWorldObjectDead, type WorldObjectState, type WorldPosition, type WorldState } from "../world/WorldState.js";
import type { EnvironmentObject } from "./Terrain.js";
import { creatureIconSource, type CreatureMetadata } from "./CreatureMetadata.js";
import { setIconSource } from "./ui/IconImage.js";
import { drawPlate, plateLayout, stackPlates, type PlateBox, type PlateData } from "./NamePlate.js";

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Camera {
  position: Vector3;
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

export interface ScreenPoint {
  x: number;
  y: number;
  depth: number;
}

export type HeightSampler = (x: number, y: number) => number | undefined;

/**
 * The vertical field of view of the WebGL camera. The Canvas 2D overlay projects with exactly
 * the same intrinsics, otherwise its unit markers drift away from the terrain underneath them.
 */
export const CAMERA_FOV_DEGREES = 52;
/**
 * How far the camera orbits by default, in yards.
 *
 * 21.31 rather than the 27.313 the old rig asked for, because the old rig never stood that far
 * away: it aimed at a point seven yards in front of the character and sat 27.313 behind *that*,
 * which left it 21.31 yards from the character's chest and 22.20 from their feet (measured, at
 * the default pitch). Orbiting the chest at 21.31 therefore leaves the body all but exactly the
 * size it has always been — measured on a 1920x1080 window with a 2.127-yard HumanMale, 93.6 px
 * from foot to head before and 99.2 px after — where keeping the 27.313 would have shrunk it to
 * 77.7 px on the day the pivot moved.
 */
export const CAMERA_DEFAULT_DISTANCE = 21.31;
export const CAMERA_DEFAULT_PITCH = -Math.atan2(11, 25);
/** The closest the camera orbits before the wheel drops it into the character's own head. */
export const CAMERA_MIN_DISTANCE = 3.5;
export const CAMERA_MAX_DISTANCE = 55;
/**
 * First person. Not a mode with a flag of its own: the orbit distance simply becomes zero, so
 * every projection, pick and plate goes on working out of the same camera.
 */
export const CAMERA_FIRST_PERSON_DISTANCE = 0;
/**
 * Where the camera hangs on a character nobody has measured yet: the upper chest, wowee's
 * `PIVOT_HEIGHT_DEFAULT` (camera_controller.hpp:387). Only used until the character's own model
 * arrives and says where its shoulder is — on a gnome, whose whole body is 1.524 yards, this
 * constant is nearly at the crown of its head.
 */
export const CAMERA_DEFAULT_PIVOT_HEIGHT = 1.6;
/**
 * Where the eye is in first person before the model arrives.
 *
 * A separate number from the pivot and a decision rather than a side effect: until now the eye
 * stood at a flat `z + 2` for everyone, which is 0.476 yards above a gnome's own head and well
 * below a tauren's shoulders. Third person hangs the camera off the shoulder because that is what
 * keeps the body centred; first person has to be behind the eyes, which is higher.
 */
export const CAMERA_DEFAULT_EYE_HEIGHT = 1.9;
/** What share of a body its shoulder is, over the 20 playable displays: measured median 0.807. */
export const CAMERA_PIVOT_BODY_SHARE = 0.8;
/** And its helm point: measured median 0.924 over the same displays. */
export const CAMERA_EYE_BODY_SHARE = 0.95;
/**
 * The band a pivot height may land in, as wowee clamps it (`hpp:384`, 0..3).
 *
 * The floor is not decoration: a model that arrives with a broken attachment table, or a display
 * scale of 0.01, would otherwise put the orbit centre on the ground and the camera underneath it.
 */
export const CAMERA_MIN_PIVOT_HEIGHT = 0.4;
export const CAMERA_MAX_PIVOT_HEIGHT = 3;

/** How far outside its box a click still counts, in pixels. */
const PICK_SLOP = 12;

/** Pixel focal length of a vertical-fov perspective camera, matching THREE.PerspectiveCamera. */
const FOCAL_PER_PIXEL_HEIGHT = 1 / (2 * Math.tan(CAMERA_FOV_DEGREES * Math.PI / 360));

/**
 * The point the camera orbits and keeps on its own optical axis: a place on the character's body.
 *
 * It used to be a point seven yards *in front* of the character at a fixed `z + 2`, and that one
 * decision is the whole of "the camera feels like it belongs to somewhere behind me rather than
 * to me". Measured on the old rig at 1920x1080: the camera stood 18.000 yards from the character
 * horizontally at every yaw and 22.20 in space while the wheel said 27.313; a HumanMale's body sat
 * 190 px below the middle of the screen and at the closest zoom its feet were 156 px below the
 * bottom edge of the window; and because yaw turned the whole rig about the character while pitch
 * turned it about the point in front, a vertical drag slid the body 539 px up the screen while the
 * real camera-to-character distance wandered over seven yards — 20.27 to 27.25, measured at six
 * pitches — for one unchanging number on the wheel.
 *
 * Orbiting the body itself makes `distance` mean the distance to the character at every pitch, to
 * the last digit, and holds the body 10..28 px from the middle of the screen over that same drag.
 */
export function cameraPivot(player: WorldPosition, pivotHeight: number): Vector3 {
  return { x: player.x, y: player.y, z: player.z + pivotHeight };
}

/**
 * The camera, hung on the character at `pivotHeight` and swung `distance` back along its own axis.
 *
 * `anchorDistance` used to be the fifth argument here and is gone: it existed only to keep the
 * look-ahead from chasing the boom around a pillar and to keep the camera behind the character
 * when a wall squeezed it, and neither problem outlived the look-ahead. It stays a parameter of
 * `draw`, where it decides first person — the distance the player *asked* for, never the one a
 * wall granted.
 *
 * The remaining parameter is an options object rather than a fifth number on purpose. Five call
 * sites and two test lines used to pass `anchorDistance` in that slot; a number landing there
 * silently becomes a 21-yard-high orbit centre, and one of the two tests would have gone on
 * passing while measuring nothing. An object refuses a stray number at the type level and falls
 * back to the default at runtime.
 */
export function createCamera(
  player: WorldPosition,
  yawOffset = 0,
  pitch = CAMERA_DEFAULT_PITCH,
  distance = CAMERA_DEFAULT_DISTANCE,
  options: { pivotHeight?: number | undefined } = {},
): Camera {
  const yaw = player.orientation + yawOffset;
  const forward = { x: Math.cos(yaw) * Math.cos(pitch), y: Math.sin(yaw) * Math.cos(pitch), z: Math.sin(pitch) };
  const pivot = cameraPivot(player, options.pivotHeight ?? CAMERA_DEFAULT_PIVOT_HEIGHT);
  const position = {
    x: pivot.x - forward.x * distance,
    y: pivot.y - forward.y * distance,
    z: pivot.z - forward.z * distance,
  };
  const right = normalize({ x: forward.y, y: -forward.x, z: 0 });
  const up = cross(right, forward);
  return { position, forward, right, up };
}

/**
 * Where the camera's arm is hinged, recovered from the camera itself.
 *
 * The boom is scanned for obstructions from this point outwards rather than from the character's
 * feet, because this is where the arm actually is; a scan that started at the feet would report
 * the floor the character is standing on and pin the camera to the back of their head. Written as
 * "walk `distance` forwards from the camera" rather than as "the character plus a height" so that
 * it stays true of whatever camera it is handed, and so the two can be asserted equal.
 */
export function boomAnchor(camera: Camera, distance: number): Vector3 {
  return {
    x: camera.position.x + camera.forward.x * distance,
    y: camera.position.y + camera.forward.y * distance,
    z: camera.position.z + camera.forward.z * distance,
  };
}

/**
 * How high on a character the camera hangs, out of the three things that can know it.
 *
 * The model's own attachment point is the answer whenever there is one — a shoulder for the orbit
 * centre, a helm point for the first-person eye — because it is the only source that scales with
 * the body: measured over the 20 playable displays the shoulder sits between 0.540 (gnome) and
 * 0.861 of the drawn height. Failing that, a share of the drawn body, which is within 0.040 yards
 * of the true shoulder on the median playable body and 0.396 at worst. Failing *that*, a constant,
 * because until a real model is applied the drawn "height" is the clamped combat reach the
 * stand-in capsule was shaped to, which is not a body height at all.
 *
 * Every link is tested for being a usable number rather than merely for being present, so all
 * three are really in the chain: a model whose attachment table says the shoulder is at zero, or
 * at NaN, used to skip the body share and land straight on the constant — 1.6 yards, which is
 * above a gnome's head — where the drawn body standing right there could have answered.
 *
 * `CreatureModelData.CollisionHeight` is deliberately not in this chain, although it is already on
 * the wire: measured over the same 20 displays it puts 31 of 190 pairs in the wrong order and
 * gives Human, Orc, Troll and both blood elves one identical 2.031 across bodies from 2.033 to
 * 3.192 yards. It is the water-depth threshold the core builds, not a height.
 */
export function cameraBodyHeight(
  attachment: number | undefined,
  bodyHeight: number | undefined,
  share: number,
  fallback: number,
): number {
  const usable = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
  const body = usable(bodyHeight);
  const height = usable(attachment) ?? (body === undefined ? undefined : usable(body * share)) ?? fallback;
  return Math.max(CAMERA_MIN_PIVOT_HEIGHT, Math.min(CAMERA_MAX_PIVOT_HEIGHT, height));
}

export function projectPoint(point: Vector3, camera: Camera, width: number, height: number): ScreenPoint | undefined {
  const relative = {
    x: point.x - camera.position.x,
    y: point.y - camera.position.y,
    z: point.z - camera.position.z,
  };
  const depth = dot(relative, camera.forward);
  if (depth <= 0.2) return undefined;
  const focal = height * FOCAL_PER_PIXEL_HEIGHT;
  return {
    x: width / 2 + dot(relative, camera.right) * focal / depth,
    y: height / 2 - dot(relative, camera.up) * focal / depth,
    depth,
  };
}

export function healthRatio(object: WorldObjectState): number | undefined {
  const health = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset);
  const maximum = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset);
  return health === undefined || maximum === undefined || maximum <= 0
    ? undefined
    : Math.max(0, Math.min(1, health / maximum));
}

const GAMEOBJECT_NAMES: Partial<Record<number, string>> = {
  0: "Дверь",
  1: "Кнопка",
  2: "Задание",
  3: "Сундук",
  6: "Ловушка",
  7: "Стул",
  10: "Механизм",
  11: "Транспорт",
  14: "Объект карты",
  15: "Транспорт",
  17: "Рыбалка",
  19: "Почта",
  24: "Флаг",
  25: "Место рыбалки",
  29: "Точка захвата",
  33: "Здание",
  34: "Банк гильдии",
  35: "Люк",
};

/**
 * The object's type, from byte 1 of its bytes field.
 *
 * Absent means zero, not unknown: a create block writes a field only when its value is non-zero,
 * so an open door — type 0, state 0 — arrives with the whole word missing. Treating that as "no
 * type" left every open door in the world unlabelled and unclassified.
 */
export function gameObjectType(object: WorldObjectState): number {
  return ((object.fields.get(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset) ?? 0) >>> 8) & 0xff;
}

export function gameObjectLabel(object: WorldObjectState): string {
  const type = gameObjectType(object);
  return GAMEOBJECT_NAMES[type] ?? `Объект type ${type}`;
}

export class SimpleScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #portraits = new Map<number, HTMLImageElement | null>();
  readonly #familyIcons = new Map<number, HTMLImageElement | null>();
  readonly #typeIcons = new Map<number, HTMLImageElement | null>();
  readonly #drawWorld: boolean;
  /**
   * Where the gateway answers, for the icons drawn over a head.
   *
   * A field and not a read of `game`: `game/Context.ts` imports this file for the camera constants
   * it initialises itself with, so an import the other way would be a cycle whose loser evaluates
   * first and finds those constants in their temporal dead zone. `EnterWorld` writes it beside
   * `game.gatewayOrigin`; until then the icons come from the directory published beside the page,
   * which is what they always did.
   */
  gatewayOrigin: string | undefined;
  #portraitIds: Set<number> | undefined;
  #portraitIndexLoading = false;
  /**
   * `exactOnly` keeps a box out of the forgiving pass while leaving it in the strict one. Exactly
   * one thing needs that today — the player's own body — and it needs it badly: a click two yards
   * off a mob standing in front of the character would otherwise be pulled back onto the character
   * by the slop, and the player would attack themselves out of every near miss.
   */
  #hits: Array<{ guid: bigint; x: number; y: number; width: number; height: number; exactOnly?: boolean }> = [];

  constructor(canvas: HTMLCanvasElement, drawWorld = true) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.#canvas = canvas;
    this.#context = context;
    this.#drawWorld = drawWorld;
  }

  draw(
    state: WorldState,
    heightAt?: HeightSampler,
    selectedGuid?: bigint,
    environment: readonly EnvironmentObject[] = [],
    creatureMetadata?: (entry: number) => CreatureMetadata | undefined,
    cameraYaw = 0,
    cameraPitch = CAMERA_DEFAULT_PITCH,
    cameraDistance = CAMERA_DEFAULT_DISTANCE,
    unitHeight?: (guid: bigint) => number | undefined,
    /** What the plate over each head should say, or nothing for a unit that gets no plate. */
    plateFor?: (object: WorldObjectState, distance: number) => PlateData | undefined,
    /** How far the camera wanted to be, where `cameraDistance` is how far a wall let it. */
    cameraAnchorDistance = cameraDistance,
    /**
     * How high on the character the camera hangs this frame. Handed in rather than worked out
     * here: it comes from the player's own model, this class has no renderer to ask, and every
     * camera a frame builds has to agree to the yard or the plates leave the heads.
     *
     * Last on purpose. `nameplate` and `zh0-pick` drive `draw` positionally and derive their own
     * boxes through `createCamera`, so anything appended after `cameraAnchorDistance` leaves them
     * saying exactly what they said before.
     */
    cameraPivotHeight = CAMERA_DEFAULT_PIVOT_HEIGHT,
  ): void {
    const { width, height } = this.#resize();
    const context = this.#context;
    this.#hits = [];
    context.clearRect(0, 0, width, height);
    if (this.#drawWorld) {
      const sky = context.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, "#20364d");
      sky.addColorStop(0.58, "#486273");
      sky.addColorStop(0.59, "#25382f");
      sky.addColorStop(1, "#101b16");
      context.fillStyle = sky;
      context.fillRect(0, 0, width, height);
    }

    const player = state.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
    if (!player?.position) {
      context.fillStyle = "#d8e5ef";
      context.font = "16px system-ui";
      context.textAlign = "center";
      context.fillText("Ожидание позиции персонажа…", width / 2, height / 2);
      return;
    }

    const camera = createCamera(player.position, cameraYaw, cameraPitch, cameraDistance, { pivotHeight: cameraPivotHeight });
    if (this.#drawWorld) {
      this.#drawTerrain(player.position, camera, width, height, heightAt);
      this.#drawEnvironment(environment, player.position, camera, width, height);
    }
    const selected = selectedGuid === undefined ? undefined : state.objects.get(selectedGuid);
    // The dashed line to the target belongs to the painted fallback, where nothing else says which
    // shape on the screen is the target. With WebGL running the ring on the ground says it.
    if (this.#drawWorld && selected?.position) this.#drawTargetLine(player.position, selected.position, camera, width, height);
    // In first person the camera sits inside the character, so its own plate would be painted
    // across the middle of the screen with nothing under it.
    // The wanted distance, not the granted one: first person is a place the player asked to be,
    // and a wall squeezing the camera in must never be mistaken for that request.
    const firstPerson = cameraAnchorDistance <= CAMERA_FIRST_PERSON_DISTANCE;
    // Corpses stay in this list. They carry no ring, and a plate only while the server still marks
    // them lootable, but they are the way to a kill's loot: `interactWithTarget` opens loot for a
    // dead creature, and picking is what puts one in the target frame — a body filtered out here
    // could not be right-clicked at all.
    // One pass over the object table: this used to be spread/filter/map/filter/sort — four
    // intermediate arrays plus a second squared-distance per object, sixty times a second. The
    // admitted set and the painter order are exactly what those passes produced.
    const playerPosition = player.position!;
    const objects: Array<{ object: WorldObjectState; distance: number; point: ScreenPoint }> = [];
    for (const object of state.objects.values()) {
      const objectPosition = object.position;
      if (!objectPosition) continue;
      if (firstPerson && object.guid === state.selfGuid) continue;
      const squared = squaredDistance(objectPosition, playerPosition);
      if (!(squared < 100 * 100)) continue;
      const point = projectPoint(objectPosition, camera, width, height);
      if (point === undefined) continue;
      objects.push({ object, distance: Math.sqrt(squared), point });
    }
    objects.sort((left, right) => right.point.depth - left.point.depth);

    const plates: Array<{ box: PlateBox; data: PlateData; depth: number; clickable: boolean }> = [];
    for (const { object, point, distance } of objects) {
      const position = object.position!;
      const isUnit = object.typeId === 3 || object.typeId === 4;
      const dead = isWorldObjectDead(object);
      // Match the height of the body drawn in the WebGL scene so the plate sits on its head.
      const heightInWorld = isUnit ? unitHeight?.(object.guid) ?? 2 : 1.2;
      const top = projectPoint({ x: position.x, y: position.y, z: position.z + heightInWorld }, camera, width, height);
      if (!top) continue;
      const bodyHeight = Math.max(4, point.y - top.y);
      const isSelected = object.guid === selectedGuid;
      const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
      const metadata = creatureMetadata?.(entry);
      // The faint rings under everything belong to the painted fallback. With WebGL running, the
      // ring under the target is a real decal on the ground, laid on the slope it stands on
      // rather than drawn flat around a point that a hill puts somewhere else.
      if (this.#drawWorld && !dead && (isUnit || object.typeId === 5)) {
        this.#drawGroundMarker(position, camera, width, height, isSelected, object.typeId === 5);
      }
      if (isUnit) {
        // Both doors on to the player's own body were shut, and each of them separately: no box was
        // pushed here, and `NamePlates` draws no plate of one's own either, so there was no second
        // box to fall back on. Self-cast, self-inspect and «who am I targeting» had no way in.
        //
        // A unit the server has flagged unselectable — a spell trigger, a totem's aura anchor, a
        // quest bunny — is skipped outright. The plates already skip it and Tab already skips it;
        // only the click still walked into them, and the 12px slop made that worse rather than
        // better, because a trigger no longer had to be under the cursor to steal the click.
        const self = object.guid === state.selfGuid;
        const clickable = self || ((unit.flags(object) ?? 0) & UNIT_FLAGS_UNCLICKABLE) === 0;
        if (clickable) this.#pushUnitHit(object.guid, point, top.y, bodyHeight, dead, self);
        if (this.#drawWorld && !dead) this.#drawUnit(object, point, top.y, bodyHeight, distance, object.guid === state.selfGuid, isSelected, metadata);
        // The dead are no longer refused here. `NamePlates.plateSource` is the one place that
        // decides what carries a plate, and it now keeps a corpse the server still marks lootable;
        // a second `dead` test in this loop meant that decision could never reach the screen.
        //
        // A corpse hangs its plate over the middle of its own body rather than over `top`. The
        // renderer lays a dead unit down at full length without shortening it, so `top` — the feet
        // anchor plus the standing height — is a body-length of empty air above the ground the
        // body is on. `#pushUnitHit` already builds the corpse's click box the same way and for
        // the same reason, so the plate and the box now stand over the same thing.
        //
        // Which is exactly why that plate is not a click target: `clickable` below keeps it out of
        // `#hits`. A living unit's plate hangs in empty sky above its head, so a box there can steal
        // nothing; a corpse's plate hangs at the height of a standing neighbour's chest. Measured
        // over this `draw` at 1280x720 with a lootable body at (15, 0) and a live mob one yard
        // behind it at (15, 1), both 15 yards from the camera: the mob's silhouette runs
        // y 224.4..265.3 and its hit box is 22.5 px wide, while the corpse's plate box is
        // x 588..692, y 233.1..246.1 — so clicks straight down the middle of the mob at y 235, 238,
        // 241 and 244 all selected the corpse, and a right click there opened its loot instead of
        // swinging. The corpse stays reachable by its own body box (`#pushUnitHit`), centred on it.
        const data = plateFor?.(object, distance);
        const anchorY = dead ? point.y - Math.max(14, bodyHeight * 0.45) / 2 : top.y;
        if (data) plates.push({ box: plateLayout(data, point.x, anchorY), data, depth: point.depth, clickable: !dead });
      } else if (object.typeId === 5) this.#drawGameObject(object, point, top.y, bodyHeight, distance, isSelected);
      // A dynamic object is the server-side anchor for a lasting spell area, not authored art of
      // its own. In the Canvas fallback a marker is still useful because no spell model is drawn;
      // over WebGL it was a yellow service bar painted through the real spell effect. Other object
      // types, notably Corpse, keep the marker because WebGL has no authored representation for
      // them yet and this overlay is still the only way the player can see them.
      else if (this.#drawWorld || object.typeId !== 6) {
        this.#drawMarker(object, point, top.y, bodyHeight, distance, isSelected);
      }
    }
    // After every body, and only once every box is known: a plate that has been shoved upwards by
    // a nearer one must not be painted before the plate that shoved it.
    stackPlates(plates);
    for (const plate of plates) {
      drawPlate(context, plate.box, plate.data);
      // The plate over a head is a click target of its own, and at any distance it is the larger
      // one: a mob at thirty yards is twenty pixels of body under a hundred pixels of plate. Pushed
      // after every body, so a plate wins over whatever it happens to hang in front of — `pick`
      // scans this list backwards. Plates never overlap each other, because `stackPlates` has just
      // seen to that. A corpse's plate is not one of these: see `clickable` above.
      if (!plate.clickable) continue;
      this.#hits.push({ guid: plate.data.guid, x: plate.box.x, y: plate.box.y, width: plate.box.width, height: plate.box.height });
    }
  }

  /**
   * The box a click has to land in to select this unit.
   *
   * Pushed for every unit rather than by whichever drawing routine happened to run, because those
   * two sets stopped being the same one in slice R6: a friendly unit with plates switched off is
   * still a unit the player can click, and a corpse has to be clickable to be looted.
   */
  #pushUnitHit(guid: bigint, point: ScreenPoint, top: number, bodyHeight: number, dead: boolean, exactOnly = false): void {
    if (dead) {
      // A corpse lies along its own facing, centred on the unit's position rather than standing on
      // it — `#shapeCapsule` turns the body a quarter turn and leaves it centred — so the box is
      // centred on the feet anchor too. Ending at the anchor put it half a body-length too high,
      // over ground the corpse is not on and in front of whatever is standing behind it.
      const width = Math.max(24, bodyHeight * 0.9);
      const height = Math.max(14, bodyHeight * 0.45);
      this.#hits.push({ guid, x: point.x - width / 2, y: point.y - height / 2, width, height, exactOnly });
      return;
    }
    if (this.#drawWorld) {
      // The painted fallback draws a disc, not a body, and it is a different size and in a
      // different place: a box shaped for a 3D silhouette misses half of it at thirty yards.
      const size = Math.max(18, Math.min(42, bodyHeight * 1.4));
      const centerY = top + bodyHeight / 2;
      this.#hits.push({ guid, x: point.x - size / 2 - 5, y: centerY - size / 2 - 10, width: size + 10, height: size + 15, exactOnly });
      return;
    }
    const width = Math.max(20, bodyHeight * 0.55);
    this.#hits.push({ guid, x: point.x - width / 2, y: top - 2, width, height: point.y - top + 6, exactOnly });
  }

  /**
   * Who a click at this point selects.
   *
   * Two passes, and the second one is the point. An exact hit wins, scanned backwards so that a
   * plate beats the body it hangs in front of and a nearer plate beats a further one. When nothing
   * is hit exactly, the nearest box within `PICK_SLOP` pixels is taken instead: a mob at thirty
   * yards is about twenty pixels of body, and asking the player to land inside twenty pixels of a
   * moving target is asking them to aim rather than to point. The original client is forgiving here
   * and this is what that forgiveness costs — a radius, not a bigger box, so two units standing
   * together still resolve to whichever one the cursor is actually closer to.
   */
  pick(x: number, y: number): bigint | undefined {
    for (let index = this.#hits.length - 1; index >= 0; index--) {
      const hit = this.#hits[index];
      if (hit && x >= hit.x && x <= hit.x + hit.width && y >= hit.y && y <= hit.y + hit.height) return hit.guid;
    }
    let nearest: bigint | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (let index = this.#hits.length - 1; index >= 0; index--) {
      const hit = this.#hits[index];
      if (!hit || hit.exactOnly) continue;
      // Distance to the box, which is zero inside it — the exact pass has already ruled that out.
      const gap = Math.hypot(
        Math.max(hit.x - x, 0, x - (hit.x + hit.width)),
        Math.max(hit.y - y, 0, y - (hit.y + hit.height)),
      );
      // Strictly nearer, not «no further». Two boxes the same distance from the cursor happen all
      // the time — a body and the plate above it, two spawns of the same mob side by side — and
      // this loop runs from the front of the list backwards, so «no further» handed every one of
      // those ties to whichever box was pushed *first*, which is the one further from the camera.
      // The exact pass has always resolved ties towards the front; now the forgiving one does too.
      if (gap > PICK_SLOP || gap >= best) continue;
      best = gap;
      nearest = hit.guid;
    }
    return nearest;
  }

  #drawUnit(
    object: WorldObjectState,
    point: ScreenPoint,
    top: number,
    bodyHeight: number,
    distance: number,
    self: boolean,
    selected: boolean,
    metadata?: CreatureMetadata,
  ): void {
    // Only the painted fallback reaches here. With WebGL running the body is a real object in the
    // 3D scene, and the overlay's whole job over a unit is the plate.
    const context = this.#context;
    const size = Math.max(18, Math.min(42, bodyHeight * 1.4));
    const centerY = top + bodyHeight / 2;
    const displayId = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
    context.save();
    context.beginPath();
    context.arc(point.x, centerY, size / 2, 0, Math.PI * 2);
    context.clip();
    context.fillStyle = self ? "#3db879" : object.typeId === 4 ? "#438bd4" : `hsl(${(displayId * 47) % 360} 48% 43%)`;
    context.fillRect(point.x - size / 2, centerY - size / 2, size, size);
    const portrait = this.#portrait(displayId) ?? this.#creatureIcon(metadata);
    if (portrait) context.drawImage(portrait, point.x - size / 2, centerY - size / 2, size, size);
    else {
      context.fillStyle = "#10171eb8";
      context.beginPath();
      context.arc(point.x, centerY - size * 0.1, size * 0.17, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.ellipse(point.x, centerY + size * 0.32, size * 0.34, size * 0.3, 0, Math.PI, Math.PI * 2);
      context.fill();
    }
    context.restore();

    context.strokeStyle = selected ? "#ffe36e" : "#d9e6ef";
    context.lineWidth = selected ? 3 : 1;
    context.beginPath();
    context.arc(point.x, centerY, size / 2 + (selected ? 2 : 0), 0, Math.PI * 2);
    context.stroke();

    const ratio = healthRatio(object);
    if (ratio !== undefined) {
      const barWidth = size + 10;
      const barY = centerY - size / 2 - 8;
      context.fillStyle = "#190d0d";
      context.fillRect(point.x - barWidth / 2, barY, barWidth, 5);
      context.fillStyle = ratio > 0.5 ? "#42cf77" : ratio > 0.2 ? "#e2b84d" : "#e45f5f";
      context.fillRect(point.x - barWidth / 2 + 1, barY + 1, (barWidth - 2) * ratio, 3);
    }

    if (point.depth < 45) {
      const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
      const name = self ? "Вы" : object.typeId === 4 ? "Игрок" : metadata?.name ?? `NPC ${entry}`;
      this.#label(self ? name : `${name} · ${distance.toFixed(0)} м`, point.x, centerY - size / 2 - 11);
    }
  }

  #drawGameObject(object: WorldObjectState, point: ScreenPoint, top: number, bodyHeight: number, distance: number, selected: boolean): void {
    const context = this.#context;
    const size = Math.max(10, Math.min(34, bodyHeight * 1.7));
    const centerY = top + bodyHeight / 2;
    const displayId = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset) ?? 0;
    const type = gameObjectType(object);
    // Units have always pushed one of these and game objects never did, so a door or a lever was
    // drawn, labelled, and impossible to click: `pick` scans this list and it held only creatures.
    // It is pushed before the drawing and not inside it, because with WebGL running the object is
    // already a real mesh in the scene and only the box is still wanted.
    //
    // `GO_FLAG_NOT_SELECTABLE` is the same test `gameObjectAction` already makes before it will do
    // anything with an object. Making it only there meant the collision hulls that fill a city —
    // 261 of the 739 objects inside the draw radius on the worst measured circle — could still be
    // picked, become the target, wear a selection ring, and then refuse every interaction.
    const flags = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0;
    if (interactiveGameObjectType(type) && (flags & GO_FLAG_NOT_SELECTABLE) === 0) {
      this.#hits.push({ guid: object.guid, x: point.x - size / 2 - 4, y: centerY - size / 2 - 4, width: size + 8, height: size + 8 });
    }
    // The diamond and the label are the painted fallback's way of saying a door is there. With the
    // real door drawn behind it, it was a yellow lozenge painted over the door.
    if (!this.#drawWorld) return;
    context.fillStyle = type === 0 || type === 33 ? "#9fa8b1"
      : type === 2 || type === 19 ? "#70b8ef"
        : type === 11 || type === 15 ? "#65d4ca"
          : `hsl(${35 + (displayId * 29) % 35} 70% 52%)`;
    context.strokeStyle = selected ? "#ffe36e" : "#fff0ad";
    context.lineWidth = selected ? 3 : 1;
    context.beginPath();
    context.moveTo(point.x, centerY - size / 2);
    context.lineTo(point.x + size / 2, centerY);
    context.lineTo(point.x, centerY + size / 2);
    context.lineTo(point.x - size / 2, centerY);
    context.closePath();
    context.fill();
    context.stroke();
    context.beginPath();
    context.moveTo(point.x, centerY - size / 2 + 3);
    context.lineTo(point.x, centerY + size / 2 - 3);
    context.stroke();
    if (point.depth < 45) {
      const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
      this.#label(`${gameObjectLabel(object)} #${entry} · ${distance.toFixed(0)} м`, point.x, centerY - size / 2 - 5);
    }
  }

  #portrait(displayId: number): HTMLImageElement | undefined {
    if (displayId <= 0 || typeof Image === "undefined") return undefined;
    if (!this.#portraitIds) {
      if (!this.#portraitIndexLoading) {
        this.#portraitIndexLoading = true;
        void fetch("/portraits/index.json")
          .then((response) => response.ok ? response.json() : [])
          .then((ids: unknown) => {
            this.#portraitIds = new Set(Array.isArray(ids) ? ids.filter((id): id is number => Number.isInteger(id) && id > 0) : []);
          })
          .catch(() => { this.#portraitIds = new Set(); });
      }
      return undefined;
    }
    if (!this.#portraitIds.has(displayId)) return undefined;
    return this.#image(this.#portraits, displayId, `/portraits/${displayId}.png`);
  }

  #creatureIcon(metadata: CreatureMetadata | undefined): HTMLImageElement | undefined {
    const source = creatureIconSource(metadata, this.gatewayOrigin);
    if (metadata?.family) return this.#image(this.#familyIcons, metadata.family, source);
    return this.#image(this.#typeIcons, metadata?.type ?? 0, source);
  }

  #image(cache: Map<number, HTMLImageElement | null>, id: number, source: string): HTMLImageElement | undefined {
    if (typeof Image === "undefined") return undefined;
    const cached = cache.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const image = new Image();
    cache.set(id, null);
    image.onload = () => cache.set(id, image);
    // Through `setIconSource` rather than a bare `src`: an icon that comes from the gateway is a
    // cross-origin `<img>`, and the gateway refuses a request with no `Origin` header on it. The
    // portrait index beside the page still goes straight in — that is what the helper decides.
    setIconSource(image, source);
    return undefined;
  }

  #drawMarker(object: WorldObjectState, point: ScreenPoint, top: number, bodyHeight: number, distance: number, selected: boolean): void {
    const context = this.#context;
    const bodyWidth = Math.max(3, bodyHeight * 0.38);
    context.fillStyle = "#e6c86b";
    context.fillRect(point.x - bodyWidth / 2, top, bodyWidth, bodyHeight);
    if (selected) {
      context.strokeStyle = "#ffe36e";
      context.lineWidth = 2;
      context.strokeRect(point.x - bodyWidth / 2 - 3, top - 3, bodyWidth + 6, bodyHeight + 6);
    }
    if (point.depth < 45) this.#label(`Объект ${object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0} · ${distance.toFixed(0)} м`, point.x, top - 5);
  }

  #label(text: string, x: number, y: number, highlighted = false): void {
    const context = this.#context;
    context.font = "11px system-ui";
    context.textAlign = "center";
    const width = context.measureText(text).width + 8;
    context.fillStyle = "#0b1016c7";
    context.fillRect(x - width / 2, y - 11, width, 14);
    context.fillStyle = highlighted ? "#ffe36e" : "#f3f6f8";
    context.fillText(text, x, y);
  }

  #drawGroundMarker(position: WorldPosition, camera: Camera, width: number, height: number, selected: boolean, gameobject: boolean): void {
    const context = this.#context;
    context.strokeStyle = selected ? "#ffe36e" : gameobject ? "#e8c05d88" : "#d7e5ed70";
    context.lineWidth = selected ? 3 : 1;
    context.beginPath();
    let started = false;
    for (let index = 0; index <= 16; index++) {
      const angle = index / 16 * Math.PI * 2;
      const point = projectPoint({
        x: position.x + Math.cos(angle) * (selected ? 1.1 : 0.75),
        y: position.y + Math.sin(angle) * (selected ? 1.1 : 0.75),
        z: position.z + 0.04,
      }, camera, width, height);
      if (!point) continue;
      if (!started) {
        context.moveTo(point.x, point.y);
        started = true;
      } else context.lineTo(point.x, point.y);
    }
    if (started) context.stroke();

    const facing = projectPoint({
      x: position.x + Math.cos(position.orientation) * 1.4,
      y: position.y + Math.sin(position.orientation) * 1.4,
      z: position.z + 0.06,
    }, camera, width, height);
    const center = projectPoint({ x: position.x, y: position.y, z: position.z + 0.06 }, camera, width, height);
    if (center && facing) {
      context.beginPath();
      context.moveTo(center.x, center.y);
      context.lineTo(facing.x, facing.y);
      context.stroke();
    }
  }

  #drawTargetLine(player: WorldPosition, target: WorldPosition, camera: Camera, width: number, height: number): void {
    const start = projectPoint({ x: player.x, y: player.y, z: player.z + 0.08 }, camera, width, height);
    const end = projectPoint({ x: target.x, y: target.y, z: target.z + 0.08 }, camera, width, height);
    if (!start || !end) return;
    const context = this.#context;
    context.strokeStyle = "#ffe36e99";
    context.lineWidth = 2;
    context.setLineDash([6, 5]);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.setLineDash([]);
  }

  #drawTerrain(player: WorldPosition, camera: Camera, width: number, height: number, heightAt?: HeightSampler): void {
    // ponytail: GridMap heights cover open terrain; add VMap/WMO floors when indoor movement becomes necessary.
    const context = this.#context;
    const step = 5;
    const radius = 50;
    const centerX = Math.floor(player.x / step) * step;
    const centerY = Math.floor(player.y / step) * step;
    const faces: Array<{ points: ScreenPoint[]; depth: number; elevation: number }> = [];
    for (let x = centerX - radius; x < centerX + radius; x += step) {
      for (let y = centerY - radius; y < centerY + radius; y += step) {
        const corners = [
          { x, y, z: heightAt?.(x, y) ?? player.z },
          { x: x + step, y, z: heightAt?.(x + step, y) ?? player.z },
          { x: x + step, y: y + step, z: heightAt?.(x + step, y + step) ?? player.z },
          { x, y: y + step, z: heightAt?.(x, y + step) ?? player.z },
        ];
        const projected = corners.map((corner) => projectPoint(corner, camera, width, height));
        if (projected.some((point) => point === undefined)) continue;
        const points = projected as ScreenPoint[];
        faces.push({
          points,
          depth: points.reduce((sum, point) => sum + point.depth, 0) / points.length,
          elevation: corners.reduce((sum, corner) => sum + corner.z, 0) / corners.length,
        });
      }
    }
    faces.sort((left, right) => right.depth - left.depth);
    context.lineWidth = 0.6;
    context.strokeStyle = "#8eb99a42";
    for (const face of faces) {
      const lightness = 24 + Math.max(-5, Math.min(8, (face.elevation - player.z) * 0.7));
      context.fillStyle = `hsl(137 27% ${lightness}%)`;
      context.beginPath();
      context.moveTo(face.points[0]!.x, face.points[0]!.y);
      for (let index = 1; index < face.points.length; index++) context.lineTo(face.points[index]!.x, face.points[index]!.y);
      context.closePath();
      context.fill();
      context.stroke();
    }
  }

  #drawEnvironment(objects: readonly EnvironmentObject[], player: WorldPosition, camera: Camera, width: number, height: number): void {
    // ponytail: VMAP collision bounds are enough for readable landmarks; load full WMO/M2 meshes only when boxes stop being useful.
    const nearby = objects
      .map((object) => ({ object, distance: Math.hypot(object.x - player.x, object.y - player.y) }))
      .filter(({ distance }) => distance < 160)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 300)
      .sort((left, right) => right.distance - left.distance);
    for (const { object } of nearby) {
      if (!object.bounds || !this.#drawEnvironmentBox(object, camera, width, height)) {
        this.#drawEnvironmentMarker(object, camera, width, height);
      }
    }
  }

  #drawEnvironmentBox(object: EnvironmentObject, camera: Camera, width: number, height: number): boolean {
    const bounds = object.bounds!;
    if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY || bounds.maxZ <= bounds.minZ) return false;
    const corners = [
      { x: bounds.minX, y: bounds.minY, z: bounds.minZ },
      { x: bounds.maxX, y: bounds.minY, z: bounds.minZ },
      { x: bounds.maxX, y: bounds.maxY, z: bounds.minZ },
      { x: bounds.minX, y: bounds.maxY, z: bounds.minZ },
      { x: bounds.minX, y: bounds.minY, z: bounds.maxZ },
      { x: bounds.maxX, y: bounds.minY, z: bounds.maxZ },
      { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ },
      { x: bounds.minX, y: bounds.maxY, z: bounds.maxZ },
    ];
    const points = corners.map((corner) => projectPoint(corner, camera, width, height));
    if (points.some((point) => point === undefined)) return false;
    const projected = points as ScreenPoint[];
    const context = this.#context;
    const color = environmentColor(object);
    context.globalAlpha = object.kind === "wmo" ? 0.38 : 0.3;
    context.fillStyle = color;
    context.strokeStyle = "#d4dfd577";
    context.lineWidth = 0.8;
    for (const face of [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]]) {
      context.beginPath();
      context.moveTo(projected[face[0]!]!.x, projected[face[0]!]!.y);
      for (let index = 1; index < face.length; index++) context.lineTo(projected[face[index]!]!.x, projected[face[index]!]!.y);
      context.closePath();
      context.fill();
      context.stroke();
    }
    context.globalAlpha = 1;
    return true;
  }

  #drawEnvironmentMarker(object: EnvironmentObject, camera: Camera, width: number, height: number): void {
    const base = projectPoint({ x: object.x, y: object.y, z: object.z }, camera, width, height);
    const top = projectPoint({ x: object.x, y: object.y, z: object.z + Math.max(1.5, Math.min(8, object.scale * 3)) }, camera, width, height);
    if (!base || !top) return;
    const size = Math.max(2, Math.min(12, (base.y - top.y) * 0.4));
    const context = this.#context;
    context.globalAlpha = 0.55;
    context.fillStyle = environmentColor(object);
    context.beginPath();
    context.moveTo(top.x, top.y);
    context.lineTo(base.x + size, base.y);
    context.lineTo(base.x - size, base.y);
    context.closePath();
    context.fill();
    context.globalAlpha = 1;
  }

  /** The canvas's CSS size as the last layout left it; see `#canvasSize`. */
  #observedSize: { width: number; height: number } | undefined;
  #sizeObserver: ResizeObserver | undefined;

  /**
   * The canvas's CSS size, without laying the page out to learn it.
   *
   * `getBoundingClientRect` once a frame, called after the frame had already written the world
   * status, the minimap labels and the rest, forced a layout in the middle of every frame for a size
   * that changes only when the window does. A `ResizeObserver` is told after each layout that
   * changed it, before that frame is painted, so the next frame reads a number instead. The canvas
   * fills its viewport with no border, padding or transform (`#world-canvas` in style.css), so its
   * content box is the rectangle the old read returned. Until the first observation, and where there
   * is no observer at all (the tests), the rectangle is measured as before.
   */
  #canvasSize(): { width: number; height: number } {
    if (this.#observedSize) return this.#observedSize;
    if (!this.#sizeObserver && typeof ResizeObserver === "function") {
      this.#sizeObserver = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) this.#observedSize = { width: entry.contentRect.width, height: entry.contentRect.height };
      });
      this.#sizeObserver.observe(this.#canvas);
    }
    const bounds = this.#canvas.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  }

  #resize(): { width: number; height: number } {
    const bounds = this.#canvasSize();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * scale);
    const pixelHeight = Math.round(height * scale);
    if (this.#canvas.width !== pixelWidth || this.#canvas.height !== pixelHeight) {
      this.#canvas.width = pixelWidth;
      this.#canvas.height = pixelHeight;
    }
    this.#context.setTransform(scale, 0, 0, scale, 0, 0);
    return { width, height };
  }
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function normalize(vector: Vector3): Vector3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function squaredDistance(left: WorldPosition, right: WorldPosition): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

function environmentColor(object: EnvironmentObject): string {
  const name = object.name.toLowerCase();
  if (/tree|bush|shrub|grass|fern|mushroom/.test(name)) return "#527b4f";
  if (/rock|boulder|stone|cliff/.test(name)) return "#697177";
  return object.kind === "wmo" ? "#89765d" : "#8b7951";
}
