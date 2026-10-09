import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

/**
 * L15 5.05: the at-war flag and the rank of a reputation faction, as Wow.exe 3.3.5a (12340) keeps them
 * (Ghidra read-only, .runtime/re-2026-10-04/l15-combat/g1.c): 0x005d0600 (rank), 0x005d2e30
 * (SMSG_INITIALIZE_FACTIONS), 0x005d20a0 (SMSG_SET_FACTION_STANDING), 0x005d0850 (SMSG_SET_FACTION_ATWAR).
 */
const reputation = await import("../dist/code/world/ReputationReaction.js");
const {
  FACTION_FLAG_AT_WAR, factionFlagsAfterAtWar, factionFlagsAfterStanding, interactionReactionOfRank, reactionOfRank,
  reputationBaseFor, reputationListIdOf, reputationRank, setReputationBaseSource, parseSetFactionAtWar,
} = reputation;
const { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } = await import("../dist/code/world/FactionRules.js");

test("L15 5.05: 0x005d0600 draws the rank edges of the total standing", () => {
  const edges = [
    [42_999, 7], [42_000, 7], [41_999, 6], [21_000, 6], [20_999, 5], [9_000, 5], [8_999, 4], [3_000, 4], [2_999, 3],
    [0, 3], [-1, 2], [-3_000, 2], [-3_001, 1], [-6_000, 1], [-6_001, 0], [-42_000, 0],
  ];
  for (const [total, rank] of edges) assert.equal(reputationRank(total), rank, String(total));
});

test("L15 5.05: 0x005d20a0 — at war below Unfriendly, peace when the rank rose, else the flag stays", () => {
  const VISIBLE = 0x1;
  assert.equal(factionFlagsAfterStanding(VISIBLE, 0, -3_001), VISIBLE | FACTION_FLAG_AT_WAR, "fell to Hostile");
  assert.equal(factionFlagsAfterStanding(VISIBLE, -6_001, -6_500), VISIBLE | FACTION_FLAG_AT_WAR, "Hated stays at war");
  assert.equal(factionFlagsAfterStanding(VISIBLE | FACTION_FLAG_AT_WAR, -3_001, -3_000), VISIBLE, "rose to Unfriendly");
  assert.equal(factionFlagsAfterStanding(VISIBLE | FACTION_FLAG_AT_WAR, -6_500, -4_000), VISIBLE | FACTION_FLAG_AT_WAR,
    "Hated to Hostile is still below Unfriendly");
  assert.equal(factionFlagsAfterStanding(VISIBLE | FACTION_FLAG_AT_WAR, 3_000, 9_000), VISIBLE,
    "a declared war ends when the rank rises (Friendly to Honored)");
  assert.equal(factionFlagsAfterStanding(VISIBLE | FACTION_FLAG_AT_WAR, 3_000, 8_999), VISIBLE | FACTION_FLAG_AT_WAR,
    "standing up within the same rank keeps it");
  assert.equal(factionFlagsAfterStanding(VISIBLE | FACTION_FLAG_AT_WAR, 9_000, 3_000), VISIBLE | FACTION_FLAG_AT_WAR,
    "falling, but not below Unfriendly, keeps it");
  assert.equal(factionFlagsAfterStanding(VISIBLE, 9_000, -2_000), VISIBLE, "falling to Unfriendly declares nothing");
  assert.equal(factionFlagsAfterStanding(0x20, -3_001, 0), 0x20, "other bits are left alone");
});

test("L15 5.05: SMSG_SET_FACTION_ATWAR copies only bit 0x2 (0x005d0850)", () => {
  assert.equal(factionFlagsAfterAtWar(0x1, 0x2), 0x3);
  assert.equal(factionFlagsAfterAtWar(0x3, 0x0), 0x1);
  assert.equal(factionFlagsAfterAtWar(0x21, 0xfd), 0x21, "every other bit of the wire is ignored");
  assert.deepEqual(parseSetFactionAtWar(new PacketWriter().u32(97).u8(2).toUint8Array()), { listId: 97, flags: 2 });
});

test("L15 5.05: the ranks as reactions — forced-style for display, neutral-or-better for the talk", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7].map(reactionOfRank),
    [REACTION_HOSTILE, REACTION_HOSTILE, REACTION_NEUTRAL, REACTION_NEUTRAL, REACTION_FRIENDLY, REACTION_FRIENDLY]);
  assert.deepEqual([0, 1, 2, 3, 4, 7].map(interactionReactionOfRank),
    [REACTION_HOSTILE, REACTION_HOSTILE, REACTION_HOSTILE, REACTION_NEUTRAL, REACTION_FRIENDLY, REACTION_FRIENDLY]);
});

test("L15 5.05: Faction.dbc's base standing by race and class (ReputationMgr::GetBaseReputation)", () => {
  // Undercity (68) in the dataset: Horde 0xa2 at 500, Alliance 0x44d at -42000, Blood Elf 0x200 at 3100.
  const undercity = { factionId: 68, raceMasks: [0xa2, 0x44d, 0x10, 0x200], classMasks: [0, 0, 0, 0],
    bases: [500, -42_000, 4_000, 3_100] };
  assert.equal(reputationBaseFor(undercity, 1, 1), -42_000, "a human");
  assert.equal(reputationBaseFor(undercity, 2, 1), 500, "an orc");
  assert.equal(reputationBaseFor(undercity, 5, 5), 4_000, "a forsaken");
  assert.equal(reputationBaseFor(undercity, 10, 2), 3_100, "a blood elf");
  assert.equal(reputationBaseFor(undercity, 0, 0), 0, "no race: no row");
  // A class-only entry (race mask 0, class mask set) matches any race of that class.
  const classRow = { factionId: 1, raceMasks: [0, 0, 0, 0], classMasks: [0x20, 0, 0, 0], bases: [-3_500, 0, 0, 0] };
  assert.equal(reputationBaseFor(classRow, 3, 6), -3_500, "a death knight");
  assert.equal(reputationBaseFor(classRow, 3, 1), 0, "a warrior");
  assert.equal(reputationBaseFor({ factionId: 1119 }, 1, 1), 0, "a row without its arrays");
  assert.equal(reputationBaseFor(undefined, 1, 1), 0);
});

test("L15 5.05: the list id of a faction, from the catalog's rows", () => {
  const catalog = { factions: { 97: { factionId: 1119 }, 17: { factionId: 68 } } };
  assert.equal(reputationListIdOf(catalog, 1119), 97);
  assert.equal(reputationListIdOf(catalog, 68), 17);
  assert.equal(reputationListIdOf(catalog, 14), undefined, "Monster keeps no reputation");
  assert.equal(reputationListIdOf(catalog, 1119), 97, "asked twice, the same");
});

// ---- the world client -------------------------------------------------------------------------

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  return { client, connection };
}

const initialize = (rows) => {
  const writer = new PacketWriter().u32(rows.length);
  for (const [flags, standing] of rows) writer.u8(flags).i32(standing);
  return writer.toUint8Array();
};
const standing = (...rows) => {
  const writer = new PacketWriter().f32(0).u8(0).u32(rows.length);
  for (const [listId, value] of rows) writer.u32(listId).i32(value);
  return writer.toUint8Array();
};

test("L15 5.05: the world keeps the server's flags and moves the at-war bit with the rank", async () => {
  const { client, connection } = await loggedIn();
  // Sons of Hodir: base -42000 for every race (Faction.dbc 1119); the wire carries the standing without it.
  setReputationBaseSource((listId) => (listId === 2 ? -42_000 : 0));
  try {
    connection.push(OPCODES.SMSG_INITIALIZE_FACTIONS, initialize([[0x1, 0], [0x1 | 0x2, 500], [0x1, 39_000]]));
    await settle();
    assert.equal(client.factions.get(1).flags, 0x3, "0x005d2e30 stores the flags as they come");
    assert.equal(client.factions.get(2).flags, 0x1);
    // Base -42000 + 39000 = -3000 (Unfriendly) → +100: Unfriendly still; → -3001 is Hostile: at war.
    connection.push(OPCODES.SMSG_SET_FACTION_STANDING, standing([2, 38_999]));
    await settle();
    assert.equal(client.factions.get(2).flags, 0x3, "fell to Hostile: at war");
    assert.equal(client.factions.get(2).standing, 38_999);
    connection.push(OPCODES.SMSG_SET_FACTION_STANDING, standing([2, 45_000]));
    await settle();
    assert.equal(client.factions.get(2).flags, 0x1, "rose to Friendly: the client makes peace (the core never does)");
    // The first row's war was declared at Neutral; standing up within Neutral keeps it, a new rank ends it.
    connection.push(OPCODES.SMSG_SET_FACTION_STANDING, standing([1, 2_999]));
    await settle();
    assert.equal(client.factions.get(1).flags, 0x3, "the same rank: still at war");
    connection.push(OPCODES.SMSG_SET_FACTION_STANDING, standing([1, 3_000]));
    await settle();
    assert.equal(client.factions.get(1).flags, 0x1, "Friendly now: peace");
  } finally {
    setReputationBaseSource(undefined);
    client.close();
  }
});

test("L15 5.05: without the player's base standing a standing update leaves the flag as it was", async () => {
  const { client, connection } = await loggedIn();
  connection.push(OPCODES.SMSG_INITIALIZE_FACTIONS, initialize([[0x1, 0], [0x3, 0]]));
  connection.push(OPCODES.SMSG_SET_FACTION_STANDING, standing([0, -50_000], [1, 50_000]));
  await settle();
  assert.equal(client.factions.get(0).flags, 0x1);
  assert.equal(client.factions.get(1).flags, 0x3);
  assert.equal(client.factions.get(0).standing, -50_000);
  client.close();
});

test("L15 5.05: SMSG_SET_FACTION_ATWAR sets and clears the bit of its row", async () => {
  const { client, connection } = await loggedIn();
  connection.push(OPCODES.SMSG_INITIALIZE_FACTIONS, initialize([[0x1, 100], [0x1, 0]]));
  connection.push(OPCODES.SMSG_SET_FACTION_ATWAR, new PacketWriter().u32(0).u8(0x2).toUint8Array());
  await settle();
  assert.deepEqual(client.factions.get(0), { listId: 0, flags: 0x3, standing: 100 });
  connection.push(OPCODES.SMSG_SET_FACTION_ATWAR, new PacketWriter().u32(0).u8(0x0).toUint8Array());
  await settle();
  assert.equal(client.factions.get(0).flags, 0x1);
  assert.equal(client.factions.get(1).flags, 0x1, "the other row is untouched");
  client.close();
});
