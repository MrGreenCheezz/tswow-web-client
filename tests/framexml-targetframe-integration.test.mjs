import assert from "node:assert/strict";
import test from "node:test";

// This regression is MPQ-backed on purpose: TargetFrame.lua and UnitFrame.lua must drive the
// real TargetFrame widgets, not a hand-built stand-in that only repeats the expected values.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const {
  CannedWorldSeam,
  CANNED_TARGET,
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

test("MPQ TargetFrame paints and updates the canned target through stock Lua", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let candidate;
  try {
    candidate = await loadCandidate(chain);
    assert.ok(candidate.requests.has("interface/framexml/targetframe.xml"));
    assert.ok(candidate.requests.has("interface/framexml/targetframe.lua"));
    assert.ok(candidate.requests.has("interface/framexml/unitframe.lua"));
    assert.equal(candidate.inventory.files.missing.length, 0);
    assert.equal(candidate.inventory.xml.failed.length, 0);
    assert.equal(candidate.inventory.lua.failed, 0);

    const target = frame(candidate.boot, "TargetFrame");
    const name = frame(candidate.boot, "TargetFrameTextureFrameName");
    const health = frame(candidate.boot, "TargetFrameHealthBar");
    const power = frame(candidate.boot, "TargetFrameManaBar");
    assert.equal(target.visible, false, "TargetFrame starts hidden without a selected target");

    const errorsAtLoad = candidate.boot.vm.errors.length;
    assert.ok(candidate.seam.setTarget(CANNED_TARGET) > 0);
    assert.equal(target.visible, true, "stock TargetFrame shows after PLAYER_TARGET_CHANGED");
    assert.equal(name.text, CANNED_TARGET.name);
    assert.equal(health.statusBar.min, 0);
    assert.equal(health.statusBar.max, CANNED_TARGET.healthMax);
    assert.equal(health.statusBar.value, CANNED_TARGET.health);
    assert.equal(power.statusBar.min, 0);
    assert.equal(power.statusBar.max, CANNED_TARGET.powerMax);
    assert.equal(power.statusBar.value, CANNED_TARGET.power);

    const nextHealth = CANNED_TARGET.health - 333;
    assert.ok(candidate.seam.setTargetHealth(nextHealth) > 0);
    assert.equal(health.statusBar.max, CANNED_TARGET.healthMax);
    assert.equal(health.statusBar.value, nextHealth);
    assert.equal(candidate.seam.setTargetHealth(nextHealth), 0,
      "unchanged target health does not duplicate UNIT_HEALTH");

    assert.ok(candidate.seam.setTarget(undefined) > 0);
    assert.equal(target.visible, false, "stock TargetFrame hides after target loss");
    assert.equal(candidate.boot.vm.errors.length, errorsAtLoad,
      "target selection and health events add no unhandled Lua errors");
  } finally {
    candidate?.boot.close();
    chain.close();
  }
});

test("FrameXML child OnLoad runs before its parent OnLoad", () => {
  const order = [];
  const bridge = new FrameXmlUiBridge(undefined, {
    runtime: {
      name: "onload-order-test",
      luaVersion: "5.1-compatible adapter",
      execute(source, context) {
        order.push({ frame: context.frame.name, source });
      },
    },
  });
  const loaded = bridge.loadAddon(`<Ui><Frame name="Parent"><Scripts><OnLoad>parent</OnLoad></Scripts>
    <Frames><Frame name="Child"><Scripts><OnLoad>child</OnLoad></Scripts></Frame></Frames>
  </Frame></Ui>`);
  assert.equal(loaded.ok, true);
  assert.deepEqual(order.map(({ frame }) => frame), ["Child", "Parent"]);
});
