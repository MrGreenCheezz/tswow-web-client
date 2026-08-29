/**
 * Reading a WWM1/WWM2 artifact: one WMO as the rooms it is made of.
 *
 * The encoder and the byte layout live in `tools/wwm.mjs`, which is where the format is written
 * down. What matters here is the shape it arrives in: a header that always carries every group's
 * box, flags and size, and geometry only for the groups that came with it. A building under the
 * publisher's triangle budget arrives whole; a city arrives as a compact table of boxes and portal
 * metadata, and the handful of rooms the player is standing in are fetched one at a time afterwards.
 */

import { VISUAL_MODEL_ROUTE_VERSION } from "./Wvm.js";

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

/** Bit 0 of an MFOG record's flags: it has no radius and holds wherever its groups are. */
export const WMO_FOG_UNBOUNDED = 0x01;

/** MOGP bit 13: this group is a room and not a porch or a roof. */
export const WMO_GROUP_INDOOR = 0x2000;

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
  const { portals, fogs } = decodeMetadata(bytes, view, metadataOffset, offset, groups);
  const model: WmoModel = { ambient, textureUrls, lights, groups, fogs, complete };
  if (portals) model.portals = portals;
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
): { portals?: WmoPortals; fogs: WmoFog[] } {
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
    };
  }
  // Accept the short-lived direct-WME2 artifact too. Published artifacts put WME1 first so an old
  // reader sees the envelope it knows, but accepting this costs nothing and avoids a brittle cache.
  return magic === METADATA_MAGIC
    ? {
      ...withPortals(decodePortalExtension(bytes, view, metadataOffset, groups, true)),
      fogs: decodeFogExtension(bytes, view, metadataOffset, groups),
    }
    : { fogs: [] };
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
 */
export function wmoVertexLight(
  mesh: WmoGroupMesh,
  normals: Float32Array,
  ambient: readonly [number, number, number],
  lights: readonly WmoLight[],
): Float32Array {
  const vertexCount = mesh.positions.length / 3;
  const light = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    for (let channel = 0; channel < 3; channel++) {
      light[vertex * 3 + channel] = mesh.colours[vertex * 4 + channel]! + ambient[channel]!;
    }
  }
  for (const reference of mesh.lightRefs) {
    const lamp = lights[reference];
    // Optional light data is not allowed to turn one malformed MOLT record into NaN vertex light.
    // The decoder preserves ordinals with inert placeholders, while this guard protects direct
    // callers that supply a decoded-like object themselves.
    if (!lamp || !validWmoLight(lamp) || lamp.intensity <= 0) continue;
    const reach = lamp.attenuates ? Math.max(lamp.attenuationEnd, lamp.attenuationStart) : Infinity;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const dx = lamp.position[0] - mesh.positions[vertex * 3]!;
      const dy = lamp.position[1] - mesh.positions[vertex * 3 + 1]!;
      const dz = lamp.position[2] - mesh.positions[vertex * 3 + 2]!;
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= reach) continue;
      // The file states where the falloff starts and where it ends, so neither is invented.
      const span = lamp.attenuationEnd - lamp.attenuationStart;
      const attenuation = !lamp.attenuates || distance <= lamp.attenuationStart ? 1
        : span > 0 ? (lamp.attenuationEnd - distance) / span : 0;
      // Wrapped rather than clamped: a lamp in a room lights the wall behind it too, and a hard
      // terminator on baked geometry reads as a seam. The reference client wraps the same way.
      const scale = distance > 0 ? 1 / distance : 0;
      const facing = (normals[vertex * 3]! * dx + normals[vertex * 3 + 1]! * dy + normals[vertex * 3 + 2]! * dz) * scale;
      const diffuse = 0.22 + 0.78 * Math.max(facing, 0);
      const strength = lamp.intensity * attenuation * diffuse;
      for (let channel = 0; channel < 3; channel++) light[vertex * 3 + channel]! += lamp.colour[channel]! * strength;
    }
  }
  for (let index = 0; index < light.length; index++) light[index] = srgbToLinear(Math.min(1, light[index]! / 255));
  return light;
}

/** The sRGB transfer function, which is what a byte of authored colour is expressed in. */
function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
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
    runs.push({
      start,
      count,
      material: view.getUint16(at + 8, true),
      blendMode: view.getUint8(at + 10),
      materialFlags: view.getUint8(at + 11),
      lighting: view.getUint8(at + 12),
    });
  }
  const lightRefs = new Uint16Array(data.slice(lightOffset, lightOffset + lightRefCount * 2));
  return { index, mesh: { positions, uvs, colours, indices, runs, lightRefs, ...(normals ? { normals } : {}) } };
}
