// Shared world-packet fixtures for line A4 (docs/implementation/line-A4.ru.md, М-A4-8).
//
// Every builder writes its fields by hand, in the order the TrinityCore writer named beside it
// puts them on the wire, and never through the parser under test: a fixture made by the reader it
// is meant to check proves only that the reader agrees with itself. Paths are relative to
// tswow/cores/TrinityCore/src/server.
import { PacketWriter } from "../../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../../dist/code/generated/opcodes.js";
import { WorldClient } from "../../dist/code/world/WorldClient.js";

/** A few macrotasks: the world loop reads in time slices, so one turn is not always enough. */
export async function settle(rounds = 6) {
  for (let round = 0; round < rounds; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * The socket half of a `WorldClient`: `read()` drains the queue in order, `push()` appends to it
 * and wakes a read that is already waiting, and every packet the client sends lands in `sent`.
 */
export function fakeWorldConnection(packets = []) {
  const queue = [...packets];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      const packet = { opcode, payload };
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(packet);
      } else queue.push(packet);
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
    /** What the client sent with one opcode, oldest first. */
    sentOf(opcode) { return this.sent.filter((packet) => packet.opcode === opcode); },
  };
}

/** `SMSG_LOGIN_VERIFY_WORLD`: `u32 map, f32 x, f32 y, f32 z, f32 orientation` (Handlers/CharacterHandler.cpp). */
export function loginVerifyWorldPacket(mapId = 0, position = { x: 10, y: 20, z: 30, orientation: 0 }) {
  return new PacketWriter().u32(mapId)
    .f32(position.x).f32(position.y).f32(position.z).f32(position.orientation).toUint8Array();
}

/**
 * A client logged in as `guid` whose world loop has already read `packets`; copied from
 * tests/world-travel.test.mjs, which keeps its own copy, and given `connection.push` to feed the
 * loop afterwards. The fake login stops short of the self CREATE, so the self guid and the position
 * (10, 20, 30) are set by hand.
 */
export async function travelClient(packets, guid) {
  const connection = fakeWorldConnection([
    { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: loginVerifyWorldPacket() },
    ...packets,
  ]);
  const client = new WorldClient(connection);
  client.state.selfGuid = guid;
  client.state.move(guid, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  await client.loginCharacter(guid);
  await settle();
  return { client, connection };
}

/**
 * `SMSG_SPELLLOGMISS` — `WorldObject::SendSpellMiss` (game/Entities/Object/Object.cpp:2775-2787):
 * `u32 spell, u64 caster, u8 0, u32 1`, then one full-guid target and its `SpellMissInfo` byte.
 * The core always writes exactly one target.
 */
export function spellLogMissPacket({ spellId, caster, target, missInfo }) {
  return new PacketWriter().u32(spellId).u64(caster).u8(0).u32(1).u64(target).u8(missInfo).toUint8Array();
}

/**
 * `SMSG_SPELL_GO` — `operator<<(SpellCastData)` (game/Server/Packets/SpellPackets.cpp:112-170):
 * packed caster (the item for an item cast), packed caster unit, `u8 castId, u32 spell,
 * u32 castFlags, u32 castTime`, `u8` hit count and full-guid hits, `u8` miss count and
 * `{u64 target, u8 SpellMissInfo}` — plus the reflect result byte for a REFLECT only (:45-52) —
 * then the target block, here `u32 TARGET_FLAG_NONE`. The flags are CAST_FLAG_UNKNOWN_9 alone, as
 * `Spell::SendSpellGo` starts them (Spell.cpp:4481), so no power-left word follows. The misses are
 * the ones decided at cast time (`Spell::UpdateSpellCastDataTargets`, Spell.cpp:4677-4708).
 */
export function spellGoPacket({ caster, casterUnit = caster, castId = 0, spellId, hits = [], misses = [] }) {
  const writer = new PacketWriter().packedGuid(caster).packedGuid(casterUnit)
    .u8(castId).u32(spellId).u32(0x100).u32(0);
  writer.u8(hits.length);
  for (const guid of hits) writer.u64(guid);
  writer.u8(misses.length);
  for (const miss of misses) {
    writer.u64(miss.guid).u8(miss.reason);
    if (miss.reason === 11) writer.u8(miss.reflect ?? 0);
  }
  return writer.u32(0).toUint8Array();
}

/** `SMSG_CLIENT_CONTROL_UPDATE` — `Player::SetClientControl` (Player.cpp:24590-24593): packed guid, u8 allowed. */
export function clientControlUpdatePacket(guid, allowed) {
  return new PacketWriter().packedGuid(guid).u8(allowed ? 1 : 0).toUint8Array();
}

/**
 * `SMSG_AUCTION_BIDDER_NOTIFICATION` — `WorldSession::SendAuctionBidderNotification`
 * (game/Handlers/AuctionHouseHandler.cpp:97-108): `u32 house, u32 auction, u64 bidder, u32 bid,
 * u32 diff, u32 item, u32 0`. The winner hears its own guid with bid and diff zero
 * (AuctionHouseMgr.cpp:173); the outbid player hears the NEW bidder's guid (:277).
 */
export function auctionBidderNotificationPacket({ houseId = 7, auctionId, bidder, bid = 0, diff = 0, itemEntry }) {
  return new PacketWriter().u32(houseId).u32(auctionId).u64(bidder).u32(bid).u32(diff).u32(itemEntry).u32(0)
    .toUint8Array();
}

/**
 * `SMSG_AUCTION_OWNER_NOTIFICATION` — `WorldSession::SendAuctionOwnerNotification`
 * (AuctionHouseHandler.cpp:111-122): `u32 auction, u32 bid, u32 0, u64 0, u32 item, u32 0, f32 0`.
 * Sent on a sale and on an expiry alike (AuctionHouseMgr.cpp:226, :250); an expiry has no bid.
 */
export function auctionOwnerNotificationPacket({ auctionId, bid, itemEntry }) {
  return new PacketWriter().u32(auctionId).u32(bid).u32(0).u64(0n).u32(itemEntry).u32(0).f32(0).toUint8Array();
}

/**
 * `SMSG_ITEM_ENCHANT_TIME_UPDATE` — `WorldSession::SendItemEnchantTimeUpdate`
 * (game/Handlers/ItemHandler.cpp:851-859): `u64 item, u32 slot, u32 seconds, u64 player`.
 */
export function itemEnchantTimeUpdatePacket({ item, slot, seconds, player }) {
  return new PacketWriter().u64(item).u32(slot).u32(seconds).u64(player).toUint8Array();
}

/**
 * `SMSG_SOCKET_GEMS_RESULT` — `Item::SendUpdateSockets` (game/Entities/Item/Item.cpp:1026-1034):
 * `u64 item`, then the enchantment ids of SOCK_ENCHANTMENT_SLOT (2) to BONUS_ENCHANTMENT_SLOT (5).
 */
export function socketGemsResultPacket(item, [first, second, third, bonus]) {
  return new PacketWriter().u64(item).u32(first).u32(second).u32(third).u32(bonus).toUint8Array();
}

/**
 * `SMSG_INITIAL_SPELLS` — `Player::SendInitialSpells` (Player.cpp:2973-3003) and
 * `SpellHistory::WritePacket<Player>` (game/Spells/SpellHistory.cpp:239-281): `u8 0, u16 count,
 * {u32 spell, u16 0}`, then `u16 count, {u32 spell, u16 item, u16 category, u32 cooldown,
 * u32 categoryCooldown}`. An on-hold cooldown is the pair `1, 0x80000000` (:254-258).
 */
export function initialSpellsPacket({ spells = [], cooldowns = [] }) {
  const writer = new PacketWriter().u8(0).u16(spells.length);
  for (const spellId of spells) writer.u32(spellId).u16(0);
  writer.u16(cooldowns.length);
  for (const entry of cooldowns) {
    writer.u32(entry.spellId).u16(entry.itemId ?? 0).u16(entry.categoryId ?? 0)
      .u32(entry.cooldown).u32(entry.categoryCooldown);
  }
  return writer.toUint8Array();
}

/** `SMSG_COOLDOWN_EVENT` — `SpellHistory::SendCooldownEvent` (SpellHistory.cpp:384-387): `u32 spell, u64 owner`. */
export function cooldownEventPacket(spellId, guid) {
  return new PacketWriter().u32(spellId).u64(guid).toUint8Array();
}

/**
 * `SMSG_CAST_FAILED` / `SMSG_PET_CAST_FAILED` — `Spell::WriteCastResultInfo`
 * (game/Spells/Spell.cpp:4161-4339): `u8 castCount, u32 spell, u8 result`, then the tail the
 * result carries, every value a `u32`. The caller passes the tail it means to test.
 */
export function castFailedPacket({ castCount = 0, spellId, result, tail = [] }) {
  const writer = new PacketWriter().u8(castCount).u32(spellId).u8(result);
  for (const value of tail) writer.u32(value);
  return writer.toUint8Array();
}
