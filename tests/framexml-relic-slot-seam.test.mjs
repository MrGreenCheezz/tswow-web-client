// Plan item 1.15: UnitHasRelicSlot by class and SetBagPortraitTexture (FrameXmlRelicSlot.ts), as
// Wow.exe 0x611330 and 0x5d7180 answer them.
import assert from "node:assert/strict";
import test from "node:test";

const { FRAMEXML_BAG_PORTRAIT_PRELUDE, frameXmlClassHasRelicSlot } =
  await import("../dist/code/browser/framexml/FrameXmlRelicSlot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { learnCreationNames, forgetCreationNames } = await import("../dist/code/browser/ui/UnitSnapshot.js");

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

function liveSeam(classId, typeId = TYPEID_PLAYER) {
  const selfGuid = 0x10n;
  const targetGuid = 0x20n;
  const bytes0 = (classId << 8) | (1 << 24);
  const world = {
    state: { selfGuid, objects: new Map([
      [selfGuid, { guid: selfGuid, typeId: TYPEID_PLAYER, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, bytes0]]) }],
      [targetGuid, { guid: targetGuid, typeId, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, bytes0]]) }],
    ]) },
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    targetGuid,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  return (unit) => [...FRAMEXML_SEAM_BINDINGS.UnitHasRelicSlot(seam, [unit])];
}

test("paladins, death knights, shamans and druids have a relic slot; 1 or nil", () => {
  for (const classId of [2, 6, 7, 11]) {
    assert.deepEqual(liveSeam(classId)("player"), [1], `class ${classId}`);
  }
  for (const classId of [1, 3, 4, 5, 8, 9, 12]) {
    assert.deepEqual(liveSeam(classId)("player"), [undefined], `class ${classId}`);
  }
});

test("any player unit is answered by its class; a creature, nothing or no unit is nil", () => {
  assert.deepEqual(liveSeam(7)("target"), [1], "a shaman target");
  assert.deepEqual(liveSeam(7, TYPEID_UNIT)("target"), [undefined], "a creature with the same bytes");
  assert.deepEqual(liveSeam(7)("party3"), [undefined], "no such unit");
  assert.deepEqual(liveSeam(7)(undefined), [undefined]);
});

test("ChrClasses.Flags decides when it is known", () => {
  assert.equal(frameXmlClassHasRelicSlot(13, 0x3a), true, "13 HERO carries bit 0x8 on this dataset");
  assert.equal(frameXmlClassHasRelicSlot(2, 0x32), false, "the bit, not the class id");
  assert.equal(frameXmlClassHasRelicSlot(13), false, "without flags only the stock rows are known");
});

test("the dataset's ChrClasses.Flags from /dbc/character-creation?v=4 replaces the stock set", () => {
  // This dataset: 13 HERO carries 0x3a (bit 0x8), 1 WARRIOR 0x32 (no bit).
  learnCreationNames([], [
    { id: 13, name: "Герой", fileName: "HERO", flags: 0x3a, spellClassSet: 10 },
    { id: 2, name: "Паладин", fileName: "PALADIN", flags: 0x32 },
    { id: 1, name: "Воин", fileName: "WARRIOR", flags: 0x32 },
  ]);
  try {
    assert.deepEqual(liveSeam(13)("player"), [1], "HERO has a relic slot on this dataset");
    assert.deepEqual(liveSeam(2)("player"), [undefined], "a paladin row without the bit has none");
    assert.deepEqual(liveSeam(1)("player"), [undefined]);
    assert.deepEqual(liveSeam(7)("player"), [1], "a class the answer leaves out keeps the stock row");
    assert.equal(frameXmlClassHasRelicSlot(13), true, "learned flags without an explicit argument");
  } finally {
    forgetCreationNames();
  }
  assert.deepEqual(liveSeam(13)("player"), [undefined], "an old gateway (no flags): the stock set again");
});

test("the canned seam answers by its units' class tokens", () => {
  const seam = new CannedWorldSeam();
  const answer = [...FRAMEXML_SEAM_BINDINGS.UnitHasRelicSlot(seam, ["player"])];
  const token = seam.unitClass("player")?.[1];
  assert.deepEqual(answer, [["PALADIN", "DEATHKNIGHT", "SHAMAN", "DRUID"].includes(token) ? 1 : undefined]);
});

function withPortraitVm(body) {
  const vm = new GlueLuaVm();
  try {
    vm.setGlobal("__fxNeutralImpl", {});
    const setup = vm.execute(`
      __calls = {}
      function ContainerIDToInventoryID(bag)
        -- The backpack answers a slot here on purpose: the guard, not the mapping, must stop it.
        if bag == 0 then return 20 end
        if bag >= 1 and bag <= 4 then return 19 + bag end
        if bag >= 5 and bag <= 11 then return 63 + bag end
      end
      function GetInventoryItemTexture(unit, slot)
        if unit == "player" and slot == 20 then return "Interface\\\\Icons\\\\INV_Misc_Bag_08" end
        if unit == "player" and slot == 68 then return "Interface\\\\Icons\\\\INV_Misc_Bag_10" end
      end
      function SetPortraitToTexture(texture, path) __calls[#__calls + 1] = tostring(texture) .. "=" .. path end
    `, "@portrait:setup");
    assert.equal(setup.ok, true, setup.error);
    const loaded = vm.execute(FRAMEXML_BAG_PORTRAIT_PRELUDE, "@portrait:prelude");
    assert.equal(loaded.ok, true, loaded.error);
    body((source) => vm.execute(source, "@portrait:probe"), () => {
      const run = vm.execute(`__joined = table.concat(__calls, ";")`, "@portrait:read");
      assert.equal(run.ok, true, run.error);
      return vm.getGlobal("__joined");
    });
  } finally {
    vm.close();
  }
}

test("SetBagPortraitTexture draws the bag item's icon for containers 1..11 only", () => {
  withPortraitVm((run, calls) => {
    const impl = "__fxNeutralImpl.SetBagPortraitTexture";
    assert.equal(run(`${impl}("P1", 1)`).ok, true);
    assert.equal(run(`${impl}("P5", 5)`).ok, true);
    assert.equal(run(`${impl}("P2", 2)`).ok, true, "an empty bag slot draws nothing");
    assert.equal(run(`${impl}("P0", 0)`).ok, true, "the backpack draws nothing");
    assert.equal(run(`${impl}("PM", -1)`).ok, true);
    // The slot is truncated, not rounded: 0x5d7180 converts it with 0x88b9c0 (cvttsd2si).
    assert.equal(run(`${impl}("PT", 0.9)`).ok, true, "0.9 truncates to the backpack");
    assert.equal(run(`${impl}("PR", 1.9)`).ok, true, "1.9 truncates to bag 1");
    assert.equal(run(`${impl}("PB", 11.9)`).ok, true, "11.9 truncates to bank bag 11, not an error");
    assert.equal(calls(), "P1=Interface\\Icons\\INV_Misc_Bag_08;P5=Interface\\Icons\\INV_Misc_Bag_10;PR=Interface\\Icons\\INV_Misc_Bag_08");
    const invalid = run(`${impl}("PX", 12)`);
    assert.equal(invalid.ok, false);
    assert.match(String(invalid.error), /Invalid slot in SetBagPortraitTexture/);
    const usage = run(`${impl}("PX")`);
    assert.equal(usage.ok, false);
    assert.match(String(usage.error), /Usage: SetBagPortraitTexture/);
  });
});

test("the seam prelude carries SetBagPortraitTexture", () => {
  assert.ok(FRAMEXML_SEAM_PRELUDE.includes(FRAMEXML_BAG_PORTRAIT_PRELUDE));
});

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

async function ammoSlotShown(chain, classToken) {
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  seam.setPlayerClass(classToken, classToken);
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU",
    subset: [...FRAMEXML_VERTICAL_TOC],
    seam,
    exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    assert.equal(inventory.files.missing.length, 0);
    const character = boot.bridge.getFrame("CharacterFrame");
    const ammo = boot.bridge.getFrame("CharacterAmmoSlot");
    assert.ok(character, "CharacterFrame"); assert.ok(ammo, "CharacterAmmoSlot");
    const errors = boot.vm.errors.length;
    assert.equal(boot.bridge.Show(character), true);
    assert.equal(boot.vm.errors.length, errors, "PaperDollFrame_OnShow adds no Lua error");
    return boot.bridge.isVisible(ammo);
  } finally {
    boot.close();
  }
}

test("PaperDollFrame_OnShow hides the ammo slot for a relic class and shows it otherwise", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  try {
    assert.equal(await ammoSlotShown(chain, "PALADIN"), false, "a paladin's ranged slot is the relic");
    assert.equal(await ammoSlotShown(chain, "WARRIOR"), true, "a warrior keeps the ammo slot");
  } finally {
    chain.close();
  }
});
