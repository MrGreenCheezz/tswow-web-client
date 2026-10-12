// 12.10 6.25: the doodads a WMO drawn as a game object carries, beside its artifact.
//
// A ship's sails are not in its WMO's groups: Transport_Ship.wmo (the Bravery, the Lady Mehley, the
// Maiden's Fancy) hangs them as TransportShip_Sails.m2 in doodad set 0, Transportship_NE.wmo (the
// Moonspray, Elune's Blessing, the Feathermoon Ferry) as TransportShip_NE_DoodadsMoving.m2, the
// zeppelins their propellers as ZepAnimation.m2 / HordeZepAnimation.m2, the icebreakers their paddle
// wheel. A WMO placed by an ADT gets its doodads from the tile (`generate-visual-tile.mjs`
// `worldDoodad`); a game object's WMO has no tile, and until now nothing at all — every transport
// sailed bare-masted. The list is written for every WMO the generator publishes, as
// `<hash>.doodads.json` beside `<hash>.bin`, and the gateway serves it at `/visual/doodads`.
//
// Doodad set 0 ("Set_$DefaultGlobal") as the tile numbers it (the effective form of
// `parseWmoDoodadSets`): the set every placement draws. Positions and rotations are the MODD record's,
// in the WMO's own model space; the browser carries them into the object's frame.
//
// Room light (`localLight`, the MODD colour) only for a doodad no exterior group names. The sails
// are named by the ship's three indoor groups and by its outdoor deck, with a MODD colour of black
// (0, 0, 0, 255); the zeppelin's propellers likewise. Lit by that colour they are black silhouettes,
// where the original client shows them white in daylight. The vanilla client's doodad setup keeps
// one def per MODD record and never marks a def interior once an exterior group has named it
// (benilla `wmo.rs` `resolve_doodad_bases`, citing 1.12 Wow.exe 0x694e90 / 0x695aa0, with Booty Bay's
// black-coloured entrance arch as its case); the 3.3.5 routine is not located yet. The tile path
// (`wmo-visual.mjs` `wmoLocallyLitDoodads`) still lights any doodad an indoor group names.

import { WMO_GROUP_INDOOR, parseWmoDoodadSets } from "./wmo-visual.mjs";

export const WMO_DOODAD_LIST_VERSION = 1;

const MOGP_HEADER = 68;
const MOGP_FLAGS = 0x08;

function chunks(data) {
  const map = new Map();
  for (let offset = 0; offset + 8 <= data.length;) {
    const tag = data.toString("latin1", offset, offset + 4).split("").reverse().join("");
    const size = data.readUInt32LE(offset + 4);
    if (offset + 8 + size > data.length) break;
    if (!map.has(tag)) map.set(tag, data.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return map;
}

/** The MODD records some group without `WMO_GROUP_INDOOR` names in its MODR. */
export function exteriorNamedDoodads(groups) {
  const named = new Set();
  for (const group of Array.isArray(groups) ? groups : []) {
    try {
      const mogp = chunks(group).get("MOGP");
      if (!mogp || mogp.length < MOGP_HEADER || (mogp.readUInt32LE(MOGP_FLAGS) & WMO_GROUP_INDOOR) !== 0) continue;
      const references = chunks(mogp.subarray(MOGP_HEADER)).get("MODR");
      if (!references) continue;
      for (let at = 0; at + 2 <= references.length; at += 2) named.add(references.readUInt16LE(at));
    } catch {
      // A malformed group names nothing; its doodads keep whatever light the others give them.
    }
  }
  return named;
}

/** The JSON body of `<hash>.doodads.json` for a WMO root and its group files. */
export function encodeWmoDoodadList(root, groups) {
  let set = [];
  try {
    set = parseWmoDoodadSets(root, groups, { effective: true })[0] ?? [];
  } catch {
    set = [];
  }
  const exterior = exteriorNamedDoodads(groups);
  const doodads = set.map((doodad) => ({
    name: doodad.name,
    position: [doodad.x, doodad.y, doodad.z],
    rotation: [doodad.quaternionX, doodad.quaternionY, doodad.quaternionZ, doodad.quaternionW],
    scale: doodad.scale,
    ...(doodad.localLight && !exterior.has(doodad.index) ? { localLight: doodad.localLight } : {}),
  }));
  return Buffer.from(JSON.stringify({ version: WMO_DOODAD_LIST_VERSION, doodads }));
}
