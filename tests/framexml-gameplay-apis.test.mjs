import assert from "node:assert/strict";
import test from "node:test";

const { frameXmlShapeshiftForms } = await import("../dist/code/browser/framexml/FrameXmlShapeshiftForms.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam, CANNED_TARGET } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const metadata = (id, changes = {}) => ({
  id, name: `Spell ${id}`, iconPath: `Interface\\Icons\\Spell_${id}`,
  passive: false, displayInStanceBar: false, stanceBarOrder: 0,
  effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], spellLevel: 1,
  ...changes,
});

test("actual 3.3.5 DBC stance rows include warrior forms and flagged paladin auras in authored order", async (t) => {
  let directory;
  try {
    const { dbcDirectory } = await import("../tools/paths.mjs");
    directory = dbcDirectory();
  } catch {
    t.skip("no local 3.3.5a DBC dataset");
    return;
  }
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const { loadTalentData } = await import("../dist/code/gateway/TalentMetadata.js");
  const [spells, talentData] = await Promise.all([
    loadSpellMetadata(directory), loadTalentData(directory),
  ]);
  const warrior = [2458, 71, 2457].map((id, slot) => ({ id, slot }));
  assert.deepEqual(frameXmlShapeshiftForms(warrior, (id) => spells.get(id)).map((form) => form.spellId),
    [2457, 71, 2458], "warrior stances have MOD_SHAPESHIFT but no display flag");
  const paladin = [7294, 465].map((id, slot) => ({ id, slot }));
  assert.deepEqual(frameXmlShapeshiftForms(paladin, (id) => spells.get(id)).map((form) => form.spellId),
    [465, 7294], "flagged auras have no MOD_SHAPESHIFT effect");
  assert.deepEqual(frameXmlShapeshiftForms([{ id: 13165, slot: 0 }], (id) => spells.get(id)), [],
    "a hunter aspect without either contract is not invented as a stance");
  assert.deepEqual(frameXmlShapeshiftForms(
    [{ id: 5487, slot: 0 }, { id: 9634, slot: 1 }], (id) => spells.get(id),
    (id) => talentData.spellAbilities[id],
  ).map((form) => form.spellId), [9634],
  "SkillLineAbility supersession replaces Bear with Dire Bear in the same stance slot");
});

function liveFixture() {
  const listeners = new Map();
  const fired = [];
  const casts = [];
  const clock = { monotonic: 100_000, lua: 500 };
  const player = { guid: 1n, typeId: 4, fields: new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 17 << 24],
    [UPDATE_FIELDS.PLAYER_BYTES_2.offset, 2 << 16],
  ]) };
  const target = { guid: 2n, typeId: 3, fields: new Map() };
  const spellRows = new Map([
    [2457, metadata(2457, { name: "Battle Stance", stanceBarOrder: 0,
      effectAura: [36, 0, 0], effectMiscValue: [17, 0, 0], bonusActionBarOffset: 1 })],
    [71, metadata(71, { name: "Defensive Stance", stanceBarOrder: 1,
      effectAura: [36, 0, 0], effectMiscValue: [18, 0, 0], bonusActionBarOffset: 2 })],
    [465, metadata(465, { name: "Devotion Aura", stanceBarOrder: 0,
      displayInStanceBar: true })],
  ]);
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player], [2n, target]]) },
    targetGuid: 2n,
    names: new Map(), creatureTemplates: new Map(),
    knownSpells: [{ id: 71, slot: 1 }, { id: 2457, slot: 0 }],
    comboPoints: { guid: 2n, points: 3 },
    auras: new Map(),
    aurasFor(guid) { return [...(world.auras.get(guid)?.values() ?? [])]; },
    actionButtons: [], casts: new Map(), cooldownSnapshots: new Map(),
    spellCategories: new Map([[2457, 47], [71, 47]]), categoryCooldowns: new Map(),
    itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    cooldownRemaining: (id, now) => Math.max(0,
      (world.cooldownSnapshots.get(id)?.endsAt ?? 0) - now,
      (world.categoryCooldowns.get(world.spellCategories.get(id)) ?? 0) - now),
    events: { on(name, callback) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(callback);
      return () => set.delete(callback);
    } },
    buyBankSlot() { world.bankBuys = (world.bankBuys ?? 0) + 1; },
    closeBank() { world.bankerGuid = undefined; },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => spellRows.get(id),
    monotonic: () => clock.monotonic, globalCooldownUntil: () => 0,
    castSpell: (id) => casts.push(id), bankSlotPrice: (bought) => [1000, 2500, 5000][bought],
  });
  const pump = { now: () => clock.lua, fire: (event, ...args) => {
    fired.push([event, ...args]); return 1;
  } };
  const emit = (name, args = {}) => { for (const callback of listeners.get(name) ?? []) callback(args); };
  return { seam, world, player, target, spellRows, casts, clock, pump, fired, emit };
}

test("live stance APIs read form fields, aura flags, cooldowns and route a cast without optimistic activation", () => {
  const { seam, world, player, spellRows, casts, clock, pump, fired } = liveFixture();
  seam.attach(pump);
  assert.deepEqual(call(seam, "GetNumShapeshiftForms"), [2]);
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [1]);
  assert.deepEqual(call(seam, "GetShapeshiftFormInfo", 1),
    ["Interface\\Icons\\Spell_2457", "Battle Stance", true, true]);
  assert.deepEqual(call(seam, "GetShapeshiftFormInfo", 2),
    ["Interface\\Icons\\Spell_71", "Defensive Stance", false, true]);
  assert.deepEqual(call(seam, "GetShapeshiftFormInfo", 3), []);
  call(seam, "CastShapeshiftForm", 2);
  assert.deepEqual(casts, [71]);
  assert.equal(call(seam, "GetShapeshiftFormInfo", 2)[2], false,
    "the server field, not a button click, chooses active form");

  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 18 << 24);
  seam.tick(clock.lua);
  assert.equal(call(seam, "GetShapeshiftFormInfo", 2)[2], true);
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [2]);
  assert.ok(fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.updateShapeshiftForm));
  assert.ok(fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.updateBonusActionBar));
  world.cooldownSnapshots.set(71, { startedAt: 99_000, duration: 10_000, endsAt: 109_000 });
  seam.tick(clock.lua + 0.1);
  assert.deepEqual(call(seam, "GetShapeshiftFormCooldown", 2), [499, 10, 1]);
  assert.equal(call(seam, "GetShapeshiftFormInfo", 2)[3], false);
  assert.ok(fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.updateShapeshiftCooldown));
  call(seam, "CastShapeshiftForm", 2);
  assert.deepEqual(casts, [71], "cooling-down form is not sent");
  world.knownSpells = [{ id: 465, slot: 0 }];
  seam.tick(clock.lua + 0.2);
  assert.deepEqual(call(seam, "GetNumShapeshiftForms"), [1]);
  assert.equal(call(seam, "GetShapeshiftFormInfo", 1)[2], false);
  world.auras.set(1n, new Map([[0, { slot: 0, spellId: 465, flags: 0, casterLevel: 1,
    applications: 1, casterGuid: 3n }]]));
  assert.equal(call(seam, "GetShapeshiftFormInfo", 1)[2], false,
    "another paladin's aura does not select our stance button");
  world.auras.get(1n).get(0).casterGuid = 1n;
  seam.tick(clock.lua + 0.3);
  assert.equal(call(seam, "GetShapeshiftFormInfo", 1)[2], true);
  assert.equal(spellRows.get(465).effectAura.includes(36), false);
  seam.detach();
});

test("bonus page waits for real metadata; shared stance category cooldown blocks sibling forms", () => {
  const { seam, world, player, spellRows, casts, clock, pump, fired } = liveFixture();
  const initial = spellRows.get(2457);
  spellRows.set(2457, { ...initial, bonusActionBarOffset: undefined });
  seam.attach(pump);
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [0]);
  spellRows.set(2457, initial);
  seam.tick(clock.lua);
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [1]);
  assert.equal(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.updateBonusActionBar).length, 1);

  world.categoryCooldowns.set(47, 101_000);
  seam.tick(clock.lua + 0.1);
  assert.deepEqual(call(seam, "GetShapeshiftFormCooldown", 2), [500, 1, 1]);
  assert.equal(call(seam, "GetShapeshiftFormInfo", 2)[3], false);
  assert.ok(fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.updateShapeshiftCooldown));
  call(seam, "CastShapeshiftForm", 2);
  assert.deepEqual(casts, [], "shared category lockout prevents sibling stance cast");

  clock.monotonic = 101_001;
  clock.lua = 501.001;
  seam.tick(clock.lua);
  assert.deepEqual(call(seam, "GetShapeshiftFormCooldown", 2), [0, 0, 0]);
  assert.equal(call(seam, "GetShapeshiftFormInfo", 2)[3], true);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 18 << 24);
  seam.tick(clock.lua + 0.1);
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [2]);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 0);
  seam.tick(clock.lua + 0.2);
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [0]);
  seam.detach();
});

test("combo points remain tied to the selected target; bank slots and price are server-backed", () => {
  const { seam, world, player, pump, fired, emit } = liveFixture();
  seam.attach(pump);
  assert.deepEqual(call(seam, "GetComboPoints", "player", "target"), [3]);
  assert.deepEqual(call(seam, "GetComboPoints", "pet", "target"), [0]);
  world.comboPoints = { guid: 99n, points: 5 };
  emit("COMBO_POINTS_CHANGED", world.comboPoints);
  assert.deepEqual(call(seam, "GetComboPoints", "player", "target"), [0]);
  assert.ok(fired.some(([event, unit]) => event === FRAMEXML_SEAM_EVENTS.unitComboPoints && unit === "player"));
  const count = fired.length;
  emit("COMBO_POINTS_CHANGED", { guid: 2n, points: 5 });
  assert.equal(fired.length, count, "pet combo packet cannot change player combo state");

  assert.deepEqual(call(seam, "GetNumBankSlots"), [2, false]);
  assert.deepEqual(call(seam, "GetBankSlotCost", 2), [5000]);
  assert.deepEqual(call(seam, "GetBankSlotCost", 6), [], "unknown price stays nil");
  call(seam, "BuyBankSlot");
  assert.equal(world.bankBuys, undefined, "no banker permission");
  world.bankerGuid = 40n;
  emit("BANK_OPENED", { bankerGuid: 40n });
  const opened = fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.bankFrameOpened).length;
  emit("BANK_OPENED", { bankerGuid: 40n });
  assert.equal(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.bankFrameOpened).length,
    opened, "purchase-result notification does not reopen the stock bank frame");
  call(seam, "BuyBankSlot");
  assert.equal(world.bankBuys, 1);
  player.fields.set(UPDATE_FIELDS.PLAYER_BYTES_2.offset, 7 << 16);
  seam.tick(500);
  assert.deepEqual(call(seam, "GetNumBankSlots"), [7, true]);
  call(seam, "BuyBankSlot");
  assert.equal(world.bankBuys, 1, "full bank cannot request an eighth slot");
  call(seam, "CloseBankFrame");
  assert.equal(world.bankerGuid, undefined);
  seam.detach();
});

test("original MPQ BonusActionBar and ComboFrame consume the seam and route stance clicks", async (t) => {
  let directory;
  try {
    const { clientDirectory } = await import("../tools/paths.mjs");
    directory = clientDirectory();
  } catch {
    t.skip("no local 3.3.5a client");
    return;
  }
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const chain = await clientArchives(directory);
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) {
      const bytes = await chain.read(path.replaceAll("/", "\\"));
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    } },
    locale: "ruRU", seam,
    subset: FRAMEXML_VERTICAL_TOC,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    assert.equal(inventory.lua.failed, 0);
    assert.equal(boot.errorCount, 0, "full production FrameXML subset initializes without Lua errors");
    const frame = (name) => boot.bridge.getFrame(name);
    assert.ok(frame("ShapeshiftBarFrame"));
    seam.setShapeshiftForms([
      { spellId: 2457, name: "Боевая стойка", texture: "Interface\\Icons\\Ability_Warrior_OffensiveStance",
        bonusActionBarOffset: 1 },
      { spellId: 71, name: "Оборонительная стойка", texture: "Interface\\Icons\\Ability_Warrior_DefensiveStance",
        bonusActionBarOffset: 2 },
    ]);
    assert.equal(frame("ShapeshiftBarFrame").visible, true);
    assert.equal(frame("ShapeshiftButton1Icon").texture,
      "Interface\\Icons\\Ability_Warrior_OffensiveStance");
    assert.equal(frame("ShapeshiftButton2Icon").texture,
      "Interface\\Icons\\Ability_Warrior_DefensiveStance");
    assert.ok(frame("ComboFrame"));
    const before = boot.errorCount;
    boot.bridge.Click(frame("ShapeshiftButton2"), "LeftButton", false);
    assert.deepEqual(seam.castSpellIds, [71]);
    seam.setActiveShapeshiftForm(2);
    assert.equal(frame("ShapeshiftButton2").checked, true);
    assert.deepEqual(call(seam, "GetBonusBarOffset"), [2]);
    assert.equal(boot.vm.execute("__testBonusPage = BonusActionBarFrame.lastBonusBar",
      "@gameplay-bonus-page").ok, true);
    assert.equal(boot.vm.getGlobal("__testBonusPage"), 2,
      "the original BonusActionBar_OnEvent consumes UPDATE_BONUS_ACTIONBAR");
    seam.setTarget(CANNED_TARGET);
    seam.setComboPoints(3);
    assert.equal(frame("ComboFrame").visible, true);
    assert.equal(frame("ComboPoint3").visible, true);
    seam.setComboPoints(0);
    assert.equal(frame("ComboFrame").visible, false);
    seam.setActiveShapeshiftForm(0);
    assert.deepEqual(call(seam, "GetBonusBarOffset"), [0]);
    assert.equal(boot.vm.execute("__testBonusMode = BonusActionBarFrame.mode",
      "@gameplay-bonus-hide").ok, true);
    assert.equal(boot.vm.getGlobal("__testBonusMode"), "hide",
      "stock BonusActionBarFrame starts its hide transition when the server leaves the form");
    assert.equal(boot.errorCount, before, "stock form and combo interactions raise no new Lua errors");
  } finally {
    boot.close();
    await chain.close();
  }
});
