import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL } =
  await import("../dist/code/world/ActionBarProtocol.js");

function fixture(context = {}) {
  const listeners = new Map();
  const fired = [];
  const used = [];
  const cast = [];
  const clock = { monotonic: 100_000, lua: 500 };
  const item = (guid, entry, count) => ({
    guid, typeId: 1, fields: new Map([
      [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
      [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, count],
    ]),
  });
  const player = { guid: 1n, typeId: 4, fields: new Map([
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 2],
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 2, 3],
    [UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset, 4],
    [UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 12 * 2, 5],
  ]) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([
      [1n, player], [2n, item(2n, 13446, 2)], [3n, item(3n, 13446, 3)],
      [4n, item(4n, 13446, 99)], [5n, item(5n, 90001, 1)],
    ]) },
    actionButtons: [
      { slot: 0, action: 13446, type: ACTION_BUTTON_ITEM },
      { slot: 1, action: 90001, type: ACTION_BUTTON_ITEM },
      { slot: 2, action: 90002, type: ACTION_BUTTON_ITEM },
      { slot: 12, action: 133, type: ACTION_BUTTON_SPELL },
      { slot: 13, action: 1, type: ACTION_BUTTON_MACRO },
    ],
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(),
    itemTemplates: new Map([
      [13446, { found: true, entry: 13446, quality: 1, name: "Зелье", stackable: 20,
        spells: [{ spellId: 17534, trigger: 0 }] }],
      [90001, { found: true, entry: 90001, quality: 3, name: "Аксессуар", stackable: 1,
        spells: [{ spellId: 333, trigger: 0 }] }],
    ]),
    cooldownRemaining: (id, now) => Math.max(0, (world.cooldownSnapshots.get(id)?.endsAt ?? 0) - now),
    cooldownState: (id) => world.cooldownSnapshots.get(id),
    isActiveMountSpell: () => false,
    useItem: (...args) => used.push(args),
    events: {
      on(name, listener) {
        const callbacks = listeners.get(name) ?? new Set();
        listeners.set(name, callbacks);
        callbacks.add(listener);
        return () => callbacks.delete(listener);
      },
    },
  };
  const emit = (name, args = {}) => {
    for (const listener of listeners.get(name) ?? []) listener(args);
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined,
    spell: (id) => id === 133 ? { id, name: "Огненный шар", rank: "", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt" } : undefined,
    monotonic: () => clock.monotonic, globalCooldownUntil: () => 0,
    castSpell: (id) => cast.push(id),
    itemTexture: (entry) => entry === 13446 ? "Interface\\Icons\\INV_Potion_54" : undefined,
    ...context,
  });
  const pump = { now: () => clock.lua, fire: (name, ...args) => { fired.push([name, ...args]); return 1; } };
  return { seam, world, player, fired, used, cast, clock, pump, emit };
}

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("the stock clock reads server game time using the world monotonic epoch", () => {
  const { seam, world, clock } = fixture();
  assert.deepEqual(call(seam, "GetGameTime"), [], "no login clock remains unknown");
  world.currentGameTime = (now) => {
    assert.equal(now, clock.monotonic);
    return { minuteOfDay: 1439.99 };
  };
  assert.deepEqual(call(seam, "GetGameTime"), [23, 59]);
  world.currentGameTime = () => ({ minuteOfDay: 1440.01 });
  assert.deepEqual(call(seam, "GetGameTime"), [0, 0]);
});

test("stock item actions use carried stack counts, cached icons and current inventory addresses", () => {
  const { seam, world, player, used } = fixture();
  assert.deepEqual(call(seam, "GetActionTexture", 1), ["Interface\\Icons\\INV_Potion_54"]);
  assert.deepEqual(call(seam, "GetActionCount", 1), [5], "bank copies are excluded");
  assert.deepEqual(call(seam, "IsEquippedAction", 2), [true]);
  assert.deepEqual(call(seam, "IsUsableAction", 3), [false, false], "no carried copy");
  call(seam, "UseAction", 1);
  assert.deepEqual(used, [[255, 23, 2n]]);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 0);
  call(seam, "UseAction", 1);
  assert.deepEqual(used.at(-1), [255, 24, 3n], "moving/consuming a stack resolves the remaining GUID");
  call(seam, "UseAction", 2);
  assert.deepEqual(used.at(-1), [255, 12, 5n], "equipped trinkets use the same item protocol");
  world.state.objects.delete(3n);
  assert.deepEqual(call(seam, "GetActionCount", 1), [0]);
  const before = used.length;
  call(seam, "UseAction", 1);
  assert.equal(used.length, before, "a remaining bank copy cannot be used");
});

test("original action, bag and equipped cooldown APIs share stable realm timers and expiry events", () => {
  const { seam, world, clock, pump, emit, fired, used } = fixture();
  seam.attach(pump);
  seam.tick(clock.lua);
  fired.length = 0;
  world.cooldownSnapshots.set(17534, { startedAt: 95_000, duration: 60_000, endsAt: 155_000 });
  emit("SPELL_COOLDOWN_STARTED", { spellId: 17534 });
  assert.deepEqual(call(seam, "GetActionCooldown", 1), [495, 60, 1]);
  assert.deepEqual(call(seam, "GetContainerItemCooldown", 0, 1), [495, 60, 1]);
  assert.deepEqual(call(seam, "GetContainerItemCooldown", 0, 16), [0, 0, 0]);
  assert.equal(fired.filter(([name]) => name === FRAMEXML_SEAM_EVENTS.bagUpdateCooldown).length, 1);
  call(seam, "UseAction", 1);
  assert.deepEqual(used, [], "recovering actions are not submitted");

  world.itemCooldowns.set(333, 130_000);
  emit("ITEM_COOLDOWN_STARTED", { spellId: 333, itemGuid: 5n });
  assert.deepEqual(call(seam, "GetInventoryItemCooldown", "player", 13), [500, 30, 1]);
  clock.monotonic += 5_000;
  clock.lua += 5;
  fired.length = 0;
  seam.tick(clock.lua);
  assert.deepEqual(call(seam, "GetInventoryItemCooldown", "player", 13), [500, 30, 1], "start time stays fixed");
  assert.equal(fired.filter(([name]) => name === FRAMEXML_SEAM_EVENTS.bagUpdateCooldown).length, 0,
    "counting down does not restart every stock bag sweep");
  clock.monotonic = 160_000;
  clock.lua = 560;
  seam.tick(clock.lua);
  assert.deepEqual(call(seam, "GetActionCooldown", 1), [0, 0, 0]);
  assert.deepEqual(call(seam, "GetInventoryItemCooldown", "player", 13), [0, 0, 0]);
  assert.equal(fired.filter(([name]) => name === FRAMEXML_SEAM_EVENTS.bagUpdateCooldown).length, 1);
  seam.detach();
  fired.length = 0;
  world.itemCooldowns.set(333, 190_000);
  emit("ITEM_COOLDOWN_STARTED", { spellId: 333 });
  assert.deepEqual(fired, [], "unmount releases the new packet subscription");
});

// P1-16 (UI-6): ACTIONBAR_UPDATE_COOLDOWN/_USABLE fire on a timer's edges, never while it counts down.
const cooldownEvents = (fired) => fired
  .filter(([name]) => name === FRAMEXML_SEAM_EVENTS.actionCooldown || name === FRAMEXML_SEAM_EVENTS.actionUsable)
  .map(([name]) => name);
const PAIR = [FRAMEXML_SEAM_EVENTS.actionCooldown, FRAMEXML_SEAM_EVENTS.actionUsable];
/** Advance both clocks by `ms` and run one seam tick (past the 60 ms poll gate for any ms ≥ 60). */
const step = ({ seam, clock }, ms) => {
  clock.monotonic += ms;
  clock.lua += ms / 1000;
  seam.tick(clock.lua);
};

test("P1-16: a 60 s snapshot cooldown fires one pair at its start and one at its end, none between", () => {
  const f = fixture();
  const { seam, world, clock, pump, emit, fired } = f;
  seam.attach(pump);
  seam.tick(clock.lua);
  fired.length = 0;
  world.cooldownSnapshots.set(133, { startedAt: clock.monotonic, duration: 60_000, endsAt: clock.monotonic + 60_000 });
  emit("SPELL_COOLDOWN_STARTED", { spellId: 133 });
  assert.deepEqual(cooldownEvents(fired), PAIR, "the start");
  fired.length = 0;
  for (let index = 0; index < 19; index++) step(f, 3_000);
  assert.deepEqual(cooldownEvents(fired), [], "57 s of countdown are reads, not events");
  assert.equal(call(seam, "IsUsableAction", 13)[0], false);
  step(f, 3_000);
  assert.deepEqual(cooldownEvents(fired), PAIR, "the natural end");
  assert.deepEqual(call(seam, "IsUsableAction", 13), [true, false]);
  fired.length = 0;
  for (let index = 0; index < 5; index++) step(f, 3_000);
  assert.deepEqual(cooldownEvents(fired), [], "a ready slot stays quiet");
  seam.detach();
});

test("P1-16: a timer with no snapshot (a category from SMSG_INITIAL_SPELLS) fires a pair, silence, a pair", () => {
  const f = fixture();
  const { seam, world, clock, pump, fired } = f;
  let categoryEnd = 0;
  world.cooldownRemaining = (id, now) => id === 133 ? Math.max(0, categoryEnd - now) : 0;
  seam.attach(pump);
  seam.tick(clock.lua);
  fired.length = 0;
  categoryEnd = clock.monotonic + 15_000;
  step(f, 60);
  assert.deepEqual(cooldownEvents(fired), PAIR, "the start, on the next poll");
  assert.equal(call(seam, "GetActionCooldown", 13)[2], 1);
  fired.length = 0;
  for (let index = 0; index < 4; index++) step(f, 3_000);
  assert.deepEqual(cooldownEvents(fired), [], "12 s of countdown");
  step(f, 3_000);
  assert.deepEqual(cooldownEvents(fired), PAIR, "the end");
  assert.deepEqual(call(seam, "IsUsableAction", 13), [true, false]);
  seam.detach();
});

test("P1-16: the global cooldown fires COOLDOWN alone when it starts, nothing while it runs or ends", () => {
  let gcd = 0;
  const f = fixture({ globalCooldownUntil: () => gcd });
  const { seam, clock, pump, fired } = f;
  seam.attach(pump);
  seam.tick(clock.lua);
  fired.length = 0;
  gcd = clock.monotonic + 1_500;
  step(f, 16);
  assert.deepEqual(cooldownEvents(fired), [FRAMEXML_SEAM_EVENTS.actionCooldown], "the start, without USABLE");
  fired.length = 0;
  for (let index = 0; index < 20; index++) step(f, 16);
  assert.deepEqual(cooldownEvents(fired), [], "the sweep runs on its own");
  for (let index = 0; index < 20; index++) step(f, 100);
  assert.deepEqual(cooldownEvents(fired), [], "its end is the sweep's own, not an event");
  seam.detach();
});

test("P1-16: a reset (the snapshot or the bare timer removed) fires one pair", () => {
  const f = fixture();
  const { seam, world, clock, pump, emit, fired } = f;
  let categoryEnd = 0;
  world.cooldownRemaining = (id, now) => Math.max(0,
    (world.cooldownSnapshots.get(id)?.endsAt ?? 0) - now, id === 133 ? categoryEnd - now : 0);
  seam.attach(pump);
  seam.tick(clock.lua);
  world.cooldownSnapshots.set(133, { startedAt: clock.monotonic, duration: 30_000, endsAt: clock.monotonic + 30_000 });
  emit("SPELL_COOLDOWN_STARTED", { spellId: 133 });
  step(f, 1_000);
  fired.length = 0;
  world.cooldownSnapshots.delete(133); // SMSG_CLEAR_COOLDOWN
  step(f, 100);
  assert.deepEqual(cooldownEvents(fired), PAIR, "the snapshot's reset");
  categoryEnd = clock.monotonic + 20_000;
  step(f, 100);
  fired.length = 0;
  categoryEnd = 0;
  step(f, 100);
  assert.deepEqual(cooldownEvents(fired), PAIR, "the bare timer's reset");
  fired.length = 0;
  step(f, 100);
  assert.deepEqual(cooldownEvents(fired), []);
  seam.detach();
});

test("P1-16: a reattached seam describes the running timer again on its first poll", () => {
  const f = fixture();
  const { seam, world, clock, pump, fired } = f;
  const categoryEnd = clock.monotonic + 20_000;
  world.cooldownRemaining = (id, now) => id === 133 ? Math.max(0, categoryEnd - now) : 0;
  // attach seeds one ACTIONBAR_UPDATE_COOLDOWN of its own for the freshly loaded bar; the pair is the poll's.
  seam.attach(pump);
  fired.length = 0;
  seam.tick(clock.lua);
  assert.deepEqual(cooldownEvents(fired), PAIR);
  seam.detach();
  seam.attach(pump);
  fired.length = 0;
  step(f, 100);
  assert.deepEqual(cooldownEvents(fired), PAIR, "the new attach starts from no signature");
  seam.detach();
});

test("P1-16: button, cooldown, end gives the same event trace as CannedWorldSeam", async () => {
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const canned = new CannedWorldSeam();
  const cannedFired = [];
  let lua = 1_000;
  canned.attach({ now: () => lua, fire: (name, ...args) => { cannedFired.push([name, ...args]); return 1; } });
  canned.tick(lua);
  cannedFired.length = 0;
  canned.useAction(1);
  for (let index = 0; index < 12; index++) { lua += 1; canned.tick(lua); }
  const cannedTrace = cannedEventsOnly(cannedFired);

  const f = fixture();
  const { seam, world, clock, pump, emit, fired } = f;
  seam.attach(pump);
  seam.tick(clock.lua);
  fired.length = 0;
  world.cooldownSnapshots.set(133, { startedAt: clock.monotonic, duration: 10_000, endsAt: clock.monotonic + 10_000 });
  emit("SPELL_COOLDOWN_STARTED", { spellId: 133 });
  for (let index = 0; index < 12; index++) step(f, 1_000);
  assert.deepEqual(cooldownEvents(fired), cannedTrace);
  assert.deepEqual(cannedTrace, [...PAIR, ...PAIR]);
  seam.detach();
});

/** The canned seam's cooldown pair only: its rage sine also re-tints (USABLE) on a crossing. */
function cannedEventsOnly(fired) {
  const out = [];
  for (let index = 0; index < fired.length; index++) {
    if (fired[index][0] !== FRAMEXML_SEAM_EVENTS.actionCooldown) continue;
    out.push(fired[index][0]);
    if (fired[index + 1]?.[0] === FRAMEXML_SEAM_EVENTS.actionUsable) out.push(fired[index + 1][0]);
  }
  return out;
}

test("stock page changes and keyboard page changes stay synchronized without duplicate events", () => {
  let page = 1;
  const dispatched = [];
  const { seam, pump, clock, fired } = fixture({
    actionBarPage: () => page, changeActionBarPage: (next) => { page = next; },
    useAction: (slot) => dispatched.push(slot),
  });
  seam.attach(pump);
  seam.tick(clock.lua);
  fired.length = 0;
  call(seam, "ChangeActionBarPage", 2);
  assert.equal(page, 2);
  assert.deepEqual(call(seam, "GetActionBarPage"), [2]);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.actionPageChanged]]);
  seam.tick(clock.lua + 0.001);
  call(seam, "ChangeActionBarPage", 2);
  call(seam, "ChangeActionBarPage", 7);
  assert.equal(fired.length, 1);
  page = 6;
  seam.tick(clock.lua + 0.002);
  assert.equal(fired.length, 2, "keyboard page updates are visible before the slower data poll");
  call(seam, "UseAction", 14);
  assert.deepEqual(dispatched, [14], "macros reach the same host dispatcher as keyboard actions");
  seam.detach();
});

test("GetBonusBarOffset and UPDATE_BONUS_ACTIONBAR follow the form through the shared bonus-bar rule", () => {
  // Battle and Defensive Stance as /dbc/spells joins them onto their spells: SPELL_AURA_MOD_SHAPESHIFT
  // naming the form, and the form's BonusActionBar from SpellShapeshiftForm.dbc.
  const stance = (id, form, offset) => ({
    id, name: `stance ${id}`, rank: "", effectAura: [36, 0, 0], effectMiscValue: [form, 0, 0],
    bonusActionBarOffset: offset,
  });
  const rows = new Map([[2457, stance(2457, 17, 1)], [71, stance(71, 18, 2)]]);
  const { seam, world, player, clock, pump, fired } = fixture({ spell: (id) => rows.get(id) });
  world.knownSpells = [{ id: 2457 }, { id: 71 }];
  const setForm = (form) => player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, form * 2 ** 24);
  const bonusEvents = () => fired.filter(([name]) => name === FRAMEXML_SEAM_EVENTS.updateBonusActionBar).length;
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [0], "no form");
  setForm(17);
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [1], "Battle Stance");
  seam.attach(pump);
  seam.tick(clock.lua);
  fired.length = 0;
  setForm(18);
  seam.tick(clock.lua + 1);
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [2], "Defensive Stance");
  assert.equal(bonusEvents(), 1);
  seam.tick(clock.lua + 2);
  assert.equal(bonusEvents(), 1, "an unchanged form fires nothing");
  setForm(0);
  seam.tick(clock.lua + 3);
  assert.deepEqual(call(seam, "GetBonusBarOffset"), [0], "left the stance");
  assert.equal(bonusEvents(), 2);
  seam.detach();
});

test("stock mirror timer APIs project realm breath/fatigue, pause, regeneration and stop", () => {
  const { seam, world, clock, pump, fired } = fixture();
  seam.attach(pump);
  seam.tick(clock.lua);
  fired.length = 0;
  assert.deepEqual(call(seam, "GetMirrorTimerInfo", 2), ["UNKNOWN"]);
  const timer = { timer: 1, value: 50_000, maxValue: 60_000, scale: -1, paused: false, spellId: 0 };
  world.mirrorTimers.set(1, { timer, receivedAt: 100_000 });
  seam.tick(clock.lua + 0.001);
  assert.deepEqual(fired, [["MIRROR_TIMER_START", "BREATH", 50_000, 60_000, -1, 0, "Дыхание"]]);
  clock.monotonic += 10_000;
  clock.lua += 10;
  assert.deepEqual(call(seam, "GetMirrorTimerProgress", "BREATH"), [40_000]);
  fired.length = 0;
  seam.tick(clock.lua);
  assert.equal(fired.some(([event]) => event === "MIRROR_TIMER_START"), false,
    "normal countdown is a read, not another timer-start event");
  world.mirrorTimers.set(1, { timer: { ...timer, value: 40_000, paused: true }, receivedAt: clock.monotonic });
  seam.tick(clock.lua + 0.001);
  assert.deepEqual(fired.at(-1), ["MIRROR_TIMER_START", "BREATH", 40_000, 60_000, -1, 1, "Дыхание"]);
  clock.monotonic += 5_000;
  assert.deepEqual(call(seam, "GetMirrorTimerProgress", "BREATH"), [40_000]);
  world.mirrorTimers.set(1, { timer: { ...timer, value: 40_000, scale: 10 }, receivedAt: clock.monotonic });
  clock.monotonic += 1_000;
  assert.deepEqual(call(seam, "GetMirrorTimerProgress", "BREATH"), [50_000]);
  world.mirrorTimers.delete(1);
  seam.tick(clock.lua + 0.002);
  assert.deepEqual(fired.at(-1), ["MIRROR_TIMER_STOP", "BREATH"]);
  assert.deepEqual(call(seam, "GetMirrorTimerInfo", 2), ["UNKNOWN"]);
  assert.deepEqual(call(seam, "GetMirrorTimerInfo", 3), ["UNKNOWN"], "do not invent a FIRE-to-Lua token mapping");
  seam.detach();
});

test("original MPQ page arrows, icon/count widgets and secure click use the live action seam", async (t) => {
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
  const { seam, world, clock, used, cast } = fixture();
  // This MPQ journey represents an entered world after its login clock packet. Keep the unit
  // regression above free to assert that GetGameTime is unknown before that packet arrives.
  world.currentGameTime = () => ({ minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60,
    weekday: 4, date: { year: 2024, month: 2, day: 29 } });
  world.calendarPending = 0;
  const boot = new FrameXmlBoot({
    provider: { async read(path) {
      const bytes = await chain.read(path.replaceAll("/", "\\"));
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    } },
    locale: "ruRU", seam,
    subset: FRAMEXML_VERTICAL_TOC.slice(0, FRAMEXML_VERTICAL_TOC.indexOf("MultiActionBars.xml") + 1)
      .filter((path) => path !== "MainMenuBarMicroButtons.xml"),
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    assert.equal(inventory.lua.failed, 0);
    const frame = (name) => boot.bridge.getFrame(name);
    assert.equal(frame("ActionButton1Icon").texture, "Interface\\Icons\\INV_Potion_54");
    assert.equal(frame("ActionButton1Count").text, "5");
    boot.bridge.Click(frame("ActionButton1"), "LeftButton", false);
    assert.deepEqual(used, [[255, 23, 2n]], "stock secure click resolves the item slot");
    const errors = boot.errorCount;
    assert.equal(boot.vm.execute("ActionBar_PageUp()", "@test-page-up").ok, true);
    assert.equal(seam.actionBarPage(), 2);
    assert.equal(frame("ActionButton1Icon").texture, "Interface\\Icons\\Spell_Fire_FlameBolt");
    boot.bridge.Click(frame("ActionButton1"), "LeftButton", false);
    assert.deepEqual(cast, [133], "same stock button now executes absolute slot 13");
    assert.equal(boot.vm.execute("ActionBar_PageDown()", "@test-page-down").ok, true);
    assert.equal(seam.actionBarPage(), 1);
    assert.equal(frame("ActionButton1Count").text, "5");
    assert.equal(boot.errorCount, errors, "page/click interactions raise no Lua failures");
    assert.equal(boot.vm.execute(`
      assert(GetCurrentResolution() == 1)
      assert(GetScreenResolutions() == "1024x768")
      UpdateMenuBarTop()
    `, "@test-viewport").ok, true, "stock viewport arithmetic sees the real canvas resolution");
    world.mirrorTimers.set(1, { timer: {
      timer: 1, value: 50_000, maxValue: 60_000, scale: -1, paused: false, spellId: 0,
    }, receivedAt: clock.monotonic });
    seam.tick(clock.lua);
    assert.equal(frame("MirrorTimer1").visible, true);
    assert.equal(frame("MirrorTimer1Text").text, "Дыхание");
    assert.equal(frame("MirrorTimer1StatusBar").statusBar.value, 50);
    clock.monotonic += 5_000;
    boot.bridge.tick(0.016);
    assert.equal(frame("MirrorTimer1StatusBar").statusBar.value, 45, "original OnUpdate reads realm timer progress");
    world.mirrorTimers.delete(1);
    seam.tick(clock.lua + 0.001);
    assert.equal(frame("MirrorTimer1").visible, false);
    assert.equal(boot.errorCount, errors, "mirror lifecycle raises no handled or unhandled Lua errors");
  } finally {
    boot.close();
    await chain.close();
  }
});
