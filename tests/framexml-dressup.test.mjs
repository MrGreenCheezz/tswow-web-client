import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import {
  FRAMEXML_DRESSUP_SLOT_BY_INVENTORY_TYPE, FrameXmlDressUpModels, frameXmlDressUpSlot, installFrameXmlDressUp,
} from "../dist/code/browser/framexml/FrameXmlDressUp.js";
import {
  FrameXmlDressUpStage, frameXmlDressUpKey, frameXmlDressUpSource,
} from "../dist/code/browser/framexml/FrameXmlDressUpStage.js";

// The dressing room's host half, without the MPQ: the outfit arithmetic, IsDressableItem, the Lua
// methods on the DressUpModel type over a two-frame fixture, and the stage's source resolution.
// tests/framexml-dressup-vertical.test.mjs drives the stock DressUpFrame and the auction side frame.

const LOOK = Object.freeze({
  displayId: 49, race: 1, sex: 0, skin: 2, face: 3, hairStyle: 4, hairColor: 5, facialHair: 6,
  equipment: Object.freeze([
    { slot: 4, inventoryType: 5, displayId: 9001 },
    { slot: 15, inventoryType: 13, displayId: 9002, subClass: 7 },
    { slot: 16, inventoryType: 14, displayId: 9003 },
  ]),
});

const ITEMS = new Map([
  [1001, { inventoryType: 5, displayId: 101 }], // chest
  [1002, { inventoryType: 17, displayId: 102, subClass: 1 }], // two-hander
  [1003, { inventoryType: 14, displayId: 103 }], // shield
  [1004, { inventoryType: 2, displayId: 104 }], // neck: no appearance
  [1005, { inventoryType: 7, displayId: 105 }], // legs
  [1006, { inventoryType: 20, displayId: 106 }], // robe → chest slot
  [1007, { inventoryType: 1, displayId: 0 }], // a head row with no display
]);

function host({ items = ITEMS, look = LOOK } = {}) {
  const asked = [];
  return {
    asked,
    look: (unit) => (unit === "player" ? look : undefined),
    item: (entry) => { const row = items.get(entry); if (!row) asked.push(entry); return row; },
  };
}

const link = (entry, name = "Предмет") => `|cff1eff00|Hitem:${entry}:0:0:0:0:0:0:0:80|h[${name}]|h|r`;
const slots = (outfit) => outfit.equipment.map((item) => [item.slot, item.displayId]);

test("the try-on slot table is FindEquipSlot's first choice over the slots a character model shows", () => {
  assert.equal(frameXmlDressUpSlot({ inventoryType: 1, displayId: 1 }), 0);
  assert.equal(frameXmlDressUpSlot({ inventoryType: 20, displayId: 1 }), 4, "a robe is worn in the chest slot");
  assert.equal(frameXmlDressUpSlot({ inventoryType: 16, displayId: 1 }), 14, "a cloak is EQUIPMENT_SLOT_BACK");
  assert.equal(frameXmlDressUpSlot({ inventoryType: 13, displayId: 1 }), 15, "a one-hander goes to the main hand");
  assert.equal(frameXmlDressUpSlot({ inventoryType: 23, displayId: 1 }), 16, "a held off-hand item");
  assert.equal(frameXmlDressUpSlot({ inventoryType: 26, displayId: 1 }), 17, "a wand/gun is ranged");
  for (const type of [0, 2, 11, 12, 18, 24, 27, 28]) {
    assert.equal(FRAMEXML_DRESSUP_SLOT_BY_INVENTORY_TYPE[type], undefined, `INVTYPE ${type} has no appearance`);
  }
  assert.equal(frameXmlDressUpSlot({ inventoryType: 5, displayId: 0 }), undefined, "no display, nothing to wear");
  assert.equal(frameXmlDressUpSlot(undefined), undefined);
});

test("SetUnit/TryOn/Undress/Dress compose the outfit, and a row that has not arrived waits for it", () => {
  const world = host({ items: new Map(ITEMS) });
  const models = new FrameXmlDressUpModels(world);
  const frame = { name: "DressUpModel", type: "DressUpModel" };
  assert.equal(models.outfit(frame), undefined, "no SetUnit, no picture");
  assert.equal(models.tryOn(frame, link(1001)), false, "TryOn before SetUnit records nothing");
  models.setUnit(frame, "PLAYER");
  assert.deepEqual(slots(models.outfit(frame)), [[4, 9001], [15, 9002], [16, 9003]], "the unit as it is dressed");
  assert.equal(models.tryOn(frame, link(1001)), true);
  assert.deepEqual(slots(models.outfit(frame)), [[4, 101], [15, 9002], [16, 9003]], "the chest replaced");
  models.tryOn(frame, "item:1002:0:0:0");
  assert.deepEqual(slots(models.outfit(frame)), [[4, 101], [15, 102]], "a two-hander empties the off hand");
  models.tryOn(frame, 1003);
  assert.deepEqual(slots(models.outfit(frame)), [[4, 101], [16, 103]], "a shield takes the two-hander out");
  models.tryOn(frame, link(1006));
  assert.deepEqual(slots(models.outfit(frame)), [[4, 106], [16, 103]], "the robe is the later chest");
  models.tryOn(frame, link(1004));
  assert.deepEqual(slots(models.outfit(frame)), [[4, 106], [16, 103]], "a necklace changes nothing");

  models.tryOn(frame, link(1500));
  assert.equal(models.outfit(frame).pending, true, "an unknown row is pending, not guessed");
  assert.ok(world.asked.includes(1500), "and it was asked for at TryOn");
  // The same outfit once the row has arrived.
  const later = new FrameXmlDressUpModels({ look: world.look, item: (entry) => entry === 1500 ? { inventoryType: 7, displayId: 150 } : ITEMS.get(entry) });
  later.setUnit(frame, "player");
  later.tryOn(frame, link(1500));
  assert.deepEqual(slots(later.outfit(frame)), [[4, 9001], [6, 150], [15, 9002], [16, 9003]]);
  assert.equal(later.outfit(frame).pending, false);

  models.undress(frame);
  assert.deepEqual(slots(models.outfit(frame)), [], "Undress takes everything off");
  models.tryOn(frame, link(1005));
  assert.deepEqual(slots(models.outfit(frame)), [[6, 105]], "and a try-on on a bare model wears just that");
  models.dress(frame);
  assert.deepEqual(slots(models.outfit(frame)), [[4, 9001], [15, 9002], [16, 9003]], "Dress is the reset");
  const revision = models.revision;
  models.clear(frame);
  assert.equal(models.has(frame), false);
  assert.ok(models.revision > revision);
  models.setUnit(frame, "target");
  assert.equal(models.outfit(frame), undefined, "a unit the host cannot resolve shows nothing");
});

test("IsDressableItem is a flag over a known row; an unknown row is nil and is asked for", () => {
  const world = host();
  const models = new FrameXmlDressUpModels(world);
  assert.equal(models.isDressable(link(1001)), true);
  assert.equal(models.isDressable(1006), true);
  assert.equal(models.isDressable(link(1004)), false, "neck");
  assert.equal(models.isDressable(link(1007)), false, "a row with no display");
  assert.equal(models.isDressable("[Предмет]"), false, "not an item link");
  assert.equal(models.isDressable(link(4242)), undefined);
  assert.deepEqual(world.asked, [4242]);
});

async function fixtureBoot() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "DressUp.lua",
      "interface/framexml/dressup.lua": [
        'DressUpFrame = CreateFrame("Frame", "DressUpFrame", UIParent)',
        'DressUpModel = CreateFrame("DressUpModel", "DressUpModel", DressUpFrame)',
        'DressUpModel.rotation = 0.61; DressUpModel:SetRotation(DressUpModel.rotation)',
        'DressUpFrame:Hide()',
      ].join("\n"),
    }),
    exercise: false,
  });
  await boot.load();
  return boot;
}

test("the Lua methods land on the DressUpModel type: SetUnit/TryOn/Dress/Undress, SetRotation as facing", async () => {
  const boot = await fixtureBoot();
  try {
    const models = new FrameXmlDressUpModels(host());
    let changes = 0;
    const frame = boot.bridge.getFrame("DressUpModel");
    assert.equal(frame.model.facing, undefined, "before install the widget layer only records SetRotation");
    assert.equal(installFrameXmlDressUp(boot, models, () => { changes += 1; }), true);
    assert.equal(frame.model.facing, 0.61, "Model_OnLoad's rotation is applied once on install");
    const run = (code) => assert.equal(boot.vm.execute(code, "@dressup-fixture").ok, true, code);
    run(`DressUpModel:SetUnit("player"); DressUpModel:TryOn("${link(1001).replaceAll('"', '\\"')}")`);
    assert.deepEqual(slots(models.outfit(frame)), [[4, 101], [15, 9002], [16, 9003]]);
    run("DressUpModel:Undress()");
    assert.deepEqual(slots(models.outfit(frame)), []);
    run("DressUpModel:Dress()");
    assert.deepEqual(slots(models.outfit(frame)), [[4, 9001], [15, 9002], [16, 9003]]);
    run("DressUpModel:SetRotation(1.5)");
    assert.equal(frame.model.facing, 1.5);
    // A DressUpModel made later shares the type's methods: AuctionDressUpModel's route.
    run('Other = CreateFrame("DressUpModel", "OtherDressUp", UIParent); Other:SetUnit("player"); Other:TryOn(1005)');
    const other = boot.bridge.getFrame("OtherDressUp");
    assert.deepEqual(slots(models.outfit(other)), [[4, 9001], [6, 105], [15, 9002], [16, 9003]]);
    run('Other:SetDisplayInfo(678)');
    assert.equal(models.has(other), false, "SetDisplayInfo ends the unit view");
    assert.equal(other.model.displayId, 678, "and still does what it did");
    const before = changes;
    run("DressUpFrame:Show()");
    assert.equal(changes, before + 1, "DressUpFrame's OnShow wakes the stage");
    const fn = boot.vm.compileFunction(
      "return IsDressableItem(1001) or 0, IsDressableItem(1004) == nil and 1 or 0, IsDressableItem(4242) == nil and 1 or 0",
      "dressable", []);
    try { assert.deepEqual(boot.vm.call(fn, [], 3), [1, 1, 1], "1 for a chest; nil for a necklace and an unknown row"); }
    finally { boot.vm.release(fn); }
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("the stage source is the native display's model with the outfit's composed appearance", () => {
  const outfit = { unit: "player", look: LOOK, equipment: LOOK.equipment, pending: false };
  const requests = [];
  const appearanceCalls = [];
  const metadata = { model: "Character\\Human\\Male\\HumanMale.m2", textures: "", scale: 1 };
  let ready = false;
  let composed;
  const source = {
    get: (id) => (ready && id === 49 ? metadata : undefined),
    request: (id) => requests.push(id),
    playerAppearance: (...args) => { appearanceCalls.push(args); return composed; },
  };
  assert.equal(frameXmlDressUpSource(outfit, source), undefined);
  assert.deepEqual(requests, [49], "the display record is asked for");
  ready = true;
  assert.equal(frameXmlDressUpSource(outfit, source), undefined, "the appearance is still on the wire");
  assert.deepEqual(appearanceCalls[0], [1, 0, 2, 3, 4, 5, 6, LOOK.equipment]);
  composed = { body: [], hair: "", cloak: "", geosets: [], attached: [] };
  const resolved = frameXmlDressUpSource(outfit, source);
  assert.equal(resolved.file, metadata.model);
  assert.equal(resolved.appearance, composed);
  assert.equal(resolved.fitBody, true);
  assert.ok(resolved.key.startsWith(frameXmlDressUpKey(outfit)));
  assert.equal(frameXmlDressUpKey(outfit), "dressup:49/1/0/2/3/4/5/6/4:5:9001,15:13:9002:7,16:14:9003");
});

test("the stage keeps the last picture while a new outfit resolves, and sleeps while nothing is visible", () => {
  const world = host();
  const models = new FrameXmlDressUpModels(world);
  const frame = { name: "DressUpModel", type: "DressUpModel" };
  const metadata = { model: "Character\\Human\\Male\\HumanMale.m2", textures: "", scale: 1 };
  const composed = new Map();
  const scheduled = [];
  const stage = new FrameXmlDressUpStage({
    gatewayOrigin: "http://127.0.0.1:8090",
    models,
    elementFor: () => undefined,
    isVisible: () => false,
    creatureModels: {
      get: () => metadata, request() {},
      playerAppearance: (...args) => composed.get(JSON.stringify(args.at(-1))),
    },
    requestFrame: (callback) => { scheduled.push(callback); return scheduled.length; },
    cancelFrame() {},
  });
  models.setUnit(frame, "player");
  composed.set(JSON.stringify(models.outfit(frame).equipment), { body: [], geosets: [], attached: [], id: "own" });
  const first = stage.resolve(frame);
  assert.equal(first.appearance.id, "own");
  models.tryOn(frame, link(1001));
  assert.equal(stage.resolve(frame), first, "the dressed picture stays while the try-on's appearance is fetched");
  composed.set(JSON.stringify(models.outfit(frame).equipment), { body: [], geosets: [], attached: [], id: "tried" });
  assert.equal(stage.resolve(frame).appearance.id, "tried");
  models.clear(frame);
  assert.equal(stage.resolve(frame), undefined);

  stage.wake();
  assert.equal(stage.running, true);
  scheduled.shift()();
  assert.equal(stage.running, false, "nothing visible: the loop stops after one pass and builds no stage");
  stage.dispose();
  stage.wake();
  assert.equal(stage.running, false, "a disposed stage never wakes");
});
