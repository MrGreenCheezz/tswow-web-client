import assert from "node:assert/strict";
import test from "node:test";

const {
  createFrameXmlServices,
  FRAMEXML_SERVICE_BINDINGS,
  TABARD_CREATION_COST_COPPER,
} = await import("../dist/code/browser/framexml/FrameXmlServices.js");
const { loadSlotPrices } = await import("../dist/code/gateway/SlotPrices.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { clientArchives } = await import("../tools/mpq.mjs");

let clientDirectory;
let dbcDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
  dbcDirectory = paths.dbcDirectory();
} catch {
  // The arithmetic test below still runs without local 3.3.5a resources.
}
const withClient = { skip: clientDirectory && dbcDirectory ? false : "no 3.3.5a client and DBC dataset" };

function callLua(boot, name, args = [], results = 1) {
  const ref = boot.vm.globalFunction(name);
  assert.ok(ref, `${name} must be available to stock Lua`);
  try { return boot.vm.call(ref, args, results); }
  finally { boot.vm.release(ref); }
}

test("postage follows the server's attachment rule; absent stable offers remain inactive", () => {
  let items = [];
  let stable;
  let price;
  const services = createFrameXmlServices({
    sendMailItems: () => items,
    stableService: () => stable,
    stableSlotPrice: () => price,
  });

  assert.equal(services.tabardCreationCost(), TABARD_CREATION_COST_COPPER);
  assert.equal(services.sendMailPrice(), 30, "a plain letter costs 30 copper");
  assert.deepEqual(services.sendMailItem(1), [undefined, undefined, 0, undefined]);
  items = [["Linen Cloth", "Interface\\Icons\\INV_Fabric_Linen_01", 8, 1],
    ["Copper Ore", "Interface\\Icons\\INV_Ore_Copper_01", 3, 1]];
  assert.equal(services.sendMailPrice(), 60, "each attached item adds 30 copper");
  assert.deepEqual(services.sendMailItem(1), items[0]);
  assert.deepEqual(FRAMEXML_SERVICE_BINDINGS.GetSendMailItem(services, [2]), items[1]);
  assert.deepEqual(FRAMEXML_SERVICE_BINDINGS.GetSendMailItem(services, [3]), [undefined, undefined, 0, undefined]);
  assert.equal(services.nextStableSlotCost(), undefined);
  assert.equal(services.stableSlots(), undefined);
  assert.deepEqual(FRAMEXML_SERVICE_BINDINGS.GetNumStableSlots(services, []), [0],
    "an unopened stable has no enabled slots in the hidden stock frame");
  assert.deepEqual(FRAMEXML_SERVICE_BINDINGS.GetNextStableSlotCost(services, []), [0],
    "the closed stock MoneyFrame gets an inactive display value, not a purchasable offer");

  stable = { masterGuid: 42n, slotsOwned: 1 };
  assert.deepEqual(FRAMEXML_SERVICE_BINDINGS.GetNumStableSlots(services, []), [1]);
  assert.equal(services.nextStableSlotCost(), undefined, "an open service without DBC prices has no offer");
  price = 50_000;
  assert.equal(services.nextStableSlotCost(), 50_000);
  assert.deepEqual(FRAMEXML_SERVICE_BINDINGS.GetNextStableSlotCost(services, []), [50_000]);
  stable = { masterGuid: 0n, slotsOwned: 1 };
  assert.equal(services.nextStableSlotCost(), undefined, "a stale or closed master has no offer");
  assert.deepEqual(FRAMEXML_SERVICE_BINDINGS.GetNumStableSlots(services, []), [0]);
  stable = { masterGuid: 42n, slotsOwned: 4 };
  assert.equal(services.nextStableSlotCost(), undefined, "the server's four-slot maximum has no next row");
  assert.deepEqual(FRAMEXML_SERVICE_BINDINGS.GetNumStableSlots(services, []), [4]);
});

test("live seam prices the native draft, rejects a stale stable list, and reads pet owner XP", () => {
  const item1 = 0x101n;
  const item2 = 0x102n;
  const petGuid = 0x201n;
  const field = (name, value) => [UPDATE_FIELDS[name].offset, value];
  const world = {
    state: { selfGuid: 0x100n, objects: new Map([
      [0x100n, { guid: 0x100n, fields: new Map([
        field("PLAYER_PET_SPELL_POWER", 123),
      ]) }],
      [item1, { guid: item1, fields: new Map([
        field("OBJECT_FIELD_ENTRY", 2589), field("ITEM_FIELD_STACK_COUNT", 8),
      ]) }],
      [item2, { guid: item2, fields: new Map([
        field("OBJECT_FIELD_ENTRY", 2770), field("ITEM_FIELD_STACK_COUNT", 3),
      ]) }],
      [petGuid, { guid: petGuid, fields: new Map([
        field("UNIT_FIELD_PETEXPERIENCE", 125), field("UNIT_FIELD_PETNEXTLEVELEXP", 400),
      ]) }],
    ]) },
    itemTemplates: new Map([
      [2589, { name: "Linen Cloth", quality: 1 }],
      [2770, { name: "Copper Ore", quality: 1 }],
    ]),
    petSpells: { guid: petGuid },
    stableMasterGuid: 0n,
    stable: undefined,
  };
  let nativeDraft = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 1_000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    mailDraftAttachments: () => nativeDraft,
    stableSlotPrice: (owned) => new Map([[1, 50_000], [2, 500_000]]).get(owned),
    itemTexture: (entry) => entry === 2589 ? "Interface\\Icons\\INV_Fabric_Linen_01"
      : entry === 2770 ? "Interface\\Icons\\INV_Ore_Copper_01" : undefined,
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("GetSendMailPrice"), [30]);
  assert.deepEqual(call("GetSendMailItem", 1), [undefined, undefined, 0, undefined]);
  nativeDraft = [item1, item2];
  assert.deepEqual(call("GetSendMailItem", 1), [
    "Linen Cloth", "Interface\\Icons\\INV_Fabric_Linen_01", 8, 1,
  ]);
  assert.deepEqual(call("GetSendMailItem", 2), [
    "Copper Ore", "Interface\\Icons\\INV_Ore_Copper_01", 3, 1,
  ]);
  assert.deepEqual(call("GetSendMailPrice"), [60], "postage uses the same native draft slots");
  assert.deepEqual(call("GetPetExperience"), [125, 400]);
  assert.deepEqual(call("GetPetSpellBonusDamage"), [123],
    "the live pet bonus comes from its owner's private server update field");
  world.petSpells = undefined;
  assert.deepEqual(call("GetPetSpellBonusDamage"), [0],
    "a stale owner field is not exposed after the current pet disappears");
  world.petSpells = { guid: petGuid };

  world.stable = { npcGuid: 0x700n, stableSlots: 1, pets: [] };
  assert.deepEqual(call("GetNumStableSlots"), [0], "a stale server list is not an open stable service");
  assert.deepEqual(call("GetNextStableSlotCost"), [0], "the hidden frame gets an inactive display value");
  assert.equal(seam.services.nextStableSlotCost(), undefined, "no purchasable quote exists");
  world.stableMasterGuid = 0x700n;
  assert.deepEqual(call("GetNumStableSlots"), [1]);
  assert.deepEqual(call("GetNextStableSlotCost"), [50_000]);
  world.stableMasterGuid = 0x701n;
  assert.deepEqual(call("GetNumStableSlots"), [0], "changing NPC invalidates the old roster");
  assert.equal(seam.services.nextStableSlotCost(), undefined);
});

test("live stable slot and master changes publish once before DBC prices resolve", () => {
  const world = new WorldClient({ send() {}, close() {} });
  world.state = new WorldState();
  world.stableMasterGuid = 0x700n;
  world.stable = { npcGuid: 0x700n, stableSlots: 1, pets: [] };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 1_000, globalCooldownUntil: () => 0, castSpell: () => {},
    stableSlotPrice: () => undefined,
  });
  const events = [];
  seam.attach({ now: () => 0, fire(event) { events.push(event); return 1; } });
  try {
    assert.equal(seam.services.nextStableSlotCost(), undefined,
      "the catalog has not resolved a purchase quote");
    seam.tick(0);
    events.length = 0;
    world.stable = { ...world.stable, stableSlots: 2 };
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNumStableSlots(seam, []), [2]);
    seam.tick(0.1);
    assert.deepEqual(events.filter((event) => event === "PET_STABLE_UPDATE"), ["PET_STABLE_UPDATE"],
      "an authoritative slot change redraws the stock stable even with no next price");
    seam.tick(0.2);
    assert.equal(events.filter((event) => event === "PET_STABLE_UPDATE").length, 1,
      "unchanged polls do not repeat the update");

    world.stableMasterGuid = 0x701n;
    world.stable = { ...world.stable, npcGuid: 0x701n };
    seam.tick(0.3);
    assert.equal(events.filter((event) => event === "PET_STABLE_UPDATE").length, 2,
      "changing the active NPC is a separate stable service edge");
    seam.tick(0.4);
    assert.equal(events.filter((event) => event === "PET_STABLE_UPDATE").length, 2);
  } finally {
    seam.detach();
  }
});

test("real MPQ MoneyFrames receive costs from server rules and the selected StableSlotPrices DBC", withClient, async () => {
  const prices = await loadSlotPrices(dbcDirectory);
  const stablePrices = new Map(Object.entries(prices.stable).map(([id, cost]) => [Number(id), cost]));
  assert.ok(stablePrices.get(1) > 0 && stablePrices.get(2) > 0,
    "the selected dataset supplies the first two stable offers");
  let items = [];
  let stable;
  const services = createFrameXmlServices({
    sendMailItems: () => items,
    stableService: () => stable,
    stableSlotPrice: (slotsOwned) => stablePrices.get(slotsOwned + 1),
  });
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  seam.services = services;
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const bytes = await chain.read(path.replaceAll("/", "\\"));
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    locale: "ruRU",
    screen: () => ({ width: 1280, height: 768 }),
    seam,
  });

  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.errors.filter(({ file }) => file.endsWith("/moneyframe.lua")), [],
      "all three original money cost call sites initialize without a nil amount");
    assert.deepEqual(callLua(boot, "GetTabardCreationCost"), [TABARD_CREATION_COST_COPPER]);
    assert.deepEqual(callLua(boot, "GetSendMailPrice"), [30]);
    assert.deepEqual(callLua(boot, "GetSendMailItem", [1], 4), [undefined, undefined, 0, undefined]);
    const moneyProbe = boot.vm.execute(`function __TestStockMoneyFrames()
      return TabardFrameCostMoneyFrame.staticMoney,
        SendMailCostMoneyFrame.staticMoney, PetStableCostMoneyFrame.staticMoney
    end`, "@framexml-services:money-probe");
    assert.equal(moneyProbe.ok, true);
    assert.deepEqual(callLua(boot, "__TestStockMoneyFrames", [], 3), [100_000, 30, 0]);
    assert.deepEqual(callLua(boot, "GetNextStableSlotCost"), [0],
      "UNIT_PET can refresh the hidden stable frame before a stable service is open");
    assert.deepEqual(callLua(boot, "GetNumStableSlots"), [0]);
    const errorsBeforePetUpdate = boot.errors.length;
    boot.bridge.dispatchEvent("UNIT_PET", "player");
    assert.deepEqual(boot.errors.slice(errorsBeforePetUpdate).filter(({ file }) => file.endsWith("/petstable.lua")), [],
      "the hidden stock stable frame has a numeric slot count before a stable list arrives");

    items = [["Linen Cloth", "Interface\\Icons\\INV_Fabric_Linen_01", 8, 1],
      ["Copper Ore", "Interface\\Icons\\INV_Ore_Copper_01", 3, 1],
      ["Peacebloom", "Interface\\Icons\\INV_Misc_Flower_02", 1, 1]];
    stable = { masterGuid: 42n, slotsOwned: 0 };
    assert.deepEqual(callLua(boot, "GetSendMailPrice"), [90]);
    assert.deepEqual(callLua(boot, "GetSendMailItem", [2], 4), items[1]);
    const errorsBeforeMailUpdate = boot.errors.length;
    boot.bridge.dispatchEvent("MAIL_SEND_INFO_UPDATE");
    assert.deepEqual(boot.errors.slice(errorsBeforeMailUpdate), [],
      "the original SendMailFrame_Update accepts the same draft items used to price postage");
    assert.deepEqual(callLua(boot, "__TestStockMoneyFrames", [], 3), [100_000, 90, 0],
      "MAIL_SEND_INFO_UPDATE repaints the original postage MoneyFrame from the same draft");
    assert.deepEqual(callLua(boot, "GetNextStableSlotCost"), [stablePrices.get(1)]);
    assert.deepEqual(callLua(boot, "GetNumStableSlots"), [0]);
    stable = { masterGuid: 42n, slotsOwned: 1 };
    assert.deepEqual(callLua(boot, "GetNextStableSlotCost"), [stablePrices.get(2)],
      "the next offer follows the server's MaxStabledPets + 1 DBC row");
    assert.deepEqual(callLua(boot, "GetNumStableSlots"), [1],
      "a matching server list, rather than the DBC, controls enabled stable slots");
  } finally {
    boot.close();
    chain.close();
  }
});
