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

// Macros (3.10): RunMacro/RunMacroText/StopMacro/GetClickFrame over the shared runner
// (src/browser/macro/MacroRunner.ts), and the seam's macro context over the live world.
test("RunMacro and RunMacroText run the slash lines in order with their button; StopMacro ends a run after its line", async () => {
  const { installMacroLineExecutor, macroRunButton } = await import("../dist/code/browser/macro/MacroRunner.js");
  const { seam, store } = fixture();
  store.put({ index: 3, name: "Бой", body: "#showtooltip\n/cast [mod:shift] А; Б\n#show Б\n-- заметка\nпросто текст\n  /stopmacro [combat]\n/dance\n" });
  const ran = [];
  let stopAt;
  let nested;
  const uninstall = installMacroLineExecutor((line) => {
    ran.push([line, macroRunButton() ?? null]);
    if (line === stopAt) call(seam, "StopMacro");
    if (line === "/click Вложенный" && nested) call(seam, "RunMacroText", nested, "LeftButton");
  });
  try {
    // Position 2 is slot 3 (slot 2 is «Танец»); a name reaches the same macro.
    call(seam, "RunMacro", 2);
    assert.deepEqual(ran, [
      ["/cast [mod:shift] А; Б", null], ["просто текст", null], ["/stopmacro [combat]", null], ["/dance", null],
    ], "every line runs, a line without / too (the client says it); the # directives and - comments do not");
    ran.length = 0;
    stopAt = "/stopmacro [combat]";
    call(seam, "RunMacro", "бой", "RightButton");
    assert.deepEqual(ran, [
      ["/cast [mod:shift] А; Б", "RightButton"], ["просто текст", "RightButton"], ["/stopmacro [combat]", "RightButton"],
    ]);
    assert.equal(macroRunButton(), undefined, "the button belongs to the run");
    ran.length = 0;
    call(seam, "StopMacro");
    call(seam, "RunMacroText", "/first\n/second", "MiddleButton");
    assert.deepEqual(ran, [["/first", "MiddleButton"], ["/second", "MiddleButton"]], "a stop outside a run stops nothing later");
    // A macro a macro starts (a /click of a macro button) runs inside it with its own button, and
    // its /stopmacro ends only itself.
    ran.length = 0;
    stopAt = "/n-stop";
    nested = "/n1\n/n-stop\n/n2";
    call(seam, "RunMacroText", "/a\n/click Вложенный\n/b", "RightButton");
    assert.deepEqual(ran, [
      ["/a", "RightButton"], ["/click Вложенный", "RightButton"], ["/n1", "LeftButton"], ["/n-stop", "LeftButton"],
      ["/b", "RightButton"],
    ]);
    ran.length = 0;
    call(seam, "RunMacro", 99);
    call(seam, "RunMacroText", 42);
    assert.deepEqual(ran, [], "no macro, no text: nothing runs");
  } finally {
    uninstall();
  }
});

test("GetClickFrame answers any frame of that name; the stock /click body checks it is a Button", async () => {
  const { installMacroClickFrames } = await import("../dist/code/browser/macro/MacroRunner.js");
  const { seam } = fixture();
  const frames = new Map([["Кнопка", { name: "Кнопка", type: "Button" }], ["Рамка", { name: "Рамка", type: "Frame" }]]);
  assert.deepEqual(call(seam, "GetClickFrame", "Кнопка"), [], "no interface published: no frames");
  const uninstall = installMacroClickFrames((name) => frames.get(name));
  try {
    assert.equal(call(seam, "GetClickFrame", "Кнопка")[0]?.name, "Кнопка");
    assert.equal(call(seam, "GetClickFrame", "Рамка")[0]?.name, "Рамка", "Wow.exe 0x564130 → 0x562990: any frame");
    assert.deepEqual(call(seam, "GetClickFrame", "Нет"), []);
    assert.deepEqual(call(seam, "GetClickFrame"), []);
  } finally {
    uninstall();
  }
});

test("a macro may start another only so deep: a macro that runs itself ends", async () => {
  const { installMacroLineExecutor, MACRO_RUN_DEPTH } = await import("../dist/code/browser/macro/MacroRunner.js");
  const { seam } = fixture();
  let runs = 0;
  const uninstall = installMacroLineExecutor(() => {
    runs += 1;
    call(seam, "RunMacroText", "/again");
  });
  try {
    call(seam, "RunMacroText", "/again");
    assert.equal(runs, MACRO_RUN_DEPTH, "each level ran its one line, the next level was refused");
  } finally {
    uninstall();
  }
});

test("UseAction hands the host the mouse button, which a macro on the button reads", () => {
  const presses = [];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    actionButtons: [{ slot: 4, action: 37, type: ACTION_BUTTON_MACRO }], casts: new Map(), cooldownSnapshots: new Map(),
    itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    events: { on() { return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell() {}, useAction: (slot, button) => presses.push([slot, button ?? null]),
  });
  call(seam, "UseAction", 5, undefined, "RightButton");
  call(seam, "UseAction", 5);
  assert.deepEqual(presses, [[5, "RightButton"], [5, null]]);
});

test("the live seam's macro context answers from the world the stock UI reads", async () => {
  const { frameXmlSecureCmdOptionParse } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
  const { REACTION_HOSTILE } = await import("../dist/code/world/FactionRules.js");
  const player = { guid: 1n, typeId: 4, movementFlags: 0, fields: new Map() };
  const wolf = { guid: 2n, typeId: 3, movementFlags: 0, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 50]]) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player], [2n, wolf]]) },
    targetGuid: 2n, actionButtons: [], casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(),
    mirrorTimers: new Map(), itemTemplates: new Map(), knownSpells: [], partyStats: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    aurasFor: () => [], events: { on() { return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell() {},
    reaction: () => REACTION_HOSTILE,
  });
  const parse = (options) => frameXmlSecureCmdOptionParse(options, seam.macroContext());
  assert.equal(seam.macroContext(), seam.macroContext(), "one context per seam");
  assert.deepEqual(parse("[combat] А; Б"), ["Б"]);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x80000);
  assert.deepEqual(parse("[combat] А; Б"), ["А"], "UNIT_FLAG_IN_COMBAT on the player");
  assert.deepEqual(parse("[harm,nodead] А; Б"), ["А"]);
  assert.deepEqual(parse("[help] А; Б"), ["Б"]);
  assert.deepEqual(parse("[@player,help] А; Б"), ["А", "player"]);
  wolf.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  assert.deepEqual(parse("[harm,nodead] А; Б"), ["Б"]);
  assert.deepEqual(parse("[@focus,exists] А; Б"), ["Б"]);
  assert.deepEqual(parse("[mounted] А; [swimming] Б; [flying] В; [stealth] Г; Д"), ["Д"]);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 14_338);
  assert.deepEqual(parse("[mounted] А; Б"), ["А"]);
  player.movementFlags = 0x0020_0000;
  assert.deepEqual(parse("[swimming] А; Б"), ["А"], "MOVEMENTFLAG_SWIMMING of the last movement sent");
  player.movementFlags = 0x0200_0000;
  assert.deepEqual(parse("[swimming] А; [flying] Б; В"), ["Б"]);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset, 0x02 << 16);
  assert.deepEqual(parse("[stealth] А; Б"), ["А"], "UNIT_VIS_FLAGS_CREEP, which only SPELL_AURA_MOD_STEALTH sets");
  assert.deepEqual(parse("[spec:1] А; Б"), ["Б"], "no talents yet: no spec");
  world.talents = { activeSpec: 1, unspentPoints: 0, pet: false, specs: [] };
  assert.deepEqual(parse("[spec:2] А; Б"), ["А"]);
  assert.deepEqual(parse("[stance:0,nobonusbar,actionbar:1] А; Б"), ["А"], "no forms, the main page");
  // The conditions this client has no data for yet answer «no»; without area data the player is outdoors.
  assert.deepEqual(parse("[flyable] А; [indoors] Б; [vehicleui] В; [equipped:Щиты] Г; Д"), ["Д"]);
  assert.deepEqual(parse("[outdoors] А; Б"), ["А"]);
  // [combat] also holds while only the pet fights (Wow.exe 0x5ef710).
  player.fields.delete(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset);
  assert.deepEqual(parse("[combat] А; Б"), ["Б"]);
  world.petSpells = { guid: 9n, creatureFamily: 1 };
  world.state.objects.set(9n, { guid: 9n, typeId: 3, movementFlags: 0, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x80000]]) });
  assert.deepEqual(parse("[combat] А; Б"), ["А"]);
  // [party] leaves the player out, though UnitInParty("player") is true in a group (0x5eede0); [raid]
  // is the party or the raid, which counts the player (0x5eee20).
  world.group = { groupType: 0, leaderGuid: 1n, members: [{ guid: 3n, name: "Жрец" }] };
  assert.equal(seam.unitInParty("player"), true);
  assert.deepEqual(parse("[@player,party] А; Б"), ["Б"]);
  assert.deepEqual(parse("[@player,raid] А; Б"), ["Б"]);
  world.group = { groupType: 2, leaderGuid: 1n, members: [{ guid: 3n, name: "Жрец" }] };
  assert.deepEqual(parse("[@player,raid] А; Б"), ["А", "player"]);
});

test("the live seam's [stance] is 0 without a form byte, whatever the stance bar shows as active", async () => {
  const { frameXmlSecureCmdOptionParse } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
  const player = { guid: 1n, typeId: 4, movementFlags: 0, fields: new Map() };
  const rows = new Map([
    // Devotion Aura: on the stance bar (DisplayInStanceBar) but no shapeshift, like a DK presence.
    [465, { id: 465, name: "Аура благочестия", iconPath: "Interface\\Icons\\Spell_Holy_DevotionAura", passive: false,
      stanceBarOrder: 0, displayInStanceBar: true, effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], spellLevel: 1 }],
    [768, { id: 768, name: "Облик кошки", iconPath: "Interface\\Icons\\Ability_Druid_CatForm", passive: false,
      stanceBarOrder: 1, displayInStanceBar: false, effectAura: [36, 0, 0], effectMiscValue: [1, 0, 0], spellLevel: 20,
      bonusActionBarOffset: 1 }],
  ]);
  let lookups = 0;
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player]]) },
    knownSpells: [{ id: 465, slot: 0 }, { id: 768, slot: 1 }], actionButtons: [], casts: new Map(),
    cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    aurasFor: () => [{ spellId: 465, casterGuid: 1n }], events: { on() { return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => { lookups += 1; return rows.get(id); },
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell() {},
  });
  const parse = (options) => frameXmlSecureCmdOptionParse(options, seam.macroContext());
  assert.deepEqual(parse("[stance:1] А; [stance:0] Б; В"), ["Б"], "the aura is active, but GetShapeshiftForm(true) is 0");
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 1 << 24);
  assert.deepEqual(parse("[stance:2,bonusbar:1] А; Б"), ["А"], "cat form is the second button, on bonus bar 1");
  // A state driver asks five times a second: the form lookups walk the learned spells once per form.
  const walked = lookups;
  for (let press = 0; press < 5; press += 1) parse("[stance:2,bonusbar:1] А; Б");
  assert.equal(lookups, walked, "no spell row is read again until the form, the spells or the rows change");
});
