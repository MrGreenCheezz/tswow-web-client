import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {},
    className: "", textContent: "", hidden: false, disabled: false,
    type: "", value: "", title: "", placeholder: "",
    listeners: new Map(),
    append(...children) { node.children.push(...children); },
    replaceChildren(...children) { node.children = [...children]; },
    addEventListener(name, handler) { node.listeners.set(name, handler); },
    setAttribute() {},
    click() { node.listeners.get("click")?.(); },
  };
  return node;
}

globalThis.document = { createElement: (tag) => makeNode(tag) };

function allNodes(root, out = []) {
  out.push(root);
  for (const child of root.children ?? []) allNodes(child, out);
  return out;
}

function buttons(root) {
  return allNodes(root).filter((node) => node.tagName === "BUTTON");
}

class FakePanel {
  static instances = [];
  body = makeNode("div");
  visible = false;
  constructor() { FakePanel.instances.push(this); }
  show() { this.visible = true; }
  hide() { this.visible = false; }
}

async function isolatedBarber(game) {
  const source = await readFile(new URL("../src/browser/ui/BarberShop.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const modules = {
    "../../generated/updateFields.js": await import("../dist/code/generated/updateFields.js"),
    "../../world/Fields.js": await import("../dist/code/world/Fields.js"),
    "../../world/BarberRules.js": await import("../dist/code/world/BarberRules.js"),
    "../../gateway/BarberMetadata.js": await import("../dist/code/gateway/BarberMetadata.js"),
    "../game/Context.js": { game },
    "./Widgets.js": { Panel: FakePanel, setTip: () => {} },
  };
  new Function("require", "module", "exports", js)(
    (name) => modules[name] ?? new Proxy({}, { get: () => () => {} }), module, module.exports);
  return module.exports;
}

function fakeWorld() {
  const calls = [];
  const fields = new Map([
    // race 1, class 1, gender 0 (male).
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (1 << 8)],
    // skin 2, face 1, hair style 3, hair colour 4.
    [UPDATE_FIELDS.PLAYER_BYTES.offset, 2 | (1 << 8) | (3 << 16) | (4 << 24)],
    // facial hair 5.
    [UPDATE_FIELDS.PLAYER_BYTES_2.offset, 5],
  ]);
  return {
    calls,
    barberShopOpen: true,
    serviceMessage: undefined,
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields }]]) },
    alterAppearance: (...args) => calls.push(args),
  };
}

function fakeBarber() {
  const hair = [
    { id: 63, type: 0, race: 1, sex: 0, data: 0, name: "Лысая" },
    { id: 64, type: 0, race: 1, sex: 0, data: 3, name: "Хвост" },
  ];
  const facial = [
    { id: 85, type: 2, race: 1, sex: 0, data: 0, name: "Без бороды" },
    { id: 86, type: 2, race: 1, sex: 0, data: 5, name: "Борода" },
  ];
  return {
    ready: true,
    stylesFor: (type) => (type === 0 ? hair : type === 2 ? facial : []),
  };
}

test("confirming sends row ids, the colour and a zero skin for non-tauren", async () => {
  FakePanel.instances.length = 0;
  const world = fakeWorld();
  const barber = await isolatedBarber({ world, barberStyles: fakeBarber(), spells: new Map() });
  barber.showBarberShop();
  assert.equal(barber.barberOpen(), true);
  assert.deepEqual(world.calls, [], "opening sends nothing");
  const panel = FakePanel.instances.at(-1);
  const confirm = buttons(panel.body).find((button) => button.textContent === "Подтвердить стрижку");
  assert.ok(confirm, "a confirm button is drawn");
  confirm.click();
  // Worn bytes select the rows: hair data 3 -> row 64, colour 4, facial data 5 -> row 86,
  // and with no skin rows for humans the skin id is the legal zero.
  assert.deepEqual(world.calls, [[64, 4, 86, 0]]);
});

test("steppers walk only this race and sex, and the window shuts on close", async () => {
  FakePanel.instances.length = 0;
  const world = fakeWorld();
  const barber = await isolatedBarber({ world, barberStyles: fakeBarber(), spells: new Map() });
  barber.showBarberShop();
  const panel = FakePanel.instances.at(-1);
  const forwards = buttons(panel.body).filter((button) => button.textContent === "▶");
  assert.equal(forwards.length, 3, "hair, colour and facial steppers; no skin stepper for humans");
  forwards[0].click();
  const confirm = buttons(panel.body).find((button) => button.textContent === "Подтвердить стрижку");
  confirm.click();
  assert.deepEqual(world.calls, [[63, 4, 86, 0]], "one hair step forward wraps to row 63");
  barber.closeBarberShop();
  assert.equal(barber.barberOpen(), false);
});

test("the window stays shut without the server flag, and waits for the style table", async () => {
  const world = fakeWorld();
  world.barberShopOpen = false;
  const barber = await isolatedBarber({ world, barberStyles: fakeBarber(), spells: new Map() });
  barber.showBarberShop();
  assert.equal(barber.barberOpen(), false);

  const world2 = fakeWorld();
  const barber2 = await isolatedBarber({ world: world2, barberStyles: { ready: false }, spells: new Map() });
  barber2.showBarberShop();
  assert.equal(barber2.barberOpen(), true, "a loading state beats a silent refusal");
  assert.deepEqual(world2.calls, []);
});
