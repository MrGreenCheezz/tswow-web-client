import assert from "node:assert/strict";
import test from "node:test";
import {
  ACT_COMMAND, ACT_DISABLED, ACT_ENABLED, ACT_PASSIVE, ACT_REACTION, COMMAND_ATTACK,
  COMMAND_FOLLOW, COMMAND_STAY, DECLINED_NAME_CASES, PET_ACTION_BAR_SIZE, REACT_AGGRESSIVE,
  REACT_DEFENSIVE, REACT_PASSIVE, buildPetNameQuery, buildPetRename, buildPetSetAction,
  buildPetSpellAutocast, buildPetSwapAction, isVehicleActionBar, packPetAction,
  parsePetActionFeedback, parsePetActionSound, parsePetCastFailed, parsePetComboPoints,
  parsePetLearnedSpell, parsePetNameInvalid, parsePetNameQueryResponse, parsePetSpells,
  parsePetTameFailure, petCooldownRemaining,
} from "../dist/code/world/PetProtocol.js";
import {
  STABLED_PET_ACTIVE, STABLED_PET_STABLED, STABLE_SUCCESS_UNSTABLE, isStableSuccess,
  parseStableList, parseStableResult,
} from "../dist/code/world/StableProtocol.js";
import {
  buildRequestVehicleSwitchSeat, parseCancelExpectedRideVehicleAura, parsePlayerVehicleData,
} from "../dist/code/world/VehicleProtocol.js";

const encoder = new TextEncoder();
function bytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const u8 = (value) => Uint8Array.from([value & 0xff]);
const u16 = (value) => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff, true);
  return out;
};
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};
const cstr = (value) => bytes(encoder.encode(value), u8(0));
const packed = (value) => {
  const body = [];
  let mask = 0;
  for (let index = 0; index < 8; index++) {
    const byte = Number((value >> BigInt(index * 8)) & 0xffn);
    if (byte !== 0) {
      mask |= 1 << index;
      body.push(byte);
    }
  }
  return bytes(u8(mask), Uint8Array.from(body));
};

const PET = 0xf140_0058_0000_1234n;
const TARGET = 0x0000_0000_0000_2a01n;

/** The default hunter-pet bar the core builds: three commands, four spells, three reactions. */
function defaultBar(spells = [0, 0, 0, 0]) {
  return [
    u32(packPetAction(COMMAND_ATTACK, ACT_COMMAND)),
    u32(packPetAction(COMMAND_FOLLOW, ACT_COMMAND)),
    u32(packPetAction(COMMAND_STAY, ACT_COMMAND)),
    u32(packPetAction(spells[0], spells[0] ? ACT_ENABLED : ACT_PASSIVE)),
    u32(packPetAction(spells[1], spells[1] ? ACT_DISABLED : ACT_PASSIVE)),
    u32(packPetAction(spells[2], spells[2] ? ACT_PASSIVE : ACT_PASSIVE)),
    u32(packPetAction(spells[3], ACT_PASSIVE)),
    u32(packPetAction(REACT_AGGRESSIVE, ACT_REACTION)),
    u32(packPetAction(REACT_DEFENSIVE, ACT_REACTION)),
    u32(packPetAction(REACT_PASSIVE, ACT_REACTION)),
  ];
}

test("the pet bar is ten fixed words split twenty-four and eight", () => {
  const payload = bytes(
    u64(PET), u16(1), u32(0), u8(REACT_DEFENSIVE), u8(COMMAND_FOLLOW), u16(0),
    ...defaultBar([2649, 17253, 0, 0]),
    u8(2), u32(packPetAction(2649, ACT_ENABLED)), u32(packPetAction(17253, ACT_DISABLED)),
    u8(0),
  );
  const pet = parsePetSpells(payload);
  assert.equal(pet.closed, false);
  assert.equal(pet.guid, PET);
  assert.equal(pet.creatureFamily, 1);
  assert.equal(pet.reactState, REACT_DEFENSIVE);
  assert.equal(pet.commandState, COMMAND_FOLLOW);
  assert.equal(pet.bar.length, PET_ACTION_BAR_SIZE, "the bar is never counted and never truncated");
  assert.deepEqual(pet.bar[0], { slot: 0, packed: 0x07000002, action: COMMAND_ATTACK, type: ACT_COMMAND });
  assert.deepEqual(pet.bar[9], { slot: 9, packed: 0x06000000, action: REACT_PASSIVE, type: ACT_REACTION });
  assert.equal(pet.bar[3].action, 2649, "a spell slot carries the spell id in the low 24 bits");
  assert.equal(pet.bar[3].type, ACT_ENABLED, "and its autocast state in the high 8");
  assert.deepEqual(pet.spells, [
    { spellId: 2649, active: ACT_ENABLED },
    { spellId: 17253, active: ACT_DISABLED },
  ]);
  assert.equal(isVehicleActionBar(pet.bar), false);
});

test("a bare zero guid is the whole packet and means the pet bar comes down", () => {
  const closed = parsePetSpells(u64(0n));
  assert.equal(closed.closed, true);
  assert.equal(closed.guid, 0n);
  assert.deepEqual(closed.bar, []);
});

test("a vehicle bar puts the slot index where a pet puts its state", () => {
  // VehicleSpellInitialize writes MAKE_UNIT_ACTION_BUTTON(spellId, i + 8), so the high byte is
  // 8..15 rather than an ACT_* value — that is the only thing that tells the two bars apart.
  const bar = [];
  for (let index = 0; index < 8; index++) bar.push(u32(packPetAction(index === 0 ? 45838 : 0, index + 8)));
  bar.push(u32(0), u32(0));
  const payload = bytes(
    u64(PET), u16(0), u32(0), u8(REACT_PASSIVE), u8(0), u16(0x0800), ...bar, u8(0), u8(0),
  );
  const vehicle = parsePetSpells(payload);
  assert.equal(vehicle.flags, 0x0800);
  assert.equal(vehicle.bar[0].action, 45838);
  assert.equal(vehicle.bar[0].type, 8, "the high byte is the bar slot, not a state");
  assert.equal(isVehicleActionBar(vehicle.bar), true);
});

test("a pet cooldown entry is fourteen bytes or six, and nothing on the wire says which", () => {
  // SpellHistory::WritePacket<Pet> writes the two durations only when the cooldown is not on hold,
  // and "on hold" never reaches the wire. The block is last, so what is left resolves it.
  const head = bytes(u64(PET), u16(1), u32(0), u8(0), u8(0), u16(0), ...defaultBar(), u8(0));

  const running = parsePetSpells(bytes(head, u8(1), u32(2649), u16(0), u32(3000), u32(0)));
  assert.equal(running.cooldowns.length, 1);
  assert.equal(running.cooldowns[0].onHold, false);
  assert.equal(petCooldownRemaining(running.cooldowns[0]), 3000);

  // A category timer carries the remainder instead, and the two are mutually exclusive.
  const category = parsePetSpells(bytes(head, u8(1), u32(2649), u16(76), u32(0), u32(9000)));
  assert.equal(petCooldownRemaining(category.cooldowns[0]), 9000);

  // One held cooldown: six bytes and then the packet ends.
  const held = parsePetSpells(bytes(head, u8(1), u32(2649), u16(0)));
  assert.equal(held.cooldowns.length, 1);
  assert.equal(held.cooldowns[0].onHold, true);
  assert.equal(petCooldownRemaining(held.cooldowns[0]), 0);

  // A running one followed by a held one still resolves, because the tail is too short to be two
  // full entries.
  const mixed = parsePetSpells(bytes(
    head, u8(2), u32(2649), u16(0), u32(3000), u32(0), u32(17253), u16(0),
  ));
  assert.equal(mixed.cooldowns.length, 2);
  assert.equal(mixed.cooldowns[0].onHold, false);
  assert.equal(mixed.cooldowns[1].onHold, true);
  assert.equal(mixed.cooldowns[1].spellId, 17253);
});

test("a truncated cooldown tail costs the cooldowns and nothing else", () => {
  // The block is last, so a count that overstates what follows must not throw away the bar.
  const head = bytes(u64(PET), u16(1), u32(0), u8(0), u8(0), u16(0), ...defaultBar(), u8(0));
  const short = parsePetSpells(bytes(head, u8(3), u32(2649), u16(0)));
  assert.equal(short.bar.length, PET_ACTION_BAR_SIZE, "the bar survived");
  assert.equal(short.cooldowns.length, 1, "and the reader stopped rather than overrunning");
});

test("the pet's small packets are exactly as small as they look", () => {
  assert.equal(parsePetLearnedSpell(u32(2649)), 2649, "no guid: it belongs to whichever pet is out");
  assert.equal(parsePetActionFeedback(u8(1)), 1);
  assert.equal(parsePetTameFailure(u8(10)), 10);
  const talk = parsePetActionSound(bytes(u64(PET), u32(1)));
  assert.deepEqual(talk, { guid: PET, talk: 1 }, "the talk id is widened to a full word");
  const failure = parsePetCastFailed(bytes(u8(0), u32(2649), u8(4), u32(999)));
  assert.deepEqual(failure, { castCount: 0, spellId: 2649, result: 4 });
});

test("pet combo points are two packed guids, where the rest of the family writes full ones", () => {
  const combo = parsePetComboPoints(bytes(packed(PET), packed(TARGET), u8(3)));
  assert.equal(combo.guid, PET);
  assert.equal(combo.targetGuid, TARGET);
  assert.equal(combo.points, 3);

  // No combo target is a default-constructed packed guid: one zero mask byte, no value bytes.
  const untargeted = parsePetComboPoints(bytes(packed(PET), u8(0), u8(0)));
  assert.equal(untargeted.targetGuid, 0n);
  assert.equal(untargeted.points, 0);
});

test("a pet name is correlated by number, and its declined block is always five strings", () => {
  const plain = parsePetNameQueryResponse(bytes(u32(4242), cstr("Мурчик"), u32(1755000000), u8(0)));
  assert.equal(plain.petNumber, 4242);
  assert.equal(plain.name, "Мурчик");
  assert.deepEqual(plain.declined, []);

  const declined = parsePetNameQueryResponse(bytes(
    u32(4242), cstr("Мурчик"), u32(0), u8(1),
    cstr("Мурчик"), cstr("Мурчика"), cstr("Мурчику"), cstr("Мурчика"), cstr("Мурчиком"),
  ));
  assert.equal(declined.declined.length, DECLINED_NAME_CASES);
  assert.equal(declined.declined[4], "Мурчиком");

  // A pet the server cannot see answers with the same shape and an empty name.
  const missing = parsePetNameQueryResponse(bytes(u32(4242), u8(0), u32(0), u8(0)));
  assert.equal(missing.name, "");
  assert.equal(missing.timestamp, 0);

  const rejected = parsePetNameInvalid(bytes(u32(16), cstr("Плохое"), u8(0)));
  assert.equal(rejected.error, 16, "the reason is widened to a full word");
  assert.equal(rejected.name, "Плохое");
});

test("the client's pet requests match what the server reads", () => {
  // The pet number comes first here, the reverse of every other query.
  const query = buildPetNameQuery(4242, PET);
  assert.equal(query.length, 12);
  assert.deepEqual(query.slice(0, 4), u32(4242));

  // One pair is sixteen bytes and a swap is exactly twenty-four; the count is not on the wire.
  assert.equal(buildPetSetAction(PET, 3, packPetAction(2649, ACT_ENABLED)).length, 16);
  assert.equal(buildPetSwapAction(PET, 3, 0, 4, 0).length, 24);
  assert.throws(() => buildPetSetAction(PET, 10, 0), RangeError, "slots run 0 to 9");

  // The autocast byte is read as a signed char, so only 1 and 0 are safe.
  assert.equal(buildPetSpellAutocast(PET, 2649, true).at(-1), 1);
  assert.equal(buildPetSpellAutocast(PET, 2649, false).at(-1), 0);

  assert.equal(buildPetRename(PET, "Мурчик").at(-1), 0, "no declined block is a single zero byte");
  assert.throws(() => buildPetRename(PET, "Мурчик", ["a", "b"]), RangeError, "it is five forms or none");
  assert.equal(buildPetRename(PET, "X", ["a", "b", "c", "d", "e"]).length, 8 + 2 + 1 + 10);
});

test("the stable list counts pets before it counts slots", () => {
  const payload = bytes(
    u64(TARGET), u8(2), u8(3),
    u32(11), u32(299), u32(78), cstr("Мурчик"), u8(STABLED_PET_ACTIVE),
    u32(12), u32(1996), u32(70), cstr("Бублик"), u8(STABLED_PET_STABLED),
  );
  const stable = parseStableList(payload);
  assert.equal(stable.stableSlots, 3, "the slot total sits after the pet count, not before it");
  assert.equal(stable.pets.length, 2);
  assert.equal(stable.pets[0].flags, STABLED_PET_ACTIVE);
  assert.equal(stable.pets[0].level, 78, "the level is widened, but can never exceed 255");
  assert.equal(stable.pets[1].petNumber, 12, "the number is what identifies a pet, not its position");

  // No stable at all is ten bytes.
  const empty = parseStableList(bytes(u64(TARGET), u8(0), u8(0)));
  assert.deepEqual(empty.pets, []);

  assert.equal(parseStableResult(u8(STABLE_SUCCESS_UNSTABLE)), STABLE_SUCCESS_UNSTABLE);
  assert.equal(isStableSuccess(STABLE_SUCCESS_UNSTABLE), true);
  assert.equal(isStableSuccess(0x06), false);
});

test("a vehicle kit is announced with a packed guid, and zero means it is gone", () => {
  const gained = parsePlayerVehicleData(bytes(packed(TARGET), u32(123)));
  assert.deepEqual(gained, { guid: TARGET, vehicleId: 123 });

  const lost = parsePlayerVehicleData(bytes(packed(TARGET), u32(0)));
  assert.equal(lost.vehicleId, 0, "zero is the message, not a filler");

  // The cancel packet has no body at all.
  assert.equal(parseCancelExpectedRideVehicleAura(new Uint8Array(0)), undefined);

  // The seat index is signed, so -1 goes out as 0xFF rather than being clamped.
  assert.equal(buildRequestVehicleSwitchSeat(TARGET, -1).at(-1), 0xff);
  assert.equal(buildRequestVehicleSwitchSeat(TARGET, 2).at(-1), 2);
  assert.throws(() => buildRequestVehicleSwitchSeat(TARGET, 200), RangeError);
});

test("a swap moves the held bar, because nothing answers CMSG_PET_SET_ACTION", () => {
  // HandlePetSetAction writes no packet back at all, and it rejects a swap whose two words do not
  // match what it believes is in those slots. A bar left stale here makes the NEXT swap fail in
  // silence, so the move has to be applied locally.
  const bar = [
    { slot: 0, packed: packPetAction(COMMAND_ATTACK, ACT_COMMAND) },
    { slot: 1, packed: packPetAction(COMMAND_FOLLOW, ACT_COMMAND) },
  ].map((entry) => ({ ...entry, action: entry.packed & 0x00ffffff, type: (entry.packed >>> 24) & 0xff }));

  // The server cross-checks data[0] against position[1] and data[1] against position[0], so the
  // words are sent crossed.
  const sent = buildPetSwapAction(PET, 0, bar[1].packed, 1, bar[0].packed);
  assert.equal(sent.length, 24, "a swap is exactly twenty-four bytes, which is how the count is inferred");
  const view = new DataView(sent.buffer, sent.byteOffset, sent.byteLength);
  assert.equal(view.getUint32(8, true), 0, "position[0]");
  assert.equal(view.getUint32(12, true), bar[1].packed, "carries what is currently in slot 1");
  assert.equal(view.getUint32(16, true), 1, "position[1]");
  assert.equal(view.getUint32(20, true), bar[0].packed, "carries what is currently in slot 0");
});

test("a pet action word survives a round trip through the packer", () => {
  for (const [action, type] of [[2649, ACT_ENABLED], [COMMAND_STAY, ACT_COMMAND], [REACT_PASSIVE, ACT_REACTION]]) {
    const word = packPetAction(action, type);
    assert.equal(word & 0x00ffffff, action);
    assert.equal((word >>> 24) & 0xff, type);
  }
  // The high byte is genuinely unsigned: ACT_ENABLED is 0xC1 and must not come back negative.
  assert.equal(packPetAction(0, ACT_ENABLED) >>> 24, 0xc1);
  assert.ok(packPetAction(0, ACT_ENABLED) > 0, "the packed word is unsigned");
});
