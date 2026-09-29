import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  parseAchievementData, parseAchievementEarned, parseBindPoint, parseCriteriaUpdate,
  parseEquipmentSetList, parseFactionStanding, parseForcedReactions, parseInitialFactions,
  parseLevelUpInfo, parsePlayedTime, parseTalentsInfo, parseTitleEarned,
} from "../dist/code/world/CharacterProgressProtocol.js";
import { formatPlayed, reputationRank } from "../dist/code/browser/ui/Format.js";

const PLAYER = 0xf130000000000404n;

test("a level up says what it brought, for every power and stat", () => {
  const writer = new PacketWriter().u32(12).u32(58);
  for (let power = 0; power < 7; power++) writer.u32(power === 0 ? 40 : 0);
  for (let stat = 0; stat < 5; stat++) writer.u32(stat + 1);

  const info = parseLevelUpInfo(writer.toUint8Array());
  assert.equal(info.level, 12);
  assert.equal(info.healthDelta, 58);
  assert.equal(info.powerDelta.length, 7, "seven powers, whether or not the class uses them");
  assert.equal(info.powerDelta[0], 40);
  assert.deepEqual(info.statDelta, [1, 2, 3, 4, 5]);
});

test("reputation arrives as one entry per list id, met or not", () => {
  const writer = new PacketWriter().u32(3);
  writer.u8(0).u32(0);          // never met
  writer.u8(1).u32(2_100);      // met, friendly
  writer.u8(1).u32(0xffff_e890); // met, and disliked: standings go negative
  const factions = parseInitialFactions(writer.toUint8Array());

  assert.equal(factions.length, 3);
  assert.deepEqual(factions[1], { listId: 1, flags: 1, standing: 2_100 });
  assert.equal(factions[2].standing, -6_000, "the standing is signed");

  // A standing update carries only what moved, behind a float and a flag that mean nothing else.
  const update = parseFactionStanding(new PacketWriter().f32(0).u8(1).u32(1).u32(21).u32(3_100).toUint8Array());
  assert.equal(update.increased, true);
  assert.deepEqual(update.standings, [{ listId: 21, standing: 3_100 }]);

  assert.deepEqual(parseForcedReactions(new PacketWriter().u32(1).u32(72).u32(4).toUint8Array()),
    [{ factionId: 72, rank: 4 }]);

  assert.equal(reputationRank(2_999), "Нейтралитет");
  assert.equal(reputationRank(3_000), "Дружелюбие");
  assert.equal(reputationRank(42_000), "Превознесение");
  assert.equal(reputationRank(-7_000), "Ненависть");
});

test("achievements arrive both one at a time and as two lists ended by -1", () => {
  const earned = parseAchievementEarned(new PacketWriter().packedGuid(PLAYER).u32(6).u32(1_700_000).u32(0).toUint8Array());
  assert.equal(earned.achievementId, 6);
  assert.equal(earned.playerGuid, PLAYER);

  const criteria = parseCriteriaUpdate(new PacketWriter()
    .u32(101).packedGuid(37n).packedGuid(PLAYER).u32(0).u32(0).u32(1_700_000).u32(90).u32(0)
    .toUint8Array());
  assert.equal(criteria.criteriaId, 101);
  assert.equal(criteria.counter, 37n, "the counter is written with the packed-guid encoding");

  const all = parseAchievementData(new PacketWriter()
    .u32(6).u32(1_700_000)
    .u32(9).u32(1_700_100)
    .u32(0xffff_ffff)
    .u32(101).packedGuid(37n).packedGuid(PLAYER).u32(0).u32(1_700_000).u32(0).u32(0)
    .u32(0xffff_ffff)
    .toUint8Array(), false);
  assert.deepEqual(all.completed.map((entry) => entry.achievementId), [6, 9]);
  assert.deepEqual(all.criteria, [{ criteriaId: 101, counter: 37n }]);
});

test("talents come per specialisation, with ranks one below what is shown", () => {
  const payload = new PacketWriter().u8(0).u32(3).u8(2).u8(1)
    .u8(2).u32(1234).u8(0).u32(5678).u8(4)
    .u8(2).u16(100).u16(0)
    .u8(0).u8(6).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0)
    .toUint8Array();

  const talents = parseTalentsInfo(payload);
  assert.equal(talents.pet, false);
  assert.equal(talents.unspentPoints, 3);
  assert.equal(talents.activeSpec, 1);
  assert.equal(talents.specs.length, 2);
  // The wire counts ranks from zero; a talent at rank 0 is one point spent, not none.
  assert.deepEqual(talents.specs[0].talents, [{ talentId: 1234, rank: 1 }, { talentId: 5678, rank: 5 }]);
  assert.deepEqual(talents.specs[0].glyphs, [100, 0]);
  assert.equal(talents.specs[1].glyphs.length, 6);
});

test("pet talents use the pet-only count and rank layout from BuildPetTalentsInfoData", () => {
  // The pet form has no spec count, active spec, or glyphs: after points comes one talent count.
  const payload = new PacketWriter().u8(1).u32(2).u8(2)
    .u32(2110).u8(0)
    .u32(2111).u8(2)
    .toUint8Array();
  assert.deepEqual(parseTalentsInfo(payload), {
    pet: true,
    unspentPoints: 2,
    activeSpec: 0,
    specs: [{ talents: [{ talentId: 2110, rank: 1 }, { talentId: 2111, rank: 3 }], glyphs: [] }],
  });
  assert.deepEqual(parseTalentsInfo(new PacketWriter().u8(1).u32(0).u8(0).toUint8Array()), {
    pet: true,
    unspentPoints: 0,
    activeSpec: 0,
    specs: [{ talents: [], glyphs: [] }],
  }, "an untrained pet still has a valid empty tree snapshot");
});

test("an incoming pet talent packet is stored separately and reaches the talent window edge", async () => {
  const petPacket = new PacketWriter().u8(1).u32(1).u8(1).u32(2110).u8(1).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array() },
      { opcode: OPCODES.SMSG_TALENTS_INFO, payload: petPacket },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const world = new WorldClient(connection);
  const changes = [];
  const errors = [];
  world.events.on("TALENTS_CHANGED", (change) => changes.push(change));
  world.onPacketError = (opcode, error) => errors.push([opcode, error.message]);
  await world.loginCharacter(0x1234n);
  for (let tick = 0; tick < 3; tick++) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(world.petTalents?.specs[0]?.talents, [{ talentId: 2110, rank: 2 }]);
  assert.equal(world.petTalents?.unspentPoints, 1);
  assert.equal(world.talents, undefined, "a pet packet cannot overwrite the player's talent tree");
  assert.deepEqual(changes, [{ pet: true }]);
  assert.deepEqual(errors, []);
  world.close();
});

test("bind point, played time, titles and equipment sets", () => {
  const bind = parseBindPoint(new PacketWriter().f32(-8949.95).f32(-132.49).f32(83.53).u32(0).u32(1519).toUint8Array());
  assert.equal(bind.mapId, 0);
  assert.equal(bind.areaId, 1519);
  assert.ok(Math.abs(bind.x - -8949.95) < 0.01);

  const played = parsePlayedTime(new PacketWriter().u32(93_600).u32(3_600).u8(0).toUint8Array());
  assert.deepEqual(played, { total: 93_600, atLevel: 3_600 });
  assert.equal(formatPlayed(93_600), "1 д 2 ч");
  assert.equal(formatPlayed(3_600), "1 ч 0 мин");
  assert.equal(formatPlayed(90), "1 мин");

  assert.deepEqual(parseTitleEarned(new PacketWriter().u32(47).u32(1).toUint8Array()), { maskId: 47, earned: true });
  assert.equal(parseTitleEarned(new PacketWriter().u32(47).u32(0).toUint8Array()).earned, false);

  const writer = new PacketWriter().u32(1).packedGuid(5n).u32(1).cString("Танк").cString("icon");
  for (let piece = 0; piece < 19; piece++) writer.packedGuid(piece === 0 ? 0x123n : 0n);
  const sets = parseEquipmentSetList(writer.toUint8Array());
  assert.equal(sets.length, 1);
  assert.equal(sets[0].name, "Танк");
  assert.equal(sets[0].pieces.length, 19);
  assert.equal(sets[0].pieces[0], 0x123n);
});
