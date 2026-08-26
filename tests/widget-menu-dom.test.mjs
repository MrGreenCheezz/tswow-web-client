import assert from "node:assert/strict";
import test from "node:test";

/**
 * The same small DOM as `widget-dom.test.mjs`, with the three things the floating boxes need on
 * top of it: a body that can drop children, a window that can hold listeners, and a timer. Added
 * deliberately and one at a time, so anything else the kit starts using still shows up as a crash.
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
      disabled: false,
      listeners: new Map(),
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        toggle(name, on) { on ? this.add(name) : node.className = node.className.split(" ").filter((c) => c !== name).join(" "); },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...nodes) { node.children.push(...nodes); },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      removeEventListener(name) { node.listeners.delete(name); },
      setAttribute(name, value) { node.dataset[`attr:${name}`] = value; },
      remove() { node.removed = true; },
      getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, right: 0, width: 100, height: 40 }; },
      closest() { return undefined; },
    };
    return node;
  };
  return { createElement: make, body: make("body") };
}

globalThis.document = fakeDocument();
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 720,
  listeners: new Map(),
  addEventListener(name, handler) { this.listeners.set(name, handler); },
  removeEventListener(name) { this.listeners.delete(name); },
  setTimeout(run) { run(); return 0; },
};
const { Tabs, closeFloating, confirmPanel, showMenu } = await import("../dist/code/browser/ui/Widgets.js");

const anchor = () => document.createElement("div");
const click = (node) => node.listeners.get("click")({ stopPropagation() {}, preventDefault() {} });
const box = () => document.body.children[document.body.children.length - 1];

test("a confirmation runs its action only when the accepting button is pressed", () => {
  let ran = 0;
  confirmPanel(anchor(), { title: "Удалить?", confirm: "Удалить", danger: true, onConfirm: () => { ran++; } });
  const actions = box().children.find((child) => child.className === "ui-confirm-actions");
  const [accept, cancel] = actions.children;
  assert.equal(accept.textContent, "Удалить");
  assert.equal(accept.className, "ui-menu-danger", "a destructive answer does not look like the rest");

  click(cancel);
  assert.equal(ran, 0, "cancelling asks for nothing");

  confirmPanel(anchor(), { title: "Удалить?", onConfirm: () => { ran++; } });
  const again = box().children.find((child) => child.className === "ui-confirm-actions");
  click(again.children[0]);
  assert.equal(ran, 1);
});

test("a confirmation says what will happen before it happens", () => {
  confirmPanel(anchor(), { title: "Снять лот?", lines: ["Депозит не возвращается."], onConfirm: () => {} });
  const lines = box().children.filter((child) => child.tagName === "P");
  assert.equal(lines[0].textContent, "Депозит не возвращается.");
  closeFloating();
});

test("a disabled menu row says why nothing happens instead of being missing", () => {
  let ran = 0;
  showMenu(anchor(), "Игрок", [
    { label: "Исключить", enabled: false, danger: true, run: () => { ran++; } },
    { label: "Написать", run: () => { ran++; } },
  ]);
  const [, kick, whisper] = box().children;
  assert.equal(kick.textContent, "Исключить");
  assert.equal(kick.disabled, true);
  assert.equal(whisper.textContent, "Написать");
  click(whisper);
  assert.equal(ran, 1);
});

test("a submenu row opens a second menu rather than doing something", () => {
  let ran = 0;
  showMenu(anchor(), "Игрок", [
    { label: "Метка", submenu: [{ label: "Череп", run: () => { ran++; } }] },
  ]);
  const mark = box().children[1];
  assert.equal(mark.textContent, "Метка ▸", "a row with a submenu says so");
  click(mark);
  assert.equal(ran, 0, "opening the submenu is not choosing from it");
  const skull = box().children[1];
  assert.equal(skull.textContent, "Череп");
  click(skull);
  assert.equal(ran, 1);
});

test("only one floating box is on screen at a time", () => {
  showMenu(anchor(), "Первое", [{ label: "А" }]);
  const first = box();
  showMenu(anchor(), "Второе", [{ label: "Б" }]);
  assert.equal(first.removed, true, "the second replaced the first rather than stacking on it");
  closeFloating();
});

test("Escape closes a floating box without choosing anything", () => {
  let ran = 0;
  showMenu(anchor(), "Игрок", [{ label: "Исключить", run: () => { ran++; } }]);
  const opened = box();
  globalThis.window.listeners.get("keydown")({ key: "Escape", stopPropagation() {} });
  assert.equal(opened.removed, true);
  assert.equal(ran, 0);
});

test("one tab is active, and it says so where a screen reader can hear it", () => {
  const tabs = new Tabs();
  const chosen = [];
  tabs.onSelect = (id) => chosen.push(id);
  tabs.set([{ id: "a", title: "Состав" }, { id: "b", title: "Ранги", badge: 3 }]);
  assert.equal(tabs.active, "a", "the first tab is active when none was named");

  const [first, second] = tabs.root.children;
  assert.equal(first.className, "ui-tab is-active");
  assert.equal(first.dataset["attr:aria-selected"], "true");
  assert.equal(second.dataset["attr:aria-selected"], "false");
  assert.equal(second.dataset["badge"], "3", "a badge only on the tab that is not being looked at");

  second.listeners.get("click")();
  assert.deepEqual(chosen, ["b"]);
  assert.equal(tabs.root.children[0].className, "ui-tab", "exactly one active tab, still");
  assert.equal(tabs.root.children[1].className, "ui-tab is-active");
  assert.equal(tabs.root.children[1].dataset["badge"], undefined, "the badge goes once it is read");
});

test("an active tab that disappears falls back to the first rather than to nothing", () => {
  const tabs = new Tabs();
  tabs.set([{ id: "a", title: "А" }, { id: "b", title: "Б" }], "b");
  assert.equal(tabs.active, "b");
  tabs.set([{ id: "a", title: "А" }]);
  assert.equal(tabs.active, "a");
});
