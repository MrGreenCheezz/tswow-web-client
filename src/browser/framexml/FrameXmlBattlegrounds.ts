import { type BattlegroundCatalog } from "../BattlegroundMetadata.js";

// Compatibility names for the FrameXML seam. Catalog loading and validation live in the shared
// browser module so the native HUD does not depend on the optional FrameXML implementation.
export {
  BATTLEGROUND_TYPE_IDS as FRAMEXML_BATTLEGROUND_TYPE_IDS,
  BattlegroundClient as FrameXmlBattlegroundClient,
} from "../BattlegroundMetadata.js";
export type {
  BattlegroundCatalog as FrameXmlBattlegroundCatalog,
  BattlegroundMap as FrameXmlBattlegroundMap,
  BattlegroundMetadata as FrameXmlBattlegroundMetadata,
} from "../BattlegroundMetadata.js";

/** Deterministic catalog used by the no-server seam and focused FrameXML tests. */
export const FRAMEXML_CANNED_BATTLEGROUNDS: BattlegroundCatalog = Object.freeze([
  { bgTypeId: 1, name: "Alterac Valley", mapIds: [30], minLevel: 10, maxLevel: 80, maxGroupSize: 40, groupsAllowed: 1, holidayWorldState: 0, random: false, maps: [{ id: 30, name: "Alterac Valley", description0: "Fight for the Frostwolf clan.", description1: "Fight for the Stormpike clan." }] },
  { bgTypeId: 2, name: "Warsong Gulch", mapIds: [489], minLevel: 10, maxLevel: 80, maxGroupSize: 5, groupsAllowed: 1, holidayWorldState: 0, random: false, maps: [{ id: 489, name: "Warsong Gulch", description0: "Capture the enemy flag.", description1: "Capture the enemy flag." }] },
  { bgTypeId: 3, name: "Arathi Basin", mapIds: [529], minLevel: 10, maxLevel: 80, maxGroupSize: 5, groupsAllowed: 1, holidayWorldState: 0, random: false, maps: [{ id: 529, name: "Arathi Basin", description0: "Capture and hold the bases.", description1: "Capture and hold the bases." }] },
  { bgTypeId: 7, name: "Eye of the Storm", mapIds: [566], minLevel: 10, maxLevel: 80, maxGroupSize: 5, groupsAllowed: 1, holidayWorldState: 0, random: false, maps: [{ id: 566, name: "Eye of the Storm", description0: "Capture bases and the flag.", description1: "Capture bases and the flag." }] },
  { bgTypeId: 9, name: "Strand of the Ancients", mapIds: [607], minLevel: 10, maxLevel: 80, maxGroupSize: 5, groupsAllowed: 1, holidayWorldState: 0, random: false, maps: [{ id: 607, name: "Strand of the Ancients", description0: "Attack or defend the relic.", description1: "Attack or defend the relic." }] },
  { bgTypeId: 30, name: "Isle of Conquest", mapIds: [628], minLevel: 10, maxLevel: 80, maxGroupSize: 5, groupsAllowed: 1, holidayWorldState: 0, random: false, maps: [{ id: 628, name: "Isle of Conquest", description0: "Destroy the enemy general.", description1: "Destroy the enemy general." }] },
  { bgTypeId: 32, name: "Random Battleground", mapIds: [], minLevel: 10, maxLevel: 80, maxGroupSize: 5, groupsAllowed: 1, holidayWorldState: 0, random: true, maps: [] },
].map((row) => Object.freeze({
  ...row,
  mapIds: Object.freeze([...row.mapIds]),
  maps: Object.freeze(row.maps.map((map) => Object.freeze({ ...map }))),
})));
