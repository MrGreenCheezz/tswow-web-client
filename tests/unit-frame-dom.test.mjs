import assert from "node:assert/strict";
import test from "node:test";

/**
 * The same small DOM `widget-dom.test.mjs` uses, so the unit frame is exercised rather than hoped
 * for. It answers only what the frame actually touches; anything it starts touching shows up here
 * as a crash rather than as a frame that silently draws nothing.
 */
function fakeDocument() {
  const make = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      style: { setProperty(name, value) { this[name] = value; } },
      className: "",
      textContent: "",
      hidden: false,
      listeners: new Map(),
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        toggle(name, on) { on ? this.add(name) : node.className = node.className.split(" ").filter((c) => c !== name).join(" "); },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...nodes) { node.children.push(...nodes); },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      attributes: new Map(),
      setAttribute(name, value) { node.attributes.set(name, String(value)); },
      removeAttribute(name) { node.attributes.delete(name); },
      closest() { return undefined; },
    };
    return node;
  };
  return { createElement: make, body: make("body") };
}

globalThis.document = fakeDocument();
const { UnitFrame, UnitFrameList } = await import("../dist/code/browser/ui/UnitFrame.js");
const { unitSnapshot, CLASS_DRUID, MEMBER_STATUS_ONLINE, MEMBER_STATUS_DEAD } =
  await import("../dist/code/browser/ui/UnitSnapshot.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const GUID = 0x0000_0000_0000_2a01n;

function object({ health, maxHealth, classId, powerType, power, maxPower, level } = {}) {
  const fields = new Map();
  if (level !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, level);
  if (health !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health);
  if (maxHealth !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, maxHealth);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, ((classId ?? 0) << 8) | ((powerType ?? 0) << 24));
  if (power !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + (powerType ?? 0), power);
  if (maxPower !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + (powerType ?? 0), maxPower);
  return { guid: GUID, typeId: 4, fields };
}

/** The bar element inside a frame, by the class the widget kit gives it. */
function bars(frame) {
  return frame.root.children.filter((child) => child.className?.startsWith("ui-bar"));
}

/** A header child by its class, so a new badge in front of the name does not move the others. */
function headerPart(frame, className) {
  return frame.root.children[0].children.find((child) => child.className === className);
}

test("a frame paints the unit's own power type rather than everyone's mana", () => {
  const frame = new UnitFrame({ kind: "party", size: "full" });
  assert.equal(frame.root.hidden, true, "a frame with nobody in it is not on the screen");

  frame.show(unitSnapshot(GUID, "Аллея", {
    object: object({ health: 45, maxHealth: 90, level: 80, classId: CLASS_DRUID, powerType: 1, power: 300, maxPower: 1_000 }),
  }));
  assert.equal(frame.root.hidden, false);
  assert.equal(frame.guid, GUID);

  const [health, power] = bars(frame);
  assert.equal(health.children[0].style.width, "50%");
  assert.equal(health.children[1].textContent, "45/90");
  assert.equal(power.children[0].dataset.variant, "1", "rage is red, not mana blue");
  assert.equal(power.hidden, false);

  // A unit with no power at all — a totem, a corpse — hides the bar rather than drawing it empty.
  frame.show(unitSnapshot(GUID, "Тотем", { object: object({ health: 10, maxHealth: 10 }) }));
  assert.equal(bars(frame)[1].hidden, true);
});

test("a class colour is a player thing, and a creature does not get one", () => {
  const frame = new UnitFrame({ kind: "party", size: "full" });
  const name = frame.root.children[0].children.find((child) => child.tagName === "STRONG");

  frame.show(unitSnapshot(GUID, "Аллея", { object: object({ health: 1, maxHealth: 1, classId: CLASS_DRUID }) }));
  assert.equal(name.style.color, "#ff7d0a");

  // Out of the grid there is no class byte, so no colour is invented for one.
  frame.show(unitSnapshot(GUID, "Аллея", { stats: { health: 1, maxHealth: 1 } }));
  assert.equal(name.style.color, "");
});

test("a frame says which of dead, offline, away and out of range it is", () => {
  const frame = new UnitFrame({ kind: "raid", size: "grid" });

  frame.show(unitSnapshot(GUID, "Аллея", { stats: { health: 5, maxHealth: 10, status: MEMBER_STATUS_ONLINE } }));
  assert.ok(frame.root.classList.contains("is-far"), "in the raid, outside the client's grid");
  assert.ok(!frame.root.classList.contains("is-dead"));

  frame.show(unitSnapshot(GUID, "Аллея", { stats: { status: MEMBER_STATUS_ONLINE | MEMBER_STATUS_DEAD } }));
  assert.ok(frame.root.classList.contains("is-dead"));

  frame.show(unitSnapshot(GUID, "Аллея", { online: false }));
  assert.ok(frame.root.classList.contains("is-offline"));

  frame.show(unitSnapshot(GUID, "Аллея", { object: object({ health: 5, maxHealth: 10 }) }));
  assert.ok(!frame.root.classList.contains("is-far"), "in the grid again");
  assert.ok(!frame.root.classList.contains("is-offline"));

  // A grid slot has no power bar: forty of them is forty bars nobody reads.
  assert.equal(bars(frame).length, 1);
});

test("the raid mark, the reaction and the threat are written as attributes", () => {
  const frame = new UnitFrame({ kind: "party", size: "full" });
  const snapshot = unitSnapshot(GUID, "Аллея", {
    object: object({ health: 5, maxHealth: 10 }), raidMark: 0, reaction: -1,
  });

  frame.show(snapshot, { threat: 1 });
  assert.equal(frame.root.dataset.reaction, "hostile");
  assert.equal(frame.root.dataset.threat, "tanking");
  assert.equal(headerPart(frame, "ui-unit-mark").textContent, "★");

  frame.show(unitSnapshot(GUID, "Аллея", { object: object({ health: 5, maxHealth: 10 }) }), { threat: 0.6 });
  assert.equal(frame.root.dataset.reaction, undefined, "no reaction is no border, not a neutral one");
  assert.equal(frame.root.dataset.threat, "some");
  assert.equal(frame.root.children[0].children[0].hidden, true);

  frame.show(unitSnapshot(GUID, "Аллея", { object: object({ health: 5, maxHealth: 10 }) }));
  assert.equal(frame.root.dataset.threat, undefined, "an empty threat table is not zero threat");
});

test("a list reuses its frames and hides what a smaller group left behind", () => {
  const list = new UnitFrameList({ kind: "party", size: "full" });
  const snapshot = (name) => ({ snapshot: unitSnapshot(GUID, name, { object: object({ health: 5, maxHealth: 10 }) }) });

  list.render([snapshot("Аллея"), snapshot("Тень"), snapshot("Рассвет")]);
  assert.equal(list.root.children.length, 3);
  const first = list.root.children[0];

  list.render([snapshot("Аллея")]);
  assert.equal(list.root.children.length, 3, "frames are kept: forty buttons rebuilt per update flicker");
  assert.equal(list.root.children[1].hidden, true);
  assert.equal(list.root.children[2].hidden, true);
  assert.equal(list.root.children[0], first, "and the one still in use is the same element");

  list.render([]);
  assert.equal(list.root.hidden, true, "an empty list takes its container off the screen too");
});

test("a four-row party list preallocates stable portrait canvases and reuses them on reorder", () => {
  const list = new UnitFrameList({ kind: "party", size: "full", portrait: true });
  const frames = [0, 1, 2, 3].map((index) => list.at(index));
  const canvases = frames.map((frame) => frame.portraitCanvas);
  assert.equal(list.root.children.length, 4, "party portrait rows are ready before a member arrives");
  assert.ok(canvases.every(Boolean));
  assert.equal(new Set(canvases).size, 4, "each party row has its own canvas");
  assert.deepEqual(canvases.map((canvas) => canvas.dataset.portraitSlot),
    ["party1", "party2", "party3", "party4"]);

  const entries = [1, 2, 3, 4].map((index) => ({
    snapshot: unitSnapshot(BigInt(index), `Участник ${index}`, {
      object: object({ health: 5, maxHealth: 10 }),
    }),
  }));
  list.render(entries);
  const originalFrames = [...frames];
  const originalCanvases = [...canvases];
  list.render([entries[3], entries[2], entries[1], entries[0]]);
  assert.deepEqual(frames, originalFrames, "reorder does not replace party row buttons");
  assert.deepEqual(frames.map((frame) => frame.portraitCanvas), originalCanvases,
    "reorder does not replace party canvases");
  assert.deepEqual(frames.map((frame) => frame.guid), [4n, 3n, 2n, 1n],
    "reorder retargets the stable rows by GUID");
});

// 4.08: an empty raid slot (guid 0, `emptyGridSlot`) holds its place and is nobody — a click does
// not select guid 0 and a right click opens no group menu for it.
test("an empty raid slot takes no click and no context menu; a member's slot does", () => {
  const clicks = [];
  const menus = [];
  const frame = new UnitFrame({ kind: "raid", size: "grid", onClick: (guid) => clicks.push(guid),
    onContext: (guid) => menus.push(guid) });
  frame.show(unitSnapshot(0n, "", {}));
  assert.equal(frame.guid, undefined);
  assert.equal(frame.root.dataset.empty, "");
  assert.equal(frame.root.attributes.get("aria-hidden"), "true");
  frame.root.listeners.get("click")();
  frame.root.listeners.get("contextmenu")({ preventDefault() {} });
  assert.deepEqual(clicks, []);
  assert.deepEqual(menus, []);
  frame.show(unitSnapshot(GUID, "Лиара", {}));
  assert.equal(frame.root.dataset.empty, undefined);
  assert.equal(frame.root.attributes.has("aria-hidden"), false);
  frame.root.listeners.get("click")();
  frame.root.listeners.get("contextmenu")({ preventDefault() {} });
  assert.deepEqual(clicks, [GUID]);
  assert.deepEqual(menus, [GUID]);
});

test("the raid grid fills by columns: one subgroup a column of five", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = (await readFile(new URL("../src/browser/style.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /\.ui-raid-grid\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /grid-auto-flow:\s*column/);
  assert.match(rule, /grid-template-rows:\s*repeat\(5,/);
  assert.match(css, /\.ui-unit-frame\[data-empty\]\s*\{[^}]*pointer-events:\s*none/);
});
