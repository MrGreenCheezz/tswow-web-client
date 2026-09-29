import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
let dbcDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
  dbcDirectory = paths.dbcDirectory();
} catch { /* the MPQ/DBC-backed case is skipped on machines without a client */ }

const withClient = {
  skip: clientDirectory && dbcDirectory ? false : "no 3.3.5a client and DBC dataset on this machine",
};

test("original MPQ WorldMapFrame opens, navigates, changes dungeon floors and positions markers", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FrameXmlMap } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { frameXmlWorldMapGate } = await import("../dist/code/browser/framexml/FrameXmlWorldMapController.js");
  const {
    closeFrameXmlWorldMap, frameXmlWorldMapOpen, publishFrameXmlWorldMap, toggleFrameXmlWorldMap,
  } = await import("../dist/code/browser/framexml/FrameXmlWorldMapPublication.js");

  const archives = await clientArchives(clientDirectory);
  const decoder = new TextDecoder();
  const data = await loadAreaData(dbcDirectory);
  let location = { mapId: 0, areaId: 12, x: -9_000, y: -400, orientation: 1.25 };
  let corpse = null;
  const seam = new CannedWorldSeam();
  seam.map = new FrameXmlMap({
    metadata: () => data,
    location: () => location,
    corpseLocation: () => corpse,
    deathReleaseLocation: () => null,
    isExploredArea: () => true,
  });
  const requested = new Set();
  const boot = new FrameXmlBoot({
    provider: { async read(path) {
      requested.add(path.replaceAll("\\", "/").toLowerCase());
      const bytes = await archives.read(path.replaceAll("/", "\\"));
      return bytes ? decoder.decode(bytes) : undefined;
    } },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    exercise: false,
    screen: () => ({ width: 1280, height: 768 }),
  });
  let releaseOwner;

  try {
    const report = await boot.load();
    assert.ok(requested.has("interface/framexml/worldmapframe.xml"));
    assert.ok(requested.has("interface/framexml/worldmapframe.lua"));
    assert.equal(report.xml.failed.length, 0);
    assert.deepEqual(boot.errors.filter((error) => error.file.endsWith("/worldmapframe.lua")), [],
      "WorldMapFrame OnLoad must complete through its actual MPQ Lua");
    const worldMap = boot.bridge.getFrame("WorldMapFrame");
    const parent = boot.bridge.getFrame("UIParent");
    const button = boot.bridge.getFrame("WorldMapButton");
    const tile = boot.bridge.getFrame("WorldMapDetailTile1");
    const arrow = boot.bridge.getFrame("PlayerArrowEffectFrame");
    const objective = boot.bridge.getFrame("WorldMapQuestFrame0")?.children
      .find((child) => child.parentKey === "objectives");
    assert.ok(worldMap && parent && button && tile && arrow && objective);
    assert.equal(objective.attributes.spacing, "2", "stock quest template authors the line spacing");
    assert.equal(boot.vm.execute("assert(WorldMapQuestFrame0.lineSpacing == 2)", "@worldmap-spacing").ok, true,
      "OnLoad reads the FontString GetSpacing C method");

    // Keep the gate attached to the actual MPQ tree and its bridge script registry. A small DOM
    // projection preserves those parent relationships; browser QA separately tests rendering.
    const elements = new Map();
    const mounted = (frame) => {
      if (!frame) return undefined;
      let element = elements.get(frame);
      if (!element) {
        element = {
          getAttribute: (key) => key === "data-framexml-name" ? frame.name : null,
          get parentElement() { return mounted(frame.parent) ?? null; },
        };
        elements.set(frame, element);
      }
      return element;
    };
    const gateReasons = [];
    const owner = frameXmlWorldMapGate(boot, { elementFor: mounted }, seam.map,
      (reason) => gateReasons.push(reason));
    assert.ok(owner, `complete stock map passes the ownership gate: ${gateReasons.join(", ")}`);
    releaseOwner = publishFrameXmlWorldMap(owner);

    boot.bridge.Show(parent);
    const baseline = boot.errorCount;
    const call = (name, args = []) => {
      const fn = boot.vm.getGlobal(name);
      assert.ok(fn, `${name} is provided by stock UIParent/WorldMap Lua`);
      boot.vm.call(fn, args, 0);
      assert.equal(boot.errorCount, baseline, `${name}: ${JSON.stringify(boot.errors.slice(-3))}`);
    };
    assert.equal(toggleFrameXmlWorldMap(), true, "published controller routes through stock ToggleFrame");
    assert.equal(frameXmlWorldMapOpen(), true);
    assert.equal(worldMap.visible, true);
    assert.deepEqual(seam.map.getMapInfo(), ["Elwynn"]);
    assert.equal(tile.texture, "Interface\\WorldMap\\Elwynn\\Elwynn1");

    boot.bridge.fireScript(button, "OnUpdate", 0.016);
    assert.equal(boot.errorCount, baseline, JSON.stringify(boot.errors.slice(-3)));
    assert.equal(arrow.visible, true);
    assert.equal(arrow.points.find((point) => point.point === "CENTER")?.relativeTo?.name,
      "WorldMapDetailFrame");
    assert.equal(arrow.children.find((child) => child.type === "Texture")?.textureRotation, 1.25);
    corpse = { mapId: 0, areaId: 12, x: -9_000, y: -400 };
    boot.bridge.fireScript(button, "OnUpdate", 0.016);
    assert.equal(boot.bridge.getFrame("WorldMapCorpse")?.visible, true,
      "server corpse coordinates are projected onto the selected zone");
    corpse = null;
    boot.bridge.fireScript(button, "OnUpdate", 0.016);
    assert.equal(boot.bridge.getFrame("WorldMapCorpse")?.visible, false);
    assert.equal(boot.errorCount, baseline);

    call("WorldMapButton_OnClick", [button, "RightButton"]);
    seam.map.tick();
    assert.deepEqual(seam.map.getMapInfo(), ["Azeroth"]);
    assert.equal(tile.texture, "Interface\\WorldMap\\Azeroth\\Azeroth1");
    location = { mapId: 571, areaId: 4395, x: 5_800, y: 300, orientation: 0.4 };
    seam.map.setMapToCurrentZone();
    seam.map.tick();
    assert.deepEqual(seam.map.getMapInfo(), ["Dalaran"]);
    assert.equal(seam.map.getCurrentMapDungeonLevel(), 1);
    assert.equal(tile.texture, "Interface\\WorldMap\\Dalaran\\Dalaran1_1");
    call("WorldMapLevelDown_OnClick", [boot.bridge.getFrame("WorldMapLevelDownButton")]);
    seam.map.tick();
    assert.equal(seam.map.getCurrentMapDungeonLevel(), 2);
    assert.equal(tile.texture, "Interface\\WorldMap\\Dalaran\\Dalaran2_1");
    call("WorldMapLevelUp_OnClick", [boot.bridge.getFrame("WorldMapLevelUpButton")]);
    seam.map.tick();
    assert.equal(tile.texture, "Interface\\WorldMap\\Dalaran\\Dalaran1_1");
    assert.equal(closeFrameXmlWorldMap(), true, "published controller routes through stock HideUIPanel");
    assert.equal(worldMap.visible, false);
    assert.equal(frameXmlWorldMapOpen(), false);
    assert.equal(tile.texture, "", "stock OnHide clears its large tile textures");
    assert.equal(boot.errorCount, baseline);
  } finally {
    releaseOwner?.();
    boot.close();
    archives.close();
  }
});
