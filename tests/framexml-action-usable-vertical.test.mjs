import assert from "node:assert/strict";
import test from "node:test";

// 19.10: the stock ActionButton.lua from the retail 3.3.5a MPQ over LiveWorldSeam and a real WorldClient: a slot
// whose spell costs more mana than the player has is tinted blue by ActionButton_UpdateUsable (IsUsableAction's
// notEnoughMana), and once the mana is there the seam's ACTIONBAR_UPDATE_USABLE turns it white again — no other
// event in between. A stealth-only spell outside stealth is grey (0.4). Colours are read back from Lua.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
const { clientDirectory } = await import("../tools/paths.mjs");
const { openClientArchives } = await import("../tools/mpq.mjs");

let clientDir;
try {
  clientDir = clientDirectory();
} catch {
  clientDir = undefined;
}

const PLAYER = 0x10n;
const offset = (name) => UPDATE_FIELDS[name].offset;
const SPELLS = new Map([
  [133, { id: 133, name: "Огненный шар", rank: "", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", passive: false,
    powerType: 0, powerCost: 100, powerCostPercent: 0, schoolMask: 4, spellClassSet: 3, spellClassMask: [1, 0, 0],
    effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], attributes: [0x10000, 0, 0, 0, 0, 0, 0, 0],
    recoveryTime: 0, categoryRecoveryTime: 0, startRecoveryTime: 1500 }],
  // 8676 «Внезапный удар»'s words: ShapeshiftMask form 30, SPELL_ATTR0_ONLY_STEALTHED.
  [8676, { id: 8676, name: "Внезапный удар", rank: "", iconPath: "Interface\\Icons\\Ability_Rogue_Ambush", passive: false,
    powerType: 3, powerCost: 60, powerCostPercent: 0, schoolMask: 1, spellClassSet: 8, spellClassMask: [0x200, 0, 0],
    effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], attributes: [0x270010, 0x8000200, 0x100000, 0x400, 0, 0, 0, 0],
    shapeshiftMask: [0x20000000, 0], shapeshiftExclude: [0, 0], recoveryTime: 0, categoryRecoveryTime: 0 }],
]);

test("stock ActionButton over the live seam: blue while short of mana, white on the seam's USABLE edge, grey when barred", {
  skip: clientDir ? false : "no 3.3.5a client on this machine",
}, async () => {
  const chain = await openClientArchives(clientDir);
  const decoder = new TextDecoder("utf-8");
  const world = new WorldClient({ send() {}, close() {} });
  const state = new WorldState();
  world.state = state;
  const fields = new Map([
    [offset("UNIT_FIELD_BYTES_0"), 1 | (8 << 8)], // human mage, mana
    [offset("UNIT_FIELD_LEVEL"), 20],
    [offset("UNIT_FIELD_HEALTH"), 400],
    [offset("UNIT_FIELD_MAXHEALTH"), 500],
    [offset("UNIT_FIELD_POWER1"), 50],
    [offset("UNIT_FIELD_MAXPOWER1"), 600],
    [offset("UNIT_FIELD_POWER1") + 3, 100],
    [offset("PLAYER_XP"), 100],
    [offset("PLAYER_NEXT_LEVEL_XP"), 1000],
  ]);
  state.objects.set(PLAYER, {
    guid: PLAYER, typeId: 4, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined,
    runSpeed: undefined, turnRate: undefined, motion: undefined, glide: undefined, transport: undefined,
    speeds: undefined, transportTime: undefined, fields,
  });
  state.selfGuid = PLAYER;
  const store = new WorldStore(state);
  world.mapId = 0;
  world.selfName = "Проба";
  world.knownSpells = [{ id: 133, slot: 0 }, { id: 8676, slot: 1 }];
  world.actionButtons = [
    { slot: 0, action: 133, type: ACTION_BUTTON_SPELL },
    { slot: 1, action: 8676, type: ACTION_BUTTON_SPELL },
  ];
  const realmTime = { minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  const clock = { monotonic: 1000, lua: 2 };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: (id) => SPELLS.get(id),
    monotonic: () => clock.monotonic, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const bytes = await chain.read(path); return bytes ? decoder.decode(bytes) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1024, height: 768 }),
  });
  const colour = (button) => {
    const probe = boot.vm.execute(`
      local r, g, b = ${button}Icon:GetVertexColor()
      __r, __g, __b = r, g, b
      __usable, __noMana = IsUsableAction(${button}.action)
    `, "@usable:probe");
    assert.equal(probe.ok, true, probe.error);
    const round = (value) => Math.round(Number(value) * 100) / 100;
    return [round(boot.vm.getGlobal("__r")), round(boot.vm.getGlobal("__g")), round(boot.vm.getGlobal("__b"))];
  };
  const step = () => { clock.monotonic += 150; clock.lua += 0.15; seam.tick(clock.lua); };
  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.errors, [], "vertical inventory has no handled Lua failures");
    step();
    // The bar paints on its own Update (PLAYER_ENTERING_WORLD / ACTIONBAR_SLOT_CHANGED).
    const paint = boot.vm.execute("ActionButton_Update(ActionButton1); ActionButton_Update(ActionButton2)", "@usable:paint");
    assert.equal(paint.ok, true, paint.error);
    assert.deepEqual(colour("ActionButton1"), [0.5, 0.5, 1], "50 of 100 mana: ActionButton_UpdateUsable's blue");
    assert.deepEqual(colour("ActionButton2"), [0.4, 0.4, 0.4], "Ambush outside stealth: grey");
    fields.set(offset("UNIT_FIELD_POWER1"), 400);
    step();
    assert.deepEqual(colour("ActionButton1"), [1, 1, 1], "the USABLE edge repaints it white");
    fields.set(offset("UNIT_FIELD_POWER1"), 20);
    step();
    assert.deepEqual(colour("ActionButton1"), [0.5, 0.5, 1], "and blue again");
    assert.deepEqual(boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`), []);
  } finally {
    boot.close();
    await chain.close();
  }
});
