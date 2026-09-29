import assert from "node:assert/strict";
import test from "node:test";

// This is deliberately an MPQ-backed test.  A hand-built PlayerFrame would not prove that the
// real UnitFrame.lua/PlayerFrame.lua event handlers can drive the status bars.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const {
  CannedWorldSeam,
  CANNED_PLAYER,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

async function loadCandidate(chain) {
  const requests = [];
  const provider = {
    async read(path) {
      requests.push(normalized(path));
      const data = await chain.read(path);
      return data ? new TextDecoder("utf-8").decode(data) : undefined;
    },
  };
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider,
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory, requests: new Set(requests) };
}

function frame(boot, name) {
  const result = boot.bridge.getFrame(name);
  assert.ok(result, `${name} exists`);
  return result;
}

function api(inventory, name) {
  const result = inventory.api.find((entry) => entry.name === name);
  assert.ok(result && result.calls > 0, `${name} is reached by real PlayerFrame Lua`);
  return result;
}

test("MPQ UnitFrame/PlayerFrame drives a live player status slice", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let candidate;
  try {
    candidate = await loadCandidate(chain);

    assert.ok(candidate.requests.has("interface/framexml/unitframe.xml"));
    assert.ok(candidate.requests.has("interface/framexml/unitframe.lua"));
    assert.ok(candidate.requests.has("interface/framexml/playerframe.xml"));
    assert.ok(candidate.requests.has("interface/framexml/playerframe.lua"));
    assert.equal(candidate.inventory.files.missing.length, 0);
    assert.equal(candidate.inventory.lua.failed, 0);

    const player = frame(candidate.boot, "PlayerFrame");
    const name = frame(candidate.boot, "PlayerName");
    const health = frame(candidate.boot, "PlayerFrameHealthBar");
    const power = frame(candidate.boot, "PlayerFrameManaBar");

    assert.equal(player.visible, true, "PlayerFrame is visible");
    assert.equal(name.text, CANNED_PLAYER.name);
    assert.deepEqual(candidate.seam.unitPowerType("player"), [1, "RAGE"]);
    assert.deepEqual(health.statusBar, {
      min: 0,
      max: CANNED_PLAYER.healthMax,
      value: CANNED_PLAYER.healthMax,
      valueStep: 0,
      orientation: "HORIZONTAL",
      texture: "Interface\\TargetingFrame\\UI-StatusBar",
      color: { r: 0, g: 1, b: 0, a: 1 },
    });
    assert.equal(power.statusBar.min, 0);
    assert.equal(power.statusBar.max, CANNED_PLAYER.powerMax);
    assert.equal(power.statusBar.value, 0);
    assert.equal(power.statusBar.color.r, 1, "RAGE uses the real red power color");
    assert.equal(power.statusBar.color.g, 0);

    api(candidate.inventory, "UnitName");
    api(candidate.inventory, "UnitLevel");
    api(candidate.inventory, "UnitHealth");
    api(candidate.inventory, "UnitHealthMax");
    api(candidate.inventory, "UnitIsConnected");
    api(candidate.inventory, "UnitPower");
    api(candidate.inventory, "UnitPowerMax");
    api(candidate.inventory, "UnitPowerType");

    const errorsAtLoad = candidate.boot.vm.errors.length;

    assert.ok(candidate.seam.setPlayerHealth(CANNED_PLAYER.healthMax - 330) > 0);
    assert.equal(health.statusBar.value, CANNED_PLAYER.healthMax - 330);
    assert.equal(candidate.seam.setPlayerHealth(CANNED_PLAYER.healthMax - 330), 0,
      "unchanged UNIT_HEALTH is not duplicated");

    assert.ok(candidate.seam.setPlayerHealthMax(CANNED_PLAYER.healthMax - 100) > 0);
    assert.equal(health.statusBar.max, CANNED_PLAYER.healthMax - 100);
    assert.equal(candidate.seam.setPlayerHealthMax(CANNED_PLAYER.healthMax - 100), 0,
      "unchanged UNIT_MAXHEALTH is not duplicated");

    assert.ok(candidate.seam.setPlayerPower(25) > 0);
    assert.equal(power.statusBar.value, 25);
    assert.equal(candidate.seam.setPlayerPower(25), 0,
      "unchanged UNIT_RAGE is not duplicated");

    assert.ok(candidate.seam.setPlayerPowerType(0) > 0);
    assert.deepEqual(candidate.seam.unitPowerType("player"), [0, "MANA"]);
    assert.equal(power.statusBar.color.b, 1, "UNIT_DISPLAYPOWER changes the bar type/color");
    assert.equal(candidate.seam.setPlayerPowerType(0), 0,
      "unchanged UNIT_DISPLAYPOWER is not duplicated");

    assert.ok(candidate.seam.setPlayerPowerMax(120) > 0);
    assert.equal(power.statusBar.max, 120);
    assert.equal(candidate.seam.setPlayerPowerMax(120), 0,
      "unchanged power max is not duplicated");
    assert.equal(candidate.boot.vm.errors.length, errorsAtLoad,
      "controlled unit events do not add Lua errors");
  } finally {
    candidate?.boot.close();
    chain.close();
  }
});
