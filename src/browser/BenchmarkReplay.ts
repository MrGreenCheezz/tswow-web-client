import type { CameraRig } from "./game/CameraRig.js";
import { MOVEMENT_MASK_MOVING } from "../world/MovementProtocol.js";
import { composePassengerPosition, type TransportSeat } from "../world/TransportMath.js";
import { shortestTurn, WorldState, type WorldObjectState } from "../world/WorldState.js";
import { weatherKind, type Weather } from "../world/WorldMessageProtocol.js";

/** The first version of the deterministic world replay wire contract. */
export const WORLD_REPLAY_SCHEMA_VERSION = 1 as const;
/** Short public spelling used by replay metadata and consumers that do not need the prefix. */
export const schemaVersion = WORLD_REPLAY_SCHEMA_VERSION;

export type WorldReplayGuid = string;

export interface WorldReplayWeatherV1 {
  readonly state: number;
  readonly intensity: number;
  readonly abrupt: boolean;
}

export interface WorldReplayCameraFrameV1 extends Omit<CameraRig, "wallView" | "terrainView"> {
  readonly frameIndex: number;
  /** JSON sentinel for the live CameraRig's +Infinity clear limit. */
  readonly wallView: number | null;
  /** JSON sentinel for the live CameraRig's +Infinity clear limit. */
  readonly terrainView: number | null;
}

export interface HydratedWorldReplayCameraFrameV1 extends CameraRig {
  readonly frameIndex: number;
}

export interface WorldReplayTransportV1 {
  readonly guid: WorldReplayGuid;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly orientation: number;
  readonly seat: number;
}

export type WorldReplaySpeedEntryV1 = readonly [string, number];
export type WorldReplayFieldEntryV1 = readonly [number, number];

export interface WorldReplayObjectV1 {
  readonly guid: WorldReplayGuid;
  readonly typeId: number | null;
  readonly position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly orientation: number;
  } | null;
  readonly movementFlags: number;
  readonly updateFlags: number;
  readonly targetGuid: WorldReplayGuid | null;
  readonly runSpeed: number | null;
  readonly turnRate: number | null;
  readonly transport: WorldReplayTransportV1 | null;
  readonly transportTime: number | null;
  readonly speeds: readonly WorldReplaySpeedEntryV1[];
  readonly fields: readonly WorldReplayFieldEntryV1[];
}

export type WorldReplaySceneV1 = "exterior" | "interior" | "underwater" | "rain";

export interface WorldReplayExpectationsV1 {
  readonly scene: WorldReplaySceneV1;
  readonly indoors: boolean;
  readonly underwater: boolean;
  readonly precipitation: boolean;
  readonly rainIntensity: number;
}

export type WorldReplayJsonPrimitive = string | number | boolean | null;
export type WorldReplayJsonValue =
  | WorldReplayJsonPrimitive
  | readonly WorldReplayJsonValue[]
  | { readonly [key: string]: WorldReplayJsonValue };
export type WorldReplayJsonObject = { readonly [key: string]: WorldReplayJsonValue };

export interface WorldReplaySnapshotV1 {
  readonly schemaVersion: typeof WORLD_REPLAY_SCHEMA_VERSION;
  readonly scenarioId: string;
  readonly mapId: number;
  readonly selfGuid: WorldReplayGuid;
  readonly targetGuid: WorldReplayGuid | null;
  readonly focusGuid: WorldReplayGuid | null;
  readonly halfMinute: number;
  readonly weather: WorldReplayWeatherV1;
  readonly rngSeed: number;
  readonly frameStepMs: number;
  readonly frames: readonly WorldReplayCameraFrameV1[];
  readonly objects: readonly WorldReplayObjectV1[];
  readonly expectations: WorldReplayExpectationsV1;
}

/** A hydrated replay keeps the world state and fixed frame stream as separate fresh values. */
export interface HydratedWorldReplaySnapshot {
  readonly state: WorldState;
  readonly schemaVersion: typeof WORLD_REPLAY_SCHEMA_VERSION;
  readonly scenarioId: string;
  readonly mapId: number;
  readonly targetGuid: bigint | undefined;
  readonly focusGuid: bigint | undefined;
  readonly halfMinute: number;
  readonly weather: WorldReplayWeatherV1;
  readonly rngSeed: number;
  readonly frameStepMs: number;
  readonly frames: HydratedWorldReplayCameraFrameV1[];
  readonly expectations: WorldReplayExpectationsV1;
}

export interface WorldReplayCaptureMetadata {
  readonly scenarioId: string;
  readonly mapId: number;
  readonly selfGuid?: bigint | string;
  readonly targetGuid?: bigint | string | null;
  readonly focusGuid?: bigint | string | null;
  readonly halfMinute: number;
  readonly weather: Weather | WorldReplayWeatherV1;
  readonly rngSeed: number;
  readonly frameStepMs: number;
  readonly expectations: WorldReplayExpectationsV1;
}

export interface WorldReplayCaptureInput {
  readonly world: WorldState;
  readonly captureNowMs: number;
  readonly metadata: WorldReplayCaptureMetadata;
  readonly frames: readonly CameraRig[];
}

export interface WorldReplayObservation {
  readonly indoors: boolean;
  readonly underwater: boolean;
  readonly weather: Weather | WorldReplayWeatherV1;
}

type PlainRecord = Record<string, unknown>;

const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_U32 = 0xffff_ffff;
const MAX_U8 = 0xff;
const RAIN_INTENSITY = Math.fround(0.7);
const SPEED_NAMES = new Set([
  "walk", "run", "runBack", "swim", "swimBack", "turnRate", "flight", "flightBack", "pitchRate",
]);
const CAMERA_KEYS = [
  "frameIndex", "yaw", "pitch", "distance", "view", "viewPitch", "zoom", "wallView", "terrainView",
  "pivotHeight", "eyeHeight",
] as const;
const OBJECT_KEYS = [
  "guid", "typeId", "position", "movementFlags", "updateFlags", "targetGuid", "runSpeed", "turnRate",
  "transport", "transportTime", "speeds", "fields",
] as const;
const ROOT_REQUIRED_KEYS = [
  "schemaVersion", "scenarioId", "mapId", "selfGuid", "halfMinute", "weather", "rngSeed", "frameStepMs", "frames",
  "objects", "expectations",
] as const;
const ROOT_OPTIONAL_KEYS = ["targetGuid", "focusGuid"] as const;
const EXPECTATION_KEYS = ["scene", "indoors", "underwater", "precipitation", "rainIntensity"] as const;

function denseArray(name: string, value: readonly unknown[]): void {
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) throw new TypeError(`${name}[${index}] must be present (sparse arrays are not allowed)`);
  }
}

const SCENE_RULES: Readonly<Record<WorldReplaySceneV1, {
  indoors: boolean;
  underwater: boolean;
  precipitation: boolean;
  rainIntensity: number;
  weather: "fine" | "rain";
}>> = {
  exterior: { indoors: false, underwater: false, precipitation: false, rainIntensity: 0, weather: "fine" },
  interior: { indoors: true, underwater: false, precipitation: false, rainIntensity: 0, weather: "fine" },
  underwater: { indoors: false, underwater: true, precipitation: false, rainIntensity: 0, weather: "fine" },
  rain: { indoors: false, underwater: false, precipitation: true, rainIntensity: RAIN_INTENSITY, weather: "rain" },
};

function plainObject(name: string, value: unknown): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value as PlainRecord;
}

function exactKeys(
  name: string,
  value: PlainRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not part of the v1 shape`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`${name}.${key} is required`);
  }
}

function finite(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function integerRange(name: string, value: unknown, minimum: number, maximum: number): number {
  const number = finite(name, value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  return number;
}

function nullableFinite(name: string, value: unknown): number | null {
  return value === undefined || value === null ? null : finite(name, value);
}

function nullableIntegerRange(name: string, value: unknown, minimum: number, maximum: number): number | null {
  return value === undefined || value === null ? null : integerRange(name, value, minimum, maximum);
}

function cameraLimit(name: string, value: unknown): number | null {
  return value === null ? null : finite(name, value);
}

function captureCameraLimit(name: string, value: unknown): number | null {
  if (value === Number.POSITIVE_INFINITY) return null;
  return finite(name, value);
}

function canonicalGuid(name: string, value: unknown, allowZero = true): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical decimal u64 string`);
  }
  let number: bigint;
  try {
    number = BigInt(value);
  } catch {
    throw new TypeError(`${name} must be a canonical decimal u64 string`);
  }
  if (number > MAX_U64 || (!allowZero && number === 0n)) {
    throw new RangeError(`${name} is outside the allowed u64 range`);
  }
  return value;
}

function nullableGuid(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const guid = canonicalGuid(name, value);
  return guid === "0" ? null : guid;
}

function captureGuid(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_U64) throw new RangeError(`${name} is outside the allowed u64 range`);
    return value === 0n ? null : value.toString(10);
  }
  return nullableGuid(name, value);
}

function copyPosition(name: string, value: unknown): WorldReplayObjectV1["position"] {
  if (value === null) return null;
  const source = plainObject(name, value);
  exactKeys(name, source, ["x", "y", "z", "orientation"]);
  return {
    x: finite(`${name}.x`, source.x),
    y: finite(`${name}.y`, source.y),
    z: finite(`${name}.z`, source.z),
    orientation: finite(`${name}.orientation`, source.orientation),
  };
}

function copyTransport(name: string, value: unknown): WorldReplayTransportV1 | null {
  if (value === null) return null;
  const source = plainObject(name, value);
  exactKeys(name, source, ["guid", "x", "y", "z", "orientation", "seat"]);
  return {
    guid: canonicalGuid(`${name}.guid`, source.guid, false),
    x: finite(`${name}.x`, source.x),
    y: finite(`${name}.y`, source.y),
    z: finite(`${name}.z`, source.z),
    orientation: finite(`${name}.orientation`, source.orientation),
    seat: integerRange(`${name}.seat`, source.seat, 0, MAX_U8),
  };
}

function copyPairs(name: string, value: unknown, kind: "speed" | "field"):
  readonly (readonly [string, number] | readonly [number, number])[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  denseArray(name, value);
  const result: (readonly [string, number] | readonly [number, number])[] = [];
  let previous: string | number | undefined;
  for (let index = 0; index < value.length; index++) {
    const pair = value[index];
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError(`${name}[${index}] must be a pair`);
    denseArray(`${name}[${index}]`, pair);
    if (kind === "speed") {
      const key = pair[0];
      if (typeof key !== "string" || !SPEED_NAMES.has(key)) throw new TypeError(`${name}[${index}] has an unknown speed`);
      if (previous !== undefined && key <= previous) throw new RangeError(`${name} must be strictly sorted and unique`);
      previous = key;
      result.push([key, finite(`${name}[${index}][1]`, pair[1])]);
    } else {
      const field = integerRange(`${name}[${index}][0]`, pair[0], 0, MAX_U32);
      if (previous !== undefined && field <= (previous as number)) throw new RangeError(`${name} must be strictly sorted and unique`);
      previous = field;
      result.push([field, integerRange(`${name}[${index}][1]`, pair[1], 0, MAX_U32)]);
    }
  }
  return result;
}

function copyFrame(name: string, value: unknown, expectedIndex: number): WorldReplayCameraFrameV1 {
  const source = plainObject(name, value);
  exactKeys(name, source, CAMERA_KEYS);
  const frameIndex = integerRange(`${name}.frameIndex`, source.frameIndex, 0, 0xffff_ffff);
  if (frameIndex !== expectedIndex) throw new RangeError(`${name}.frameIndex must be ${expectedIndex}`);
  return {
    frameIndex,
    yaw: finite(`${name}.yaw`, source.yaw),
    pitch: finite(`${name}.pitch`, source.pitch),
    distance: finite(`${name}.distance`, source.distance),
    view: finite(`${name}.view`, source.view),
    viewPitch: finite(`${name}.viewPitch`, source.viewPitch),
    zoom: finite(`${name}.zoom`, source.zoom),
    wallView: cameraLimit(`${name}.wallView`, source.wallView),
    terrainView: cameraLimit(`${name}.terrainView`, source.terrainView),
    pivotHeight: finite(`${name}.pivotHeight`, source.pivotHeight),
    eyeHeight: finite(`${name}.eyeHeight`, source.eyeHeight),
  };
}

function copyObject(name: string, value: unknown): WorldReplayObjectV1 {
  const source = plainObject(name, value);
  exactKeys(name, source, OBJECT_KEYS);
  return {
    guid: canonicalGuid(`${name}.guid`, source.guid, false),
    typeId: source.typeId === null ? null : integerRange(`${name}.typeId`, source.typeId, 0, MAX_U8),
    position: copyPosition(`${name}.position`, source.position),
    movementFlags: integerRange(`${name}.movementFlags`, source.movementFlags, 0, MAX_U32),
    updateFlags: integerRange(`${name}.updateFlags`, source.updateFlags, 0, MAX_U32),
    targetGuid: nullableGuid(`${name}.targetGuid`, source.targetGuid),
    runSpeed: nullableFinite(`${name}.runSpeed`, source.runSpeed),
    turnRate: nullableFinite(`${name}.turnRate`, source.turnRate),
    transport: copyTransport(`${name}.transport`, source.transport),
    transportTime: nullableIntegerRange(`${name}.transportTime`, source.transportTime, 0, MAX_U32),
    speeds: copyPairs(`${name}.speeds`, source.speeds, "speed") as readonly WorldReplaySpeedEntryV1[],
    fields: copyPairs(`${name}.fields`, source.fields, "field") as readonly WorldReplayFieldEntryV1[],
  };
}

function copyWeather(name: string, value: unknown): WorldReplayWeatherV1 {
  const source = plainObject(name, value);
  exactKeys(name, source, ["state", "intensity", "abrupt"]);
  const abrupt = source.abrupt;
  if (typeof abrupt !== "boolean") throw new TypeError(`${name}.abrupt must be boolean`);
  const state = integerRange(`${name}.state`, source.state, 0, MAX_U32);
  const inputIntensity = finite(`${name}.intensity`, source.intensity);
  if (inputIntensity < 0 || inputIntensity > 1) throw new RangeError(`${name}.intensity must be in [0, 1]`);
  // SMS_WEATHER carries f32. Accept the author-friendly decimal too, but keep one wire identity.
  const intensity = weatherKind(state) === "rain"
    && (inputIntensity === 0.7 || inputIntensity === RAIN_INTENSITY)
    ? RAIN_INTENSITY
    : inputIntensity;
  return {
    state,
    intensity,
    abrupt,
  };
}

function copyExpectations(name: string, value: unknown, weather: WorldReplayWeatherV1): WorldReplayExpectationsV1 {
  const source = plainObject(name, value);
  exactKeys(name, source, EXPECTATION_KEYS);
  const scene = source.scene;
  if (typeof scene !== "string" || !(scene in SCENE_RULES)) throw new TypeError(`${name}.scene is unsupported`);
  const rule = SCENE_RULES[scene as WorldReplaySceneV1];
  const indoors = source.indoors;
  const underwater = source.underwater;
  const precipitation = source.precipitation;
  if (typeof indoors !== "boolean" || typeof underwater !== "boolean" || typeof precipitation !== "boolean") {
    throw new TypeError(`${name} boolean fields must be boolean`);
  }
  const inputRainIntensity = finite(`${name}.rainIntensity`, source.rainIntensity);
  const result = {
    scene: scene as WorldReplaySceneV1,
    indoors,
    underwater,
    precipitation,
    rainIntensity: scene === "rain"
      && (inputRainIntensity === 0.7 || inputRainIntensity === RAIN_INTENSITY)
      ? RAIN_INTENSITY
      : inputRainIntensity,
  };
  if (result.indoors !== rule.indoors
    || result.underwater !== rule.underwater
    || result.precipitation !== rule.precipitation
    || result.rainIntensity !== rule.rainIntensity) {
    throw new RangeError(`${name} is incoherent for scene ${scene}`);
  }
  if (weatherKind(weather.state) !== rule.weather || weather.intensity !== rule.rainIntensity) {
    throw new RangeError(`${name} does not match fixed weather`);
  }
  if (scene === "rain" && weather.abrupt !== true) {
    throw new RangeError("rain weather must be abrupt");
  }
  return result;
}

function copyExpectationsForHydration(value: WorldReplayExpectationsV1): WorldReplayExpectationsV1 {
  return {
    scene: value.scene,
    indoors: value.indoors,
    underwater: value.underwater,
    precipitation: value.precipitation,
    rainIntensity: value.rainIntensity,
  };
}

function validateReferences(
  snapshot: Pick<WorldReplaySnapshotV1, "selfGuid" | "targetGuid" | "focusGuid" | "objects">,
): void {
  const known = new Set(snapshot.objects.map((object) => object.guid));
  const check = (name: string, guid: string | null): void => {
    if (guid === null || guid === "0") return;
    if (!known.has(guid)) throw new RangeError(`${name} references a missing object`);
  };
  if (!known.has(snapshot.selfGuid)) throw new RangeError("selfGuid must reference an object");
  check("targetGuid", snapshot.targetGuid);
  check("focusGuid", snapshot.focusGuid);
  for (const object of snapshot.objects) {
    check(`${object.guid}.targetGuid`, object.targetGuid);
    check(`${object.guid}.transport`, object.transport?.guid ?? null);
  }
}

/** Validates, clones, canonicalizes shape, and deeply freezes one replay snapshot. */
export function cloneWorldReplaySnapshot(input: unknown): WorldReplaySnapshotV1 {
  const source = plainObject("snapshot", input);
  exactKeys("snapshot", source, ROOT_REQUIRED_KEYS, ROOT_OPTIONAL_KEYS);
  if (source.schemaVersion !== WORLD_REPLAY_SCHEMA_VERSION) {
    throw new TypeError("snapshot.schemaVersion is unsupported");
  }
  const framesInput = source.frames;
  if (!Array.isArray(framesInput) || framesInput.length === 0) throw new RangeError("snapshot.frames must not be empty");
  denseArray("snapshot.frames", framesInput);
  const objectsInput = source.objects;
  if (!Array.isArray(objectsInput)) throw new TypeError("snapshot.objects must be an array");
  denseArray("snapshot.objects", objectsInput);

  const objects = objectsInput.map((value, index) => copyObject(`snapshot.objects[${index}]`, value));
  let previousGuid: bigint | undefined;
  for (const [index, object] of objects.entries()) {
    const guid = BigInt(object.guid);
    if (previousGuid !== undefined && guid <= previousGuid) {
      throw new RangeError(`snapshot.objects must be strictly sorted numerically at index ${index}`);
    }
    previousGuid = guid;
  }

  const weather = copyWeather("snapshot.weather", source.weather);

  const frames = framesInput.map((value, index) => copyFrame(`snapshot.frames[${index}]`, value, index));
  const result: WorldReplaySnapshotV1 = {
    schemaVersion: WORLD_REPLAY_SCHEMA_VERSION,
    scenarioId: (() => {
      if (typeof source.scenarioId !== "string" || source.scenarioId.length === 0) {
        throw new TypeError("snapshot.scenarioId must be non-empty");
      }
      return source.scenarioId;
    })(),
    mapId: integerRange("snapshot.mapId", source.mapId, 0, MAX_U32),
    selfGuid: canonicalGuid("snapshot.selfGuid", source.selfGuid, false),
    targetGuid: nullableGuid("snapshot.targetGuid", source.targetGuid),
    focusGuid: nullableGuid("snapshot.focusGuid", source.focusGuid),
    halfMinute: integerRange("snapshot.halfMinute", source.halfMinute, 0, 2879),
    weather,
    rngSeed: integerRange("snapshot.rngSeed", source.rngSeed, 0, MAX_U32),
    frameStepMs: finite("snapshot.frameStepMs", source.frameStepMs),
    frames,
    objects,
    expectations: copyExpectations("snapshot.expectations", source.expectations, weather),
  };
  if (result.frameStepMs <= 0) throw new RangeError("snapshot.frameStepMs must be positive");
  validateReferences(result);
  return deepFreeze(result);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as PlainRecord)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function canonicalJson(value: WorldReplayJsonValue): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new TypeError("value is not JSON-safe");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map((child) => canonicalJson(child)).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

/** Stable JSON with recursively sorted object keys and schema-validated array order. */
export function canonicalWorldReplayJson(snapshot: unknown): string {
  return canonicalJson(cloneWorldReplaySnapshot(snapshot) as unknown as WorldReplayJsonValue);
}

async function sha256Hex(value: string): Promise<string> {
  const crypto = globalThis.crypto;
  if (crypto === undefined || crypto.subtle === undefined || typeof crypto.subtle.digest !== "function") {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the canonical snapshot, using only the platform Web Crypto implementation. */
export async function hashWorldReplaySnapshot(snapshot: unknown): Promise<string> {
  return sha256Hex(canonicalWorldReplayJson(snapshot));
}

/** SHA-256 of the ordered camera frames, independent of world object state. */
export async function hashWorldReplayFrameOrder(snapshot: unknown): Promise<string> {
  const owned = cloneWorldReplaySnapshot(snapshot);
  return sha256Hex(canonicalJson(owned.frames as unknown as WorldReplayJsonValue));
}

function hydratedFrame(frame: WorldReplayCameraFrameV1): HydratedWorldReplayCameraFrameV1 {
  return {
    frameIndex: frame.frameIndex,
    yaw: frame.yaw,
    pitch: frame.pitch,
    distance: frame.distance,
    view: frame.view,
    viewPitch: frame.viewPitch,
    zoom: frame.zoom,
    wallView: frame.wallView === null ? Number.POSITIVE_INFINITY : frame.wallView,
    terrainView: frame.terrainView === null ? Number.POSITIVE_INFINITY : frame.terrainView,
    pivotHeight: frame.pivotHeight,
    eyeHeight: frame.eyeHeight,
  };
}

/** Rebuilds a fresh WorldState and replay frame stream without retaining snapshot aliases. */
export function hydrateWorldReplaySnapshot(input: unknown): HydratedWorldReplaySnapshot {
  const snapshot = cloneWorldReplaySnapshot(input);
  const state = new WorldState();
  for (const source of snapshot.objects) {
    const object: WorldObjectState = {
      guid: BigInt(source.guid),
      typeId: source.typeId ?? undefined,
      position: source.position === null ? undefined : { ...source.position },
      movementFlags: source.movementFlags,
      updateFlags: source.updateFlags,
      targetGuid: source.targetGuid === null || source.targetGuid === "0" ? undefined : BigInt(source.targetGuid),
      runSpeed: source.runSpeed ?? undefined,
      turnRate: source.turnRate ?? undefined,
      motion: undefined,
      glide: undefined,
      transport: source.transport === null ? undefined : {
        guid: BigInt(source.transport.guid),
        x: source.transport.x,
        y: source.transport.y,
        z: source.transport.z,
        orientation: source.transport.orientation,
        seat: source.transport.seat,
      },
      transportTime: source.transportTime ?? undefined,
      speeds: source.speeds.length === 0 ? undefined : new Map(source.speeds) as WorldObjectState["speeds"],
      fields: new Map(source.fields),
    };
    state.objects.set(object.guid, object);
  }
  state.selfGuid = BigInt(snapshot.selfGuid);
  return {
    state,
    schemaVersion: snapshot.schemaVersion,
    scenarioId: snapshot.scenarioId,
    mapId: snapshot.mapId,
    targetGuid: snapshot.targetGuid === null ? undefined : BigInt(snapshot.targetGuid),
    focusGuid: snapshot.focusGuid === null ? undefined : BigInt(snapshot.focusGuid),
    halfMinute: snapshot.halfMinute,
    weather: { ...snapshot.weather },
    rngSeed: snapshot.rngSeed,
    frameStepMs: snapshot.frameStepMs,
    frames: snapshot.frames.map(hydratedFrame),
    expectations: copyExpectationsForHydration(snapshot.expectations),
  };
}

function cloneLiveObject(source: WorldObjectState): WorldObjectState {
  return {
    guid: source.guid,
    typeId: source.typeId,
    position: source.position === undefined ? undefined : { ...source.position },
    movementFlags: source.movementFlags,
    updateFlags: source.updateFlags,
    targetGuid: source.targetGuid,
    runSpeed: source.runSpeed,
    turnRate: source.turnRate,
    motion: source.motion === undefined ? undefined : {
      points: (() => {
        denseArray("world.motion.points", source.motion!.points);
        denseArray("world.motion.lengths", source.motion!.lengths);
        return source.motion!.points.map((point) => ({ ...point }));
      })(),
      lengths: [...source.motion.lengths],
      totalLength: source.motion.totalLength,
      startedAt: source.motion.startedAt,
      duration: source.motion.duration,
      cyclic: source.motion.cyclic,
      flying: source.motion.flying,
      finalOrientation: source.motion.finalOrientation,
    },
    glide: source.glide === undefined ? undefined : { ...source.glide },
    transport: source.transport === undefined ? undefined : { ...source.transport },
    speeds: source.speeds === undefined ? undefined : new Map(source.speeds),
    transportTime: source.transportTime,
    fields: new Map(source.fields),
  };
}

function cloneLiveWorld(source: WorldState): WorldState {
  const copy = new WorldState();
  for (const object of source.objects.values()) copy.objects.set(object.guid, cloneLiveObject(object));
  copy.selfGuid = source.selfGuid;
  return copy;
}

const SPLINE_SCRUB_MASK = MOVEMENT_MASK_MOVING | 0x08000000;

/**
 * Materialize a private world copy in dependency order. WorldState's frame updater intentionally
 * walks its insertion order, but capture must not make a passenger's pose depend on that order.
 */
function materializeCaptureWorld(world: WorldState, now: number): void {
  const visiting = new Set<bigint>();
  const complete = new Set<bigint>();

  const advanceGlide = (object: WorldObjectState, glide: NonNullable<WorldObjectState["glide"]>): void => {
    const position = object.position;
    if (!position) {
      object.glide = undefined;
      return;
    }
    const progress = Math.min(1, Math.max(0, (now - glide.startedAt) / glide.duration));
    position.x = glide.fromX + (glide.toX - glide.fromX) * progress;
    position.y = glide.fromY + (glide.toY - glide.fromY) * progress;
    position.z = glide.fromZ + (glide.toZ - glide.fromZ) * progress;
    position.orientation = glide.fromOrientation + shortestTurn(glide.fromOrientation, glide.toOrientation) * progress;
    if (progress >= 1) object.glide = undefined;
  };

  const advanceSpline = (object: WorldObjectState, motion: NonNullable<WorldObjectState["motion"]>): void => {
    if (!object.position) return;
    const rawProgress = (now - motion.startedAt) / motion.duration;
    const progress = motion.cyclic ? ((rawProgress % 1) + 1) % 1 : Math.min(Math.max(rawProgress, 0), 1);
    const distance = progress * motion.totalLength;
    let segment = motion.lengths.findIndex((length) => distance <= length);
    if (segment < 0) segment = motion.lengths.length - 1;
    const startDistance = segment === 0 ? 0 : motion.lengths[segment - 1]!;
    const segmentLength = (motion.lengths[segment] ?? startDistance) - startDistance;
    const ratio = segmentLength === 0 ? 0 : (distance - startDistance) / segmentLength;
    const start = motion.points[segment]!;
    const end = motion.points[segment + 1]!;
    object.position.x = start.x + (end.x - start.x) * ratio;
    object.position.y = start.y + (end.y - start.y) * ratio;
    object.position.z = start.z + (end.z - start.z) * ratio;
    object.position.orientation = Math.atan2(end.y - start.y, end.x - start.x);
    if (!motion.cyclic && rawProgress >= 1) {
      if (motion.finalOrientation !== undefined) object.position.orientation = motion.finalOrientation;
      object.motion = undefined;
      if (object.typeId === 3) object.movementFlags &= ~SPLINE_SCRUB_MASK;
    }
  };

  const materialize = (object: WorldObjectState): void => {
    if (complete.has(object.guid)) return;
    if (visiting.has(object.guid)) throw new RangeError(`transport cycle at ${object.guid.toString(10)}`);
    visiting.add(object.guid);
    // Capture these before carrying: they are the object's own motion for this tick, and win
    // after transport carry just as WorldState.updateMotions does.
    const ownGlide = object.glide;
    const ownMotion = object.motion;
    const seat = object.transport;
    if (seat) {
      const transport = world.objects.get(seat.guid);
      if (transport) {
        materialize(transport);
        if (object.position && transport.position) {
          object.position = composePassengerPosition(transport.position, seat as TransportSeat);
        }
      }
    }
    if (ownGlide) advanceGlide(object, ownGlide);
    if (ownMotion) advanceSpline(object, ownMotion);
    visiting.delete(object.guid);
    complete.add(object.guid);
  };

  const objects = [...world.objects.values()].sort((left, right) => left.guid < right.guid ? -1 : left.guid > right.guid ? 1 : 0);
  for (const object of objects) materialize(object);
}

function captureCameraFrame(name: string, frame: CameraRig, frameIndex: number): WorldReplayCameraFrameV1 {
  if (frame === null || typeof frame !== "object") throw new TypeError(`${name} must be a CameraRig`);
  return {
    frameIndex,
    yaw: finite(`${name}.yaw`, frame.yaw),
    pitch: finite(`${name}.pitch`, frame.pitch),
    distance: finite(`${name}.distance`, frame.distance),
    view: finite(`${name}.view`, frame.view),
    viewPitch: finite(`${name}.viewPitch`, frame.viewPitch),
    zoom: finite(`${name}.zoom`, frame.zoom),
    wallView: captureCameraLimit(`${name}.wallView`, frame.wallView),
    terrainView: captureCameraLimit(`${name}.terrainView`, frame.terrainView),
    pivotHeight: finite(`${name}.pivotHeight`, frame.pivotHeight),
    eyeHeight: finite(`${name}.eyeHeight`, frame.eyeHeight),
  };
}

function captureObject(source: WorldObjectState): WorldReplayObjectV1 {
  const speeds = Array.from(source.speeds?.entries() ?? [])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const fields = Array.from(source.fields.entries()).sort(([left], [right]) => left - right);
  return {
    guid: canonicalGuid("object.guid", source.guid.toString(10), false),
    typeId: source.typeId ?? null,
    position: source.position === undefined ? null : { ...source.position },
    movementFlags: source.movementFlags,
    updateFlags: source.updateFlags,
    targetGuid: captureGuid("object.targetGuid", source.targetGuid),
    runSpeed: source.runSpeed ?? null,
    turnRate: source.turnRate ?? null,
    transport: source.transport === undefined ? null : {
      guid: canonicalGuid("object.transport.guid", source.transport.guid.toString(10), false),
      x: source.transport.x,
      y: source.transport.y,
      z: source.transport.z,
      orientation: source.transport.orientation,
      seat: source.transport.seat,
    },
    transportTime: source.transportTime ?? null,
    speeds,
    fields,
  };
}

function captureInput(
  world: WorldState,
  captureNowMs: number,
  metadata: WorldReplayCaptureMetadata,
  frames: readonly CameraRig[],
): WorldReplaySnapshotV1 {
  if (!(world instanceof WorldState)) throw new TypeError("capture.world must be a WorldState");
  finite("captureNowMs", captureNowMs);
  if (!Array.isArray(frames) || frames.length === 0) throw new RangeError("capture.frames must not be empty");
  denseArray("capture.frames", frames);
  const metadataSource = plainObject("capture.metadata", metadata);
  exactKeys("capture.metadata", metadataSource,
    ["scenarioId", "mapId", "halfMinute", "weather", "rngSeed", "frameStepMs", "expectations"],
    ["selfGuid", "targetGuid", "focusGuid"]);
  const sampled = cloneLiveWorld(world);
  materializeCaptureWorld(sampled, captureNowMs);
  const objects = [...sampled.objects.values()]
    .map(captureObject)
    .sort((left, right) => BigInt(left.guid) < BigInt(right.guid) ? -1 : 1);
  const selfGuid = captureGuid("capture.selfGuid", metadataSource.selfGuid ?? world.selfGuid);
  return cloneWorldReplaySnapshot({
    schemaVersion: WORLD_REPLAY_SCHEMA_VERSION,
    scenarioId: metadataSource.scenarioId,
    mapId: metadataSource.mapId,
    selfGuid,
    targetGuid: captureGuid("capture.targetGuid", metadataSource.targetGuid),
    focusGuid: captureGuid("capture.focusGuid", metadataSource.focusGuid),
    halfMinute: metadataSource.halfMinute,
    weather: metadataSource.weather,
    rngSeed: metadataSource.rngSeed,
    frameStepMs: metadataSource.frameStepMs,
    frames: frames.map((frame, index) => captureCameraFrame(`capture.frames[${index}]`, frame, index)),
    objects,
    expectations: metadataSource.expectations,
  });
}

export function captureWorldReplaySnapshot(input: WorldReplayCaptureInput): WorldReplaySnapshotV1;
export function captureWorldReplaySnapshot(
  world: WorldState,
  captureNowMs: number,
  metadata: WorldReplayCaptureMetadata,
  frames: readonly CameraRig[],
): WorldReplaySnapshotV1;
export function captureWorldReplaySnapshot(
  inputOrWorld: WorldReplayCaptureInput | WorldState,
  captureNowMs?: number,
  metadata?: WorldReplayCaptureMetadata,
  frames?: readonly CameraRig[],
): WorldReplaySnapshotV1 {
  if (inputOrWorld instanceof WorldState) {
    if (captureNowMs === undefined || metadata === undefined || frames === undefined) {
      throw new TypeError("captureWorldReplaySnapshot requires world, time, metadata, and frames");
    }
    return captureInput(inputOrWorld, captureNowMs, metadata, frames);
  }
  const input = plainObject("capture", inputOrWorld);
  exactKeys("capture", input, ["world", "captureNowMs", "metadata", "frames"]);
  return captureInput(input.world as WorldState, input.captureNowMs as number,
    input.metadata as WorldReplayCaptureMetadata, input.frames as readonly CameraRig[]);
}

/** Compares fixed scene and weather observations against one validated replay snapshot. */
export function validateWorldReplayObservation(snapshotInput: unknown, actualInput: unknown): true {
  const snapshot = cloneWorldReplaySnapshot(snapshotInput);
  const actual = plainObject("observation", actualInput);
  exactKeys("observation", actual, ["indoors", "underwater", "weather"]);
  if (typeof actual.indoors !== "boolean" || typeof actual.underwater !== "boolean") {
    throw new TypeError("observation indoors/underwater must be boolean");
  }
  if (actual.indoors !== snapshot.expectations.indoors) throw new Error("observation indoors mismatch");
  if (actual.underwater !== snapshot.expectations.underwater) throw new Error("observation underwater mismatch");
  const weather = copyWeather("observation.weather", actual.weather);
  if (weather.state !== snapshot.weather.state
    || weather.intensity !== snapshot.weather.intensity
    || weather.abrupt !== snapshot.weather.abrupt) {
    throw new Error("observation weather mismatch");
  }
  return true;
}

// Descriptive aliases keep the small contract discoverable without duplicating implementations.
export const serializeWorldReplaySnapshot = canonicalWorldReplayJson;
export const canonicalizeWorldReplaySnapshot = canonicalWorldReplayJson;
export const sha256WorldReplaySnapshot = hashWorldReplaySnapshot;
export const createWorldReplaySnapshot = cloneWorldReplaySnapshot;

export type FrozenWorldReplaySnapshotV1 = DeepReadonly<WorldReplaySnapshotV1>;
