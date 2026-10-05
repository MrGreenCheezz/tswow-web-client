import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.14 (L17, 04.10), MPQ-backed: the real Blizzard_BattlefieldMinimap from the client's MPQs over the
// vertical corpus, loaded on demand by its owner (FrameXmlBattlefieldMinimapLod.ts). In Warsong Gulch the
// stock PLAYER_ENTERING_WORLD path asks for it; nothing is read before the stock HUD is published; then the
// add-on loads, passes its gate and shows, with the zone tiles, the player's mini arrow, a party member's pin
// and the flag carrier; ToggleBattlefieldMinimap hides and shows it as stock BattlefieldMinimap_Toggle does;
// BattlefieldMinimapOptions is saved per character. Measured: the stock OnUpdate's cost per frame.
let clientDirectory;
let dbcDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
  dbcDirectory = paths.dbcDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = {
  skip: clientDirectory && dbcDirectory ? false : "no 3.3.5a client and DBC dataset on this machine", concurrency: false,
};
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = withClient.skip ? undefined : await clientArchives(clientDirectory);
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FrameXmlMap } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
const { frameXmlBattlefieldMapSource } = await import("../dist/code/browser/framexml/FrameXmlBattlefieldMapSource.js");
const { installFrameXmlBattlefieldMinimapApi, FRAMEXML_PVP_INACTIVE_SPELL } = await import(
  "../dist/code/browser/framexml/FrameXmlBattlefieldMinimapApi.js",
);
const { createFrameXmlBattlefieldMinimapOwner, installFrameXmlBattlefieldMinimapHooks, FRAMEXML_BATTLEFIELD_MINIMAP_ADDON } =
  await import("../dist/code/browser/framexml/FrameXmlBattlefieldMinimapLod.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_battlefieldminimap/";
const WSG = 489;
const SELF = 0x10n;
const FRIEND = 0x61n;
const CARRIER = 0x22n;

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "battlefield-minimap-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

async function settle(condition, rounds = 400) {
  for (let round = 0; round < rounds && !condition(); round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("Blizzard_BattlefieldMinimap loads through its owner in Warsong Gulch, shows the zone, the arrow, a party member and the flag", withClient, async () => {
  const data = await loadAreaData(dbcDirectory);
  const area = data.mapAreas.find((row) => row.mapId === WSG && row.areaId !== 0);
  const unitField = (race) => new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, race], [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100]]);
  const world = {
    mapId: WSG,
    state: {
      selfGuid: SELF, revision: 1,
      objects: new Map([
        [SELF, { guid: SELF, typeId: 4, fields: unitField(1), position: { x: 1200, y: 1500, z: 0, orientation: 1 } }],
        [FRIEND, { guid: FRIEND, typeId: 4, fields: unitField(1), position: { x: 1250, y: 1450, z: 0, orientation: 0 } }],
      ]),
    },
    battlefieldQueues: new Map(),
    // An Orc out of view carries the Alliance flag (not in the player's raid: the other side).
    flagCarriers: [{ guid: CARRIER, x: 1500, y: 1100 }],
    names: new Map(), creatureTemplates: new Map(), group: undefined, partyStats: new Map(),
    auras: new Map(),
  };
  const units = { player: SELF, party1: FRIEND };
  const unitGuid = (unit) => units[unit];
  const seam = new CannedWorldSeam();
  seam.map = new FrameXmlMap({
    metadata: () => data,
    location: () => ({ mapId: WSG, areaId: area.areaId, x: 1200, y: 1500, orientation: 1 }),
    corpseLocation: () => null, deathReleaseLocation: () => null,
    ...frameXmlBattlefieldMapSource({ world: () => world, metadata: () => data, vehicles: () => undefined, unitGuid }),
  });
  const reads = [];
  const failures = [];
  const storage = new Map();
  let boot;
  const owner = createFrameXmlBattlefieldMinimapOwner({ boot: () => boot, onFailure: (reason) => failures.push(reason) });
  let hooked;
  boot = new FrameXmlBoot({
    provider: { async read(path) { reads.push(normalize(path)); const bytes = await chain.read(path); return bytes ? decoder.decode(bytes) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
    savedVariables: {
      scope: { account: "TESTACCOUNT", realm: "TestRealm", character: "Тест" },
      storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    },
    beforeExercise: (loaded) => {
      hooked = installFrameXmlBattlefieldMinimapHooks(loaded, owner);
      installFrameXmlBattlefieldMinimapApi({
        vm: loaded.vm, bridge: loaded.bridge, facing: () => 1, world: () => world, unitGuid,
      });
    },
  });
  try {
    await boot.load();
    assert.equal(hooked, true, "UIParent's and WorldStateFrame's functions are wrapped");
    const errors = boot.errorCount;
    const newErrors = () => JSON.stringify(boot.errors.slice(errors));

    // ---- Warsong Gulch: the stock PLAYER_ENTERING_WORLD path asks, nothing loads before publication ----
    world.battlefieldQueues.set(0, { status: 3, mapId: WSG, cleared: false });
    seam.pvpWorld.instanceType = 3;
    assert.deepEqual(lua(boot, "return IsInInstance()", 2), [1, "pvp"]);
    lua(boot, "WorldStateAlwaysUpFrame_OnEvent(WorldStateAlwaysUpFrame, 'PLAYER_ENTERING_WORLD')", 0);
    await settle(() => owner.state === "waiting");
    assert.equal(owner.state, "waiting");
    assert.deepEqual(lua(boot, "return rawget(_G, 'BattlefieldMinimap') == nil, WorldStateFrame_CanShowBattlefieldMinimap()", 2), [true, false]);
    assert.ok(!reads.some((path) => path.startsWith(ADDON_PREFIX)), "no add-on file before the HUD is published");
    assert.deepEqual(lua(boot, "return GetCVar('showBattlefieldMinimap')"), ["1"]);
    assert.equal(boot.errorCount, errors, `no Lua error while waiting: ${newErrors()}`);

    // ---- publication: the load, the gate and stock's own show ----
    const roots = [];
    const loadStarted = performance.now();
    owner.publish({ addRoots: (added) => roots.push(...added), sync() {} });
    await owner.settled();
    console.log(`Blizzard_BattlefieldMinimap load + gate + show: ${(performance.now() - loadStarted).toFixed(1)} ms (Node, files from the MPQ chain)`);
    assert.deepEqual(failures, []);
    assert.equal(owner.state, "ready");
    assert.equal(boot.isAddonLoaded(FRAMEXML_BATTLEFIELD_MINIMAP_ADDON), true);
    assert.equal(boot.errorCount, errors, `no Lua error loading: ${newErrors()}`);
    assert.deepEqual(lua(boot, "return BattlefieldMinimap:IsShown() and 1 or 0, BattlefieldMinimapTab:IsShown() and 1 or 0", 2), [1, 1]);
    assert.deepEqual(lua(boot, "return WorldStateFrame_CanShowBattlefieldMinimap()"), [true], "stock's answer from now on");
    assert.equal(String(boot.bridge.getFrame("BattlefieldMinimap1").texture).toLowerCase(), "interface\\worldmap\\warsonggulch\\warsonggulch1");
    assert.deepEqual(lua(boot, `
      return type(BattlefieldMinimapOptions) == "table", BattlefieldMinimapOptions.opacity, BattlefieldMinimapOptions.locked,
        BattlefieldMinimapOptions.showPlayers`, 4), [true, 0.7, true, true]);

    // ---- one stock frame: the arrow, the party member and the flag carrier ----
    lua(boot, "BattlefieldMinimap_OnUpdate(BattlefieldMinimap, 0.02)", 0);
    assert.equal(boot.errorCount, errors, `no Lua error in OnUpdate: ${newErrors()}`);
    const arrow = boot.bridge.getFrame("PlayerMiniArrowEffectFrame");
    assert.equal(arrow?.parent?.name, "BattlefieldMinimap");
    assert.equal(arrow.visible, true);
    assert.equal(arrow.points[0]?.relativeTo?.name, "BattlefieldMinimap");
    const [u, v] = seam.map.getPlayerMapPosition("player");
    const [width, height] = lua(boot, "return BattlefieldMinimap:GetWidth(), BattlefieldMinimap:GetHeight()", 2);
    assert.ok(Math.abs(arrow.points[0].x - u * width) < 1e-6 && Math.abs(arrow.points[0].y + v * height) < 1e-6);
    assert.equal(arrow.children.find((child) => child.type === "Texture")?.textureRotation, 1, "UpdateWorldMapArrowFrames turned it");
    assert.deepEqual(lua(boot, "return BattlefieldMinimapParty1:IsShown() and 1 or 0, BattlefieldMinimapParty2:IsShown() and 1 or 0", 2), [1, 0]);
    assert.deepEqual(lua(boot, "return BattlefieldMinimapFlag1:IsShown() and 1 or 0, BattlefieldMinimapFlag1Texture:GetTexture(), BattlefieldMinimapFlag2:IsShown() and 1 or 0", 3),
      [1, "Interface\\WorldStateFrame\\AllianceFlag", 0]);
    // The tooltip's AFK test reads the «inactive» debuff of the member.
    assert.deepEqual(lua(boot, "return PlayerIsPVPInactive('party1')"), [false]);
    world.auras.set(FRIEND, new Map([[1, { spellId: FRAMEXML_PVP_INACTIVE_SPELL }]]));
    assert.deepEqual(lua(boot, "return PlayerIsPVPInactive('party1')"), [true]);

    // ---- Shift+M: stock ToggleBattlefieldMinimap → BattlefieldMinimap_Toggle ----
    lua(boot, "ToggleBattlefieldMinimap()", 0);
    assert.deepEqual(lua(boot, "return BattlefieldMinimap:IsShown() and 1 or 0, GetCVar('showBattlefieldMinimap')", 2), [0, "0"]);
    lua(boot, "ToggleBattlefieldMinimap()", 0);
    assert.deepEqual(lua(boot, "return BattlefieldMinimap:IsShown() and 1 or 0, GetCVar('showBattlefieldMinimap')", 2), [1, "1"]);
    assert.equal(boot.errorCount, errors, `no Lua error toggling: ${newErrors()}`);

    // ---- 05.10 review: the published key, and stock's other branches (outside: zone map "2"; arena: nothing) ----
    const { publishFrameXmlBattlefieldMinimapKey, toggleFrameXmlBattlefieldMinimap } = await import(
      "../dist/code/browser/framexml/FrameXmlBattlefieldMinimapKey.js",
    );
    const shown = () => lua(boot, "return BattlefieldMinimap:IsShown() and 1 or 0, GetCVar('showBattlefieldMinimap')", 2);
    const keyCleanup = publishFrameXmlBattlefieldMinimapKey(boot);
    try {
      assert.equal(toggleFrameXmlBattlefieldMinimap(), true);
      assert.deepEqual(shown(), [0, "0"], "the key hides a shown one");
      seam.pvpWorld.instanceType = 0;
      assert.deepEqual(lua(boot, "return select(2, IsInInstance())"), ["none"]);
      toggleFrameXmlBattlefieldMinimap();
      assert.deepEqual(shown(), [1, "2"], "outside a battleground: the zone map, CVar 2");
      toggleFrameXmlBattlefieldMinimap();
      assert.deepEqual(shown(), [0, "0"]);
      seam.pvpWorld.instanceType = 4;
      assert.deepEqual(lua(boot, "return select(2, IsInInstance())"), ["arena"]);
      toggleFrameXmlBattlefieldMinimap();
      assert.deepEqual(shown(), [0, "0"], "an arena: stock does not show it");
    } finally {
      seam.pvpWorld.instanceType = 3;
      toggleFrameXmlBattlefieldMinimap();
      keyCleanup();
    }
    assert.deepEqual(shown(), [1, "1"], "back in the battleground: shown again for the rest");
    assert.equal(boot.errorCount, errors, `no Lua error across the branches: ${newErrors()}`);

    // ---- the stock OnUpdate's cost (every frame while shown) ----
    const frames = 200;
    const started = performance.now();
    lua(boot, `for i = 1, ${frames} do BattlefieldMinimap_OnUpdate(BattlefieldMinimap, 0.007) end`, 0);
    const perFrame = (performance.now() - started) / frames;
    console.log(`BattlefieldMinimap_OnUpdate: ${perFrame.toFixed(3)} ms a frame (Node, ${frames} frames)`);
    assert.equal(boot.errorCount, errors, `no Lua error over ${frames} frames: ${newErrors()}`);

    // ---- the same frames in a 15-player raid (Arathi Basin's size), measured: the stock raid branch ----
    for (let index = 2; index <= 15; index += 1) {
      const guid = 0x100n + BigInt(index);
      units[`raid${index}`] = guid;
      world.state.objects.set(guid, { guid, typeId: 4, fields: unitField(1), position: { x: 1200 + index, y: 1500 - index, z: 0, orientation: 0 } });
    }
    units.raid1 = SELF;
    lua(boot, "__testRaid = GetNumRaidMembers; GetNumRaidMembers = function() return 15 end", 0);
    lua(boot, "BattlefieldMinimap_OnUpdate(BattlefieldMinimap, 0.02)", 0);
    const [raidPins] = lua(boot, "local n = 0 for i = 1, 40 do if _G['BattlefieldMinimapRaid' .. i]:IsShown() then n = n + 1 end end return n");
    assert.ok(raidPins >= 14, `the raid's pins: ${raidPins}`);
    const raidStarted = performance.now();
    lua(boot, `for i = 1, ${frames} do BattlefieldMinimap_OnUpdate(BattlefieldMinimap, 0.007) end`, 0);
    console.log(`BattlefieldMinimap_OnUpdate, 15-player raid: ${((performance.now() - raidStarted) / frames).toFixed(3)} ms a frame`);
    lua(boot, "GetNumRaidMembers = __testRaid", 0);
    assert.equal(boot.errorCount, errors, `no Lua error in the raid branch: ${newErrors()}`);

    // ---- SavedVariablesPerCharacter ----
    lua(boot, "BattlefieldMinimapOptions.opacity = 0.4", 0);
    boot.flushSavedVariables();
    const saved = [...storage.entries()].find(([key]) => key.includes("BattlefieldMinimapOptions"));
    assert.ok(saved, `saved under its own key: ${[...storage.keys()].join(", ")}`);
    assert.ok(saved[0].includes("Тест") || saved[0].includes(encodeURIComponent("Тест")), `per character: ${saved[0]}`);
    assert.match(saved[1], /0\.4/);
  } finally {
    boot.close();
  }
});
