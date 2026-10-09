import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.06 in the retail 3.3.5a DurabilityFrame from the MPQ (stock TOC line 121): the armoured
// figure under the minimap. DurabilityFrame_SetAlerts (DurabilityFrame.lua:18-64) reads
// GetInventoryAlertStatus 1..11, asks OffhandHasWeapon() which of the shield and the off-hand weapon
// stands for index 10, and — with any alert — reads VehicleSeatIndicator:IsShown() unguarded. The
// live half runs over LiveWorldSeam and a real WorldClient; UPDATE_INVENTORY_ALERTS is the seam's
// (FrameXmlInventoryAlerts.ts). Only primitives read back from Lua are compared.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { game } = await import("../dist/code/browser/game/Context.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const provider = {
  async read(path) {
    const data = await chain.read(path);
    return data ? decoder.decode(data) : undefined;
  },
};

async function loadCanned(subset) {
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", subset, seam: new CannedWorldSeam(), exercise: true,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => ({ width: 1365, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, inventory };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "durability-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("DurabilityFrame.xml sits at its stock slot after PetStable.xml; the closure's cost is pinned", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  assert.equal(toc[toc.indexOf("durabilityframe.xml") - 1], "petstable.xml", "stock TOC line 121 follows PetStable.xml (120)");
  assert.equal(toc[toc.indexOf("durabilityframe.xml") + 1], "worldstateframe.xml");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  const at = vertical.indexOf("durabilityframe.xml");
  assert.ok(at > 0, "DurabilityFrame.xml is in the vertical");
  assert.equal(vertical[at - 1], "petstable.xml");
  assert.equal(vertical[at + 1], "worldstateframe.xml");
  let baseline;
  let candidate;
  try {
    baseline = await loadCanned(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "durabilityframe.xml"));
    candidate = await loadCanned(FRAMEXML_VERTICAL_TOC);
    assert.equal(lua(baseline.boot, "return type(DurabilityFrame)")[0], "nil", "the defect: no figure without the file");
    assert.equal(lua(candidate.boot, "return type(DurabilityFrame_SetAlerts)")[0], "function");
    // The canned warrior wears nothing worn: the figure is hidden after PLAYER_ENTERING_WORLD.
    assert.equal(lua(candidate.boot, "return DurabilityFrame:IsShown() and 1 or 0")[0], 0);
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    assert.deepEqual(delta, DURABILITY_DELTA, `DurabilityFrame closure delta ${JSON.stringify(delta)}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

// Measured over the canned seam: DurabilityFrame.xml/.lua and the synthetic TOC's line naming it;
// the frame and its twelve textures (the figure's eleven parts, the shield and the off-hand weapon
// sharing index 10). The VehicleSeatIndicator stand-in is in both boots: MainMenuBar.lua reads it too.
const DURABILITY_DELTA = Object.freeze({ files: 2, bytes: 8460, widgets: 13, errors: 0, distinct: 0, luaFailed: 0 });

const PLAYER = 0x10n;
const HEAD = 0x301n;
const CHEST = 0x302n;
const OFFHAND = 0x303n;
const offset = (name) => UPDATE_FIELDS[name].offset;

function worldFixture() {
  const world = new WorldClient({ send() {}, close() {} });
  const state = new WorldState();
  world.state = state;
  const object = (guid, typeId, entries) => ({
    guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined,
    runSpeed: undefined, turnRate: undefined, motion: undefined, glide: undefined, transport: undefined,
    speeds: undefined, transportTime: undefined, fields: new Map(entries),
  });
  const slot = (index) => offset("PLAYER_FIELD_INV_SLOT_HEAD") + index * 2;
  state.objects.set(PLAYER, object(PLAYER, 4, [
    [offset("UNIT_FIELD_BYTES_0"), 1 | (1 << 8)],
    [offset("UNIT_FIELD_LEVEL"), 20],
    [offset("UNIT_FIELD_HEALTH"), 400],
    [offset("UNIT_FIELD_MAXHEALTH"), 500],
    [slot(0), Number(HEAD)], [slot(0) + 1, 0],
    [slot(4), Number(CHEST)], [slot(4) + 1, 0],
    [slot(16), Number(OFFHAND)], [slot(16) + 1, 0],
  ]));
  const item = (guid, entry, durability) => state.objects.set(guid, object(guid, 1, [
    [offset("OBJECT_FIELD_ENTRY"), entry], [offset("ITEM_FIELD_DURABILITY"), durability],
    [offset("ITEM_FIELD_MAXDURABILITY"), 100],
  ]));
  item(HEAD, 2001, 0);
  item(CHEST, 2002, 100);
  item(OFFHAND, 2003, 4);
  state.selfGuid = PLAYER;
  const store = new WorldStore(state);
  const template = (entry, itemClass, subClass, inventoryType) => ({
    entry, found: true, name: `Предмет ${entry}`, quality: 1, itemClass, subClass, flags: 0, inventoryType,
    bonding: 0, stackable: 1, bagFamily: 0, spells: [], itemLevel: 10, requiredLevel: 1, containerSlots: 0,
    maxDurability: 100, pageText: 0, startQuest: 0,
  });
  world.itemTemplates.set(2001, template(2001, 4, 4, 1));
  world.itemTemplates.set(2002, template(2002, 4, 4, 5));
  // A one-handed sword in the off hand: class 2 (ITEM_CLASS_WEAPON).
  world.itemTemplates.set(2003, template(2003, 2, 7, 13));
  // A shield, class 4 subclass 6, for the swap below.
  world.itemTemplates.set(2004, template(2004, 4, 6, 14));
  world.mapId = 0;
  world.selfName = "Флик";
  const realmTime = { minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  return { world, store };
}

test("the live figure: a broken helm and a worn off-hand weapon show it, a shield swaps the part, repair hides it", withClient, async () => {
  const { world, store } = worldFixture();
  const previousWorld = game.world;
  game.world = world;
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: (id) => ({ id, name: "Проверка", rank: "", iconPath: "Interface\\Icons\\Spell_Test" }),
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1024, height: 768 }),
  });
  const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`)
    .concat(boot.vm.errors.map(String));
  const figure = () => {
    const values = lua(boot, `
      local function color(texture)
        local r, g, b, a = texture:GetVertexColor()
        return string.format("%.2f/%.2f/%.2f/%.1f", r, g, b, a)
      end
      return DurabilityFrame:IsShown() and 1 or 0, DurabilityHead:IsShown() and 1 or 0, color(DurabilityHead),
        color(DurabilityChest), DurabilityOffWeapon:IsShown() and 1 or 0, color(DurabilityOffWeapon),
        DurabilityShield:IsShown() and 1 or 0, OffhandHasWeapon()`, 8);
    return {
      shown: values[0], head: values[1], headColor: values[2], chestColor: values[3], offWeapon: values[4],
      offWeaponColor: values[5], shield: values[6], offhandHasWeapon: values[7] ?? null,
    };
  };
  try {
    await boot.load();
    const errorsAtBoot = failures();
    seam.tick(5);
    // UPDATE_INVENTORY_ALERTS from the seam's first poll: the helm is broken (2, red), the off-hand
    // sword at 4 of 100 is low (1, yellow) and shown separately; the chest is sound (white, faded).
    assert.deepEqual(figure(), {
      shown: 1, head: 1, headColor: "0.93/0.07/0.07/1.0", chestColor: "1.00/1.00/1.00/0.5",
      offWeapon: 1, offWeaponColor: "1.00/0.82/0.18/1.0", shield: 0, offhandHasWeapon: 1,
    });
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error: VehicleSeatIndicator and OffhandHasWeapon answer");

    // A shield in the off hand, worn just as low: OffhandHasWeapon() is nil and index 10 is the shield.
    world.state.objects.get(OFFHAND).fields.set(offset("OBJECT_FIELD_ENTRY"), 2004);
    lua(boot, "DurabilityFrame_SetAlerts()", 0);
    const shieldView = figure();
    assert.equal(shieldView.offhandHasWeapon, null);
    assert.equal(shieldView.offWeapon, 0);
    assert.equal(shieldView.shield, 1);

    // Repaired: every status is 0 again; the next poll (a quarter second of the boot clock later)
    // raises the event and the figure hides.
    world.state.objects.get(HEAD).fields.set(offset("ITEM_FIELD_DURABILITY"), 100);
    world.state.objects.get(OFFHAND).fields.set(offset("ITEM_FIELD_DURABILITY"), 100);
    await new Promise((resolve) => setTimeout(resolve, 300));
    seam.tick(10);
    assert.equal(figure().shown, 0);
    assert.deepEqual(failures(), errorsAtBoot);
  } finally {
    boot.close();
    game.world = previousWorld;
  }
});

test("OffhandHasWeapon: nil with nothing in the off hand or an unknown item, 1 only for class 2", withClient, async () => {
  const { world, store } = worldFixture();
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  assert.equal(seam.offhandHasWeapon(), true);
  world.state.objects.get(OFFHAND).fields.set(offset("OBJECT_FIELD_ENTRY"), 2004);
  assert.equal(seam.offhandHasWeapon(), false, "a shield");
  world.state.objects.get(OFFHAND).fields.set(offset("OBJECT_FIELD_ENTRY"), 9999);
  assert.equal(seam.offhandHasWeapon(), false, "no template yet");
  world.state.objects.get(PLAYER).fields.delete(offset("PLAYER_FIELD_INV_SLOT_HEAD") + 32);
  world.state.objects.get(PLAYER).fields.delete(offset("PLAYER_FIELD_INV_SLOT_HEAD") + 33);
  assert.equal(seam.offhandHasWeapon(), false, "an empty off hand");
});

test("the vehicle stand-ins appear only for a loaded reader and never over a real frame", async () => {
  const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Readers.lua\nVehicle.xml",
      "interface/framexml/readers.lua": "function MainMenuBar_ToPlayerArt() end",
      "interface/framexml/vehicle.xml": `<Ui><Frame name="VehicleMenuBar"><Scripts><OnLoad>self.real = true</OnLoad></Scripts></Frame></Ui>`,
    }),
    exercise: false,
  });
  try {
    await boot.load();
    assert.equal(lua(boot, "return VehicleMenuBar.real and 1 or 0")[0], 1, "the real frame keeps its name");
    assert.equal(lua(boot, "return VehicleSeatIndicator ~= nil and not VehicleSeatIndicator:IsShown() and 1 or 0")[0], 1,
      "the other name is stood in, hidden");
  } finally {
    boot.close();
  }
  const bare = new FrameXmlBoot({
    provider: createFixtureProvider({ "interface/framexml/framexml.toc": "A.lua", "interface/framexml/a.lua": "X = 1" }),
    exercise: false,
  });
  try {
    await bare.load();
    assert.equal(lua(bare, "return rawget(_G, 'VehicleSeatIndicator') == nil and rawget(_G, 'VehicleMenuBar') == nil and 1 or 0")[0], 1,
      "no reader, no stand-in");
  } finally {
    bare.close();
  }
});
