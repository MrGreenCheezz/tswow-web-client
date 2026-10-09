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

/**
 * The create-block spline — `Movement::PacketBuilder::WriteCreate`
 * (game/Movement/Spline/MovementPacketBuilder.cpp:147-186), field by field: `u32` raw flags (the
 * low byte is the animation tier); `f32 angle` for Final_Angle (0x20000), else a raw `u64` for
 * Final_Target (0x10000), else three `f32` for Final_Point (0x8000); `u32 timePassed`,
 * `u32 duration`, `u32 splineId`; `f32 1, f32 1` (duration mods); `f32 vertical_acceleration`;
 * `u32 effect_start_time`; `u32` node count and the nodes, which are the whole of
 * `Spline::points` virtual ends included; `u8` mode; `3×f32` final destination (zero for a cycle).
 */
export function writeCreateSpline(writer, {
  flags = 0, facing, timePassed = 0, duration, splineId = 1, verticalAcceleration = 0, effectStart = 0,
  nodes, mode = 0, finalDestination = nodes.at(-1) ?? { x: 0, y: 0, z: 0 },
}) {
  writer.u32(flags >>> 0);
  if (flags & 0x20000) writer.f32(facing.angle);
  else if (flags & 0x10000) writer.u64(facing.guid);
  else if (flags & 0x8000) writer.f32(facing.x).f32(facing.y).f32(facing.z);
  writer.u32(timePassed).u32(duration).u32(splineId).f32(1).f32(1).f32(verticalAcceleration).u32(effectStart);
  writer.u32(nodes.length);
  for (const node of nodes) writer.f32(node.x).f32(node.y).f32(node.z);
  writer.u8(mode);
  const destination = flags & 0x80000 ? { x: 0, y: 0, z: 0 } : finalDestination;
  return writer.f32(destination.x).f32(destination.y).f32(destination.z);
}

/**
 * `Spline::points` as `SplineBase::InitCatmullRom` lays them out (game/Movement/Spline/Spline.cpp,
 * used for the linear mode too, :50-52): a virtual point `c0 − (cos o, sin o, 0)` first, then the
 * path, then `c(N-1)` again — or, for a cycle, `c(k), c(k+1)` with `k = 1` under Enter_Cycle.
 */
export function splineNodes(path, { orientation = 0, cyclic = false, cyclicPoint = 1 } = {}) {
  const first = path[0];
  const virtual = cyclic && cyclicPoint === 0
    ? path.at(-1)
    : { x: first.x - Math.cos(orientation), y: first.y - Math.sin(orientation), z: first.z };
  const tail = cyclic ? [path[cyclicPoint], path[cyclicPoint + 1]] : [path.at(-1)];
  return [virtual, ...path, ...tail];
}

/**
 * A one-block `SMSG_UPDATE_OBJECT` creating a LIVING unit — `Object::BuildMovementUpdate`
 * (game/Entities/Object/Object.cpp:315-343): `u16` update flags, `MovementInfo`
 * (`Unit::BuildMovementPacket`: flags, flags2, time, x, y, z, o; with ONTRANSPORT a packed guid,
 * x, y, z, o, `u32` time, `i8` seat; `f32` pitch when swimming or flying; `u32` fall time; four
 * `f32` of jump when falling; `f32` spline elevation), nine speeds, then `WriteCreate` when
 * SPLINE_ENABLED (0x08000000) is set; no field blocks.
 */
export function livingSplineCreatePacket(guid, {
  typeId = 3, updateFlags = 0x0020, movementFlags = 0x08000001, position = { x: 0, y: 0, z: 0, orientation: 0 },
  transport, spline,
}) {
  const writer = new PacketWriter().u32(1).u8(2).packedGuid(guid).u8(typeId).u16(updateFlags);
  writer.u32(movementFlags >>> 0).u16(0).u32(0)
    .f32(position.x).f32(position.y).f32(position.z).f32(position.orientation);
  if (movementFlags & 0x200) {
    writer.packedGuid(transport.guid).f32(transport.x).f32(transport.y).f32(transport.z).f32(transport.orientation ?? 0)
      .u32(0).u8(transport.seat ?? 0);
  }
  if (movementFlags & (0x200000 | 0x2000000)) writer.f32(0); // pitch: SWIMMING | FLYING
  writer.u32(0);
  if (movementFlags & 0x1000) writer.f32(0).f32(0).f32(0).f32(0); // FALLING: jump velocity, sin, cos, speed
  if (movementFlags & 0x4000000) writer.f32(0); // SPLINE_ELEVATION
  for (const speed of [2.5, 7, 4.5, 4.722222, 2.5, 7, 4.5, 3.141594, 3.14]) writer.f32(speed);
  if (movementFlags & 0x08000000) writeCreateSpline(writer, spline);
  return writer.u8(0).toUint8Array();
}

/**
 * `SMSG_MONSTER_MOVE` — `PacketBuilder::WriteMonsterMove` (MovementPacketBuilder.cpp:44-145):
 * packed guid; `u8 0`; start `3×f32`; `u32 splineId`; `u8` type (0 normal, 1 stop, 2 spot + `3×f32`,
 * 3 target + raw `u64`, 4 angle + `f32`); for a stop nothing more. Then `u32` flags (facing bits,
 * tier byte and Done stripped), `u8 tier, u32 effect_start` under Animation (0x200000),
 * `u32 duration`, `f32 acceleration, u32 effect_start` under Parabolic (0x800), and the path:
 * `WriteLinearPath` — `u32` count = N−1, the destination, then N−2 packed offsets `middle − c(i)`
 * (11/11/10 bits, quarter yards) — or, for Flying|Catmullrom, `u32` count and `c1 … c(N-1)` whole.
 * `path` includes the start point.
 */
export function monsterMovePacket({
  guid, splineId = 1, type = 0, facing, flags = 0, animation, duration = 0, parabolic, path,
}) {
  const start = path[0];
  const writer = new PacketWriter().packedGuid(guid).u8(0).f32(start.x).f32(start.y).f32(start.z).u32(splineId).u8(type);
  if (type === 2) writer.f32(facing.x).f32(facing.y).f32(facing.z);
  else if (type === 3) writer.u64(facing.guid);
  else if (type === 4) writer.f32(facing.angle);
  if (type === 1) return writer.toUint8Array();
  writer.u32(flags >>> 0);
  if (flags & 0x200000) writer.u8(animation.tier).u32(animation.startMs);
  writer.u32(duration);
  if (flags & 0x800) writer.f32(parabolic.acceleration).u32(parabolic.startMs);
  if (flags & (0x2000 | 0x40000)) {
    writer.u32(path.length - 1);
    for (const point of path.slice(1)) writer.f32(point.x).f32(point.y).f32(point.z);
    return writer.toUint8Array();
  }
  const last = path.length - 1;
  writer.u32(last);
  writer.f32(path[last].x).f32(path[last].y).f32(path[last].z);
  if (last > 1) {
    const middle = { x: (start.x + path[last].x) / 2, y: (start.y + path[last].y) / 2, z: (start.z + path[last].z) / 2 };
    for (let index = 1; index < last; index++) {
      // `Position::PackedXYZ`: x and y in 11 bits, z in 10, each a signed count of quarter yards.
      const pack = (value, bits) => Math.trunc(value / 0.25) & ((1 << bits) - 1);
      const offset = { x: middle.x - path[index].x, y: middle.y - path[index].y, z: middle.z - path[index].z };
      writer.u32((pack(offset.x, 11) | (pack(offset.y, 11) << 11) | (pack(offset.z, 10) << 22)) >>> 0);
    }
  }
  return writer.toUint8Array();
}
