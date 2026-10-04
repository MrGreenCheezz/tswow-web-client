import assert from "node:assert/strict";
import test, { mock } from "node:test";

// The one tooltip of the native interface (ui/Tooltip.ts, item 4.01): delay and warm mode, what
// hides it, the accessibility wiring and `setTip`/`getTip`, over a document double small enough
// to see every listener.

function fakeNode(tag) {
  const listeners = new Map();
  const attributes = new Map();
  const node = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, className: "", textContent: "", hidden: false, id: "",
    style: {}, focusVisible: false,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    matches(selector) { return selector === ":focus-visible" ? node.focusVisible : false; },
    append(...nodes) { node.children.push(...nodes); },
    replaceChildren(...nodes) { node.children = [...nodes]; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener));
    },
    fire(type, fields = {}) { for (const listener of listeners.get(type) ?? []) listener({ type, ...fields }); },
    getBoundingClientRect() { return { left: 10, top: 10, bottom: 40, right: 60, width: 50, height: 30 }; },
  };
  return node;
}

const windowListeners = new Map();
globalThis.document = { createElement: fakeNode, body: fakeNode("body") };
globalThis.window = {
  innerWidth: 1280, innerHeight: 720,
  addEventListener(type, listener) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(listener);
  },
  removeEventListener() {},
};
const fireWindow = (type, fields = {}) => {
  const event = { type, propagationStopped: false, stopPropagation() { this.propagationStopped = true; }, ...fields };
  for (const listener of windowListeners.get(type) ?? []) listener(event);
  return event;
};

mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
const {
  TIP_DELAY_MS, TIP_WARM_MS, TOOLTIP_ID, attachTooltip, getTip, hideTooltip, hideTooltipAtPoint, setTip,
  showTooltipAtPoint,
} = await import("../dist/code/browser/ui/Tooltip.js");
const widgets = await import("../dist/code/browser/ui/Widgets.js");

const box = () => document.body.children.find((child) => child.id === TOOLTIP_ID);
const shownTitle = () => (box() && !box().hidden ? box().children[0]?.textContent : undefined);
/** Each test starts cold: nothing on screen, the last hint long gone. */
function cold() {
  hideTooltip();
  mock.timers.tick(TIP_WARM_MS + 1000);
}

test("a plain hint waits its delay; leaving before it runs out cancels it", () => {
  cold();
  const button = fakeNode("button");
  setTip(button, "Персонаж (C)");
  button.fire("pointerenter");
  mock.timers.tick(TIP_DELAY_MS - 1);
  assert.equal(shownTitle(), undefined, "not yet at 249 ms");
  mock.timers.tick(1);
  assert.equal(shownTitle(), "Персонаж (C)");
  assert.equal(box().className, "ui-tooltip is-plain");
  button.fire("pointerleave");
  assert.equal(shownTitle(), undefined);

  cold();
  button.fire("pointerenter");
  mock.timers.tick(100);
  button.fire("pointerleave");
  mock.timers.tick(TIP_DELAY_MS);
  assert.equal(shownTitle(), undefined, "a pointer that left takes its pending hint with it");
});

test("the next hint within the warm window shows at once; after it, the delay is back", () => {
  cold();
  const first = fakeNode("button");
  const second = fakeNode("button");
  setTip(first, "Первая");
  setTip(second, "Вторая");
  first.fire("pointerenter");
  mock.timers.tick(TIP_DELAY_MS);
  first.fire("pointerleave");
  mock.timers.tick(TIP_WARM_MS - 1);
  second.fire("pointerenter");
  assert.equal(shownTitle(), "Вторая", "running along a row of buttons does not blink");
  second.fire("pointerleave");
  mock.timers.tick(TIP_WARM_MS);
  first.fire("pointerenter");
  assert.equal(shownTitle(), undefined, "cold again");
  first.fire("pointerleave");
});

test("rich cards stay instant; keyboard focus shows a card, a mouse focus does not", () => {
  cold();
  const slot = fakeNode("button");
  attachTooltip(slot, () => ({ title: "Мифриловый слиток", quality: 2 }));
  slot.fire("pointerenter");
  assert.equal(shownTitle(), "Мифриловый слиток");
  assert.equal(box().className, "ui-tooltip");
  slot.fire("pointerleave");

  cold();
  const button = fakeNode("button");
  setTip(button, "Подсказка");
  button.focusVisible = false;
  button.fire("focus");
  assert.equal(shownTitle(), undefined, "a click's focus leaves no hint");
  button.focusVisible = true;
  button.fire("focus");
  assert.equal(shownTitle(), "Подсказка", "a keyboard focus shows it at once");
  button.fire("blur");
  assert.equal(shownTitle(), undefined);
});

test("a press, the wheel, a drag, Escape and the window losing focus hide it; Escape still reaches the game", () => {
  for (const dismiss of [
    (button) => button.fire("pointerdown"),
    () => fireWindow("wheel"),
    () => fireWindow("dragstart"),
    () => fireWindow("blur"),
  ]) {
    cold();
    const button = fakeNode("button");
    setTip(button, "Подсказка");
    button.fire("pointerenter");
    mock.timers.tick(TIP_DELAY_MS);
    assert.equal(shownTitle(), "Подсказка");
    dismiss(button);
    assert.equal(shownTitle(), undefined);
  }
  cold();
  const button = fakeNode("button");
  setTip(button, "Подсказка");
  button.fire("pointerenter");
  mock.timers.tick(TIP_DELAY_MS);
  const escape = fireWindow("keydown", { key: "Escape", code: "Escape" });
  assert.equal(shownTitle(), undefined);
  assert.equal(escape.propagationStopped, false, "the back-out chain sees the same press");

  cold();
  const pending = fakeNode("button");
  setTip(pending, "Ещё не видна");
  pending.fire("pointerenter");
  fireWindow("wheel");
  mock.timers.tick(TIP_DELAY_MS);
  assert.equal(shownTitle(), undefined, "a scroll also cancels a hint still waiting");
});

test("role=tooltip, and aria-describedby only while shown", () => {
  cold();
  const button = fakeNode("button");
  setTip(button, "Подсказка");
  button.fire("pointerenter");
  mock.timers.tick(TIP_DELAY_MS);
  assert.equal(box().getAttribute("role"), "tooltip");
  assert.equal(button.getAttribute("aria-describedby"), TOOLTIP_ID);
  button.fire("pointerleave");
  assert.equal(button.getAttribute("aria-describedby"), null);

  const described = fakeNode("button");
  described.setAttribute("aria-describedby", "own-help");
  setTip(described, "Подсказка");
  described.fire("pointerenter");
  assert.equal(described.getAttribute("aria-describedby"), TOOLTIP_ID);
  described.fire("pointerleave");
  assert.equal(described.getAttribute("aria-describedby"), "own-help", "the element's own description comes back");
});

test("setTip swaps, redraws in place and removes; getTip reads it back", () => {
  cold();
  const button = fakeNode("button");
  setTip(button, "Раз\nвторая строка");
  assert.equal(getTip(button), "Раз\nвторая строка");
  button.fire("pointerenter");
  mock.timers.tick(TIP_DELAY_MS);
  assert.equal(shownTitle(), "Раз");
  assert.equal(box().children[1]?.textContent, "вторая строка", "a sentence's later lines sit under its first");
  setTip(button, "Два");
  assert.equal(shownTitle(), "Два", "the hint on screen follows the change");
  setTip(button, undefined);
  assert.equal(getTip(button), undefined);
  assert.equal(shownTitle(), undefined, "removing the hint takes it off the screen");
  button.fire("pointerleave");
  button.fire("pointerenter");
  mock.timers.tick(TIP_DELAY_MS);
  assert.equal(shownTitle(), undefined, "and nothing comes back");
  setTip(button, "");
  assert.equal(getTip(button), undefined, "an empty string is no hint");
});

test("the cursor mode places by a point and only its owner takes it down", () => {
  cold();
  showTooltipAtPoint("world", { title: "Кабан", plain: true, titleColor: "#ff2020" }, 100, 200);
  assert.equal(shownTitle(), "Кабан");
  assert.equal(box().style.left, "116px");
  assert.equal(box().style.top, "216px");
  assert.equal(box().children[0].style.color, "#ff2020");
  hideTooltipAtPoint("someone-else");
  assert.equal(shownTitle(), "Кабан");
  hideTooltipAtPoint("world");
  assert.equal(shownTitle(), undefined);
  showTooltipAtPoint("world", { title: "Плохой цвет", titleColor: "red; background: url(x)" }, 0, 0);
  assert.equal(box().children[0].style.color, undefined, "only a #rrggbb colour is written");
  hideTooltip();
});

// A world card follows every throttled pointer sample. Its size cannot change while its content is
// the same, so a move writes left/top only: a measure after the previous move's style write would
// force a synchronous layout of the whole page on each sample.
test("the cursor mode moves an unchanged card without measuring it again", () => {
  cold();
  const card = { title: "Кабан", cursor: true };
  showTooltipAtPoint("world", card, 100, 200);
  const element = box();
  let measured = 0;
  const original = element.getBoundingClientRect;
  element.getBoundingClientRect = function () { measured += 1; return original.call(this); };
  try {
    showTooltipAtPoint("world", card, 110, 205);
    showTooltipAtPoint("world", card, 1270, 710);
    assert.equal(measured, 0, "moves reuse the size taken when the card was drawn");
    assert.equal(element.style.left, `${1270 - 16 - 50}px`, "still flipped at the right edge");
    assert.equal(element.style.top, `${710 - 16 - 30}px`, "and at the bottom edge");
    showTooltipAtPoint("world", { title: "Другой", cursor: true }, 100, 200);
    assert.equal(measured, 1, "new content is measured once");
  } finally {
    element.getBoundingClientRect = original;
    hideTooltip();
  }
});

test("Widgets keeps exporting the tooltip names its panels import", () => {
  for (const name of ["attachTooltip", "hideTooltip", "refreshTooltip", "setTip", "getTip", "showTooltipAtPoint"]) {
    assert.equal(typeof widgets[name], "function", name);
  }
  assert.equal(widgets.setTip, setTip, "one module, not a copy with its own state");
});

test("a tooltip whose owner was rebuilt away goes with the next element the pointer crosses into", () => {
  cold();
  const row = fakeNode("div");
  const label = fakeNode("span");
  row.isConnected = true;
  row.contains = (node) => node === row || node === label;
  setTip(row, "Строка списка");
  row.fire("pointerenter");
  mock.timers.tick(TIP_DELAY_MS);
  fireWindow("pointerover", { target: label });
  assert.equal(shownTitle(), "Строка списка", "moving inside the owner keeps it");
  row.isConnected = false; // the list was rebuilt; no pointerleave ever comes
  fireWindow("pointerover", { target: fakeNode("div") });
  assert.equal(shownTitle(), undefined);
});
