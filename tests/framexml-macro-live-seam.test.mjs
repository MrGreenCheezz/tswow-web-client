import assert from "node:assert/strict";
import test from "node:test";

// LiveWorldSeam's construction block for the MAC lane: the macro model over the host's store, the
// action bar's macro buttons (name and icon), the macro cursor on the bar (UseAction/PlaceAction →
// CMSG_SET_ACTION_BUTTON), and the binding model's RunBinding verb.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { createFrameXmlMemoryMacroStore } = await import("../dist/code/browser/framexml/FrameXmlMacro.js");
const { ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

bindings.useBindingStorage(undefined);

function fixture() {
  const sent = [];
  const used = [];
  const runs = [];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    actionButtons: [
      { slot: 0, action: 133, type: ACTION_BUTTON_SPELL },
      { slot: 4, action: 37, type: ACTION_BUTTON_MACRO },
      { slot: 5, action: 9, type: ACTION_BUTTON_MACRO },
    ],
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    setActionButton(slot, action, type) {
      sent.push([slot, action, type]);
      world.actionButtons = [...world.actionButtons.filter((button) => button.slot !== slot), { slot, action, type }];
    },
    events: { on() { return () => {}; } },
  };
  const store = createFrameXmlMemoryMacroStore([
    { index: 2, name: "Танец", body: "/dance", icon: "Interface\\Icons\\Ability_Defend" },
    { index: 37, name: "Щит", body: "/cast Блок щитом" },
  ]);
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell() {},
    useAction: (slot) => used.push(slot),
    macroStore: store,
    runBinding: (action) => { runs.push(action); return true; },
  });
  return { seam, world, sent, used, runs, store };
}

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("an action button holding a macro shows its name and icon; a deleted macro's button shows none", () => {
  const { seam } = fixture();
  assert.deepEqual(call(seam, "GetActionText", 5), ["Щит"]);
  assert.deepEqual(call(seam, "GetActionTexture", 5), ["Interface\\Icons\\INV_Misc_QuestionMark"]);
  assert.deepEqual(call(seam, "GetActionText", 6), ["9"], "slot 9 holds no macro: the id, as before");
  assert.deepEqual(call(seam, "GetActionTexture", 6), []);
  assert.deepEqual(call(seam, "GetNumMacros"), [1, 1]);
  assert.deepEqual(call(seam, "GetMacroInfo", 37), ["Щит", "Interface\\Icons\\INV_Misc_QuestionMark", "/cast Блок щитом"]);
});

test("a macro picked up goes on the button pressed next, through CMSG_SET_ACTION_BUTTON, and not the button's own action", () => {
  const { seam, sent, used } = fixture();
  call(seam, "PickupMacro", 1);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["macro", 1]);
  call(seam, "UseAction", 1);
  assert.deepEqual(sent, [[0, 2, ACTION_BUTTON_MACRO]], "slot 1 (wire 0) now holds macro slot 2");
  assert.deepEqual(used, [], "the spell on the button was not cast");
  // The stock swap (FrameXmlCursor.ts): the spell the macro displaced is on the cursor now. Its
  // metadata is not in this fixture, so it has no book slot to name.
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", undefined, "spell"]);
  call(seam, "ClearCursor");
  assert.deepEqual(call(seam, "GetActionText", 1), ["Танец"]);
  assert.deepEqual(call(seam, "GetActionTexture", 1), ["Interface\\Icons\\Ability_Defend"]);
  // PlaceAction, and ClearCursor dropping it.
  call(seam, "PickupMacro", "Щит");
  call(seam, "PlaceAction", 12);
  assert.deepEqual(sent.at(-1), [11, 37, ACTION_BUTTON_MACRO]);
  call(seam, "PickupMacro", 37);
  call(seam, "ClearCursor");
  call(seam, "UseAction", 1);
  assert.deepEqual(used, [1], "an empty cursor: the press is the button's own");
});

test("one thing on the cursor: a bag item picked up drops the macro, a macro picked up drops the item", () => {
  const { seam, world } = fixture();
  // A live bag item in backpack slot 1 (PLAYER_FIELD_PACK_SLOT_1), as the realm's update leaves it.
  const player = world.state.objects.get(1n);
  const item = { guid: 2n, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446]]) };
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 2);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 1, 0);
  world.state.objects.set(item.guid, item);
  call(seam, "PickupMacro", 1);
  assert.deepEqual(call(seam, "GetCursorInfo"), ["macro", 1]);
  call(seam, "PickupContainerItem", 0, 1);
  assert.deepEqual(call(seam, "GetCursorInfo").slice(0, 2), ["item", 13446], "the item, not the macro under it");
  assert.equal(seam.macros.cursorSlot(), undefined, "the macro left the cursor");
  call(seam, "PickupMacro", 37);
  assert.deepEqual(call(seam, "CursorHasItem"), [false], "the item left the cursor");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["macro", 37]);
});

test("the live seam's binding model reads the table and runs the host's verbs", () => {
  const { seam, runs } = fixture();
  assert.deepEqual(call(seam, "GetBindingKey", "ACTIONBUTTON1"), ["1"]);
  assert.deepEqual(call(seam, "GetBindingByKey", "M"), ["TOGGLEWORLDMAP"]);
  call(seam, "RunBinding", "TOGGLEWORLDMAP");
  assert.deepEqual(runs, ["toggleWorldMap"]);
});
