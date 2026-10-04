import assert from "node:assert/strict";
import test from "node:test";
import { isolatedModule } from "./fixtures/isolated-ui.mjs";

// The verbs behind the stock commands added by 3.11 (input/Actions.ts over input/StockVerbs.ts),
// with the panels they call replaced by recorders: which unit a key selects, which bag it opens,
// which sheath state it asks the server for, which page, pet button and form it presses.
const UPDATE = await import("../dist/code/generated/updateFields.js");
const fields = await import("../dist/code/world/Fields.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const protocol = await import("../dist/code/world/ActionBarProtocol.js");
const verbs = await import("../dist/code/browser/input/StockVerbs.js");
const relic = await import("../dist/code/browser/framexml/FrameXmlRelicSlot.js");
// L7 4.16b: the page keys walk stock ActionBar_PageUp/PageDown over the pages a shown extra row leaves free.
const stockLayout = await import("../dist/code/browser/ui/ActionBarStockLayout.js");
const { UPDATE_FIELDS } = UPDATE;

const SELF = 1n;
const PARTY = [11n, 12n];
const PARTY_PETS = [21n, 22n];
const ENEMY = 30n;
const FOCUS = 31n;

function unitObject(guid, values = {}) {
  const map = new Map();
  for (const [name, value] of Object.entries(values)) map.set(UPDATE_FIELDS[name].offset, value);
  return { guid, typeId: 4, fields: map };
}

async function harness({ classId = 1, sheath = 0, equipment = {}, health = 100, flags = 0, channel = 0, shownBars = [] } = {}) {
  const calls = [];
  const self = unitObject(SELF, {
    UNIT_FIELD_HEALTH: health, UNIT_FIELD_FLAGS: flags, UNIT_CHANNEL_SPELL: channel,
    UNIT_FIELD_BYTES_0: classId << 8, UNIT_FIELD_BYTES_2: sheath,
  });
  const objects = new Map([[SELF, self], ...[...PARTY, ...PARTY_PETS, ENEMY, FOCUS].map((guid) => [guid, unitObject(guid)])]);
  objects.get(ENEMY).fields.set(UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, Number(PARTY[0]));
  const world = {
    state: { selfGuid: SELF, objects },
    targetGuid: undefined,
    knownSpells: [],
    selectTarget(guid) { calls.push(["select", guid]); this.targetGuid = guid; },
    setSheathed(state) { calls.push(["sheath", state]); },
    cancelSpellCast() { calls.push(["cancelCast"]); },
    startAttack() { calls.push(["startAttack"]); },
    stopAttack() { calls.push(["stopAttack"]); },
  };
  const game = { world, focusGuid: FOCUS, spells: new Map(), talentData: undefined };
  const settings = { plateEnemies: true, plateFriends: false };
  let page = 1;
  const units = {
    party1: PARTY[0], party2: PARTY[1], partypet1: PARTY_PETS[0], partypet2: PARTY_PETS[1],
    pet: 40n, mouseover: ENEMY,
    get targettarget() {
      const target = world.targetGuid === undefined ? undefined : objects.get(world.targetGuid);
      const guid = target ? fields.unit.target(target) : undefined;
      return guid === undefined || guid === 0n ? undefined : guid;
    },
  };
  const slots = Object.fromEntries(Object.entries(equipment).map(([slot, item]) => [slot, { item }]));
  const actions = await isolatedModule("browser/input/Actions", {
    "../game/Context.js": { game },
    "./Bindings.js": bindings,
    "../../world/ActionBarProtocol.js": protocol,
    "../../world/Fields.js": fields,
    "../../generated/updateFields.js": UPDATE,
    "./StockVerbs.js": verbs,
    "../framexml/FrameXmlRelicSlot.js": relic,
    "../Inventory.js": { playerInventory: () => ({ equipment: Array.from({ length: 19 }, (_, index) => slots[index] ?? { item: undefined }) }) },
    "../ui/CombatCommands.js": { macroUnitGuid: (token) => units[token] },
    "../framexml/FrameXmlBagController.js": { toggleFrameXmlBackpack: () => false, toggleFrameXmlBag: () => false },
    "../ui/Bags.js": {
      toggleBackpack: () => calls.push(["backpack"]),
      toggleBag: (container) => { calls.push(["bag", container]); return container !== 3; },
    },
    "../ui/ActionBar.js": {
      getActionBarPage: () => page, turnActionPage: (next) => { page = next + 1; calls.push(["page", next]); },
      actionPageViewable: (page0) => stockLayout.mainPageViewable(page0, (bar) => shownBars.includes(bar)), // L7 4.16b
    },
    "../ui/ActionBarStockLayout.js": stockLayout,
    "../ui/PetBar.js": { pressPetButton: (id) => { calls.push(["pet", id]); return id <= 3; } },
    "../framexml/FrameXmlShapeshiftForms.js": { frameXmlShapeshiftForms: () => [{ spellId: 2457 }, { spellId: 71 }] },
    "../ui/Spellbook.js": { castSpell: (id) => calls.push(["cast", id]) },
    "../ui/Settings.js": {
      settingOn: (id) => settings[id] === true,
      setSetting: (id, value) => { settings[id] = value; return true; },
    },
  });
  const run = (action) => {
    calls.length = 0;
    return actions.runAction(action);
  };
  return { run, calls, world, settings };
}

test("F2–F5 select the party member, and the member's pet when the member is already the target", async () => {
  const { run, calls, world } = await harness();
  assert.equal(run("targetPartyMember2"), true);
  assert.deepEqual(calls, [["select", PARTY[1]]]);
  assert.equal(run("targetPartyMember2"), true);
  assert.deepEqual(calls, [["select", PARTY_PETS[1]]], "the second press goes to the pet (Bindings.xml:495)");
  assert.equal(run("targetPartyMember3"), false, "no third member: the key stays unanswered");
  assert.equal(run("targetPartyPet1"), true);
  assert.deepEqual(calls, [["select", PARTY_PETS[0]]]);
  assert.equal(run("targetPet"), false, "a pet not in sight is not selected");
  world.state.objects.delete(PARTY[0]);
  assert.equal(run("targetPartyMember1"), false, "a member out of sight cannot be selected");
});

test("assist selects the target's target; with nothing there the key stays unanswered", async () => {
  const { run, calls, world } = await harness();
  // L2 3.11: Wow.exe 0x525eb0 answers no target with ERR_GENERIC_NO_TARGET — the key is spent (native-target-keys).
  assert.equal(run("assistTarget"), true, "no target: the UI error, not the browser's key");
  assert.deepEqual(calls, [], "and nothing selected");
  world.targetGuid = ENEMY;
  assert.equal(run("assistTarget"), true);
  assert.deepEqual(calls, [["select", PARTY[0]]]);
  assert.equal(run("targetFocus"), true);
  assert.deepEqual(calls, [["select", FOCUS]]);
  assert.equal(run("targetMouseover"), true);
  assert.deepEqual(calls, [["select", ENEMY]]);
});

test("F8–F11 open the fourth to the first carried bag, as ToggleBag(5 - n)", async () => {
  const { run, calls } = await harness();
  assert.equal(run("toggleBag1"), true);
  assert.deepEqual(calls, [["bag", 4]]);
  assert.equal(run("toggleBag3"), true);
  assert.deepEqual(calls, [["bag", 2]]);
  assert.equal(run("toggleBag2"), false, "no bag in container 3");
  assert.equal(run("toggleBackpack"), true);
  assert.deepEqual(calls, [["backpack"]]);
});

test("Z follows ToggleSheath: unarmed → melee, melee → ranged → unarmed; a relic is never drawn", async () => {
  const sword = { guid: 100n };
  const bow = { guid: 101n };
  let h = await harness({ sheath: 0, equipment: { 15: sword, 17: bow } });
  h.run("toggleSheath");
  assert.deepEqual(h.calls, [["sheath", 1]]);
  h = await harness({ sheath: 1, equipment: { 15: sword, 17: bow } });
  h.run("toggleSheath");
  assert.deepEqual(h.calls, [["sheath", 2]]);
  h = await harness({ sheath: 2, equipment: { 15: sword, 17: bow } });
  h.run("toggleSheath");
  assert.deepEqual(h.calls, [["sheath", 0]]);
  h = await harness({ sheath: 0, equipment: { 17: bow } });
  h.run("toggleSheath");
  assert.deepEqual(h.calls, [["sheath", 2]], "no melee weapon: the bow");
  h = await harness({ classId: 2, sheath: 1, equipment: { 15: sword, 17: bow } });
  h.run("toggleSheath");
  assert.deepEqual(h.calls, [["sheath", 0]], "a paladin's ranged slot holds a libram: melee goes back to unarmed");
  h = await harness({ sheath: 0 });
  assert.equal(h.run("toggleSheath"), true);
  assert.deepEqual(h.calls, [], "nothing to draw: no packet");
  for (const blocked of [{ health: 0 }, { flags: verbs.UNIT_FLAG_STUNNED }, { channel: 12051 }]) {
    h = await harness({ sheath: 0, equipment: { 15: sword }, ...blocked });
    h.run("toggleSheath");
    assert.deepEqual(h.calls, [], JSON.stringify(blocked));
  }
});

test("page keys wrap, pet keys press the pet bar, form keys cast the listed form", async () => {
  const { run, calls } = await harness();
  run("previousActionPage");
  assert.deepEqual(calls, [["page", 5]], "page 1 back wraps to page 6 (ActionBar_PageDown)");
  run("nextActionPage");
  assert.deepEqual(calls, [["page", 0]]);
  run("nextActionPage");
  assert.deepEqual(calls, [["page", 1]]);
  // L7 4.16b: with the bottom-left (page 6) and right (page 3) rows up, those pages are skipped.
  const shown = await harness({ shownBars: ["bottomLeft", "right"] });
  shown.run("nextActionPage");
  shown.run("nextActionPage");
  shown.run("nextActionPage");
  shown.run("previousActionPage");
  assert.deepEqual(shown.calls, [["page", 3]], "1 → 2 → 4 → 5, then down: 5 → 4 (0-based 3)");
  shown.run("previousActionPage");
  shown.run("previousActionPage");
  shown.run("previousActionPage");
  assert.deepEqual(shown.calls, [["page", 4]], "4 → 2 → 1 → wraps to 5, the highest free page");
  assert.equal(run("bonusAction3"), true);
  assert.deepEqual(calls, [["pet", 3]]);
  assert.equal(run("bonusAction10"), false, "an empty pet button is not a press");
  assert.equal(run("shapeshift2"), true);
  assert.deepEqual(calls, [["cast", 71]]);
  assert.equal(run("shapeshift3"), false, "no third form");
});

test("the name plate keys follow Bindings.xml's FRIENDNAMEPLATES and ALLNAMEPLATES bodies", async () => {
  const { run, settings } = await harness();
  run("friendNamePlates");
  assert.deepEqual(settings, { plateEnemies: false, plateFriends: true }, "friends only");
  run("friendNamePlates");
  assert.deepEqual(settings, { plateEnemies: false, plateFriends: false }, "friends only again: off");
  run("allNamePlates");
  assert.deepEqual(settings, { plateEnemies: true, plateFriends: true }, "both off: both on");
  run("allNamePlates");
  assert.deepEqual(settings, { plateEnemies: false, plateFriends: false });
  settings.plateEnemies = true;
  settings.plateFriends = true;
  run("friendNamePlates");
  assert.deepEqual(settings, { plateEnemies: false, plateFriends: true }, "both on: friends only, not off");
});

test("the pure rules: sheath order, page step, party pet", () => {
  assert.equal(verbs.nextSheathState(0, false, false), undefined);
  assert.equal(verbs.nextSheathState(3, true, true), undefined, "an unknown state is left alone");
  assert.equal(verbs.stepActionPage(5, 1), 0);
  assert.equal(verbs.stepActionPage(0, -1), 5);
  assert.equal(verbs.partyMemberTarget(5n, 5n, undefined), 5n, "no pet: the member stays");
  assert.equal(verbs.partyMemberTarget(undefined, undefined, 6n), undefined);
});
