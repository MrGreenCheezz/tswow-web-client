import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { fetchCatalogJson, CATALOG_FETCH_DEFAULTS } = await import("../dist/code/browser/CatalogFetch.js");
const { BattlegroundClient } = await import("../dist/code/browser/BattlegroundMetadata.js");
const { FRAMEXML_CANNED_BATTLEGROUNDS } = await import("../dist/code/browser/framexml/FrameXmlBattlegrounds.js");
const { LfgDungeonClient } = await import("../dist/code/browser/LfgDungeons.js");
const { FRAMEXML_QUEST_REWARD_DATA_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlQuestRewardData.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { parseFrameXml } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");

const FAST = { timeoutMs: 20, retryDelayMs: 1 };

function withFetch(context, fetcher) {
  const original = globalThis.fetch;
  const warn = console.warn;
  console.warn = () => {};
  context.after(() => { globalThis.fetch = original; console.warn = warn; });
  globalThis.fetch = fetcher;
}

/** A request stuck behind the browser's connection limit: nothing until its abort signal. */
function stalled(init) {
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

test("a catalog request that outlives its timeout is asked again, not given up on", async (context) => {
  let calls = 0;
  withFetch(context, (_url, init) => {
    calls += 1;
    return calls === 1 ? stalled(init) : Promise.resolve({ ok: true, json: async () => ({ answer: 1 }) });
  });
  assert.deepEqual(await fetchCatalogJson("http://gateway/x", "X", FAST), { answer: 1 });
  assert.equal(calls, 2);
});

test("the mount's catalogs outlast the world-entry queue the owner's session lost them to", () => {
  // The old budget was one try of five seconds; the owner's five fallback lines reproduce with a seven second stall.
  assert.ok(CATALOG_FETCH_DEFAULTS.timeoutMs > 7_000);
  assert.ok(CATALOG_FETCH_DEFAULTS.attempts >= 2);
});

test("a 5xx is repeated up to the limit; a 4xx and a malformed body are final", async (context) => {
  let calls = 0;
  withFetch(context, async () => { calls += 1; return { ok: false, status: 503 }; });
  await assert.rejects(fetchCatalogJson("http://gateway/x", "X", { ...FAST, attempts: 3 }), /X gateway returned 503/);
  assert.equal(calls, 3);

  calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 404 }; };
  await assert.rejects(fetchCatalogJson("http://gateway/x", "X", { ...FAST, attempts: 3 }), /X gateway returned 404/);
  assert.equal(calls, 1);

  calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => JSON.parse("{") }; };
  await assert.rejects(fetchCatalogJson("http://gateway/x", "X", { ...FAST, attempts: 3 }), SyntaxError);
  assert.equal(calls, 1);
});

test("the request goes at high priority and keeps the caller's cache mode", async (context) => {
  let seen;
  withFetch(context, async (_url, init) => { seen = init; return { ok: true, json: async () => ({}) }; });
  await fetchCatalogJson("http://gateway/x", "X", { ...FAST, init: { cache: "no-cache" } });
  assert.equal(seen.priority, "high");
  assert.equal(seen.cache, "no-cache");
});

test("BattlegroundClient survives a dropped first request", async (context) => {
  let calls = 0;
  withFetch(context, async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return { ok: true, json: async () => FRAMEXML_CANNED_BATTLEGROUNDS };
  });
  const client = new BattlegroundClient("http://127.0.0.1:1");
  assert.ok(await client.load());
  assert.equal(client.ready, true);
  assert.equal(calls, 2);
});

test("LfgDungeonClient survives a dropped first request", async (context) => {
  let calls = 0;
  withFetch(context, async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return { ok: true, json: async () => ({ version: 2, dungeons: [{
      id: 1, name: "Probe", minLevel: 15, maxLevel: 25, type: 1, difficulty: 0, expansion: 0, description: "",
      texture: "PROBE", mapId: 43, targetLevel: 19, targetLevelMin: 17, targetLevelMax: 20, groupId: 1,
      flags: 3, faction: -1, orderIndex: 0, maxPlayers: 10,
    }], groups: [] }) };
  });
  const client = new LfgDungeonClient("http://127.0.0.1:1");
  await client.load();
  assert.equal(calls, 2);
  assert.equal(client.ready, true);
});

test("GetQuestItemLink answers a reward row (stock's modified click, WCollections' row hook)", () => {
  const read = FRAMEXML_QUEST_REWARD_DATA_BINDINGS.GetQuestItemLink;
  const item = (id) => ({ id, count: 1, displayId: 0 });
  const dialog = { kind: "reward", rewards: { items: [item(11)], choices: [item(21), item(22)] } };
  const metadata = { item: () => undefined, link: (id) => `link:${id}` };
  assert.deepEqual(read(dialog, ["reward", 1], metadata), ["link:11"]);
  assert.deepEqual(read(dialog, ["choice", 2], metadata), ["link:22"]);
  assert.deepEqual(read(dialog, ["choice", 3], metadata), []);
  assert.deepEqual(read(dialog, ["reward", 1], { item: () => undefined }), [], "no link source: Lua nil, no error");
  const required = { kind: "request-items", items: [item(31)] };
  assert.deepEqual(read(required, ["required", 1], metadata), ["link:31"]);
});

test("GetQuestLogItemLink is a bound C API over the seam", () => {
  const binding = FRAMEXML_SEAM_BINDINGS.GetQuestLogItemLink;
  assert.equal(typeof binding, "function");
  const calls = [];
  const seam = { questLogItemLink: (type, index) => { calls.push([type, index]); return index === 1 ? "link" : undefined; } };
  assert.deepEqual([...binding(seam, ["reward", 1])], ["link"]);
  assert.deepEqual([...binding(seam, ["choice", 2])], []);
  assert.deepEqual(calls, [["reward", 1], ["choice", 2]]);
});

test("a region in a frame's Layer is built even when it says virtual (WCollections' ModelControlButtonTemplate)", () => {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  bridge.setRuntime(new GlueWidgetBinder(vm, bridge));
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(
    String(args[0] ?? "Frame"),
    args[1] === undefined ? undefined : String(args[1]),
    args[2],
    args[3] === undefined ? undefined : String(args[3]),
  )]);
  try {
    const parsed = parseFrameXml(`<Ui>
      <Button name="ProbeControlTemplate" virtual="true">
        <Layers>
          <Layer level="BACKGROUND"><Texture name="$parentBg" parentKey="bg"/></Layer>
          <Layer level="ARTWORK"><Texture name="$parentIcon" virtual="true" parentKey="icon"/></Layer>
        </Layers>
      </Button>
    </Ui>`);
    assert.equal(parsed.ok, true, parsed.diagnostics.join(" | "));
    assert.equal(bridge.registerTemplateElement(parsed.root.children[0]), true);
    const result = vm.execute(`
      local button = CreateFrame("Button", "ProbeControl", nil, "ProbeControlTemplate")
      ProbeBg, ProbeIcon, ProbeIconGlobal = type(button.bg), type(button.icon), type(ProbeControlIcon)
    `, "@probe");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(vm.getGlobal("ProbeBg"), "table");
    assert.equal(vm.getGlobal("ProbeIcon"), "table");
    assert.equal(vm.getGlobal("ProbeIconGlobal"), "table");
  } finally {
    vm.close();
  }
});

test("a native window opened while the corpus loaded closes when its stock owner is published", () => {
  const source = readFileSync(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  const before = (close, publish) => {
    const at = source.indexOf(`${close}();`);
    assert.ok(at > 0, `${close} is called`);
    const to = source.indexOf(publish, at);
    assert.ok(to > at, `${close} runs before ${publish}`);
  };
  before("closeReputation", "publishFrameXmlCharacter(");
  before("closeArenaWindow", "publishFrameXmlPvp(");
  before("closeMacroWindow", "mountFrameXmlMacroBindingWindows(");
  before("closeKeyBindingsWindow", "mountFrameXmlMacroBindingWindows(");
  before("closeCalendar", "mountFrameXmlCalendar(");
  before("closeSettingsWindow", "mountFrameXmlOptions(");
});

test("a texture name with a doubled separator asks for the one file (WCollections' long strings)", async () => {
  const { frameXmlTexturePath } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlTextures.js");
  assert.equal(frameXmlTexturePath(String.raw`Interface\AddOns\W\Interface\\FrameGeneral\UI-Frame`),
    String.raw`Interface\AddOns\W\Interface\FrameGeneral\UI-Frame.blp`);
  assert.equal(frameXmlTexturePath(String.raw`Interface\Icons//INV_Misc`), String.raw`Interface\Icons\INV_Misc.blp`);
});
