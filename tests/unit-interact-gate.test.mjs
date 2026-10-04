import assert from "node:assert/strict";
import test from "node:test";

// 11.02-tails (5.05): Wow.exe 0x00729530 — whether a right click may hand a live unit to the
// interaction chain 0x006ddbb0 (world/UnitInteractGate.ts). Ghidra, read-only:
// .runtime/re-2026-10-03/l1102bcd-review/r1.c (0x00731260), r2.c (0x00729530).
const {
  CREATURE_TYPE_FLAG_INTERACT_ONLY_WITH_CREATOR, CREATURE_TYPE_FLAG_VISIBLE_TO_GHOSTS, canInteractWithUnit,
} = await import("../dist/code/world/UnitInteractGate.js");
const { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } = await import("../dist/code/world/FactionRules.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const H = REACTION_HOSTILE;
const N = REACTION_NEUTRAL;
const FR = REACTION_FRIENDLY;
const GOSSIP = 0x1;
const VENDOR = 0x80;
const SPIRIT_HEALER = 0x4000;
const PLAYER_VEHICLE = 0x0200_0000;

function unit(guid, { typeId = 3, npcFlags = 0, flags = 0, flags2 = 0, createdBy, playerFlags } = {}) {
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100],
    [UPDATE_FIELDS.UNIT_NPC_FLAGS.offset, npcFlags],
    [UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, flags],
    [UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset, flags2],
  ]);
  if (createdBy !== undefined) {
    fields.set(UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset, Number(createdBy & 0xffff_ffffn));
    fields.set(UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset + 1, Number(createdBy >> 32n));
  }
  if (playerFlags !== undefined) fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, playerFlags);
  return { guid, typeId, fields, position: { x: 0, y: 0, z: 0, orientation: 0 } };
}

const SELF = 0x0000_0000_0000_0007n;
const player = (playerFlags = 0) => unit(SELF, { typeId: 4, playerFlags });

test("0x00729530 rule 4: an NPC flag and both reactions neutral or better — or UNIT_FLAG2_ALLOW_ENEMY_INTERACT", () => {
  const self = player();
  const keeper = unit(10n, { npcFlags: GOSSIP });
  assert.equal(canInteractWithUnit(self, keeper, N, N, undefined), true, "the yellow innkeeper");
  assert.equal(canInteractWithUnit(self, keeper, FR, FR, undefined), true, "a friend");
  assert.equal(canInteractWithUnit(self, keeper, H, N, undefined), false, "hostile to the player");
  assert.equal(canInteractWithUnit(self, keeper, N, H, undefined), false, "the unit's own side counts too (0x007251c0 both ways)");
  const forHire = unit(11n, { npcFlags: GOSSIP, flags2: 0x4000 });
  assert.equal(canInteractWithUnit(self, forHire, H, H, undefined), true, "an NPCBot for hire: hostile and still talked to");
  assert.equal(canInteractWithUnit(self, unit(12n, { flags2: 0x4000 }), H, H, undefined), false,
    "ALLOW_ENEMY_INTERACT without an NPC flag offers nothing");
});

test("0x00729530 rule 3: no NPC flag, or UNIT_FLAG_UNINTERACTIBLE 0x02000000, is never talked to", () => {
  const self = player();
  assert.equal(canInteractWithUnit(self, unit(20n), FR, FR, undefined), false, "a friend with nothing to offer");
  assert.equal(canInteractWithUnit(self, unit(21n, { npcFlags: VENDOR, flags: 0x0200_0000 }), FR, FR, undefined), false,
    "a vendor the server made uninteractible");
  assert.equal(canInteractWithUnit(self, unit(22n, { npcFlags: GOSSIP, flags: 0x0200_0000, flags2: 0x4000 }), H, H, undefined), false,
    "and ALLOW_ENEMY_INTERACT does not reopen it");
  assert.equal(canInteractWithUnit(self, unit(23n, { npcFlags: VENDOR, flags: 0x0100_0000 }), FR, FR, undefined), true,
    "the flag next to it is not the gate");
  // A group member's vehicle: a player whose only NPC flag is UNIT_NPC_FLAG_PLAYER_VEHICLE.
  assert.equal(canInteractWithUnit(self, unit(24n, { typeId: 4, npcFlags: PLAYER_VEHICLE }), FR, FR, undefined), true);
});

test("0x00729530 rule 1: a ghost talks only to a creature that shows itself to ghosts", () => {
  const ghost = player(0x10);
  const healer = unit(30n, { npcFlags: GOSSIP | SPIRIT_HEALER });
  assert.equal(canInteractWithUnit(ghost, healer, FR, FR, CREATURE_TYPE_FLAG_VISIBLE_TO_GHOSTS), true, "the spirit healer");
  assert.equal(canInteractWithUnit(ghost, unit(31n, { npcFlags: VENDOR }), FR, FR, 0), false, "a vendor does not see the dead");
  assert.equal(canInteractWithUnit(ghost, unit(32n, { typeId: 4, npcFlags: PLAYER_VEHICLE }), FR, FR, undefined), false,
    "a player has no creature cache entry: refused");
  assert.equal(canInteractWithUnit(ghost, unit(33n, { npcFlags: VENDOR }), FR, FR, undefined), true,
    "a template not cached yet keeps the click as it was (Wow.exe would hold it already)");
  assert.equal(canInteractWithUnit(player(), unit(34n, { npcFlags: VENDOR }), FR, FR, 0), true, "alive: no ghost gate");
  assert.equal(canInteractWithUnit(player(0x20), unit(35n, { npcFlags: VENDOR }), FR, FR, 0), true, "only the ghost bit");
  // Only a player self is a ghost: a self that is not a player is not asked.
  assert.equal(canInteractWithUnit(unit(SELF, { typeId: 3, playerFlags: 0x10 }), unit(36n, { npcFlags: VENDOR }), FR, FR, 0), true);
});

test("0x00729530 rule 2: a creator-only gossip creature is the player's only when the player created it", () => {
  const self = player();
  const flags = CREATURE_TYPE_FLAG_INTERACT_ONLY_WITH_CREATOR;
  const mine = unit(40n, { npcFlags: GOSSIP, createdBy: SELF });
  const theirs = unit(41n, { npcFlags: GOSSIP, createdBy: 0x0000_0001_0000_0007n });
  assert.equal(canInteractWithUnit(self, mine, FR, FR, flags), true, "my own");
  assert.equal(canInteractWithUnit(self, theirs, FR, FR, flags), false, "somebody else's (the high word differs)");
  assert.equal(canInteractWithUnit(self, unit(42n, { npcFlags: GOSSIP }), FR, FR, flags), false, "nobody's");
  assert.equal(canInteractWithUnit(self, theirs, FR, FR, 0), true, "without the type flag anyone may");
  assert.equal(canInteractWithUnit(self, theirs, FR, FR, undefined), true, "the template not cached: no gate (Wow.exe needs it too)");
  assert.equal(canInteractWithUnit(self, unit(43n, { npcFlags: VENDOR, createdBy: 9n }), FR, FR, flags), true,
    "the gate is the gossip flag's only");
  assert.equal(canInteractWithUnit(undefined, theirs, N, N, flags), true, "no player in the world: no creator to compare");
});

// 11.02-tails-review: 0x007251c0 reads a reputation faction off the player's standing, not the masks
// (.runtime/re-2026-10-03/l1102tails-review/r1.c: 0x0071f770, 0x00718b30, 0x005d04b0, 0x005d06a0).
test("11.02-tails-review: reactions are the masks' only for a faction that keeps no reputation", async () => {
  const { reactionsByTemplate } = await import("../dist/code/world/UnitInteractGate.js");
  const SONS_OF_HODIR = 1119;
  const MONSTER = 14;
  const catalog = { factions: { 97: { factionId: SONS_OF_HODIR }, 19: { factionId: 72 } } };
  const self = player();
  assert.equal(reactionsByTemplate(self, MONSTER, catalog, undefined), true, "no reputation: the masks");
  assert.equal(reactionsByTemplate(self, SONS_OF_HODIR, catalog, undefined), false, "a reputation: the player's standing");
  assert.equal(reactionsByTemplate(self, 72, catalog, new Map()), false, "any slot of the catalog");
  assert.equal(reactionsByTemplate(self, SONS_OF_HODIR, catalog, undefined), false, "asked twice, the same");
  assert.equal(reactionsByTemplate(self, SONS_OF_HODIR, catalog, new Map([[SONS_OF_HODIR, 1]])), true,
    "a forced reaction for it is read first (0x005d06a0), and reactionBetween applies it");
  assert.equal(reactionsByTemplate(self, SONS_OF_HODIR, catalog, new Map([[72, 1]])), false, "someone else's forced reaction");
  assert.equal(reactionsByTemplate(unit(SELF, { typeId: 4, flags2: 0x4 }), SONS_OF_HODIR, catalog, undefined), true,
    "UNIT_FLAG2_IGNORE_REPUTATION sends both ways back to the masks");
  assert.equal(reactionsByTemplate(unit(SELF, { typeId: 4, flags2: 0x4000 }), SONS_OF_HODIR, catalog, undefined), false,
    "only that bit");
  assert.equal(reactionsByTemplate(self, SONS_OF_HODIR, undefined, undefined), false, "no catalog yet: not the masks");
  assert.equal(reactionsByTemplate(self, MONSTER, undefined, undefined), false, "whatever the faction");
  assert.equal(reactionsByTemplate(self, undefined, catalog, undefined), true, "no template row: both read neutral anyway");
  assert.equal(reactionsByTemplate(undefined, MONSTER, catalog, undefined), true, "no player: the masks");
});
