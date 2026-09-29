import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";

// The native owners' step-aside hooks for this lane's stock windows: the native «Вставить камни»
// asks the published stock socketing route first (through the Lua entry point gem-abilities hooks),
// and the native barber window stays shut while the stock BarberShopFrame owns the chair.

const { frameXmlSocketTarget, publishFrameXmlSocket, openFrameXmlSocket } =
  await import("../dist/code/browser/framexml/FrameXmlSocketController.js");
const { openSocketing, socketingOpen, closeSocketing } = await import("../dist/code/browser/ui/Socketing.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

test("a native slot maps to the Lua address openSocketingFromLua reads back", () => {
  assert.deepEqual(frameXmlSocketTarget(255, 0), { location: 0, bag: 0, slot: 1 }, "head");
  assert.deepEqual(frameXmlSocketTarget(255, 18), { location: 0, bag: 0, slot: 19 }, "tabard");
  assert.deepEqual(frameXmlSocketTarget(255, 23), { location: 1, bag: 0, slot: 1 }, "the backpack's first slot");
  assert.deepEqual(frameXmlSocketTarget(19, 0), { location: 1, bag: 1, slot: 1 }, "the first bag");
  assert.deepEqual(frameXmlSocketTarget(22, 5), { location: 1, bag: 4, slot: 6 });
  assert.equal(frameXmlSocketTarget(255, 19), undefined, "a bag slot itself is not socketed");
  assert.equal(frameXmlSocketTarget(255, 40), undefined, "nor the bank");
  assert.equal(openFrameXmlSocket(255, 0), false, "nothing published: the native window");
});

test("the native «Вставить камни» takes the stock route while one is published, and its own window otherwise", () => {
  const previous = game.world;
  const item = { guid: 5n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 40416]]) };
  game.world = { state: { objects: new Map([[5n, item]]) } };
  const opened = [];
  let accept = true;
  const release = publishFrameXmlSocket({
    open: (target) => { opened.push(target); return accept; }, isOpen: () => false, close: () => false,
  });
  try {
    assert.equal(openSocketing({ item, guid: 5n, bag: 255, slot: 23, index: 23 }), true);
    assert.deepEqual(opened, [{ location: 1, bag: 0, slot: 1 }]);
    assert.equal(socketingOpen(), false, "the native panel stayed shut");
    release();
    accept = false;
    assert.equal(openFrameXmlSocket(255, 23), false, "an unpublished route answers false");
    assert.equal(opened.length, 1);
  } finally {
    release();
    closeSocketing();
    game.world = previous;
  }
});

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "", hidden: false,
    append(...children) { node.children.push(...children); },
    replaceChildren(...children) { node.children = [...children]; },
    addEventListener() {}, setAttribute() {},
  };
  return node;
}

class FakePanel {
  static instances = [];
  body = makeNode("div");
  visible = false;
  constructor() { FakePanel.instances.push(this); }
  show() { this.visible = true; }
  hide() { this.visible = false; }
}

async function isolatedBarber(game, owns) {
  const source = await readFile(new URL("../src/browser/ui/BarberShop.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const modules = {
    "../../generated/updateFields.js": await import("../dist/code/generated/updateFields.js"),
    "../../world/Fields.js": await import("../dist/code/world/Fields.js"),
    "../../world/BarberRules.js": await import("../dist/code/world/BarberRules.js"),
    "../game/Context.js": { game },
    "./Widgets.js": { Panel: FakePanel },
    "../framexml/FrameXmlBarberController.js": { frameXmlBarberOwnsShop: () => owns.value },
  };
  new Function("require", "module", "exports", js)((name) => modules[name] ?? {}, module, module.exports);
  return module.exports;
}

test("the native barber window steps aside while the stock BarberShopFrame owns the chair", async () => {
  globalThis.document ??= { createElement: (tag) => makeNode(tag) };
  const owns = { value: false };
  const self = { guid: 1n, fields: new Map() };
  const fakeGame = {
    world: { barberShopOpen: true, state: { selfGuid: 1n, objects: new Map([[1n, self]]) }, serviceMessage: undefined },
    barberStyles: { ready: false, stylesFor: () => [] },
  };
  const barber = await isolatedBarber(fakeGame, owns);
  barber.showBarberShop();
  const panel = FakePanel.instances.at(-1);
  assert.equal(panel.visible, true, "the chair is the native window's while nothing stock owns it");
  owns.value = true;
  barber.showBarberShop();
  assert.equal(panel.visible, false, "the stock frame owns the chair: the native window closes");
  assert.equal(barber.barberOpen(), false);
});
