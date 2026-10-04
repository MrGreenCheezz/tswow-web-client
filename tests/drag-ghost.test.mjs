// 4.02 and 4.05: the icon a native drag carries under the cursor (ui/DragGhost.ts), what an action
// bar drag carries and how strictly a bar reads it (ui/ActionDrag.ts), and the macro window as a
// drag source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

function node(tag = "div") {
  const listeners = new Map();
  const n = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, className: "", textContent: "", attributes: new Map(),
    draggable: false, removed: 0, listeners, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append(...children) { n.children.push(...children); }, prepend(...children) { n.children.unshift(...children); },
    replaceChildren(...children) { n.children = children; },
    remove() { n.removed += 1; },
    addEventListener(name, handler) { listeners.set(name, handler); },
    setAttribute(name, value) { n.attributes.set(name, String(value)); },
    getAttribute(name) { return n.attributes.has(name) ? n.attributes.get(name) : (name === "src" ? n.src ?? null : null); },
    querySelector(selector) {
      const all = (root) => root.children.flatMap((child) => [child, ...all(child)]);
      return all(n).find((child) => selector.split(",").some((part) => {
        const s = part.trim();
        return s.startsWith(".") ? child.className.split(/\s+/).includes(s.slice(1)) : child.tagName === s.toUpperCase();
      })) ?? null;
    },
  };
  return n;
}
globalThis.document = { createElement: node, body: node("body") };

const ghost = await import("../dist/code/browser/ui/DragGhost.js");
const drag = await import("../dist/code/browser/ui/ActionDrag.js");

function dragEvent() {
  const calls = [];
  const data = new Map();
  return {
    calls, data,
    dataTransfer: {
      setDragImage(element, x, y) { calls.push({ element, x, y }); },
      setData(format, value) { data.set(format, value); },
    },
  };
}

function itemSlot({ src, count, quality } = {}) {
  const slot = node("button");
  slot.className = quality === undefined ? "item-slot" : `item-slot quality-${quality}`;
  const icon = node("span");
  icon.className = "item-icon";
  if (src) { const img = node("img"); img.src = src; img.currentSrc = src; icon.append(img); }
  slot.append(icon);
  if (count) { const stack = node("span"); stack.className = "stack-count"; stack.textContent = count; slot.append(stack); }
  return slot;
}

test("the ghost is the source's picture, count and quality, 36×36, held at its centre", () => {
  const event = dragEvent();
  ghost.beginIconDrag(event, itemSlot({ src: "blob:icon-1", count: "20", quality: 3 }));
  assert.equal(event.calls.length, 1, "setDragImage once");
  const { element, x, y } = event.calls[0];
  assert.equal(element.className, "drag-ghost");
  assert.equal(element.dataset.quality, "3");
  assert.equal(element.children[0].tagName, "IMG");
  assert.equal(element.children[0].src, "blob:icon-1", "the URL the button already shows");
  assert.equal(element.children[1].textContent, "20");
  assert.deepEqual([x, y], [18, 18]);
  assert.equal(ghost.DRAG_GHOST_SIZE, 36);
  assert.ok(document.body.children.includes(element), "painted from the document");
});

test("the ghost is removed on the next task", async () => {
  const event = dragEvent();
  ghost.beginIconDrag(event, itemSlot({ src: "blob:icon-2" }));
  const { element } = event.calls[0];
  assert.equal(element.removed, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(element.removed, 1);
});

test("a source without a picture still gets a ghost — its letter — and no dataTransfer is no error", () => {
  const event = dragEvent();
  const source = node("button");
  source.textContent = "Атака";
  ghost.beginIconDrag(event, source);
  assert.equal(event.calls.length, 1);
  assert.equal(event.calls[0].element.children[0].textContent, "А");
  const labelled = dragEvent();
  ghost.beginIconDrag(labelled, node("span"), { label: "М" });
  assert.equal(labelled.calls[0].element.children[0].textContent, "М");
  assert.doesNotThrow(() => ghost.beginIconDrag({}, source));
  assert.doesNotThrow(() => ghost.beginIconDrag({ dataTransfer: { setData() {} } }, source));
});

test("action drag payloads: fixed key order, the server's type bytes", () => {
  assert.deepEqual(drag.macroActionDragPayload(37), ["application/x-webclient-action", '{"action":37,"type":64}']);
  assert.deepEqual(drag.spellDragPayload(133), ["application/x-webclient-action", '{"action":133,"type":0}']);
  assert.deepEqual(drag.itemActionDragPayload(6948), ["application/x-webclient-action", '{"action":6948,"type":128}']);
  assert.deepEqual(drag.slotDragPayload({ action: 5, type: 0 }, 13), ["application/x-webclient-action", '{"action":5,"type":0,"from":13}']);
});

test("a bar reads a drop strictly and ignores anything else", () => {
  assert.deepEqual(drag.parseActionDrop('{"action":37,"type":64}'), { action: 37, type: 64 });
  assert.deepEqual(drag.parseActionDrop('{"action":5,"type":0,"from":143}'), { action: 5, type: 0, from: 143 });
  assert.deepEqual(drag.parseActionDrop('{"action":3,"type":65}'), { action: 3, type: 65 }, "ACTION_BUTTON_CMACRO");
  for (const raw of [undefined, "", "null", "not json", "[1,2]", '{"action":"x","type":0}', '{"action":-1,"type":0}',
    '{"action":0,"type":0}', '{"action":16777216,"type":0}', '{"action":1,"type":1}', '{"action":1,"type":0,"from":144}',
    '{"action":1,"type":0,"from":-1}', '{"action":1.5,"type":0}']) {
    assert.equal(drag.parseActionDrop(raw), undefined, String(raw));
  }
});

test("the macro window: a macro's button drags its payload with a letter ghost, an empty slot does not drag", async () => {
  const ghosts = [];
  const macros = [{ index: 3, name: "Лечение", body: "/cast Лечение" }];
  let stores = 0;
  class FakeStore { constructor() { this.value = stores++ === 0 ? macros : []; } }
  class FakePanel {
    constructor() { this.body = node("div"); this.visible = false; }
    show() { this.visible = true; } hide() { this.visible = false; }
  }
  class FakeTabs { constructor() { this.root = node("div"); this.active = "account"; } set() {} }
  const model = await import("../dist/code/browser/ui/MacroModel.js");
  const real = await import("../dist/code/browser/ui/ActionDrag.js");
  const ui = await isolatedUi("Macros", {
    "../AccountStore.js": { AccountStore: FakeStore },
    "./MacroModel.js": model,
    "./Widgets.js": { setTip() {}, Panel: FakePanel, Tabs: FakeTabs, confirmPanel() {} },
    "./ActionDrag.js": real,
    "./DragGhost.js": { beginIconDrag: (event, source, spec) => ghosts.push({ source, spec }) },
    "../framexml/FrameXmlMacroController.js": { toggleFrameXmlMacro: () => false, frameXmlMacroOpen: () => false },
  });
  ui.toggleMacroWindow();
  // The slot grid is the div whose children were last replaced by buttons (hook below).
  const buttons = lastGrid.children;
  const filled = buttons.find((button) => button.textContent === "Лечение");
  const empty = buttons.find((button) => button.textContent === "");
  assert.ok(filled && empty);
  assert.equal(filled.draggable, true);
  assert.equal(empty.draggable, false, "nothing to drag out of an empty slot");
  assert.equal(empty.listeners.has("dragstart"), false);
  const event = dragEvent();
  filled.listeners.get("dragstart")(event);
  assert.equal(event.data.get("application/x-webclient-action"), '{"action":3,"type":64}');
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0].source, filled);
  assert.equal(ghosts[0].spec.label, "Л");
});

let lastGrid;
const createElement = document.createElement;
document.createElement = (tag) => {
  const created = createElement(tag);
  if (tag === "div") {
    const replace = created.replaceChildren;
    created.replaceChildren = (...children) => {
      replace(...children);
      if (children.length > 0 && children[0].tagName === "BUTTON") lastGrid = created;
    };
  }
  return created;
};

test("the native drag sources hand their drag an icon and the bars read drops strictly", async () => {
  const read = (file) => readFile(new URL(`../src/browser/ui/${file}`, import.meta.url), "utf8");
  const [bar, slots, book, pet] = await Promise.all([
    read("ActionBar.ts"), read("ItemSlots.ts"), read("Spellbook.ts"), read("PetBar.ts"),
  ]);
  assert.match(pet, /addEventListener\("dragstart"[\s\S]{0,300}?beginIconDrag\(event, button\.root\)/, "the pet bar");
  assert.match(bar, /addEventListener\("dragstart"[\s\S]{0,600}?beginIconDrag\(event, button\.root\)/, "action bar slots");
  assert.match(slots, /addEventListener\("dragstart"[\s\S]{0,700}?beginIconDrag\(event, element\)/, "bag and equipment slots");
  assert.match(book, /addEventListener\("dragstart"[\s\S]{0,400}?beginIconDrag\(event, icon/, "the spell book");
  assert.match(bar, /parseActionDrop\(event\.dataTransfer\?\.getData\(ACTION_DRAG_FORMAT\)\)/, "the bar's drop");
  assert.doesNotMatch(bar, /JSON\.parse\(raw\)/, "no unchecked parse left on the bar");
});
