import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The micro buttons' hints from the binding table (ui/HudKeys.ts, WORK_PLAN 4.10): the stock
// MicroButtonTooltipText shape, the hint in the interface's tooltip instead of `title`, the
// W3C `aria-keyshortcuts`, and a rebinding reaching the button without a reload.
function element(id, attributes = {}) {
  const map = new Map(Object.entries(attributes));
  return {
    id, listeners: [],
    getAttribute: (name) => map.get(name) ?? null,
    setAttribute: (name, value) => map.set(name, String(value)),
    removeAttribute: (name) => map.delete(name),
    hasAttribute: (name) => map.has(name),
    addEventListener(type, listener) { this.listeners.push(type); },
  };
}

const { setStringSource } = await import("../dist/code/browser/ui/Strings.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const { getTip } = await import("../dist/code/browser/ui/Tooltip.js");
const hud = await import("../dist/code/browser/ui/HudKeys.js");

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, String(value)) };
}

function page() {
  const elements = new Map(hud.MICRO_BUTTONS.map((button) => [button.id, element(button.id, {
    title: "старая подсказка", "aria-keyshortcuts": "C", "aria-label": "старое имя",
  })]));
  return { elements, doc: { getElementById: (id) => elements.get(id) ?? null } };
}

test("each micro button says its name and its bound key, in the tooltip, never in title", () => {
  bindings.useBindingStorage(memoryStorage());
  setStringSource((key) => ({ CHARACTER_BUTTON: "Информация о персонаже", MAINMENU_BUTTON: "Главное меню" })[key]);
  try {
    const { elements, doc } = page();
    hud.refreshMicroButtons(doc);
    const character = elements.get("character-toggle");
    assert.equal(character.getAttribute("title"), null, "the browser's hint is gone");
    assert.equal(getTip(character), "Информация о персонаже (C)", "MicroButtonTooltipText: the name, the key in brackets");
    assert.equal(character.getAttribute("aria-keyshortcuts"), "C");
    assert.equal(character.getAttribute("aria-label"), "Информация о персонаже");
    assert.equal(getTip(elements.get("inventory-toggle")), "Инвентарь (B)", "no stock name: the native word");
    assert.equal(getTip(elements.get("calendar-toggle")), "Календарь", "no key: no brackets");
    assert.equal(elements.get("calendar-toggle").getAttribute("aria-keyshortcuts"), null);
    assert.equal(getTip(elements.get("social-toggle")), "Общение", "TOGGLESOCIAL ships unbound here (O is held, 0.4g)");
    assert.equal(getTip(elements.get("game-menu-toggle")), "Главное меню (Esc)");
    assert.equal(elements.get("game-menu-toggle").getAttribute("aria-keyshortcuts"), "Escape");
  } finally {
    setStringSource(undefined);
  }
});

test("a rebinding reaches the buttons through the table's change notice", () => {
  bindings.useBindingStorage(memoryStorage());
  setStringSource(() => undefined);
  try {
    const { elements, doc } = page();
    hud.installHudKeys(doc);
    bindings.bindKey("toggleCharacter", 0, "KeyU");
    const character = elements.get("character-toggle");
    assert.equal(getTip(character), "Персонаж (U)");
    assert.equal(character.getAttribute("aria-keyshortcuts"), "U");
    bindings.bindKey("toggleCharacter", 0, "Ctrl+Shift+KeyF");
    assert.equal(character.getAttribute("aria-keyshortcuts"), "Control+Shift+F");
    bindings.bindKey("toggleCharacter", 0, "");
    assert.equal(getTip(character), "Персонаж");
    assert.equal(character.getAttribute("aria-keyshortcuts"), null);
  } finally {
    setStringSource(undefined);
  }
});

test("the W3C key form", () => {
  assert.equal(hud.ariaKeyShortcut("Shift+KeyB"), "Shift+B");
  assert.equal(hud.ariaKeyShortcut("Digit1"), "1");
  assert.equal(hud.ariaKeyShortcut("F2"), "F2");
  assert.equal(hud.ariaKeyShortcut("Alt+KeyZ"), "Alt+Z");
  assert.equal(hud.ariaKeyShortcut(""), "");
});

test("every micro button of the page markup is one HudKeys keeps", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const button of hud.MICRO_BUTTONS) assert.match(html, new RegExp(`id="${button.id}"`), button.id);
});
