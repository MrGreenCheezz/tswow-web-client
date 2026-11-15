import assert from "node:assert/strict";
import test from "node:test";

// 5.05 / 6.04 / 6.06 (15.11, combat7). Wow.exe 3.3.5a 12340, read-only Ghidra (.runtime/re-2026-11-15/combat7/,
// re-2026-10-11/glue-1110/s608-2.txt, re-2026-11-11/combat4/c1.c):
// * 0x00737aa0, the UNIT_FIELD_BYTES_2 sheath-byte callback (0x00741d00 registers it for offset 0x1d0): for the active
//   player the server's new byte is taken only while the held state (+0xb5c) still equals the old byte; the own model
//   hangs its pieces by the held state (world/SheathSetter.ts `shown`, pushed to the renderer as RenderInputs.ownSheath);
// * 0x00756800 case 0x14a: a known attacker's swing draws its melee weapons (0x00736d30(1, 1, 0)), the packet for the player;
// * 0x0073b050's ParryUnarmed by the shown sheath (browser/ShownParry.ts), not the byte;
// * 0x00714dd0, the melee stance selector of the attack-stance rung 0x0071e0d0;
// * 0x0080cce0's OverrideSpellData refusal (0x007fe820), the route /dbc/override-spells?v=1;
// * the cues hold while the attacker's swing waits for its clip (no nominal clock before the swing).

const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { ANIMATION_DATA_AVAILABLE, ANIMATION_IDS: A } = await import("../dist/code/generated/animations.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { SheathSetter } = await import("../dist/code/world/SheathSetter.js");
const { castPreflightRefusal, overrideSpellRefused, SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW } =
  await import("../dist/code/world/CastPreflightRule.js");
const { shownParryPayload } = await import("../dist/code/browser/ShownParry.js");
const { UnitShownSheath, swungAt } = await import("../dist/code/browser/UnitShownSheath.js");
const { readyStance, READY_UNARMED } = await import("../dist/code/browser/UnitStandingPose.js");
const { ownSheathRefused, pendingOwnSheathRequest, requestOwnSheath, resetOwnSheath, stepOwnSheath } =
  await import("../dist/code/browser/SheathCeremony.js");
const { setRenderClockOffset } = await import("../dist/code/browser/RenderClock.js");
const { OwnAnimationSheath } = await import("../dist/code/browser/game/OwnAnimationSheath.js");
const { RenderInputsReceiver, RenderInputsSender } = await import("../dist/code/browser/RenderTablesBridge.js");
const { NO_RENDER_INPUTS } = await import("../dist/code/browser/RenderInputs.js");
const { SwingMeleeReactions } = await import("../dist/code/browser/game/SwingReactionHost.js");
const { HITINFO_AFFECTS_VICTIM, VICTIMSTATE_HIT } = await import("../dist/code/world/CombatProtocol.js");
const { overrideSpellCatalog, OVERRIDE_SPELLS_VERSION, OVERRIDE_SPELL_DATA_LAYOUT } =
  await import("../dist/code/gateway/OverrideSpellMetadata.js");
const { parseFixed } = await import("../dist/code/gateway/DbcFixed.js");
const { CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const { overrideSpellRowsFrom, OVERRIDE_SPELLS_ROUTE_VERSION } = await import("../dist/code/browser/OverrideSpellClient.js");
import { fakeWorldConnection, loginVerifyWorldPacket, settle } from "./fixtures/world-packets.mjs";

const withData = { skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data" };
const SELF = 0x1234n;
const OTHER = 0x5678n;
const BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;

/** SMSG_UPDATE_OBJECT with one VALUES block (UpdateData::BuildPacket, Object::BuildValuesUpdate). */
function valuesUpdate(guid, values) {
  const indices = Object.keys(values).map(Number).sort((a, b) => a - b);
  const blocks = Math.floor(indices.at(-1) / 32) + 1;
  const mask = new Array(blocks).fill(0);
  for (const index of indices) mask[index >> 5] |= 1 << (index & 31);
  const writer = new PacketWriter().u32(1).u8(0).packedGuid(guid).u8(blocks);
  for (const word of mask) writer.u32(word >>> 0);
  for (const index of indices) writer.u32(values[index] >>> 0);
  return writer.toUint8Array();
}

/** SMSG_ATTACKERSTATEUPDATE as Unit::SendAttackStateUpdate writes a one-school hit. */
function attackerStateUpdate(attacker, victim) {
  return new PacketWriter().u32(HITINFO_AFFECTS_VICTIM).packedGuid(attacker).packedGuid(victim).u32(10).u32(0).u8(1)
    .u32(1).f32(10).u32(10).u8(VICTIMSTATE_HIT).u32(0).u32(0).toUint8Array();
}

async function client() {
  const connection = fakeWorldConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: loginVerifyWorldPacket() }]);
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  world.state.objects.get(SELF).typeId = 4;
  world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  await world.loginCharacter(SELF);
  await settle();
  world.state.move(OTHER, { flags: 0, position: { x: 12, y: 20, z: 30, orientation: 0 } });
  world.state.objects.get(OTHER).typeId = 3;
  connection.sent.length = 0;
  const sheaths = () => connection.sentOf(OPCODES.CMSG_SET_SHEATHED).map(({ payload }) => payload[0]);
  const serverByte = async (value) => {
    connection.push(OPCODES.SMSG_UPDATE_OBJECT, valuesUpdate(SELF, { [BYTES_2]: value }));
    await settle();
  };
  return { world, connection, sheaths, serverByte };
}

test("the setter: a new object holds its CREATE byte; the client's own state shows at once", () => {
  const setter = new SheathSetter();
  assert.equal(setter.shown(1), 1, "nothing held: the byte");
  setter.reset(1);
  assert.equal(setter.held, 1, "the CREATE block's byte is held");
  assert.equal(setter.shown(0), 1, "a later byte does not move it");
  assert.equal(setter.request(0, 0), true);
  assert.equal(setter.shown(1), 0, "held 0 shows at once, before any echo");
});

/** SMSG_UPDATE_OBJECT with one CREATE_OBJECT block of the player: LIVING movement, nine speeds, the sheath byte. */
function selfCreate(sheath) {
  const writer = new PacketWriter().u32(1).u8(2).packedGuid(SELF).u8(4).u16(0x0020)
    .u32(0).u16(0).u32(0).f32(10).f32(20).f32(30).f32(0).u32(0);
  for (let speed = 0; speed < 9; speed++) writer.f32(speed + 1);
  const blocks = Math.floor(BYTES_2 / 32) + 1;
  writer.u8(blocks);
  for (let block = 0; block < blocks; block++) writer.u32(block === BYTES_2 >> 5 ? (1 << (BYTES_2 & 31)) >>> 0 : 0);
  writer.u32(sheath);
  return writer.toUint8Array();
}

test("the world client: the own model holds the CREATE byte and its own requests; later byte changes move nothing", async () => {
  const { world, connection, sheaths, serverByte } = await client();
  world.state.destroy(SELF);
  world.state.selfGuid = SELF; // the destroy forgets it; a login names it before the CREATE
  connection.push(OPCODES.SMSG_UPDATE_OBJECT, selfCreate(1)); // login with the byte 1 (sheath6-calib: a later 0 → 1 drew nothing)
  await settle();
  assert.equal(world.ownSheathShown, 1, "right after the create: the server's byte, drawn");
  await serverByte(0);
  assert.equal(world.ownSheathShown, 1, "a VALUES change of the byte does not move the own model");
  world.setSheathed(0);
  assert.equal(world.ownSheathShown, 0, "put away in the frame of the request, not at the echo");
  await serverByte(1);
  await serverByte(0); // the echo, late
  assert.equal(world.ownSheathShown, 0);
  world.setSheathed(1);
  assert.equal(world.ownSheathShown, 1);
  assert.deepEqual(sheaths(), [0, 1]);
  world.close();
});

test("0x00756800 case 0x14a: the player's own swing draws melee — one SET_SHEATHED 1, none for another's", async () => {
  const { world, connection, sheaths } = await client();
  connection.push(OPCODES.SMSG_ATTACKERSTATEUPDATE, attackerStateUpdate(OTHER, SELF));
  await settle();
  assert.deepEqual(sheaths(), [], "another unit's swing");
  connection.push(OPCODES.SMSG_ATTACKERSTATEUPDATE, attackerStateUpdate(SELF, OTHER));
  connection.push(OPCODES.SMSG_ATTACKERSTATEUPDATE, attackerStateUpdate(SELF, OTHER));
  await settle();
  assert.deepEqual(sheaths(), [1], "held 1 after the first: the second sends nothing");
  assert.equal(world.ownSheathShown, 1);
  world.close();
});

test("another unit's swing draws its shown melee weapons at once (swungAt)", () => {
  const shown = new UnitShownSheath(0, 3);
  swungAt(shown);
  assert.equal(shown.held, 1);
  shown.held = 2;
  swungAt(shown);
  assert.equal(shown.held, 1, "0x00736d30(1, 1, 0) whatever is held");
  swungAt(undefined); // a unit not judged yet: nothing to change
});

test("0x0073b050 by the shown sheath: ParryUnarmed only while the weapons are shown away", () => {
  const parry = { action: undefined, reaction: "parry" };
  assert.equal(shownParryPayload(parry, 0).reaction, "parryUnarmed");
  assert.equal(shownParryPayload(parry, 1), parry);
  assert.equal(shownParryPayload(parry, undefined), parry, "not judged yet: armed");
  const dodge = { action: undefined, reaction: "dodge" };
  assert.equal(shownParryPayload(dodge, 0), dodge);
});

test("6.04: the melee stance is 0x00714dd0's table — main hand, else the off hand's weapon", withData, () => {
  const weapon = (slot, inventoryType, subClass) => ({ slot, inventoryType, ...(subClass === undefined ? {} : { subClass }) });
  assert.equal(readyStance([weapon(15, 17, 12)], 1)[0], A.Ready2H, "exotic2 is a two-hander (WeaponReadySeq said 1H)");
  assert.equal(readyStance([weapon(15, 17, 20)], 1)[0], A.Ready1H, "a fishing pole is Ready1H (WeaponReadySeq said 2HL)");
  assert.equal(readyStance([weapon(15, 17, 8), weapon(16, 22, 7)], 1)[0], A.Ready1H, "Titan's Grip: 2H with an off hand");
  assert.equal(readyStance([weapon(16, 22, 15)], 1)[0], A.Ready1H, "no main-hand weapon: the off hand's dagger");
  assert.equal(readyStance([weapon(16, 14, 6)], 1), READY_UNARMED, "a shield is not a weapon");
  assert.equal(readyStance([weapon(15, 13, 9)], 1), READY_UNARMED, "subclass 9: no case");
  assert.equal(readyStance([weapon(15, 17, 10)], 1)[0], A.Ready2HL);
  assert.equal(readyStance([weapon(15, 17, 8)], 0), undefined, "weapons shown away: no stance (open, 14.25)");
});

test("the own ceremony starts from what the model showed, though the pushed state is already the target", () => {
  resetOwnSheath();
  const pieces = () => [{ slot: 15, inventoryType: 17, sheathe: 1 }];
  const pointOf = (_piece, sheath) => (sheath === 1 ? 1 : 26);
  const rig = { model: undefined, animations: new Set([89, 90]), keyBones: undefined, clip: () => ({ duration: 1, blend: 0.1 }) };
  requestOwnSheath(1, 100);
  const ceremony = stepOwnSheath(undefined, 1, 100, pieces, pointOf, rig, 0);
  assert.equal(ceremony?.from, 0);
  assert.equal(ceremony?.to, 1);
  assert.equal(ceremony?.arms.length, 1);
  requestOwnSheath(1, 200);
  assert.equal(stepOwnSheath(undefined, 1, 200, pieces, pointOf, rig, 1), undefined, "already shown: nothing to play");
  resetOwnSheath();
});

test("RenderInputs.ownSheath crosses to the worker", () => {
  const receiver = new RenderInputsReceiver();
  const sender = new RenderInputsSender();
  assert.equal(receiver.apply(sender.encode({ ...NO_RENDER_INPUTS, ownSheath: 2 })).ownSheath, 2);
  assert.equal(receiver.apply(sender.encode({ ...NO_RENDER_INPUTS })).ownSheath, undefined);
});

test("follow-up: the own ToggleSheath crosses to the worker on its clock and plays its ceremony once", () => {
  resetOwnSheath();
  setRenderClockOffset(-1_000); // a worker whose clock started a second after the page's
  try {
    const sender = new RenderInputsSender();
    const receiver = new RenderInputsReceiver();
    requestOwnSheath(1, 5_000);
    const request = pendingOwnSheathRequest();
    const first = sender.encode({ ...NO_RENDER_INPUTS, ownSheath: 1, ownSheathRequest: request });
    assert.deepEqual(structuredClone(first.ownSheathRequest), first.ownSheathRequest);
    const pushed = receiver.apply(first).ownSheathRequest;
    assert.equal(pushed.at, 4_000, "the page's moment on the worker's clock");
    const again = sender.encode({ ...NO_RENDER_INPUTS, ownSheath: 1, ownSheathRequest: request });
    assert.equal(again.ownSheathRequest.changed, false, "the same record is not sent again");
    const pieces = () => [{ slot: 15, inventoryType: 17, sheathe: 1 }];
    const pointOf = (_piece, sheath) => (sheath === 1 ? 1 : 26);
    const rig = { model: undefined, animations: new Set([89, 90]), keyBones: undefined, clip: () => ({ duration: 1, blend: 0.1 }) };
    const ceremony = stepOwnSheath(undefined, 1, 4_010, pieces, pointOf, rig, 0, receiver.apply(again).ownSheathRequest);
    assert.equal(ceremony?.to, 1, "the worker's renderer starts the arm clips");
    assert.equal(stepOwnSheath(undefined, 1, 4_020, pieces, pointOf, rig, 1, pushed), undefined, "taken once by its serial");
    assert.equal(stepOwnSheath(undefined, 1, 4_030, pieces, pointOf, rig, 1, null), undefined, "none pushed: nothing");
  } finally {
    setRenderClockOffset(0);
    resetOwnSheath();
  }
});

test("follow-up: a worker renderer's rig guards reach the page's ToggleSheath, on the page's clock", () => {
  resetOwnSheath();
  setRenderClockOffset(-1_000);
  try {
    const own = new OwnAnimationSheath();
    // The record as it comes out of a worker (a structured clone): the arms busy until 4 500 on the worker's clock.
    own.afterDraw(undefined, structuredClone({ guid: 1n, animation: 0, starts: 0, keep: false,
      rig: { refuses: false, busyUntil: 4_500, at: 4_000 } }));
    assert.equal(ownSheathRefused(5_400), true, "the arms still play (5 500 on the page's clock)");
    assert.equal(ownSheathRefused(5_600), false);
  } finally {
    setRenderClockOffset(0);
    resetOwnSheath();
  }
});

test("follow-up: the fixed facings cross to the worker; an unchanged empty map sends nothing", () => {
  const facings = new Map();
  const inputs = (map) => ({ ...NO_RENDER_INPUTS, facing: { ...NO_RENDER_INPUTS.facing, fixedFacings: map } });
  const sender = new RenderInputsSender();
  const receiver = new RenderInputsReceiver();
  receiver.apply(sender.encode(inputs(facings)));
  assert.equal(sender.encode(inputs(facings)).fixedFacings, undefined, "empty and unchanged: no delta, nothing built");
  facings.set(0x1234n, 1.25);
  const facing = receiver.apply(sender.encode(inputs(facings))).facing;
  assert.equal(facing.fixedFacings.get(0x1234n), 1.25);
  facings.clear();
  assert.equal(receiver.apply(sender.encode(inputs(facings))).facing.fixedFacings.size, 0, "a revival clears it there too");
  assert.equal(receiver.apply(sender.encode(inputs(undefined))).facing.fixedFacings, undefined, "no world: none");
});

test("6.06: a swing waiting for its clip holds the cues — no nominal clock before the swing", () => {
  const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
  const world = { objects: new Map([[11n, { fields: new Map([[HEALTH, 100]]) }], [22n, { fields: new Map([[HEALTH, 100]]) }]]) };
  const results = { swings: new Map(), swingFrame: 0, swingNow: 0 };
  const reacted = [];
  let id;
  const renderer = {
    results,
    playUnitAction(_guid, _action, _hold, given) { id = given; return given; },
    playUnitReaction(_guid, reaction) { reacted.push(reaction); },
    releaseUnitAction() {},
    setMeleeTargets() {},
  };
  const reactions = new SwingMeleeReactions(world, () => renderer);
  reactions.swing({ attacker: 11n, victim: 22n, hitInfo: HITINFO_AFFECTS_VICTIM, victimState: VICTIMSTATE_HIT, blocked: 0 }, "attack");
  const frame = (now, row) => {
    results.swings.set(id, { swingSeconds: undefined, ...row });
    results.swingFrame++;
    results.swingNow = now;
    reactions.afterDraw();
  };
  frame(0, { progress: undefined, started: false, waitingForClip: true });
  frame(3_000, { progress: undefined, started: false, waitingForClip: true });
  assert.deepEqual(reacted, [], "three nominal swings later: still nothing");
  frame(3_100, { progress: 1, started: true, waitingForClip: false });
  assert.deepEqual(reacted, ["standWound"], "at the drawn swing's own events");
  // Follow-up: a swing whose wait ran out unplayed (it left the queue: progress null) reacts then, not never.
  reactions.swing({ attacker: 11n, victim: 22n, hitInfo: HITINFO_AFFECTS_VICTIM, victimState: VICTIMSTATE_HIT, blocked: 0 }, "attack");
  frame(4_000, { progress: undefined, started: false, waitingForClip: true });
  assert.equal(reacted.length, 1);
  frame(7_000, { progress: null, started: false, waitingForClip: true });
  assert.deepEqual(reacted, ["standWound", "standWound"], "the wait is over: the reaction plays at once");
  // Follow-up: the attacker's next swing arrives while the previous one still waits: that one reacts first.
  reactions.swing({ attacker: 11n, victim: 22n, hitInfo: HITINFO_AFFECTS_VICTIM, victimState: VICTIMSTATE_HIT, blocked: 0 }, "attack");
  frame(7_100, { progress: undefined, started: false, waitingForClip: true });
  reactions.swing({ attacker: 11n, victim: 22n, hitInfo: HITINFO_AFFECTS_VICTIM, victimState: VICTIMSTATE_HIT, blocked: 0 }, "attack");
  assert.equal(reacted.length, 3, "flushed by the next swing: played, not dropped");
  reactions.dispose();
});

/** A WDBC image of "niiiiiiiiiix" records, no strings. */
function overrideImage(rows) {
  const data = Buffer.alloc(20 + rows.length * 48 + 1);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(12, 8);
  data.writeUInt32LE(48, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach((row, index) => row.forEach((value, field) => data.writeInt32LE(value, 20 + index * 48 + field * 4)));
  return data;
}

// Two rows of this dataset's OverrideSpellData.dbc (read 15.11): 61 restricts (Flags 0), 1 does not (Flags 5).
const ROW_61 = [61, 62634, 62479, 62473, 62471, 0, 62428, 0, 0, 0, 0, 0];
const ROW_1 = [1, 40430, 59351, 31262, 61721, 0, 0, 0, 0, 0, 0, 5];

test("/dbc/override-spells: every record, the client and the gateway agree on ?v=", () => {
  const catalog = overrideSpellCatalog(parseFixed("OverrideSpellData", overrideImage([ROW_61, ROW_1]), OVERRIDE_SPELL_DATA_LAYOUT));
  assert.deepEqual(catalog.rows[0], [61, 0, 62634, 62479, 62473, 62471, 0, 62428, 0, 0, 0, 0]);
  assert.equal(OVERRIDE_SPELLS_VERSION, OVERRIDE_SPELLS_ROUTE_VERSION);
  assert.ok(CATALOG_ROUTES.some((route) => route.pathname === "/dbc/override-spells" && route.version === OVERRIDE_SPELLS_VERSION));
  const rows = overrideSpellRowsFrom(catalog);
  assert.deepEqual(rows.get(1), { flags: 5, spells: [40430, 59351, 31262, 61721, 0, 0, 0, 0, 0, 0] });
  assert.equal(overrideSpellRowsFrom({ version: 2, rows: [] }), undefined);
  assert.equal(overrideSpellRowsFrom({ version: 1, rows: [[1, 2, 3]] }), undefined);
});

test("0x0080cce0: a spell outside a restricting OverrideSpellData row is CANT_DO_THAT_RIGHT_NOW, before anything else", () => {
  const rows = overrideSpellRowsFrom(overrideSpellCatalog(parseFixed("OverrideSpellData", overrideImage([ROW_61, ROW_1]),
    OVERRIDE_SPELL_DATA_LAYOUT)));
  const caster = (row) => ({ health: 100, playerFlags: 0, rangedItem: undefined, overrideSpells: row });
  const plain = (id) => ({ id, attributes: [0, 0, 0], effect0: 6 });
  assert.equal(overrideSpellRefused(62479, rows.get(61)), false, "one of the row's ten");
  assert.equal(castPreflightRefusal(plain(40430), caster(rows.get(61))), SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW);
  assert.equal(castPreflightRefusal(plain(62428), caster(rows.get(61))), undefined);
  assert.equal(castPreflightRefusal(plain(62428), caster(rows.get(1))), undefined, "Flags 0x4: no restriction");
  assert.equal(castPreflightRefusal({ id: 40430, attributes: [0, 0, 0], effect0: 78 }, caster(rows.get(61))), undefined,
    "an attack spell is not held to the row");
  assert.equal(castPreflightRefusal(plain(40430), caster(undefined)), undefined, "no override");
  assert.equal(castPreflightRefusal({ ...plain(40430), id: undefined }, caster(rows.get(61))), undefined, "no id: no test");
  // Before the dead test: refusal 0 comes first.
  assert.equal(castPreflightRefusal(plain(40430), { ...caster(rows.get(61)), health: 0 }), SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW);
});
