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
// Room light (`localLight`, the MODD colour) only for a doodad no exterior group names, the rule
// `visual-tile-v7` applies to placed WMOs too (`wmo-visual.mjs` `wmoExteriorNamedDoodads`): the
// sails and the propellers carry a black MODD colour and are named by the outdoor deck as well.

import { parseWmoDoodadSets } from "./wmo-visual.mjs";

export const WMO_DOODAD_LIST_VERSION = 1;

/** The JSON body of `<hash>.doodads.json` for a WMO root and its group files. */
export function encodeWmoDoodadList(root, groups) {
  let set = [];
  try {
    set = parseWmoDoodadSets(root, groups, { effective: true, exteriorWins: true })[0] ?? [];
  } catch {
    set = [];
  }
  const doodads = set.map((doodad) => ({
    name: doodad.name,
    position: [doodad.x, doodad.y, doodad.z],
    rotation: [doodad.quaternionX, doodad.quaternionY, doodad.quaternionZ, doodad.quaternionW],
    scale: doodad.scale,
    ...(doodad.localLight ? { localLight: doodad.localLight } : {}),
  }));
  return Buffer.from(JSON.stringify({ version: WMO_DOODAD_LIST_VERSION, doodads }));
}
