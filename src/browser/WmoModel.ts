/**
 * Reading a WWM1/WWM2 artifact: one WMO as the rooms it is made of.
 *
 * The encoder and the byte layout live in `tools/wwm.mjs`, which is where the format is written
 * down. What matters here is the shape it arrives in: a header that always carries every group's
 * box, flags and size, and geometry only for the groups that came with it. A building under the
 * publisher's triangle budget arrives whole; a city arrives as a compact table of boxes and portal
 * metadata, and the handful of rooms the player is standing in are fetched one at a time afterwards.
 */

import { VISUAL_MODEL_ROUTE_VERSION, textureUrl } from "./Wvm.js"; // 05.10-A7b-2: textureUrl
import { decodeWmoMaterialSection, type WmoMaterial } from "./WmoMaterials.js"; // 05.10-A7b-3

const MAGIC_WWM1 = "WWM1";
const MAGIC_WWM2 = "WWM2";
const HEADER_SIZE = 24;
const GROUP_SIZE = 40;
const BLOCK_HEADER_SIZE = 16;
const RUN_SIZE = 16;
const LIGHT_SIZE = 28;
const COMPLETE = 0x01;
const AUTHORED_NORMALS = 0x01;
const LEGACY_METADATA_MAGIC = "WME1";
const LEGACY_METADATA_HEADER_SIZE = 8;
const METADATA_MAGIC = "WME2";
const METADATA_HEADER_SIZE = 24;
const METADATA_GROUP_SIZE = 8;
const METADATA_DEFINITION_SIZE = 4;
const METADATA_REFERENCE_SIZE = 8;
const FOG_MAGIC = "WME3";
const FOG_HEADER_SIZE = 16;
const FOG_GROUP_SIZE = 4;
const FOG_SIZE = 48;
/** Header flag bits written by `tools/wwm.mjs` from the source's MOHD flags. */
const CLASSIC_VERTEX_LIGHT = 0x02;
const VERTEX_ALPHA_UNFIXED = 0x04;
const ROOMS_MAGIC = "WME4";
const ROOMS_HEADER_SIZE = 12;
const ROOMS_SET_SIZE = 8;

/** Bit 0 of an MFOG record's flags: it has no radius and holds wherever its groups are. */
export const WMO_FOG_UNBOUNDED = 0x01;

/** MOGP bit 13: this group is a room and not a porch or a roof. */
export const WMO_GROUP_INDOOR = 0x2000;
/** MOGP bit 3: the group is outdoors (the server's `Map::IsOutdoors` reads this same bit). */
export const WMO_GROUP_OUTDOOR = 0x8;
/** MOGP bit 2: the group carries MOCV; without it the encoder writes white placeholders. */
export const WMO_GROUP_HAS_COLOURS = 0x4;

/**
 * Which of the client's two WMO pipelines lights a model's rooms, from MOHD bit 0x2.
 *
 * `classic` is `MapObj.wfx`: MOCV already holds `MOHD.ambColor` (the load step subtracts it and the
 * shader adds it back), so the room's light is MOCV itself, brightened by its alpha as
 * `FixColorVertexAlpha` does. `unified` is `MapObjU.wfx`: the ambient is added to MOCV at run time.
 * Artifacts that predate the flag read as `unified`, which is the light they were always given.
 */
export type WmoVertexLightPath = "classic" | "unified";

/**
 * One doodad set's MODR rooms: doodad ordinal k (the tiles' numbering) belongs to
 * `groups[offsets[k]]` up to `groups[offsets[k + 1]]`.
 */
export interface WmoDoodadRooms {
  offsets: Uint32Array;
  groups: Uint16Array;
}

/**
 * Which light a run of triangles is drawn in, as the WMO's own batch order states it.
 *
 * Not the group's flag: 175,137 of Stormwind's triangles sit in exterior batches inside groups
 * marked indoor — the outward faces of its rooms — and lighting those by the group would put a
 * street-facing wall in a windowless room. A transition batch counts as interior; see the encoder.
 */
export const WMO_LIGHT_EXTERIOR = 0;
export const WMO_LIGHT_INTERIOR = 1;
export const WMO_LIGHT_TRANSITION = 2;

/**
 * Whether a run is lit as a room's inside: its batch says so *and* the group it sits in is a room.
 *
 * The batch order on its own is not enough, and Dalaran is where that shows. Its artist marked
 * next to no exterior batches — measured on `ND_Dalaran.wmo`, 336 exterior triangles out of
 * 419,562 — so the 17 of its 21 groups without the indoor flag that hold interior batches, which
 * are the shell of the city and the streets under it, were drawn unlit and multiplied by an
 * ambient of (53, 66, 90). Those 17 are 1,765,218 of the model's 2,321,769 square yards of drawn
 * surface, 76.0%. The remaining four hold nothing but those 336 exterior triangles and were in
 * the sun before this rule as well as after; all 21 together are 1,834,426 square yards, 79.0%.
 *
 * The reference client asks the flag and nothing else (`wowee/src/rendering/wmo_renderer.cpp:777`,
 * `bool isInterior = (groupRes.groupFlags & 0x2000) != 0`). Keeping the flag as the outer question
 * and letting the batch order answer the inner one is what Stormwind still needs: 118 of its
 * indoor groups carry exterior batches on 175,137 triangles, the outward faces of its rooms.
 */
export function wmoRunIsInterior(group: Pick<WmoGroup, "indoor">, run: Pick<WmoRun, "lighting">): boolean {
  return run.lighting !== WMO_LIGHT_EXTERIOR && group.indoor;
}

const INTERIOR_ONLY = new WeakMap<WmoModel, boolean>();

/**
 * Whether a model is rooms and nothing else: every drawn group indoor, none outdoor (MOGP 0x8) and
 * none holding an exterior or transition run.
 *
 * Gundrak's 24 groups all are. Stormwind, Dalaran, the Deadmines (one outdoor group), the Undercity
 * (two) and the Goldshire Inn (two) are not. Such a model has no street to keep on a short leash
 * and no sky of its own: its rooms are chosen through its portals at the full environment range,
 * and a unit standing in it is lit by the room rather than by a sun the room has no window to.
 */
export function wmoInteriorOnly(model: Pick<WmoModel, "groups">): boolean {
  const key = model as WmoModel;
  let known = INTERIOR_ONLY.get(key);
  if (known === undefined) {
    known = model.groups.some((group) => group.triangleCount > 0)
      && model.groups.every((group) => group.triangleCount === 0
        || (group.indoor && !group.exterior && (group.flags & WMO_GROUP_OUTDOOR) === 0));
    INTERIOR_ONLY.set(key, known);
  }
  return known;
}

/** The first room (indoor, no exterior run) whose model-space box strictly holds a point, or -1. */
export function wmoInteriorGroupAt(model: Pick<WmoModel, "groups">, x: number, y: number, z: number): number {
  for (const [index, group] of model.groups.entries()) {
    if (!group.indoor || group.exterior || group.boundsValid === false) continue;
    const b = group.bounds;
    if (x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ) return index;
  }
  return -1;
}

/**
 * Whether any MODR room of the doodad at `ordinal` is in `visible` (one byte per group).
 *
 * Undefined when the table cannot answer — no WME4, an ordinal past it, or a record no room names —
 * so the caller keeps the distance leash instead of hiding furniture on a guess.
 */
export function wmoDoodadRoomVisible(
  rooms: WmoDoodadRooms | undefined,
  ordinal: number,
  visible: Uint8Array,
): boolean | undefined {
  if (!rooms || !Number.isInteger(ordinal) || ordinal < 0 || ordinal + 1 >= rooms.offsets.length) return undefined;
  const start = rooms.offsets[ordinal]!;
  const end = rooms.offsets[ordinal + 1]!;
  if (end <= start) return undefined;
  for (let at = start; at < end; at++) if (visible[rooms.groups[at]!] === 1) return true;
  return false;
}

/**
 * Whether the doodad at `ordinal`, a sphere in the space `clip` projects from, can be seen through
 * the screen rectangle of one of its shown MODR rooms (`apertures`: minX, maxX, minY, maxY in NDC
 * per group, as `selectWmoPortalGroups` writes them), widened by `margin`. A room seen whole, a
 * sphere reaching the eye plane or anything non-finite answers true: the frustum test decides.
 */
export function wmoDoodadInAperture(
  rooms: WmoDoodadRooms,
  ordinal: number,
  visible: Uint8Array,
  apertures: Float32Array,
  clip: ArrayLike<number>,
  sphere: { readonly x: number; readonly y: number; readonly z: number; readonly radius: number },
  margin: number,
): boolean {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal + 1 >= rooms.offsets.length) return true;
  const start = rooms.offsets[ordinal]!;
  const end = rooms.offsets[ordinal + 1]!;
  for (let at = start; at < end; at++) {
    const group = rooms.groups[at]!;
    if (visible[group] === 1 && apertures[group * 4]! <= -1 && apertures[group * 4 + 1]! >= 1
      && apertures[group * 4 + 2]! <= -1 && apertures[group * 4 + 3]! >= 1) return true;
  }
  // The corners of the sphere's box, projected; the box holds the sphere and the projection of a
  // box wholly in front of the eye is the hull of its corners.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const x = sphere.x + ((corner & 1) !== 0 ? sphere.radius : -sphere.radius);
    const y = sphere.y + ((corner & 2) !== 0 ? sphere.radius : -sphere.radius);
    const z = sphere.z + ((corner & 4) !== 0 ? sphere.radius : -sphere.radius);
    const w = clip[3]! * x + clip[7]! * y + clip[11]! * z + clip[15]!;
    if (!(w > 1e-4)) return true;
    const ndcX = (clip[0]! * x + clip[4]! * y + clip[8]! * z + clip[12]!) / w;
    const ndcY = (clip[1]! * x + clip[5]! * y + clip[9]! * z + clip[13]!) / w;
    if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return true;
    minX = Math.min(minX, ndcX);
    maxX = Math.max(maxX, ndcX);
    minY = Math.min(minY, ndcY);
    maxY = Math.max(maxY, ndcY);
  }
  for (let at = start; at < end; at++) {
    const group = rooms.groups[at]!;
    if (visible[group] !== 1) continue;
    if (minX <= apertures[group * 4 + 1]! + margin && maxX >= apertures[group * 4]! - margin
      && minY <= apertures[group * 4 + 3]! + margin && maxY >= apertures[group * 4 + 2]! - margin) return true;
  }
  return false;
}

export interface WmoBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** One run of triangles: a texture, the state it is drawn with, and the light it is drawn in. */
export interface WmoRun {
  start: number;
  count: number;
  material: number;
  blendMode: number;
  materialFlags: number;
  lighting: number;
  /** 05.10-A7b-3 (7.11): the MOMT record (index into {@link WmoModel.materials}); absent before v25. */
  materialIndex?: number;
}

/** One of the lamps the artist hung inside the building, as `MOLT` records it. */
export interface WmoLight {
  /** Model space, the same frame the group's vertices are in. */
  position: [number, number, number];
  /** 0 to 255 per channel. */
  colour: [number, number, number];
  intensity: number;
  attenuationStart: number;
  attenuationEnd: number;
  attenuates: boolean;
}

/** One end of an MFOG record: the distance the fog closes at, where it starts, and its colour. */
export interface WmoFogHalf {
  /** Yards, in the model's own units. */
  end: number;
  /** The fraction of `end` the fog begins at. */
  scale: number;
  /** 0 to 255 per channel. */
  colour: [number, number, number];
}

/**
 * One MFOG record: the fog inside a building, as the artist placed it.
 *
 * Every one of the 1,985 root WMOs under `World\wmo\` carries this chunk — 2,463 records between
 * them — and until this arrived nothing in the client read a byte of it, so a tavern and a sewer
 * were both drawn in whatever fog `Light.dbc` says the sky outside has. Most records say nothing:
 * the land colour is pure white on 1,811 of the 2,463.
 */
export interface WmoFog {
  /** {@link WMO_FOG_UNBOUNDED} and whatever else the source WMO set; kept verbatim. */
  flags: number;
  /** Model space, the same frame the group's vertices are in. */
  position: [number, number, number];
  innerRadius: number;
  outerRadius: number;
  land: WmoFogHalf;
  /**
   * The same for a camera in water — and not usable as one in this data.
   *
   * 2,429 of the 2,463 records carry a negative start scale here, which would put the near plane
   * behind the camera. It travels because dropping half a record would make the artifact disagree
   * with the file, not because a renderer should read it as a distance.
   */
  water: WmoFogHalf;
}

/** One group's geometry, numbered from its own first vertex and needing nothing else. */
export interface WmoGroupMesh {
  positions: Float32Array;
  uvs: Float32Array;
  /** Baked vertex light, RGBA. White where the artist left the group unpainted. */
  colours: Uint8Array;
  /** Optional authored MONR normals in model space, one finite float3 per vertex. */
  normals?: Float32Array;
  indices: Uint16Array | Uint32Array;
  runs: WmoRun[];
  /** Which of the model's lamps hang in this group, by index into its light table. */
  lightRefs: Uint16Array;
}

export interface WmoGroup {
  /** Model-space bounds, as the group file records them. */
  bounds: WmoBounds;
  /** False means the source/wire bounds are malformed; retain them but never use them to cull. */
  boundsValid?: boolean;
  flags: number;
  indoor: boolean;
  /** Legacy wire bit: this group has an exterior or transition run needing the long boundary leash. */
  exterior: boolean;
  /** The slice of {@link WmoPortals.references} that leaves this group. */
  portalStart: number;
  portalCount: number;
  /**
   * Which of {@link WmoModel.fogs} this group stands in, as MOGP's own four indices.
   *
   * Up to four and not one because a group really can stand in more than one: 366 of the 9,346
   * groups under `World\wmo\` fill a slot past the first, and in none of them is it a repeat of
   * the first. What arrives here is what the file names: deduplicated, range-checked, and with
   * the zero bytes that pad the unfilled slots dropped rather than read as a reference to record
   * 0 — see {@link decodeFogExtension} for the corpus rule that says which of the two a zero is.
   * An empty list therefore means «the sky outside» and nothing else.
   */
  fogIds: number[];
  vertexCount: number;
  triangleCount: number;
  /** Present once this group's block has arrived, which for a small model is immediately. */
  mesh?: WmoGroupMesh;
}

export interface WmoPortalDefinition {
  /** First model-space vertex, not float, in {@link WmoPortals.vertices}. */
  startVertex: number;
  vertexCount: number;
}

export interface WmoPortalReference {
  portal: number;
  /** The group on the other side of the portal. */
  group: number;
  side: number;
}

/** The small MOPV/MOPT/MOPR graph used to decide which static WMO rooms can be seen. */
export interface WmoPortals {
  /** Flat xyz model-space vertices. */
  vertices: Float32Array;
  definitions: WmoPortalDefinition[];
  references: WmoPortalReference[];
}

export interface WmoModel {
  /** `MOHD.ambColor`, 0 to 255 per channel: the light an interior sits in before anything baked. */
  ambient: [number, number, number];
  textureUrls: string[];
  lights: WmoLight[];
  groups: WmoGroup[];
  /** Absent on legacy artifacts and whenever optional metadata fails validation. */
  portals?: WmoPortals;
  /** `MFOG`. Empty on legacy artifacts, which carry no fog section at all. */
  fogs: WmoFog[];
  /** Nothing was held back, so no group will ever have to be asked for. */
  complete: boolean;
  /** See {@link WmoVertexLightPath}; absent reads as `unified`. */
  vertexLight?: WmoVertexLightPath;
  /** MOHD 0x8 clear: MOCV alpha went through `FixColorVertexAlpha` and brightens by 1 + a/64. */
  vertexAlphaFixed?: boolean;
  /** WME4, per doodad set; empty on artifacts without it. */
  doodadRooms?: readonly WmoDoodadRooms[];
  /** 05.10-A7b-3 (7.11 P2): WME5, the MOMT table; absent on artifacts before `visual-wmo-v25`. */
  materials?: readonly WmoMaterial[];
  /**
   * 05.10-A7b-2 (7.11 P1): per MOMT record, the gateway URL of its second texture (`/texture?path=`),
   * or "" for none; beside {@link materials}, which the artifact carries without a base URL.
   */
  materialTextureUrls?: readonly string[];
  /** 05.10-A7b-3 (7.11 P4): MOSB verbatim (may be an absolute authoring path); absent when none. */
  skybox?: string;
}

function validWmoBounds(bounds: WmoBounds): boolean {
  return Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY) && Number.isFinite(bounds.minZ)
    && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY) && Number.isFinite(bounds.maxZ)
    && bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY && bounds.minZ <= bounds.maxZ;
}

function inertWmoLight(): WmoLight {
  return {
    position: [0, 0, 0], colour: [0, 0, 0], intensity: 0,
    attenuationStart: 0, attenuationEnd: 0, attenuates: false,
  };
}

function validWmoLight(light: WmoLight): boolean {
  try {
    const position = light?.position;
    const colour = light?.colour;
    if (!Array.isArray(position) || position.length !== 3
      || !Array.isArray(colour) || colour.length !== 3) return false;
    const [x, y, z] = position;
    const [red, green, blue] = colour;
    return [x, y, z, red, green, blue, light.intensity,
      light.attenuationStart, light.attenuationEnd].every(Number.isFinite)
      && red >= 0 && red <= 255 && green >= 0 && green <= 255
      && blue >= 0 && blue <= 255
      && light.intensity >= 0 && light.attenuationStart >= 0
      && light.attenuationEnd >= light.attenuationStart;
  } catch {
    return false;
  }
}

function decodeWmoLight(view: DataView, bytes: Uint8Array, offset: number): WmoLight {
  const light: WmoLight = {
    position: [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)],
    intensity: view.getFloat32(offset + 12, true),
    attenuationStart: view.getFloat32(offset + 16, true),
    attenuationEnd: view.getFloat32(offset + 20, true),
    colour: [bytes[offset + 24]!, bytes[offset + 25]!, bytes[offset + 26]!],
    attenuates: (bytes[offset + 27]! & 1) !== 0,
  };
  return validWmoLight(light) ? light : inertWmoLight();
}

export function decodeWwm(data: ArrayBuffer, baseUrl: string): WmoModel {
  if (data.byteLength < HEADER_SIZE) throw new Error("WMO model is truncated");
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== MAGIC_WWM1 && magic !== MAGIC_WWM2) throw new Error("WMO model has an invalid header");
  const groupCount = view.getUint32(4, true);
  const textureCount = view.getUint16(8, true);
  const ambient: [number, number, number] = [bytes[10]!, bytes[11]!, bytes[12]!];
  const complete = (bytes[13]! & COMPLETE) !== 0;
  const vertexLight: WmoVertexLightPath = (bytes[13]! & CLASSIC_VERTEX_LIGHT) !== 0 ? "classic" : "unified";
  const vertexAlphaFixed = (bytes[13]! & VERTEX_ALPHA_UNFIXED) === 0;
  const lightCount = view.getUint16(14, true);
  const length = view.getUint32(16, true);
  if (groupCount === 0 || groupCount > 65_535 || textureCount > 65_535) throw new Error("WMO model has invalid counts");
  if (length !== data.byteLength) throw new Error("WMO model length does not match the response");
  if (HEADER_SIZE + groupCount * GROUP_SIZE > data.byteLength) throw new Error("WMO model group table is truncated");

  const groups: WmoGroup[] = [];
  let offset = HEADER_SIZE;
  const blockLengths: number[] = [];
  for (let index = 0; index < groupCount; index++, offset += GROUP_SIZE) {
    const flags = view.getUint32(offset + 24, true);
    const bounds = {
      minX: view.getFloat32(offset, true),
      minY: view.getFloat32(offset + 4, true),
      minZ: view.getFloat32(offset + 8, true),
      maxX: view.getFloat32(offset + 12, true),
      maxY: view.getFloat32(offset + 16, true),
      maxZ: view.getFloat32(offset + 20, true),
    };
    groups.push({
      bounds,
      ...(validWmoBounds(bounds) ? {} : { boundsValid: false }),
      flags,
      indoor: (flags & WMO_GROUP_INDOOR) !== 0,
      // Old WWM1 artifacts have no metadata section. Keep their original range behavior: the
      // renderer treats only non-indoor groups as exterior until a new section says otherwise.
      exterior: false,
      portalStart: 0,
      portalCount: 0,
      fogIds: [],
      vertexCount: view.getUint32(offset + 28, true),
      triangleCount: view.getUint32(offset + 32, true),
    });
    blockLengths.push(view.getUint32(offset + 36, true));
  }

  const decoder = new TextDecoder();
  const textureUrls: string[] = [];
  for (let index = 0; index < textureCount; index++) {
    if (offset + 2 > data.byteLength) throw new Error("WMO model texture table is truncated");
    const size = view.getUint16(offset, true);
    offset += 2;
    if (size > 1000 || offset + size > data.byteLength) throw new Error("WMO model texture URL is invalid");
    const url = decoder.decode(bytes.subarray(offset, offset + size));
    // WMO PNGs are rewritten beside their model whenever the active MPQ source stamp changes.
    // They keep the same content-address-shaped route, however, so the browser also needs the
    // visual artifact generation carried by the model request. A generic URL in an older/test
    // artifact stays untouched; only the gateway-owned WMO texture route is coordinated.
    const versioned = url.startsWith("/visual/texture/")
      ? `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(VISUAL_MODEL_ROUTE_VERSION)}`
      : url;
    textureUrls.push(versioned ? `${baseUrl}${versioned}` : "");
    offset += size;
  }
  // The texture table is padded so that everything after it starts on a four-byte boundary.
  offset = (offset + 3) & ~3;

  const lights: WmoLight[] = [];
  if (offset + lightCount * LIGHT_SIZE > data.byteLength) throw new Error("WMO model light table is truncated");
  for (let index = 0; index < lightCount; index++, offset += LIGHT_SIZE) {
    // Keep the table ordinal stable: MOLR references are source indices, so a malformed optional
    // lamp becomes inert rather than shifting every later lamp onto the wrong wall.
    lights.push(decodeWmoLight(view, bytes, offset));
  }

  for (const [index, size] of blockLengths.entries()) {
    if (size === 0) continue;
    if (offset + size > data.byteLength) throw new Error("WMO model group block is truncated");
    const block = decodeWwmGroup(data.slice(offset, offset + size));
    if (block.index !== index) throw new Error("WMO model group block is out of order");
    if (magic === MAGIC_WWM1 && block.mesh.normals !== undefined) {
      throw new Error("WWM1 group block carries authored normals");
    }
    const group = groups[index]!;
    if (block.mesh.positions.length / 3 !== group.vertexCount
      || block.mesh.indices.length / 3 !== group.triangleCount) {
      throw new Error("WMO model group block counts disagree with its root table");
    }
    group.mesh = block.mesh;
    offset += size;
  }
  const metadataOffset = view.getUint32(20, true);
  const { portals, fogs, doodadRooms, materials, skybox } = decodeMetadata(bytes, view, metadataOffset, offset, groups);
  const model: WmoModel = {
    ambient, textureUrls, lights, groups, fogs, complete, vertexLight, vertexAlphaFixed,
    doodadRooms: doodadRooms ?? [],
  };
  if (portals) model.portals = portals;
  if (materials) model.materials = materials; // 05.10-A7b-3
  if (materials) model.materialTextureUrls = materials.map((material) => (material.texture2 ? textureUrl(baseUrl, material.texture2) : "")); // 05.10-A7b-2
  if (skybox !== undefined) model.skybox = skybox; // 05.10-A7b-3
  return model;
}

/**
 * The fog a camera standing at one model-space point is in, or undefined for the sky outside.
 *
 * The group is asked first because the group is what the file answers with: MOGP names up to four
 * MFOG records and nothing else in the model says which room is in which fog. Among those, an
 * unbounded record wins outright — that is what its flag means — and otherwise the tightest one
 * whose outer radius reaches the point does — which is what Stormwind's `magic05`, `ThroneRoom05`
 * and `TreeFacades02` need, each naming records 1 and 2, two 51.19-yard spheres 32.91 yards apart.
 */
function selectWmoFogAt(
  model: Pick<WmoModel, "fogs">,
  group: Pick<WmoGroup, "fogIds"> | undefined,
  x: number,
  y: number,
  z: number,
  accepts: (fog: WmoFog) => boolean,
): WmoFog | undefined {
  if (!group || model.fogs.length === 0) return undefined;
  let chosen: WmoFog | undefined;
  for (const id of group.fogIds) {
    const fog = model.fogs[id];
    if (!fog || !accepts(fog)) continue;
    if ((fog.flags & WMO_FOG_UNBOUNDED) !== 0) return fog;
    const distance = Math.hypot(fog.position[0] - x, fog.position[1] - y, fog.position[2] - z);
    if (distance > fog.outerRadius) continue;
    if (!chosen || fog.outerRadius < chosen.outerRadius) chosen = fog;
  }
  return chosen;
}

export function wmoFogAt(model: Pick<WmoModel, "fogs">, group: Pick<WmoGroup, "fogIds"> | undefined,
  x: number, y: number, z: number): WmoFog | undefined {
  return selectWmoFogAt(model, group, x, y, z, () => true);
}

/** Whether the land half carries a real, renderable override rather than MFOG's white sentinel. */
export function wmoLandFogActive(fog: WmoFog): boolean {
  const { end, scale, colour } = fog.land;
  return colour.some((channel) => channel !== 255)
    && end > 0
    && scale >= 0
    && scale < 1
    && Number.isFinite(end)
    && Number.isFinite(scale)
    && colour.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255);
}

/** The active land fog at one point. The largely unauthored water half is deliberately ignored. */
export function wmoLandFogAt(
  model: Pick<WmoModel, "fogs">,
  group: Pick<WmoGroup, "fogIds"> | undefined,
  x: number,
  y: number,
  z: number,
): WmoFog | undefined {
  return selectWmoFogAt(model, group, x, y, z, wmoLandFogActive);
}

/**
 * Optional metadata must never make otherwise valid geometry unusable. A stale WME1 artifact or
 * a damaged/newer section therefore leaves the decoder's conservative distance-only defaults in
 * place. WME1's exterior bytes remain useful when the appended portal graph alone is damaged, but
 * portal ranges are committed only after the entire graph has passed structural validation.
 */
function decodeMetadata(
  bytes: Uint8Array,
  view: DataView,
  metadataOffset: number,
  bodyEnd: number,
  groups: WmoGroup[],
): { portals?: WmoPortals; fogs: WmoFog[]; doodadRooms?: WmoDoodadRooms[]; materials?: WmoMaterial[]; skybox?: string } {
  if (metadataOffset === 0 || metadataOffset < bodyEnd || metadataOffset + 8 > bytes.byteLength) return { fogs: [] };
  const decoder = new TextDecoder();
  const magic = decoder.decode(bytes.subarray(metadataOffset, metadataOffset + 4));
  const groupCount = view.getUint32(metadataOffset + 4, true);
  if (groupCount !== groups.length) return { fogs: [] };
  if (magic === LEGACY_METADATA_MAGIC) {
    if (metadataOffset + LEGACY_METADATA_HEADER_SIZE + groupCount > bytes.byteLength) return { fogs: [] };
    for (let index = 0; index < groupCount; index++) {
      groups[index]!.exterior = bytes[metadataOffset + LEGACY_METADATA_HEADER_SIZE + index] !== 0;
    }
    const extensionOffset = Math.ceil(
      (metadataOffset + LEGACY_METADATA_HEADER_SIZE + groupCount) / 4,
    ) * 4;
    return {
      ...withPortals(decodePortalExtension(bytes, view, extensionOffset, groups, false)),
      fogs: decodeFogExtension(bytes, view, extensionOffset, groups),
      doodadRooms: decodeDoodadRooms(bytes, view, extensionOffset, groups.length),
      ...decodeWmoMaterialSection(bytes, view, extensionOffset), // 05.10-A7b-3
    };
  }
  // Accept the short-lived direct-WME2 artifact too. Published artifacts put WME1 first so an old
  // reader sees the envelope it knows, but accepting this costs nothing and avoids a brittle cache.
  return magic === METADATA_MAGIC
    ? {
      ...withPortals(decodePortalExtension(bytes, view, metadataOffset, groups, true)),
      fogs: decodeFogExtension(bytes, view, metadataOffset, groups),
      doodadRooms: decodeDoodadRooms(bytes, view, metadataOffset, groups.length),
      ...decodeWmoMaterialSection(bytes, view, metadataOffset), // 05.10-A7b-3
    }
    : { fogs: [] };
}

/**
 * WME4, found through WME3's own length word the way WME3 is found through WME2's.
 *
 * Optional like the rest of the metadata: anything inconsistent answers no rooms, and the
 * building's doodads then keep the plain distance leash they always had.
 */
function decodeDoodadRooms(
  bytes: Uint8Array,
  view: DataView,
  extensionOffset: number,
  groupCount: number,
): WmoDoodadRooms[] {
  const text = new TextDecoder();
  if (extensionOffset + METADATA_HEADER_SIZE > bytes.byteLength
    || text.decode(bytes.subarray(extensionOffset, extensionOffset + 4)) !== METADATA_MAGIC) return [];
  const fogOffset = extensionOffset + view.getUint32(extensionOffset + 20, true);
  if (fogOffset <= extensionOffset || fogOffset + FOG_HEADER_SIZE > bytes.byteLength
    || text.decode(bytes.subarray(fogOffset, fogOffset + 4)) !== FOG_MAGIC) return [];
  const offset = fogOffset + view.getUint32(fogOffset + 12, true);
  if (offset <= fogOffset || offset + ROOMS_HEADER_SIZE > bytes.byteLength
    || text.decode(bytes.subarray(offset, offset + 4)) !== ROOMS_MAGIC) return [];
  const setCount = view.getUint32(offset + 4, true);
  const end = offset + view.getUint32(offset + 8, true);
  if (setCount > 65_535 || end > bytes.byteLength
    || offset + ROOMS_HEADER_SIZE + setCount * ROOMS_SET_SIZE > end) return [];
  let at = offset + ROOMS_HEADER_SIZE + setCount * ROOMS_SET_SIZE;
  const rooms: WmoDoodadRooms[] = [];
  for (let set = 0; set < setCount; set++) {
    const counts = offset + ROOMS_HEADER_SIZE + set * ROOMS_SET_SIZE;
    const doodads = view.getUint32(counts, true);
    const owners = view.getUint32(counts + 4, true);
    if (doodads > 100_000 || owners > 6_553_500
      || at + (doodads + 1) * 4 + ((owners * 2 + 3) & ~3) > end) return [];
    const offsets = new Uint32Array(doodads + 1);
    for (let index = 0; index <= doodads; index++) offsets[index] = view.getUint32(at + index * 4, true);
    at += (doodads + 1) * 4;
    const groups = new Uint16Array(owners);
    for (let index = 0; index < owners; index++) groups[index] = view.getUint16(at + index * 2, true);
    at += (owners * 2 + 3) & ~3;
    if (offsets[0] !== 0 || offsets[doodads] !== owners) return [];
    for (let index = 1; index <= doodads; index++) if (offsets[index]! < offsets[index - 1]!) return [];
    for (const group of groups) if (group >= groupCount) return [];
    rooms.push({ offsets, groups });
  }
  return at === end ? rooms : [];
}

function withPortals(portals: WmoPortals | undefined): { portals?: WmoPortals } {
  return portals ? { portals } : {};
}

/**
 * WME3, which stands after WME2 and is found through it rather than beside it.
 *
 * The offset is computed from the portal section's own length word, not from whether that section
 * parsed: a model whose portal graph is empty or damaged still has fog, and tying the two together
 * would have made the commonest case the one that loses it — 1,570 of the 1,985 roots under
 * `World\wmo\` carry exactly one fog record and no portal at all (1,709 carry exactly one record
 * whatever their graph holds).
 */
function decodeFogExtension(
  bytes: Uint8Array,
  view: DataView,
  extensionOffset: number,
  groups: WmoGroup[],
): WmoFog[] {
  if (extensionOffset + METADATA_HEADER_SIZE > bytes.byteLength
    || new TextDecoder().decode(bytes.subarray(extensionOffset, extensionOffset + 4)) !== METADATA_MAGIC) return [];
  const offset = extensionOffset + view.getUint32(extensionOffset + 20, true);
  if (offset <= extensionOffset || offset + FOG_HEADER_SIZE > bytes.byteLength
    || new TextDecoder().decode(bytes.subarray(offset, offset + 4)) !== FOG_MAGIC) return [];
  const groupCount = view.getUint32(offset + 4, true);
  const fogCount = view.getUint32(offset + 8, true);
  const length = view.getUint32(offset + 12, true);
  const expected = FOG_HEADER_SIZE + groupCount * FOG_GROUP_SIZE + fogCount * FOG_SIZE;
  if (groupCount !== groups.length || fogCount > 255 || length !== expected
    || offset + length > bytes.byteLength) return [];

  const fogTable = offset + FOG_HEADER_SIZE + groupCount * FOG_GROUP_SIZE;
  const fogs: WmoFog[] = [];
  for (let index = 0; index < fogCount; index++) {
    const at = fogTable + index * FOG_SIZE;
    const half = (base: number): WmoFogHalf => ({
      end: view.getFloat32(base, true),
      scale: view.getFloat32(base + 4, true),
      colour: [bytes[base + 8]!, bytes[base + 9]!, bytes[base + 10]!],
    });
    const land = half(at + 24);
    const water = half(at + 36);
    // A non-finite distance would reach `THREE.Fog` and blank the frame, so the whole optional
    // section is dropped rather than a single record being repaired into something plausible.
    if (![land.end, land.scale, water.end, water.scale].every(Number.isFinite)) return [];
    fogs.push({
      flags: view.getUint32(at, true),
      position: [view.getFloat32(at + 4, true), view.getFloat32(at + 8, true), view.getFloat32(at + 12, true)],
      innerRadius: view.getFloat32(at + 16, true),
      outerRadius: view.getFloat32(at + 20, true),
      land,
      water,
    });
  }
  for (const [index, group] of groups.entries()) {
    const at = offset + FOG_HEADER_SIZE + index * FOG_GROUP_SIZE;
    // Deduplicated, slots naming no record of this model dropped, and — past slot 0 — a zero byte
    // read as an empty slot rather than as a reference to record 0. The file spells both the same
    // way, and which one it means is a fact about these files: across all 9,346 group files under
    // `World\wmo\` the non-zero indices are packed strictly left to right (1,230 groups fill one
    // slot, 265 two, 62 three, 39 all four) and not one has a non-zero index standing after a
    // zero, so a zero behind a filled slot is padding every time. Slot 0 is therefore taken as it
    // stands — a group that means record 0 names it there — and the rest only when non-zero.
    //
    // Reading that padding as a reference handed 34 groups in 4 buildings a record their own file
    // does not name: 29 of Ironforge's 104 groups got record 0's 305.56-yard sphere where the file
    // asks for nothing, and `stratholme_raid` groups 62 and 63 got record 0's 333.33 yards over
    // the 194.44 they name in slot 0. Order among the distinct ones is the file's, which is what
    // {@link wmoFogAt} reads first.
    group.fogIds = [...new Set([0, 1, 2, 3]
      .map((slot) => bytes[at + slot]!)
      .filter((id, slot) => (slot === 0 || id !== 0) && id < fogCount))];
  }
  return fogs;
}

/** Decode the optional aligned WME2 extension after its WME1 compatibility envelope. */
function decodePortalExtension(
  bytes: Uint8Array,
  view: DataView,
  metadataOffset: number,
  groups: WmoGroup[],
  readExterior: boolean,
): WmoPortals | undefined {
  if (metadataOffset + METADATA_HEADER_SIZE > bytes.byteLength
    || new TextDecoder().decode(bytes.subarray(metadataOffset, metadataOffset + 4)) !== METADATA_MAGIC) return undefined;
  const groupCount = view.getUint32(metadataOffset + 4, true);
  if (groupCount !== groups.length) return undefined;

  const vertexCount = view.getUint32(metadataOffset + 8, true);
  const definitionCount = view.getUint32(metadataOffset + 12, true);
  const referenceCount = view.getUint32(metadataOffset + 16, true);
  const metadataLength = view.getUint32(metadataOffset + 20, true);
  const rawLength = METADATA_HEADER_SIZE
    + groupCount * METADATA_GROUP_SIZE
    + vertexCount * 3 * 4
    + definitionCount * METADATA_DEFINITION_SIZE
    + referenceCount * METADATA_REFERENCE_SIZE;
  const expectedLength = Math.ceil(rawLength / 4) * 4;
  if (!Number.isSafeInteger(rawLength) || vertexCount > 65_535 || definitionCount > 65_535
    || metadataLength !== expectedLength || metadataOffset + metadataLength > bytes.byteLength) return undefined;

  let at = metadataOffset + METADATA_HEADER_SIZE;
  const ranges: { start: number; count: number }[] = [];
  for (let index = 0; index < groupCount; index++, at += METADATA_GROUP_SIZE) {
    if (readExterior) groups[index]!.exterior = bytes[at] !== 0;
    ranges.push({ start: view.getUint32(at + 4, true), count: view.getUint16(at + 2, true) });
  }
  const vertices = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertices.length; index++, at += 4) {
    const value = view.getFloat32(at, true);
    if (!Number.isFinite(value)) return undefined;
    vertices[index] = value;
  }
  const definitions: WmoPortalDefinition[] = [];
  for (let index = 0; index < definitionCount; index++, at += METADATA_DEFINITION_SIZE) {
    const startVertex = view.getUint16(at, true);
    const count = view.getUint16(at + 2, true);
    if (count < 3 || startVertex + count > vertexCount) return undefined;
    definitions.push({ startVertex, vertexCount: count });
  }
  const references: WmoPortalReference[] = [];
  for (let index = 0; index < referenceCount; index++, at += METADATA_REFERENCE_SIZE) {
    const portal = view.getUint16(at, true);
    const group = view.getUint16(at + 2, true);
    if (portal >= definitionCount || group >= groupCount) return undefined;
    references.push({ portal, group, side: view.getInt16(at + 4, true) });
  }
  // Every MOPR record belongs to exactly one source group's contiguous slice. Missing or
  // overlapping ownership would turn a malformed graph into a false occluder, so reject it.
  const owners = new Uint8Array(referenceCount);
  for (const range of ranges) {
    if (range.start + range.count > referenceCount) return undefined;
    for (let index = range.start; index < range.start + range.count; index++) {
      if (owners[index] !== 0) return undefined;
      owners[index] = 1;
    }
  }
  if (owners.some((owner) => owner === 0)) return undefined;
  if (definitionCount === 0 || referenceCount === 0) return undefined;
  for (const [index, range] of ranges.entries()) {
    groups[index]!.portalStart = range.start;
    groups[index]!.portalCount = range.count;
  }
  return { vertices, definitions, references };
}

/**
 * The light on one group's vertices: what the artist baked, the model's ambient, and its lamps.
 *
 * Three things are added rather than one chosen, and each is there because the measurements say
 * the others cannot stand in for it. The baked colours alone leave Stormwind's rooms at a median
 * of 15 out of 255. The ambient alone is 33 there and 19 in the Goldshire Inn, which is a floor and
 * not a light. The lamps alone would leave the inn — whose interiors are painted at a median of
 * 104 — lit only within a few yards of its candles. A room is the sum of the three.
 *
 * The reference client's answer is `max(colour, max(ambient, 0.35))`, a floor its own comment calls
 * a black-crush workaround; nothing here needs one, because the lamps are what the darkness in the
 * file is waiting for.
 *
 * The result is linear: three multiplies it against a texel it has already brought into linear
 * space, and encodes the product back to sRGB on the way out. So converting here is what makes the
 * product come out as the artist's colour times the artist's texture, the way an uncorrected
 * client multiplies them.
 *
 * That sum is the unified path (MOHD 0x2, `MapObjU.wfx`) — Stormwind and Dalaran, whose MOCV is
 * dark and excludes the ambient. The classic path is 1,823 of the client's 1,985 root WMOs and
 * takes the other branch: see {@link WmoVertexLightPath}.
 */
export function wmoVertexLight(
  mesh: WmoGroupMesh,
  normals: Float32Array,
  ambient: readonly [number, number, number],
  lights: readonly WmoLight[],
  path: WmoVertexLightPath = "unified",
  bakedColours = true,
  alphaFixed = true,
): Float32Array {
  const steps = wmoVertexLightSteps(mesh, normals, ambient, lights, path, bakedColours, alphaFixed);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

/** Maximum vertices, triangles or light references handled by one streaming geometry step. */
export const WMO_GEOMETRY_STEP_VERTICES = 1024;

/** Same lighting and Float32 accumulation order, with bounded work between frame-budget checks. */
export function* wmoVertexLightSteps(
  mesh: WmoGroupMesh,
  normals: Float32Array,
  ambient: readonly [number, number, number],
  lights: readonly WmoLight[],
  path: WmoVertexLightPath = "unified",
  bakedColours = true,
  alphaFixed = true,
): Generator<void, Float32Array, void> {
  const vertexCount = mesh.positions.length / 3;
  const light = new Float32Array(vertexCount * 3);
  if (path === "classic") {
    // The classic tool baked the ambient and the lamps into MOCV; adding either again doubles it.
    // On Gundrak that lifted the darkest tenth of the dungeon from 54 to 108 of 255 and halved its
    // p90/p10 contrast (4.72 to 2.36), which is the flat, unlit look. A group without MOCV keeps
    // the white it always had: the encoder's placeholder is not light and gets no alpha boost.
    const lookup = classicWmoLightLookup(ambient);
    for (let start = 0; start < vertexCount; start += WMO_GEOMETRY_STEP_VERTICES) {
      const end = Math.min(start + WMO_GEOMETRY_STEP_VERTICES, vertexCount);
      for (let vertex = start; vertex < end; vertex++) {
        const alpha = alphaFixed ? mesh.colours[vertex * 4 + 3]! : 0;
        for (let channel = 0; channel < 3; channel++) {
          light[vertex * 3 + channel] = !bakedColours ? 1
            : alpha === 0 ? lookup[channel * 256 + mesh.colours[vertex * 4 + channel]!]!
              : classicWmoLight(mesh.colours[vertex * 4 + channel]!, alpha, ambient[channel]!);
        }
      }
      yield;
    }
    return light;
  }
  const lamps: WmoLight[] = [];
  let references = 0;
  for (const reference of mesh.lightRefs) {
    const lamp = lights[reference];
    // Optional light data is not allowed to turn one malformed MOLT record into NaN vertex light.
    // Keep reference order and duplicates: each valid reference adds one contribution.
    if (lamp && validWmoLight(lamp) && lamp.intensity > 0) lamps.push(lamp);
    if (++references % WMO_GEOMETRY_STEP_VERTICES === 0) yield;
  }
  if (lamps.length === 0) {
    const lookup = bakedWmoLightLookup(ambient);
    for (let start = 0; start < vertexCount; start += WMO_GEOMETRY_STEP_VERTICES) {
      const end = Math.min(start + WMO_GEOMETRY_STEP_VERTICES, vertexCount);
      for (let vertex = start; vertex < end; vertex++) {
        light[vertex * 3] = lookup[mesh.colours[vertex * 4]!]!;
        light[vertex * 3 + 1] = lookup[256 + mesh.colours[vertex * 4 + 1]!]!;
        light[vertex * 3 + 2] = lookup[512 + mesh.colours[vertex * 4 + 2]!]!;
      }
      yield;
    }
    return light;
  }
  for (let start = 0; start < vertexCount; start += WMO_GEOMETRY_STEP_VERTICES) {
    const end = Math.min(start + WMO_GEOMETRY_STEP_VERTICES, vertexCount);
    for (let vertex = start; vertex < end; vertex++) {
      for (let channel = 0; channel < 3; channel++) {
        light[vertex * 3 + channel] = mesh.colours[vertex * 4 + channel]! + ambient[channel]!;
      }
    }
    yield;
  }
  for (const lamp of lamps) {
    for (let start = 0; start < vertexCount; start += WMO_GEOMETRY_STEP_VERTICES) {
      applyWmoLamp(light, mesh, normals, lamp, start, Math.min(start + WMO_GEOMETRY_STEP_VERTICES, vertexCount));
      // Even a lamp that misses every vertex must yield, as must many lamps in one small room.
      yield;
    }
  }
  const chunk = WMO_GEOMETRY_STEP_VERTICES * 3;
  for (let start = 0; start < light.length; start += chunk) {
    const end = Math.min(start + chunk, light.length);
    for (let index = start; index < end; index++) light[index] = srgbToLinear(Math.min(1, light[index]! / 255));
    yield;
  }
  return light;
}

/** A plain bounded kernel keeps the hot vertex/lamp loop out of the generator's resume state. */
function applyWmoLamp(
  light: Float32Array, mesh: WmoGroupMesh, normals: Float32Array,
  lamp: WmoLight, start: number, end: number,
): void {
  const reach = lamp.attenuates ? Math.max(lamp.attenuationEnd, lamp.attenuationStart) : Infinity;
  const span = lamp.attenuationEnd - lamp.attenuationStart;
  for (let vertex = start; vertex < end; vertex++) {
    const dx = lamp.position[0] - mesh.positions[vertex * 3]!;
    const dy = lamp.position[1] - mesh.positions[vertex * 3 + 1]!;
    const dz = lamp.position[2] - mesh.positions[vertex * 3 + 2]!;
    // Most city vertex/lamp pairs miss even the lamp's cube. Keep hypot for the remaining pairs
    // so falloff, reach boundaries and Float32 accumulation remain exactly the authored formula.
    if (Math.abs(dx) >= reach || Math.abs(dy) >= reach || Math.abs(dz) >= reach) continue;
    const distance = Math.hypot(dx, dy, dz);
    if (distance >= reach) continue;
    const attenuation = !lamp.attenuates || distance <= lamp.attenuationStart ? 1
      : span > 0 ? (lamp.attenuationEnd - distance) / span : 0;
    // Wrapped diffuse lights the rear wall too; clamping would add a seam to baked room lighting.
    const scale = distance > 0 ? 1 / distance : 0;
    const facing = (normals[vertex * 3]! * dx + normals[vertex * 3 + 1]! * dy + normals[vertex * 3 + 2]! * dz) * scale;
    const diffuse = 0.22 + 0.78 * Math.max(facing, 0);
    const strength = lamp.intensity * attenuation * diffuse;
    for (let channel = 0; channel < 3; channel++) light[vertex * 3 + channel]! += lamp.colour[channel]! * strength;
  }
}

interface BakedWmoLightLookup {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly values: Float32Array;
}

/** One small transfer table per live WMO ambient, shared by its unlit groups. */
const bakedWmoLightLookups = new WeakMap<readonly [number, number, number], BakedWmoLightLookup>();

function bakedWmoLightLookup(ambient: readonly [number, number, number]): Float32Array {
  const current = bakedWmoLightLookups.get(ambient);
  if (current?.red === ambient[0] && current.green === ambient[1] && current.blue === ambient[2]) {
    return current.values;
  }
  const values = new Float32Array(256 * 3);
  for (let channel = 0; channel < 3; channel++) {
    for (let colour = 0; colour < 256; colour++) {
      // The original accumulation goes through a Float32Array before the transfer function.
      // Retain that rounding even for direct callers with a fractional ambient value.
      values[channel * 256 + colour] = srgbToLinear(Math.min(1, Math.fround(colour + ambient[channel]!) / 255));
    }
  }
  bakedWmoLightLookups.set(ambient, { red: ambient[0], green: ambient[1], blue: ambient[2], values });
  return values;
}

/**
 * One channel of a classic room's light, linear, from its MOCV byte, alpha and the model ambient.
 *
 * `FixColorVertexAlpha` stores (c·(1 + a/64) − ambient) / 2 clamped to a byte, `MapObjDiffuse_T1`
 * adds the ambient's half back and clamps to one, and `MapObjDiffuse` doubles it (Mod2x). Composed,
 * the multiplier on the texel is c·(1 + a/64) held between the ambient and 510/255: the ambient is
 * a floor rather than an addend, and a large alpha may brighten up to twice the texture.
 */
export function classicWmoLight(colour: number, alpha: number, ambient: number): number {
  const boosted = colour * (1 + alpha / 64);
  return srgbToLinear(Math.min(510, Math.max(ambient, boosted)) / 255);
}

/** Alpha-zero classic transfer table per live WMO ambient — 94.6% of Gundrak's vertices. */
const classicWmoLightLookups = new WeakMap<readonly [number, number, number], BakedWmoLightLookup>();

function classicWmoLightLookup(ambient: readonly [number, number, number]): Float32Array {
  const current = classicWmoLightLookups.get(ambient);
  if (current?.red === ambient[0] && current.green === ambient[1] && current.blue === ambient[2]) {
    return current.values;
  }
  const values = new Float32Array(256 * 3);
  for (let channel = 0; channel < 3; channel++) {
    for (let colour = 0; colour < 256; colour++) values[channel * 256 + colour] = classicWmoLight(colour, 0, ambient[channel]!);
  }
  classicWmoLightLookups.set(ambient, { red: ambient[0], green: ambient[1], blue: ambient[2], values });
  return values;
}

/** The sRGB transfer function, which is what a byte of authored colour is expressed in. */
function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** A group's floor-facing triangles bucketed on a coarse XY grid, built once per decoded mesh. */
interface WmoFloorGrid {
  minX: number;
  minY: number;
  cell: number;
  columns: number;
  rows: number;
  /** Triangles of cell c are `triangles[starts[c]]` up to `triangles[starts[c + 1]]`. */
  starts: Uint32Array;
  triangles: Uint32Array;
}

const WMO_FLOOR_GRIDS = new WeakMap<WmoGroupMesh, WmoFloorGrid | null>();
/** A face whose normal is at least this far from horizontal is something to stand on, or a ceiling. */
const WMO_FLOOR_NORMAL_Z = 0.5;

function wmoFloorGrid(mesh: WmoGroupMesh): WmoFloorGrid | null {
  const known = WMO_FLOOR_GRIDS.get(mesh);
  if (known !== undefined) return known;
  const positions = mesh.positions;
  const indices = mesh.indices;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let at = 0; at < positions.length; at += 3) {
    minX = Math.min(minX, positions[at]!);
    maxX = Math.max(maxX, positions[at]!);
    minY = Math.min(minY, positions[at + 1]!);
    maxY = Math.max(maxY, positions[at + 1]!);
  }
  if (!(maxX >= minX) || !(maxY >= minY)) {
    WMO_FLOOR_GRIDS.set(mesh, null);
    return null;
  }
  // Four-yard cells, coarser only past 256 a side; a room's floor triangle spans a few cells.
  const cell = Math.max(4, Math.max(maxX - minX, maxY - minY) / 256);
  const columns = Math.floor((maxX - minX) / cell) + 1;
  const rows = Math.floor((maxY - minY) / cell) + 1;
  const floors: number[] = [];
  const counts = new Uint32Array(columns * rows + 1);
  const cellsOf = (triangle: number, visit: (cellIndex: number) => void): void => {
    let lowX = Infinity, lowY = Infinity, highX = -Infinity, highY = -Infinity;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[triangle * 3 + corner]! * 3;
      lowX = Math.min(lowX, positions[vertex]!);
      highX = Math.max(highX, positions[vertex]!);
      lowY = Math.min(lowY, positions[vertex + 1]!);
      highY = Math.max(highY, positions[vertex + 1]!);
    }
    const firstColumn = Math.floor((lowX - minX) / cell);
    const lastColumn = Math.floor((highX - minX) / cell);
    const firstRow = Math.floor((lowY - minY) / cell);
    const lastRow = Math.floor((highY - minY) / cell);
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) visit(row * columns + column);
    }
  };
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const a = indices[triangle * 3]! * 3;
    const b = indices[triangle * 3 + 1]! * 3;
    const c = indices[triangle * 3 + 2]! * 3;
    const abx = positions[b]! - positions[a]!, aby = positions[b + 1]! - positions[a + 1]!, abz = positions[b + 2]! - positions[a + 2]!;
    const acx = positions[c]! - positions[a]!, acy = positions[c + 1]! - positions[a + 1]!, acz = positions[c + 2]! - positions[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 0) || Math.abs(nz) < WMO_FLOOR_NORMAL_Z * length) continue;
    floors.push(triangle);
    cellsOf(triangle, (cellIndex) => { counts[cellIndex + 1]!++; });
  }
  for (let cellIndex = 1; cellIndex < counts.length; cellIndex++) counts[cellIndex]! += counts[cellIndex - 1]!;
  const triangles = new Uint32Array(counts[counts.length - 1]!);
  const cursor = counts.slice(0, columns * rows);
  for (const triangle of floors) cellsOf(triangle, (cellIndex) => { triangles[cursor[cellIndex]!++] = triangle; });
  const grid: WmoFloorGrid = { minX, minY, cell, columns, rows, starts: counts, triangles };
  WMO_FLOOR_GRIDS.set(mesh, grid);
  return grid;
}

/** One vertex's room light in display space, 0..1 per channel: the geometry's formula, no lamps. */
function wmoDisplayLight(
  model: Pick<WmoModel, "ambient" | "vertexLight" | "vertexAlphaFixed">,
  mesh: WmoGroupMesh,
  bakedColours: boolean,
  vertex: number,
  channel: number,
): number {
  if (!bakedColours) return 1;
  const colour = mesh.colours[vertex * 4 + channel]!;
  const ambient = model.ambient[channel]!;
  if (model.vertexLight !== "classic") return Math.min(1, (colour + ambient) / 255);
  const alpha = model.vertexAlphaFixed === false ? 0 : mesh.colours[vertex * 4 + 3]!;
  return Math.min(1, Math.max(ambient, colour * (1 + alpha / 64)) / 255);
}

/**
 * The baked light of the room floor under a model-space point, display space 0..1 per channel.
 *
 * The same light the room's own vertices are drawn with, interpolated over the highest floor face
 * within `depth` yards below the point in any room holding it. Undefined when no decoded room has
 * one — the caller keeps whatever light it had. The grid query touches only the triangles of one
 * cell, so asking every frame costs a few dozen barycentric tests.
 */
export function wmoFloorLight(
  model: Pick<WmoModel, "groups" | "ambient" | "vertexLight" | "vertexAlphaFixed">,
  x: number,
  y: number,
  z: number,
  depth = 8,
): [number, number, number] | undefined {
  if (![x, y, z].every(Number.isFinite)) return undefined;
  let bestZ = -Infinity;
  let best: [number, number, number] | undefined;
  for (const group of model.groups) {
    const mesh = group.mesh;
    if (!mesh || !group.indoor || group.exterior || group.boundsValid === false) continue;
    const b = group.bounds;
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ - 0.5 || z - depth > b.maxZ) continue;
    const grid = wmoFloorGrid(mesh);
    if (!grid) continue;
    const column = Math.floor((x - grid.minX) / grid.cell);
    const row = Math.floor((y - grid.minY) / grid.cell);
    if (column < 0 || row < 0 || column >= grid.columns || row >= grid.rows) continue;
    const cellIndex = row * grid.columns + column;
    const baked = (group.flags & WMO_GROUP_HAS_COLOURS) !== 0;
    for (let at = grid.starts[cellIndex]!; at < grid.starts[cellIndex + 1]!; at++) {
      const triangle = grid.triangles[at]!;
      const a = mesh.indices[triangle * 3]!, b2 = mesh.indices[triangle * 3 + 1]!, c = mesh.indices[triangle * 3 + 2]!;
      const ax = mesh.positions[a * 3]!, ay = mesh.positions[a * 3 + 1]!, az = mesh.positions[a * 3 + 2]!;
      const bx = mesh.positions[b2 * 3]!, by = mesh.positions[b2 * 3 + 1]!, bz = mesh.positions[b2 * 3 + 2]!;
      const cx = mesh.positions[c * 3]!, cy = mesh.positions[c * 3 + 1]!, cz = mesh.positions[c * 3 + 2]!;
      const determinant = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(determinant) < 1e-9) continue;
      const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / determinant;
      const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / determinant;
      const w = 1 - u - v;
      if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
      const height = u * az + v * bz + w * cz;
      if (height > z + 0.5 || height < z - depth || height <= bestZ) continue;
      bestZ = height;
      best = [0, 1, 2].map((channel) => Math.min(1, Math.max(0,
        u * wmoDisplayLight(model, mesh, baked, a, channel)
        + v * wmoDisplayLight(model, mesh, baked, b2, channel)
        + w * wmoDisplayLight(model, mesh, baked, c, channel)))) as [number, number, number];
    }
  }
  return best;
}

/**
 * One group's block, whether it arrived inside the model or on its own.
 *
 * It states which group it is, so a stale cache cannot pass one room off as another — the same
 * check the group table's order gets when the block travels with the header.
 */
export function decodeWwmGroup(data: ArrayBuffer): { index: number; mesh: WmoGroupMesh } {
  if (data.byteLength < BLOCK_HEADER_SIZE) throw new Error("WMO group is truncated");
  const view = new DataView(data);
  const vertexCount = view.getUint32(0, true);
  const indexCount = view.getUint32(4, true);
  const runCount = view.getUint16(8, true);
  const indexBytes = view.getUint8(10);
  const streamFlags = view.getUint8(11);
  const index = view.getUint16(12, true);
  const lightRefCount = view.getUint16(14, true);
  if (vertexCount === 0 || vertexCount > 1_000_000 || indexCount % 3 !== 0 || indexCount > 6_000_000
    || (indexBytes !== 2 && indexBytes !== 4) || (streamFlags & ~AUTHORED_NORMALS) !== 0) {
    throw new Error("WMO group has invalid counts or stream flags");
  }
  const hasNormals = (streamFlags & AUTHORED_NORMALS) !== 0;
  const vertexStride = 24 + (hasNormals ? 12 : 0);
  const indexOffset = BLOCK_HEADER_SIZE + vertexCount * vertexStride;
  const runOffset = indexOffset + ((indexCount * indexBytes + 3) & ~3);
  const lightOffset = runOffset + runCount * RUN_SIZE;
  const expectedLength = lightOffset + ((lightRefCount * 2 + 3) & ~3);
  if (!Number.isSafeInteger(expectedLength) || expectedLength !== data.byteLength) throw new Error("WMO group length is invalid or truncated");

  const positions = new Float32Array(data.slice(BLOCK_HEADER_SIZE, BLOCK_HEADER_SIZE + vertexCount * 12));
  const uvs = new Float32Array(data.slice(BLOCK_HEADER_SIZE + vertexCount * 12, BLOCK_HEADER_SIZE + vertexCount * 20));
  const colours = new Uint8Array(data.slice(BLOCK_HEADER_SIZE + vertexCount * 20, BLOCK_HEADER_SIZE + vertexCount * 24));
  for (const value of positions) if (!Number.isFinite(value)) throw new Error("WMO group position stream is not finite");
  for (const value of uvs) if (!Number.isFinite(value)) throw new Error("WMO group UV stream is not finite");
  const normals = hasNormals
    ? new Float32Array(data.slice(BLOCK_HEADER_SIZE + vertexCount * 24, indexOffset))
    : undefined;
  if (normals) {
    for (const value of normals) if (!Number.isFinite(value)) throw new Error("WMO group normal stream is not finite");
  }
  const indices = indexBytes === 2
    ? new Uint16Array(data.slice(indexOffset, indexOffset + indexCount * 2))
    : new Uint32Array(data.slice(indexOffset, indexOffset + indexCount * 4));
  for (const value of indices) if (value >= vertexCount) throw new Error("WMO group index is out of range");
  const runs: WmoRun[] = [];
  for (let run = 0; run < runCount; run++) {
    const at = runOffset + run * RUN_SIZE;
    const start = view.getUint32(at, true);
    const count = view.getUint32(at + 4, true);
    if (count === 0 || count % 3 !== 0 || start + count > indexCount) throw new Error("WMO group run does not fit its geometry");
    const record = view.getUint16(at + 14, true); // 05.10-A7b-3: MOMT record + 1, 0 before v25
    const entry: WmoRun = {
      start,
      count,
      material: view.getUint16(at + 8, true),
      blendMode: view.getUint8(at + 10),
      materialFlags: view.getUint8(at + 11),
      lighting: view.getUint8(at + 12),
    };
    if (record !== 0) entry.materialIndex = record - 1;
    runs.push(entry);
  }
  const lightRefs = new Uint16Array(data.slice(lightOffset, lightOffset + lightRefCount * 2));
  return { index, mesh: { positions, uvs, colours, indices, runs, lightRefs, ...(normals ? { normals } : {}) } };
}
