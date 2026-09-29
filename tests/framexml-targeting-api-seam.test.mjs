import assert from "node:assert/strict";
import test from "node:test";

// Focus, assist, dismount and the stance bar's cancel (FrameXmlTargetingApi.ts) over the live seam:
// the unit menu's SET_FOCUS/CLEAR_FOCUS (UnitPopup.lua:1381-1384), FocusFrame's own ClearFocus
// (TargetFrame.lua:201), SecureTemplates' focus/assist actions (:417-425) and the stock slash
// commands /focus, /assist, /dismount, /cancelform (ChatFrame.lua:1080-1262, :2114-2118).
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_TARGETING_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlTargetingApi.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const SELF = 0x10n;
const TARGET = 0xf130000000000101n;
const HEALER = 0x22n;
const TARGET_FIELD = UPDATE_FIELDS.UNIT_FIELD_TARGET.offset;
const BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;
const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;

const unit = (guid, typeId, fields = []) => ({
  guid, typeId, fields: new Map(fields), position: { x: 0, y: 0, z: 0, orientation: 0 },
});
/** A LONG update field as the wire writes it: the low word, then the high one. */
function setGuidField(object, offset, guid) {
  object.fields.set(offset, Number(guid & 0xffffffffn));
  object.fields.set(offset + 1, Number(guid >> 32n));
}
const metadata = (id, changes = {}) => ({
  id, name: `Spell ${id}`, iconPath: `Interface\\Icons\\Spell_${id}`,
  passive: false, displayInStanceBar: false, stanceBarOrder: 0,
  effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], spellLevel: 1, ...changes,
});

function fixture() {
  const player = unit(SELF, 4, [[BYTES_2, 17 << 24]]);
  const target = unit(TARGET, 3, [[ENTRY, 299]]);
  const healer = unit(HEALER, 4);
  const calls = [];
  const focus = [];
  let focusGuid;
  const spells = new Map([
    [2457, metadata(2457, { name: "Боевая стойка", effectAura: [36, 0, 0], effectMiscValue: [17, 0, 0] })],
    [71, metadata(71, { name: "Оборонительная стойка", stanceBarOrder: 1, effectAura: [36, 0, 0], effectMiscValue: [18, 0, 0] })],
    // A stance-bar entry without SPELL_AURA_MOD_SHAPESHIFT, as a paladin aura or a death knight's
    // presence is (FrameXmlShapeshiftForms.ts): shown on the bar, active by its aura, not a form.
    [465, metadata(465, { name: "Аура благочестия", stanceBarOrder: 2, displayInStanceBar: true })],
  ]);
  const auraSpells = new Set();
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, player], [TARGET, target], [HEALER, healer]]) },
    selfName: "Тестовый",
    targetGuid: TARGET,
    group: {
      groupType: 0, ownSubGroup: 0, ownFlags: 0, ownRoles: 0, guid: 0x900n, counter: 1,
      members: [{ guid: HEALER, name: "Эйра", online: true, status: 1, subGroup: 0, flags: 0, roles: 0 }],
      leaderGuid: SELF, lootMethod: 0, masterLooterGuid: 0n, lootThreshold: 2, dungeonDifficulty: 0, raidDifficulty: 0,
    },
    knownSpells: [{ id: 2457, slot: 0 }, { id: 71, slot: 1 }, { id: 465, slot: 2 }],
    partyStats: new Map(),
    auras: new Map(),
    aurasFor: (guid) => (guid === SELF ? [...auraSpells].map((spellId) => ({ spellId, casterGuid: SELF })) : []),
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    cooldownSnapshots: new Map(),
    names: new Map([[HEALER, "Эйра"]]),
    creatureTemplates: new Map([[299, { entry: 299, found: true, name: "Кролик" }]]),
    totems: new Map(),
    selectTarget(guid) { calls.push(["select", guid]); },
    dismount() { calls.push(["dismount"]); },
    cancelAura(spellId) { calls.push(["cancelAura", spellId]); },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => spells.get(id),
    focusGuid: () => focusGuid,
    setFocus: (guid) => { focus.push(guid); focusGuid = guid; },
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return { seam, world, player, target, healer, calls, focus, call, auraSpells };
}

test("FocusUnit takes a token, a name or — as a bare /focus — the target; ClearFocus lets go", () => {
  const { calls, focus, call, world } = fixture();
  assert.deepEqual(call("FocusUnit", "target"), [], "no return value");
  assert.deepEqual(call("FocusUnit", "party1"), []);
  call("FocusUnit");
  call("FocusUnit", "Кролик");
  call("ClearFocus");
  call("ClearFocus", "focus");
  assert.deepEqual(focus, [TARGET, HEALER, TARGET, TARGET, undefined, undefined]);
  // A token that names nobody: the focus follows it to nobody, as the native «focus the target»
  // does with no target; a name nobody in sight carries leaves the focus where it was.
  world.targetGuid = undefined;
  focus.length = 0;
  call("FocusUnit", "Никто");
  assert.deepEqual(focus, []);
  call("FocusUnit");
  assert.deepEqual(focus, [undefined]);
  assert.deepEqual(calls, [], "focus is the interface's; nothing goes to the realm");
});

test("AssistUnit selects what the unit has selected, and nothing when it has nothing", () => {
  const { calls, call, target, healer } = fixture();
  call("AssistUnit", "target");
  assert.deepEqual(calls, [], "the target looks at nobody");
  setGuidField(target, TARGET_FIELD, HEALER);
  call("AssistUnit", "target");
  call("AssistUnit");
  setGuidField(healer, TARGET_FIELD, TARGET);
  call("AssistUnit", "Эйра");
  setGuidField(healer, TARGET_FIELD, 0x777n);
  call("AssistUnit", "party1");
  assert.deepEqual(calls, [["select", HEALER], ["select", HEALER], ["select", TARGET]],
    "a unit out of sight is nobody the world can select");
});

test("Dismount asks the world; CancelShapeshiftForm cancels the active stance-bar form's aura", () => {
  const { calls, call, player } = fixture();
  assert.deepEqual(call("Dismount"), []);
  assert.deepEqual(call("CancelShapeshiftForm"), []);
  player.fields.set(BYTES_2, 18 << 24);
  call("CancelShapeshiftForm");
  player.fields.set(BYTES_2, 0);
  call("CancelShapeshiftForm");
  assert.deepEqual(calls, [["dismount"], ["cancelAura", 2457], ["cancelAura", 71]], "no form, nothing to cancel");
});

test("CancelShapeshiftForm leaves a paladin aura or a presence alone: only a MOD_SHAPESHIFT form is cancelled", () => {
  const { calls, call, player, auraSpells } = fixture();
  player.fields.set(BYTES_2, 0);
  auraSpells.add(465);
  assert.deepEqual(call("GetShapeshiftFormInfo", 3).slice(1, 3), ["Аура благочестия", true], "the bar shows it active");
  call("CancelShapeshiftForm");
  assert.deepEqual(calls, [], "CMSG_CANCEL_AURA would remove the aura: /cancelform is for forms");
  player.fields.set(BYTES_2, 17 << 24);
  call("CancelShapeshiftForm");
  assert.deepEqual(calls, [["cancelAura", 2457]], "a warrior stance is a form (the core refuses what cannot be cancelled)");
});

test("WorldClient.dismount sends the empty CMSG_CANCEL_MOUNT_AURA (0x375) only while mounted", async () => {
  const { OPCODES } = await import("../dist/code/generated/opcodes.js");
  const { travelClient } = await import("./fixtures/world-packets.mjs");
  const { client, connection } = await travelClient([], SELF);
  try {
    assert.equal(OPCODES.CMSG_CANCEL_MOUNT_AURA, 0x375);
    client.dismount();
    assert.equal(connection.sentOf(OPCODES.CMSG_CANCEL_MOUNT_AURA).length, 0, "on foot: nothing to ask");
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 2410);
    client.dismount();
    const sent = connection.sentOf(OPCODES.CMSG_CANCEL_MOUNT_AURA);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.length, 0, "HandleCancelMountAuraOpcode reads nothing");
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 0);
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x08000000);
    client.dismount();
    assert.equal(connection.sentOf(OPCODES.CMSG_CANCEL_MOUNT_AURA).length, 2, "UNIT_FLAG_MOUNT counts too");
  } finally {
    client.close();
  }
});

test("a seam without the model answers every name with nothing; each name is the seam's own binding", () => {
  assert.deepEqual(Object.keys(FRAMEXML_TARGETING_BINDINGS).sort(),
    ["AssistUnit", "CancelShapeshiftForm", "ClearFocus", "Dismount", "FocusUnit"]);
  for (const [name, binding] of Object.entries(FRAMEXML_TARGETING_BINDINGS)) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], binding, `${name} is not shadowed by a later key`);
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS[name]({}, ["target"]), [], name);
  }
});
