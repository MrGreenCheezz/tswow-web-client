import assert from "node:assert/strict";
import test from "node:test";

// An equip moves five or six paper-doll stat rows in one 60 ms poll, and stock PaperDollFrame answers
// each edge with PaperDollFrame_UpdateStats. Over the retail 3.3.5a corpus, a real WorldClient and
// WorldStore: one poll with every stats family moved runs that function once, UNIT_RESISTANCES's
// SetResistances included, while every other listener still receives every event. Everything
// compared is a primitive read back from Lua.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FrameXmlUiBridge, withEventOwnersExcluded } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { clientDirectory } = await import("../tools/paths.mjs");
const { openClientArchives } = await import("../tools/mpq.mjs");

let clientDir;
try {
  clientDir = clientDirectory();
} catch {
  clientDir = undefined;
}

const PLAYER = 0x10n;
const STATS_EVENTS = ["UNIT_STATS", "UNIT_RESISTANCES", "UNIT_ATTACK_POWER", "UNIT_RANGED_ATTACK_POWER",
  "UNIT_ATTACK_SPEED", "UNIT_DAMAGE", "UNIT_RANGEDDAMAGE", "PLAYER_DAMAGE_DONE_MODS"];
const word = new DataView(new ArrayBuffer(4));

function worldFixture() {
  const world = new WorldClient({ send() {}, close() {} });
  const state = new WorldState();
  world.state = state;
  const fields = new Map();
  const set = (name, value, index = 0) => {
    word.setFloat32(0, value, true);
    const offset = UPDATE_FIELDS[name].offset + index;
    fields.set(offset, UPDATE_FIELDS[name].type === "FLOAT" ? word.getUint32(0, true) : value >>> 0);
    return offset;
  };
  set("UNIT_FIELD_BYTES_0", 1 | (2 << 8)); // human paladin: stock defaults show BASE_STATS on the left
  set("UNIT_FIELD_LEVEL", 80);
  set("UNIT_FIELD_HEALTH", 20000);
  set("UNIT_FIELD_MAXHEALTH", 20000);
  set("UNIT_FIELD_MAXPOWER1", 8000);
  set("UNIT_FIELD_STAT0", 150);
  set("UNIT_FIELD_RESISTANCES", 900);
  set("UNIT_FIELD_BASEATTACKTIME", 2000);
  set("UNIT_FIELD_RANGEDATTACKTIME", 2000);
  set("UNIT_FIELD_MINDAMAGE", 100);
  set("UNIT_FIELD_MAXDAMAGE", 150);
  set("UNIT_FIELD_ATTACK_POWER", 1000);
  set("UNIT_FIELD_RANGED_ATTACK_POWER", 500);
  set("UNIT_FIELD_MINRANGEDDAMAGE", 50);
  state.objects.set(PLAYER, {
    guid: PLAYER, typeId: 4, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined,
    runSpeed: undefined, turnRate: undefined, motion: undefined, glide: undefined, transport: undefined,
    speeds: undefined, transportTime: undefined, fields,
  });
  state.selfGuid = PLAYER;
  const store = new WorldStore(state);
  world.mapId = 0;
  world.selfName = "Флик";
  world.knownSpells = [{ id: 1, slot: 0 }];
  const realmTime = { minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  return { world, store, set };
}

test("one poll that moves every stats family runs PaperDollFrame_UpdateStats once, and every event still arrives", {
  skip: clientDir ? false : "no 3.3.5a client on this machine",
}, async () => {
  const chain = await openClientArchives(clientDir);
  const decoder = new TextDecoder("utf-8");
  const { world, store, set } = worldFixture();
  let clock = 1000;
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store,
    spell: (id) => ({ id, name: "Проверочное заклинание", rank: "", iconPath: "Interface\\Icons\\Spell_Test" }),
    monotonic: () => clock * 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const bytes = await chain.read(path); return bytes ? decoder.decode(bytes) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1024, height: 768 }),
  });
  const run = (code, name) => {
    const result = boot.vm.execute(code, `@paperdoll-coalescing:${name}`);
    assert.equal(result.ok, true, `${name}: ${result.error}`);
  };
  const counts = () => {
    run(`__updates = __fxStatsUpdates
      __resistanceWrites = __fxResistanceWrites
      __probeTotal = 0
      __probeKinds = 0
      for _, count in pairs(__fxProbe) do __probeTotal = __probeTotal + count; __probeKinds = __probeKinds + 1 end`, "read");
    return {
      updates: boot.vm.getGlobal("__updates"),
      resistances: boot.vm.getGlobal("__resistanceWrites"),
      probeTotal: boot.vm.getGlobal("__probeTotal"),
      probeKinds: boot.vm.getGlobal("__probeKinds"),
    };
  };
  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.errors, [], "vertical inventory has no handled Lua failures");
    assert.equal(boot.bridge.Show(boot.bridge.getFrame("CharacterFrame")), true);
    for (let poll = 0; poll < 3; poll++) seam.tick(clock += 0.1);
    run(`
      __fxStatsUpdates = 0
      __fxResistanceWrites = 0
      hooksecurefunc("PaperDollFrame_UpdateStats", function() __fxStatsUpdates = __fxStatsUpdates + 1 end)
      hooksecurefunc("PaperDollFrame_SetResistances", function() __fxResistanceWrites = __fxResistanceWrites + 1 end)
      __fxProbe = {}
      local probe = CreateFrame("Frame")
      for _, event in ipairs({ ${STATS_EVENTS.map((event) => `"${event}"`).join(", ")} }) do probe:RegisterEvent(event) end
      probe:SetScript("OnEvent", function(_, event, unit)
        if unit == "player" then __fxProbe[event] = (__fxProbe[event] or 0) + 1 end
      end)
    `, "install");
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("PaperDollFrame")), true, "the paper doll is on screen");

    // Every stats family moves at once, as an equip that changes armor, a primary stat, the weapon
    // and spell power does.
    const moved = [
      set("UNIT_FIELD_STAT0", 164), set("UNIT_FIELD_RESISTANCES", 917), set("UNIT_FIELD_BASEATTACKTIME", 1800),
      set("UNIT_FIELD_MINDAMAGE", 120), set("UNIT_FIELD_MAXDAMAGE", 180), set("UNIT_FIELD_ATTACK_POWER", 1040),
      set("UNIT_FIELD_RANGED_ATTACK_POWER", 520), set("UNIT_FIELD_MINRANGEDDAMAGE", 60),
      set("PLAYER_FIELD_MOD_DAMAGE_DONE_POS", 33), // the physical school, which PLAYER_DAMAGE_DONE_MODS follows
    ];
    store.fieldsChanged(PLAYER, moved);
    store.flush();
    seam.tick(clock += 0.1);
    const after = counts();
    assert.equal(after.updates, 1, "one PaperDollFrame_UpdateStats for the whole poll");
    assert.equal(after.resistances, 1, "UNIT_RESISTANCES still reached PaperDollFrame: SetResistances ran");
    assert.equal(after.probeKinds, STATS_EVENTS.length, "every stats event was delivered to the other listener");
    assert.equal(after.probeTotal, STATS_EVENTS.length, "once each");
    run(`__armor = PlayerStatFrameLeft6StatText:GetText()`, "armor");
    assert.match(String(boot.vm.getGlobal("__armor")), /917/, "the one update read the poll's final fields");

    // A poll in which one family moves is the old path exactly: that edge updates the paper doll.
    store.fieldsChanged(PLAYER, [set("UNIT_FIELD_MINDAMAGE", 130)]);
    store.flush();
    seam.tick(clock += 0.1);
    const single = counts();
    assert.equal(single.updates, 2, "a lone UNIT_DAMAGE change still updates the stats");
    assert.equal(single.probeTotal, STATS_EVENTS.length + 1);
    assert.deepEqual(boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`), []);
  } finally {
    boot.close();
    await chain.close();
  }
});

test("an exclusion skips its frames for the next dispatch of its own event only, on the real bridge", () => {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(
    String(args[0] ?? "Frame"),
    args[1] === undefined ? undefined : String(args[1]),
    args[2],
    args[3] === undefined ? undefined : String(args[3]),
  )]);
  const counts = () => {
    const read = vm.execute(`
      __excludedStats = __got["ExcludedFrame:UNIT_STATS"] or 0
      __otherStats = __got["OtherFrame:UNIT_STATS"] or 0
      __excludedDamage = __got["ExcludedFrame:UNIT_DAMAGE"] or 0
    `, "@exclusion:read");
    assert.equal(read.ok, true, read.error);
    return [vm.getGlobal("__excludedStats"), vm.getGlobal("__otherStats"), vm.getGlobal("__excludedDamage")];
  };
  try {
    const setup = vm.execute(`
      __got = {}
      for _, name in ipairs({ "ExcludedFrame", "OtherFrame" }) do
        local frame = CreateFrame("Frame", name)
        frame:RegisterEvent("UNIT_STATS")
        frame:RegisterEvent("UNIT_DAMAGE")
        frame:SetScript("OnEvent", function(self, event)
          local key = self:GetName() .. ":" .. event
          __got[key] = (__got[key] or 0) + 1
        end)
      end
    `, "@exclusion:setup");
    assert.equal(setup.ok, true, setup.error);
    const excluded = new Set(["ExcludedFrame"]);
    assert.equal(withEventOwnersExcluded("UNIT_STATS", excluded, () => bridge.dispatchEvent("UNIT_STATS", "player")), 1);
    assert.deepEqual(counts(), [0, 1, 0], "the named frame is skipped, the other delivered");
    withEventOwnersExcluded("UNIT_STATS", excluded, () => {
      bridge.dispatchEvent("UNIT_DAMAGE", "player");
      bridge.dispatchEvent("UNIT_STATS", "player");
      bridge.dispatchEvent("UNIT_STATS", "player");
    });
    assert.deepEqual(counts(), [1, 3, 1],
      "another event is untouched, and only the first dispatch of the named one is narrowed");
    withEventOwnersExcluded("UNIT_STATS", excluded,
      () => bridge.dispatchEventExcept("UNIT_STATS", new Set(["OtherFrame"]), "player"));
    assert.deepEqual(counts(), [1, 3, 1], "the explicit exclusion and the scoped one combine");
    assert.throws(() => withEventOwnersExcluded("UNIT_STATS", excluded, () => { throw new Error("pump failed"); }),
      /pump failed/);
    bridge.dispatchEvent("UNIT_STATS", "player");
    assert.deepEqual(counts(), [2, 4, 1], "no exclusion outlives its scope, a thrown one included");
  } finally {
    vm.close();
  }
});
