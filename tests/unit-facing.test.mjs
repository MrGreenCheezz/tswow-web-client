import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";
import {
  EMOTE_FLAG_TURNS, SPELL_ATTR1_CHANNEL_TRACK_TARGET, SPELL_ATTR5_DONT_TURN_DURING_CAST, ShownUnitFacing, UNIT_FACING_SNAP,
  NO_UNIT_FACING_INPUTS, VEHICLE_SEAT_FLAG_ALLOW_TURNING, unitAutoFacing, unitFacingTurn, unitSeatFacing,
} from "../dist/code/world/UnitFacing.js";
import { CREATURE_MOVEMENT_CHASE_RATES, EMOTE_FLAGS } from "../dist/code/generated/animations.js";
import { UnitFacingInputsBuilder, interactionNpcGuid } from "../dist/code/world/UnitFacingSources.js";

// 22.10 ARC-2 S2a: the facing's sources are pushed data (`UnitFacingInputs`), no longer registered callbacks.
const inputs = (overrides = {}) => ({ ...NO_UNIT_FACING_INPUTS, ...overrides });
const castOf = (spellId, channel = false) => ({ spellId, startedAt: performance.now(), duration: 60_000, channel });

// 11.10: «enemies do not look toward the one they attack». The core turns a creature to its victim
// only server-side (`Unit::SetInFront` sends nothing) and leaves the drawing to the client: Wow.exe
// 0x00735f60 draws every unit that is not the active player at its UNIT_FIELD_TARGET while it stands
// and nothing forbids the turn, and follows the chosen facing smoothly.

const F = UPDATE_FIELDS;
let nextGuid = 10n;

function unit({ x = 0, y = 0, orientation = 0, typeId = 3, flags = 0, flags2 = 0, standState = 0, movementFlags = 0,
  target, channelObject, channelSpell = 0, motion, transport, emote = 0, entry = 0 } = {}) {
  const fields = new Map();
  const guid = nextGuid++;
  const put = (offset, value) => {
    if (value === undefined) return;
    fields.set(offset, Number(value & 0xffffffffn));
    fields.set(offset + 1, Number(value >> 32n));
  };
  fields.set(F.UNIT_FIELD_FLAGS.offset, flags);
  fields.set(F.UNIT_FIELD_FLAGS_2.offset, flags2);
  fields.set(F.UNIT_FIELD_BYTES_1.offset, standState);
  fields.set(F.UNIT_CHANNEL_SPELL.offset, channelSpell);
  fields.set(F.UNIT_NPC_EMOTESTATE.offset, emote); // 5.32
  fields.set(F.OBJECT_FIELD_ENTRY.offset, entry); // 5.32
  put(F.UNIT_FIELD_TARGET.offset, target);
  put(F.UNIT_FIELD_CHANNEL_OBJECT.offset, channelObject);
  return { guid, typeId, fields, movementFlags, position: { x, y, z: 0, orientation }, motion, transport };
}

function world(...objects) {
  return new Map(objects.map((object) => [object.guid, object]));
}

test("11.10 a standing creature faces its target; one that moves keeps its own facing", () => {
  const victim = unit({ x: 0, y: 5, typeId: 4 });
  const wolf = unit({ x: 0, y: 0, orientation: Math.PI, target: victim.guid });
  const objects = world(victim, wolf);
  assert.ok(Math.abs(unitAutoFacing(wolf, objects) - Math.PI / 2) < 1e-12, "toward +y is a quarter turn");
  // Moving on its own axes, or on a spline, it faces where it goes (0x00735f60: `+0x7cc & 0xf`).
  for (const flags of [MOVEMENT_FLAGS.forward, MOVEMENT_FLAGS.backward, MOVEMENT_FLAGS.strafeLeft, MOVEMENT_FLAGS.strafeRight]) {
    assert.equal(unitAutoFacing({ ...wolf, movementFlags: flags }, objects), undefined);
  }
  assert.equal(unitAutoFacing({ ...wolf, motion: {} }, objects), undefined, "a chase spline steers it");
  // Turning on the spot is not moving.
  assert.ok(unitAutoFacing({ ...wolf, movementFlags: MOVEMENT_FLAGS.turnLeft }, objects) !== undefined);
  // No target, a target out of view, a target that is no unit: nothing to face.
  assert.equal(unitAutoFacing(unit({ target: undefined }), objects), undefined);
  assert.equal(unitAutoFacing(unit({ target: 999n }), objects), undefined);
  const chest = { ...unit(), typeId: 5 };
  assert.equal(unitAutoFacing(unit({ target: chest.guid }), world(chest)), undefined);
});

test("11.10 what keeps a unit's own facing: a player, a stun, CANNOT_TURN, possession, a seat, sitting", () => {
  const victim = unit({ x: 3, y: 0 });
  const objects = world(victim);
  const facing = (options) => unitAutoFacing(unit({ target: victim.guid, ...options }), objects);
  assert.equal(facing({}), 0, "the control case faces +x");
  assert.equal(facing({ typeId: 4 }), undefined, "a player turns itself");
  assert.equal(facing({ flags: 0x0004_0000 }), undefined, "UNIT_FLAG_STUNNED");
  assert.equal(facing({ flags: 0x0100_0000 }), undefined, "UNIT_FLAG_POSSESSED");
  assert.equal(facing({ flags2: 0x0000_8000 }), undefined, "UNIT_FLAG2_CANNOT_TURN");
  assert.equal(facing({ standState: 1 }), undefined, "sitting: the stand state must be 0 (vtable+0x138)");
  assert.equal(facing({ standState: 0x0300 }), 0, "only byte 0 of UNIT_FIELD_BYTES_1 is the stand state");
  // A vehicle seat keeps its facing; a ship's deck does not.
  const vehicle = unit({ x: 9, y: 9 });
  const ship = { ...unit({ x: 9, y: 9 }), typeId: 5 };
  const aboard = (carrier) => unitAutoFacing(unit({ target: victim.guid, transport: { guid: carrier.guid } }), world(victim, carrier));
  assert.equal(aboard(vehicle), undefined);
  assert.equal(aboard(ship), 0);
  // Pet-like flags do not stop it: UNIT_FLAG_PLAYER_CONTROLLED and PET_IN_COMBAT.
  assert.equal(facing({ flags: 0x0000_0808 }), 0);
});

test("11.10 a channel that tracks its target faces the channel's object", () => {
  const victim = unit({ x: 3, y: 0 });
  const totem = unit({ x: 0, y: -3 });
  const objects = world(victim, totem);
  const caster = unit({ target: victim.guid, channelObject: totem.guid, channelSpell: 1234 });
  const tracks = (spellId) => (spellId === 1234 ? true : undefined);
  assert.ok(Math.abs(unitAutoFacing(caster, objects, tracks) + Math.PI / 2) < 1e-12, "SPELL_ATTR1_CHANNEL_TRACK_TARGET");
  assert.equal(unitAutoFacing(caster, objects, () => false), 0, "any other channel keeps the target");
  assert.equal(unitAutoFacing(caster, objects, () => undefined), 0, "and so does an unknown row");
  assert.equal(SPELL_ATTR1_CHANNEL_TRACK_TARGET, 0x4000);
});

test("11.10 the drawn facing takes half the averaged difference a frame, and never overshoots", () => {
  const shown = new ShownUnitFacing();
  assert.equal(shown.step(1, "average", 1 / 60), 1, "the first frame draws the chosen facing");
  // A turn of a quarter: half of it on the first frame, then half the average of the last four.
  const quarter = 1 + Math.PI / 2;
  assert.ok(Math.abs(shown.step(quarter, "average", 1 / 60) - (1 + Math.PI / 4)) < 1e-12);
  let previous = shown.angle;
  for (let frame = 0; frame < 30; frame++) {
    const next = shown.step(quarter, "average", 1 / 60);
    assert.ok(next >= previous - 1e-12 && next <= quarter + 1e-12, `frame ${frame}: ${next}`);
    previous = next;
  }
  assert.equal(shown.angle, quarter, "inside UNIT_FACING_SNAP it lands exactly");
  assert.equal(UNIT_FACING_SNAP, 0.01);
  // The short way round across ±π.
  const across = new ShownUnitFacing();
  across.step(3, "average", 1 / 60);
  const stepped = across.step(-3, "average", 1 / 60);
  assert.ok(stepped > 3 || stepped < -3, `went the long way: ${stepped}`);
});

test("11.10 a pet's drawn facing springs at 20 rad/s, 30 in combat", () => {
  assert.equal(unitFacingTurn(unit({})), "average");
  assert.equal(unitFacingTurn(unit({ typeId: 4, flags: 0x8 })), "average", "a player averages whatever its flags");
  assert.equal(unitFacingTurn(unit({ flags: 0x8 })), 20);
  assert.equal(unitFacingTurn(unit({ flags: 0x808 })), 30);
  const shown = new ShownUnitFacing();
  shown.step(0, 20, 1 / 60);
  let angle = 0;
  for (let frame = 0; frame < 6; frame++) angle = shown.step(1, 20, 1 / 60);
  assert.ok(angle > 0.5 && angle < 1, `a tenth of a second in: ${angle}`);
  for (let frame = 0; frame < 60; frame++) angle = shown.step(1, 20, 1 / 60);
  assert.ok(Math.abs(angle - 1) < 1e-3, `a second in: ${angle}`);
});

test("11.10 the renderer draws a unit it does not move at that facing, and the character at its own", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("    unit.node.position.set(position.x, position.z, -position.y);");
  const end = source.indexOf("const content = unitContentVisible(", start);
  assert.ok(start > 0 && end > start, "the unit's placement in #drawUnit");
  const yaw = source.slice(start, end);
  assert.match(yaw, /unit\.node\.rotation\.y = mover \|\| world === undefined \? position\.orientation/);
  // 5.32: the active player reaches it (an interaction window turns an NPC), and a seat is turned in the seat.
  // 22.10 ARC-2 S2a: with the frame's pushed facing inputs.
  assert.match(yaw, /unitAutoFacing\(object, world\.objects, undefined, world\.selfGuid, this\.#inputs\.facing\) \?\? position\.orientation,\s*unitFacingTurn\(object, this\.#inputs\.facing\), elapsed/);
  assert.match(yaw, /unitSeatFacing\(object, world\.objects, seat\.flags, this\.#drawnVehicleFacing, world\.selfGuid, undefined,\s*this\.#inputs\.facing\) \?\? own/);
  assert.match(yaw, /unit\.seatFacing = local;\s*unit\.node\.rotation\.y = position\.orientation \+ local - own;/);
  assert.match(yaw, /const mover = self \|\| \(world !== undefined && world\.predictedGuid === object\.guid\)/);
  assert.match(source, /this\.#unitShadowCasters\.decide\(object\.guid, rank, distance, this\.#lightingProfile\),[^\n]*\n\s*state\);/,
    "the frame's world state reaches #drawUnit");
});

// ---- 5.32: the rest of 0x00735f60 ----------------------------------------------------------------

const near = (actual, expected, message = "") => assert.ok(Math.abs(actual - expected) < 1e-12, `${message} ${actual} ≠ ${expected}`);
const generated = Object.keys(EMOTE_FLAGS).length > 0 ? false : "the generated Emotes.dbc / CreatureMovementInfo.dbc tables are absent";

test("5.32 an emote state whose Emotes.dbc row lacks 0x2000 keeps the unit's own facing", { skip: generated }, () => {
  const victim = unit({ x: 3, y: 0 });
  const objects = world(victim);
  const facing = (emote) => unitAutoFacing(unit({ target: victim.guid, emote }), objects);
  assert.equal(EMOTE_FLAG_TURNS, 0x2000);
  // The base dataset: ONESHOT_TALK (1) lacks it, READY_UNARMED (27) and READY1H (333) carry it.
  assert.equal(EMOTE_FLAGS[1] & EMOTE_FLAG_TURNS, 0);
  assert.notEqual(EMOTE_FLAGS[27] & EMOTE_FLAG_TURNS, 0);
  assert.notEqual(EMOTE_FLAGS[333] & EMOTE_FLAG_TURNS, 0);
  assert.equal(facing(1), undefined, "talking: its own facing");
  assert.equal(facing(27), 0, "a ready stance turns");
  assert.equal(facing(0), 0, "no emote state");
  assert.equal(facing(999_999), 0, "a row that is not there forbids nothing");
});

test("5.32 not while casting a spell with SPELL_ATTR5_DONT_TURN_DURING_CAST (0x00722640)", () => {
  assert.equal(SPELL_ATTR5_DONT_TURN_DURING_CAST, 0x80000);
  const victim = unit({ x: 3, y: 0 });
  const caster = unit({ target: victim.guid });
  const objects = world(victim, caster);
  const spellAttributes = new Map([[700, [0, 0, 0, 0, 0, 0x80000, 0, 0]], [701, [0, 0, 0, 0, 0, 0x40000, 0, 0]]]);
  const casting = (spellId, cast = castOf(spellId)) =>
    unitAutoFacing(caster, objects, undefined, undefined, inputs({ spellAttributes, casts: new Map([[caster.guid, cast]]) }));
  assert.equal(casting(700), undefined, "AttributesEx5 0x80000");
  assert.equal(casting(701), 0, "another bit");
  assert.equal(casting(702), 0, "a row not known");
  assert.equal(unitAutoFacing(caster, objects, undefined, undefined, inputs({ spellAttributes })), 0, "not casting");
  // The cast is +0xa60 only while it runs, and never a channel.
  assert.equal(casting(700, { ...castOf(700), startedAt: performance.now() - 10_000, duration: 1_000 }), 0, "run its time");
  assert.equal(casting(700, castOf(700, true)), 0, "a channel is not +0xa60");
  assert.equal(unitAutoFacing(caster, objects), 0, "no inputs: nothing there");
});

test("22.10 ARC-2 S2a: a channel's tracking is read off the pushed spell rows when no reader is given", () => {
  const victim = unit({ x: 3, y: 0 });
  const totem = unit({ x: 0, y: -3 });
  const objects = world(victim, totem);
  const caster = unit({ target: victim.guid, channelObject: totem.guid, channelSpell: 1234 });
  const rows = (word) => inputs({ spellAttributes: new Map([[1234, [0, word, 0, 0, 0, 0, 0, 0]]]) });
  near(unitAutoFacing(caster, objects, undefined, undefined, rows(SPELL_ATTR1_CHANNEL_TRACK_TARGET)), -Math.PI / 2, "tracks");
  assert.equal(unitAutoFacing(caster, objects, undefined, undefined, rows(0)), 0, "another channel keeps the target");
  assert.equal(unitAutoFacing(caster, objects), 0, "no rows: not known");
});

test("5.32 with no target an NPC faces the player whose interaction window is open on it (0x00bd07a8)", () => {
  const player = unit({ x: 0, y: 4, typeId: 4 });
  const vendor = unit({ orientation: 1 });
  const other = unit({ x: 5, y: 0 });
  const objects = world(player, vendor, other);
  near(unitAutoFacing(vendor, objects, undefined, player.guid, inputs({ interactionNpc: vendor.guid })), Math.PI / 2,
    "toward the player");
  assert.equal(unitAutoFacing(vendor, objects, undefined, undefined, inputs({ interactionNpc: vendor.guid })), undefined,
    "no active player, nobody to face");
  const busy = unit({ orientation: 1, target: other.guid });
  assert.equal(unitAutoFacing(busy, world(player, busy, other), undefined, player.guid, inputs({ interactionNpc: busy.guid })), 0,
    "its target first");
  assert.equal(unitAutoFacing(vendor, objects, undefined, player.guid, inputs({ interactionNpc: other.guid })), undefined,
    "another NPC's window");
  // The windows that set it, read off the world client.
  const none = {
    casts: new Map(), creatureTemplates: new Map(), gossip: undefined, questDialog: undefined, questList: undefined,
    vendor: undefined, trainer: undefined, taxiMenu: undefined, bankerGuid: undefined, auctioneerGuid: 0n,
    tabardVendorGuid: 0n, petitionVendor: undefined, stable: undefined, stableMasterGuid: 0n,
  };
  assert.equal(interactionNpcGuid(none), undefined);
  assert.equal(interactionNpcGuid(undefined), undefined);
  for (const [key, value, guid] of [
    ["gossip", { guid: 7n }, 7n], ["questDialog", { guid: 8n }, 8n], ["questList", { guid: 9n }, 9n],
    ["vendor", { guid: 10n }, 10n], ["trainer", { guid: 11n }, 11n], ["taxiMenu", { guid: 12n }, 12n],
    ["bankerGuid", 13n, 13n], ["auctioneerGuid", 14n, 14n], ["tabardVendorGuid", 15n, 15n],
    ["petitionVendor", { vendorGuid: 16n }, 16n],
  ]) {
    assert.equal(interactionNpcGuid({ ...none, [key]: value }), guid, key);
  }
  assert.equal(interactionNpcGuid({ ...none, stableMasterGuid: 17n }), undefined, "a stable master with its list shut");
  assert.equal(interactionNpcGuid({ ...none, stable: {}, stableMasterGuid: 17n }), 17n);
  // 22.10 ARC-2 S2a: the builder hands over the world's own casts and its interaction NPC, and collects the
  // entries' movement ids again only when the template cache changed.
  const casts = new Map([[1n, castOf(5)]]);
  const creatureTemplates = new Map([[42, { movementId: 441 }]]);
  const builder = new UnitFacingInputsBuilder();
  const live = { ...none, casts, creatureTemplates, gossip: { guid: 7n }, creatureTemplatesRevision: 1 };
  const built = builder.build(live, new Map([[5, [1, 2, 3, 4, 5, 6, 7, 8]]]));
  assert.equal(built.casts, casts, "the world's own map");
  assert.equal(built.interactionNpc, 7n);
  assert.deepEqual([...built.movementIds], [[42, 441]]);
  assert.deepEqual([...built.spellAttributes], [[5, [1, 2, 3, 4, 5, 6, 7, 8]]]);
  creatureTemplates.set(43, { movementId: 801 });
  assert.equal(builder.build(live, undefined).movementIds.has(43), false, "the same revision: not collected again");
  live.creatureTemplatesRevision++;
  assert.equal(builder.build(live, undefined).movementIds.get(43), 801, "a new revision: collected");
  assert.equal(builder.build(undefined, undefined).movementIds.size, 0, "no world: nothing");
  assert.equal(builder.build(undefined, undefined).interactionNpc, undefined);
});

test("5.32 a creature whose CreatureMovementInfo row names a SmoothFacingChaseRate springs at it", { skip: generated }, () => {
  // The base dataset: row 441 is 10 rad/s, 801 a quarter, 41 none.
  assert.equal(CREATURE_MOVEMENT_CHASE_RATES[441], 10);
  assert.equal(CREATURE_MOVEMENT_CHASE_RATES[801], 0.25);
  assert.equal(CREATURE_MOVEMENT_CHASE_RATES[41], undefined);
  const movement = (movementId) => inputs({ movementIds: new Map([[42, movementId]]) });
  assert.equal(unitFacingTurn(unit({ entry: 42 }), movement(441)), 10);
  assert.equal(unitFacingTurn(unit({ entry: 42, flags: 0x808 }), movement(441)), 10, "before the pet's spring");
  assert.equal(unitFacingTurn(unit({ entry: 42, typeId: 4 }), movement(441)), "average", "a player has no creature row");
  assert.equal(unitFacingTurn(unit({ entry: 0 }), movement(441)), "average", "no entry, no row");
  assert.equal(unitFacingTurn(unit({ entry: 42 }), movement(801)), 0.25);
  assert.equal(unitFacingTurn(unit({ entry: 42 }), movement(41)), "average", "a row of 0");
  assert.equal(unitFacingTurn(unit({ entry: 42, flags: 0x8 }), movement(41)), 20);
});

test("5.32 a passenger on a seat with VEHICLE_SEAT_FLAG_ALLOW_TURNING turns in its seat", () => {
  assert.equal(VEHICLE_SEAT_FLAG_ALLOW_TURNING, 0x400);
  const victim = unit({ x: 0, y: 5 });
  const vehicle = unit({ orientation: 0.5 });
  const gunner = unit({ target: victim.guid, transport: { guid: vehicle.guid, orientation: 0.1 } });
  const objects = world(victim, vehicle, gunner);
  const vehicleFacing = (carrier) => carrier.position.orientation;
  near(unitSeatFacing(gunner, objects, VEHICLE_SEAT_FLAG_ALLOW_TURNING, vehicleFacing), Math.PI / 2 - 0.5,
    "the angle to its target less the vehicle's facing (0x00717e50)");
  assert.equal(unitSeatFacing(gunner, objects, 0x1, vehicleFacing), undefined, "a seat that does not turn its passenger");
  near(unitSeatFacing(gunner, objects, undefined, vehicleFacing), Math.PI / 2 - 0.5, "no seat row: turned, as Wow.exe");
  assert.equal(unitSeatFacing(gunner, world(victim, gunner), 0x400, vehicleFacing), undefined, "the vehicle not in view");
  assert.equal(unitSeatFacing({ ...gunner, transport: undefined }, objects, 0x400, vehicleFacing), undefined);
  assert.equal(unitAutoFacing(gunner, objects), undefined, "the world facing leaves a seat alone");
  // Wrapped into −π…π: a target behind a vehicle facing 3.
  const behind = unit({ target: victim.guid, transport: { guid: vehicle.guid, orientation: 0 } });
  near(unitSeatFacing(behind, objects, 0x400, () => 3), Math.PI / 2 - 3);
  near(unitSeatFacing(behind, objects, 0x400, () => -3), Math.PI / 2 + 3 - 2 * Math.PI);
  // The rest of 0x00735f60 holds on a seat too.
  const stunned = unit({ target: victim.guid, flags: 0x0004_0000, transport: { guid: vehicle.guid, orientation: 0 } });
  assert.equal(unitSeatFacing(stunned, world(victim, vehicle, stunned), 0x400, vehicleFacing), undefined);
});
