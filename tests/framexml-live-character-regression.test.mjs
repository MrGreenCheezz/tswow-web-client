import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { plainFrameXmlText } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");
const { parseCharacterStatTable } = await import("../dist/code/world/CharacterStatData.js");
const { clientDirectory } = await import("../tools/paths.mjs");
const { openClientArchives } = await import("../tools/mpq.mjs");

function worldFixture() {
  const guid = 0x10n;
  // A real WorldClient/WorldState pair keeps the fixture's maps and event bus identical to the
  // production seam. Only the player update fields and the one known spell are deterministic.
  const world = new WorldClient({ send() {}, close() {} });
  const state = new WorldState();
  world.state = state;
  const store = new WorldStore(state);
  const fields = new Map([
    // race=Human, class=Paladin, gender=male, power=MANA
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (2 << 8)],
    [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 69],
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 4000],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 5000],
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 250],
    [UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset, 1000],
    [UPDATE_FIELDS.PLAYER_XP.offset, 100],
    [UPDATE_FIELDS.PLAYER_NEXT_LEVEL_XP.offset, 1000],
    [UPDATE_FIELDS.UNIT_FIELD_STAT0.offset + 3, 200],
  ]);
  const object = {
    guid,
    typeId: 4,
    position: undefined,
    movementFlags: 0,
    updateFlags: 0,
    targetGuid: undefined,
    runSpeed: undefined,
    turnRate: undefined,
    motion: undefined,
    glide: undefined,
    transport: undefined,
    speeds: undefined,
    transportTime: undefined,
    fields,
  };
  state.objects.set(guid, object);
  state.selfGuid = guid;
  world.mapId = 0;
  world.selfName = "Флик";
  world.knownSpells = [{ id: 1, slot: 0 }];
  // This logged-in character fixture has received the realm clock. Stock GameTime.lua reads its
  // hour during load; a live WorldClient with no SMSG_LOGIN_SET_TIME_SPEED would still be unknown.
  const realmTime = { minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60,
    weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  return { world, store };
}

let clientDir;
try {
  clientDir = clientDirectory();
} catch {
  clientDir = undefined;
}

test("real MPQ + LiveWorldSeam vertical CharacterFrame is error-free and has a real header", {
  skip: clientDir ? false : "no 3.3.5a client on this machine",
}, async () => {
  const chain = await openClientArchives(clientDir);
  const decoder = new TextDecoder("utf-8");
  const { world, store } = worldFixture();
  const [critBase, critRatio] = await Promise.all([
    chain.read("DBFilesClient\\gtChanceToSpellCritBase.dbc"),
    chain.read("DBFilesClient\\gtChanceToSpellCrit.dbc"),
  ]);
  assert.ok(critBase && critRatio, "original client supplies class/level intellect coefficients");
  const characterStats = {
    spellCritBase: parseCharacterStatTable(critBase),
    spellCritPerIntellect: parseCharacterStatTable(critRatio),
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    characterStats: () => characterStats,
    spell: (id) => ({
      id,
      name: "Проверочное заклинание",
      rank: "",
      iconPath: "Interface\\Icons\\Spell_Test",
    }),
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const bytes = await chain.read(path);
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.errors, [], "vertical inventory has no handled Lua failures");
    assert.equal(boot.errorCount, 0, "Live seam attach did not raise a hidden Lua failure");
    assert.ok(inventory.widgets.total > 0);
    assert.ok(inventory.widgets.roots > 0);

    // The promoted WorldMapFrame satisfies WatchFrame's dependency; the promoted world-state
    // frame also owns this zone event. Every registered stock handler should receive it.
    const zoneOwners = boot.bridge.frames
      .filter((frame) => frame.registeredEvents.has("ZONE_CHANGED_NEW_AREA"))
      .map((frame) => frame.name);
    assert.ok(zoneOwners.includes("WatchFrame"));
    assert.ok(zoneOwners.includes("MinimapCluster"));
    assert.ok(zoneOwners.includes("BattlefieldFrame"));
    const zoneDelivered = boot.pump.fire("ZONE_CHANGED_NEW_AREA");
    assert.equal(zoneDelivered, zoneOwners.length);
    assert.equal(boot.errorCount, 0, "all stock zone owners run without a Lua failure");

    // WORLD_MAP_UPDATE remains deliverable to its registered stock owners.
    const mapOwners = boot.bridge.frames
      .filter((frame) => frame.registeredEvents.has("WORLD_MAP_UPDATE"))
      .map((frame) => frame.name);
    assert.ok(mapOwners.includes("WatchFrame"));
    assert.equal(boot.pump.fire("WORLD_MAP_UPDATE"), mapOwners.length);
    assert.equal(boot.errorCount, 0);

    const character = boot.bridge.getFrame("CharacterFrame");
    assert.ok(character, "CharacterFrame is present in the vertical corpus");
    const microButton = boot.bridge.getFrame("CharacterMicroButton");
    assert.ok(microButton, "CharacterMicroButton is a real stock owner in the vertical corpus");
    assert.equal(microButton.type, "Button");
    assert.equal(boot.bridge.Show(character), true);
    const name = boot.bridge.getFrame("CharacterNameText")?.text;
    const level = boot.bridge.getFrame("CharacterLevelText")?.text;
    assert.equal(name, "Флик");
    assert.equal(level, "Человек, |3-6(Паладин) 69-го уровня");
    assert.equal(plainFrameXmlText(level), "Человек, Паладин 69-го уровня");
    assert.equal(microButton.buttonState, "PUSHED", "CharacterMicroButton follows CharacterFrame visibility");
    assert.equal(boot.errorCount, 0, "opening CharacterFrame adds no Lua failures");
    const tooltipProbe = boot.vm.execute(`
      __intellectTooltip = PlayerStatFrameLeft4.tooltip2
      __spellCritFromIntellect = GetSpellCritChanceFromIntellect("player")
    `, "@live-character:intellect-tooltip");
    assert.equal(tooltipProbe.ok, true, tooltipProbe.error);
    const expectedCrit = (characterStats.spellCritBase[1] + 200 * characterStats.spellCritPerIntellect[168]) * 100;
    assert.ok(Math.abs(boot.vm.getGlobal("__spellCritFromIntellect") - expectedCrit) < 0.000001,
      "live API uses actual Paladin69 DBC coefficients and server intellect");
    assert.match(boot.vm.getGlobal("__intellectTooltip"), new RegExp(expectedCrit.toFixed(2).replace(".", "\\.")),
      "original mana-class intellect tooltip formats the resolved percentage");
  } finally {
    boot.close();
    await chain.close();
  }
});
