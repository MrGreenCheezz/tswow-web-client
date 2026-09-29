import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");

const MINIMAP_XML = String.raw`<Ui>
  <Minimap name="Minimap"/>
  <Frame name="Ordinary"/>
</Ui>`;

function directRuntime(minimapAdapter) {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge,
    minimapAdapter === undefined ? {} : { minimapAdapter });
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(MINIMAP_XML);
  assert.equal(loaded.ok, true);
  return { vm, bridge, binder };
}

test("Minimap has a dedicated metatable and delegates bounded calls exactly", () => {
  let zoom = 1;
  const setZoom = [];
  const pings = [];
  const adapter = {
    getZoom: () => zoom,
    getZoomLevels: () => 3,
    setZoom: (value) => { setZoom.push(value); zoom = value; },
    pingLocation: (x, y) => { pings.push([x, y]); },
  };
  const { vm, bridge, binder } = directRuntime(adapter);

  const outcome = vm.execute(String.raw`
    MinimapZoom = Minimap:GetZoom()
    MinimapLevels = Minimap:GetZoomLevels()
    Minimap:SetZoom(99)
    MinimapZoomAfterClamp = Minimap:GetZoom()
    Minimap:SetZoom(99)
    Minimap:SetZoom(1.8)
    MinimapZoomAfterTruncate = Minimap:GetZoom()
    Minimap:SetZoom(1/0)
    Minimap:SetZoom(0/0)
    Minimap:PingLocation(0.25, -0.5)
    Minimap:PingLocation(math.huge, 0.5)
    Minimap:PingLocation(0.25, 0/0)
    Minimap:SetPlayerTextureWidth(math.huge)
    Minimap:SetPlayerTextureHeight("not-a-number")
    OrdinaryZoomMethod = type(Ordinary.GetZoom)
    OrdinaryPingMethod = type(Ordinary.PingLocation)
  `, "@minimap-widget");
  assert.equal(outcome.ok, true, outcome.error ?? "Minimap methods failed");
  zoom = 1.8;
  const fractionalGetter = vm.execute(
    "AdapterZoomAfterTruncate = Minimap:GetZoom()", "@minimap-widget-fractional-getter");
  assert.equal(fractionalGetter.ok, true, fractionalGetter.error ?? "fractional Minimap getter failed");
  assert.equal(vm.getGlobal("MinimapZoom"), 1);
  assert.equal(vm.getGlobal("MinimapLevels"), 3);
  assert.equal(vm.getGlobal("MinimapZoomAfterClamp"), 2);
  assert.equal(vm.getGlobal("MinimapZoomAfterTruncate"), 1);
  assert.equal(vm.getGlobal("AdapterZoomAfterTruncate"), 1);
  assert.deepEqual(setZoom, [2, 1], "the idempotent second request does not notify twice");
  assert.deepEqual(pings, [[0.25, -0.5]], "finite coordinates cross the adapter unchanged");
  assert.equal(vm.getGlobal("OrdinaryZoomMethod"), "nil");
  assert.equal(vm.getGlobal("OrdinaryPingMethod"), "nil");
  assert.equal(bridge.getFrame("Minimap")?.type, "Minimap");
  assert.equal(bridge.getFrame("Ordinary")?.type, "Frame");
  assert.deepEqual(binder.stubbedMethods, []);
  vm.close();
});

test("without an adapter Minimap stays bounded local state and never fabricates a ping", () => {
  const { vm, binder } = directRuntime();
  const outcome = vm.execute(String.raw`
    Minimap:SetZoom(999)
    LocalZoom = Minimap:GetZoom()
    LocalLevels = Minimap:GetZoomLevels()
    Minimap:PingLocation(0.1, 0.2)
    Minimap:SetPlayerTextureWidth(40)
    Minimap:SetPlayerTextureHeight(40)
    PlainHasMinimapMethod = type(Ordinary.SetPlayerTextureWidth)
  `, "@minimap-widget-no-adapter");
  assert.equal(outcome.ok, true, outcome.error ?? "local Minimap methods failed");
  assert.equal(vm.getGlobal("LocalZoom"), 0);
  assert.equal(vm.getGlobal("LocalLevels"), 1);
  assert.equal(vm.getGlobal("PlainHasMinimapMethod"), "nil");
  assert.deepEqual(binder.stubbedMethods, []);
  vm.close();
});

test("FrameXmlBoot forwards the optional Minimap adapter to its binder", () => {
  let zoom = 0;
  const calls = [];
  const adapter = {
    getZoom: () => zoom,
    getZoomLevels: () => 4,
    setZoom: (value) => { calls.push(value); zoom = value; },
    pingLocation: () => {},
  };
  const boot = new FrameXmlBoot({
    provider: { async read() { return undefined; } },
    minimapAdapter: adapter,
  });
  const loaded = boot.bridge.loadAddon(String.raw`<Ui><Minimap name="Minimap"/></Ui>`);
  assert.equal(loaded.ok, true);
  const outcome = boot.vm.execute("Minimap:SetZoom(2)", "@minimap-boot-forward");
  assert.equal(outcome.ok, true, outcome.error ?? "boot-forwarded Minimap method failed");
  assert.deepEqual(calls, [2]);
  boot.close();
});
