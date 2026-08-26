import assert from "node:assert/strict";
import test from "node:test";

/**
 * A DOM small enough to fit in a test file, so the widget kit is exercised rather than hoped for.
 * It answers only what the kit actually uses; anything it starts using shows up here as a crash
 * rather than as a panel that silently does nothing.
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
      attributes: new Map(),
      setAttribute(name, value) { node.attributes.set(name, String(value)); },
      getAttribute(name) { return node.attributes.get(name) ?? null; },
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        toggle(name, on) { on ? this.add(name) : node.className = node.className.split(" ").filter((c) => c !== name).join(" "); },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...nodes) { for (const child of nodes) child.parentNode = node; node.children.push(...nodes); },
      prepend(...nodes) { for (const child of nodes) child.parentNode = node; node.children.unshift(...nodes); },
      remove() {
        const index = node.parentNode?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parentNode.children.splice(index, 1);
      },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, right: 0 }; },
      closest() { return undefined; },
    };
    return node;
  };
  return { createElement: make, body: make("body") };
}

globalThis.document = fakeDocument();
// `place` nudges a tooltip back inside the window, so there has to be one to be inside of.
globalThis.window = { innerWidth: 1280, innerHeight: 720 };
const { Bar, IconButton, Panel, SlotGrid, attachTooltip, refreshTooltip, usePanelHost } =
  await import("../dist/code/browser/ui/Widgets.js");

test("an action icon keeps its image when a key label is assigned", () => {
  const button = new IconButton({ icon: "/icons/fireball.png" });
  button.setContent({ icon: "/icons/fireball.png", key: "Shift+1" });
  const key = button.root.children.find((child) => child.className === "ui-icon-key");
  assert.equal(key?.textContent, "Shift+1");
  assert.equal(button.root.children.some((child) => child.tagName === "IMG"), true);
  assert.equal(button.root.children.some((child) => child.className === "ui-icon-sweep"), true);
});

test("a bar writes its fill as a width and its own text", () => {
  const bar = new Bar({ kind: "health", text: true });
  // The third class is not decoration: the stylesheet cannot see inside a bar, so a bar that holds
  // a number has to say so, and `.ui-bar-text` is what carries the minimum height for one.
  assert.equal(bar.root.className, "ui-bar ui-bar-health ui-bar-text");
  assert.equal(new Bar({ kind: "health" }).root.className, "ui-bar ui-bar-health");

  bar.set(45, 90);
  const [fill, label] = bar.root.children;
  assert.equal(fill.style.width, "50%");
  assert.equal(label.textContent, "45/90");

  bar.set(45, 90, "45 / 90 опыта");
  assert.equal(label.textContent, "45 / 90 опыта");

  // An unknown value empties the bar instead of writing "NaN%" into the stylesheet.
  bar.set(undefined, undefined);
  assert.equal(fill.style.width, "0%");

  bar.setVariant("1");
  assert.equal(fill.dataset.variant, "1");
  bar.setVariant(undefined);
  assert.equal(fill.dataset.variant, undefined);
});

test("a slot grid renders what it is given and numbers its slots", () => {
  const grid = new SlotGrid({ columns: 4 });
  grid.render([
    { icon: "/icons/1.png", count: 20, quality: 3, title: "Кинжал" },
    { empty: true },
    { label: "?", count: 1 },
  ]);

  const [first, second, third] = grid.root.children;
  assert.equal(grid.root.children.length, 3);
  assert.equal(first.dataset.slot, "0");
  assert.equal(first.dataset.quality, "3");
  assert.equal(first.title, "Кинжал");
  assert.equal(first.getAttribute("aria-label"), "Кинжал");
  assert.equal(first.children.at(-1).textContent, "20");
  assert.ok(second.classList.contains("ui-slot-empty"));
  assert.equal(second.dataset.slot, "1");
  // One of something carries no badge, so the icon is not covered for nothing.
  assert.equal(third.children.length, 1);
  assert.equal(third.children[0].textContent, "?");

  // Rendering again replaces the slots rather than appending another row of them.
  grid.render([{ empty: true }]);
  assert.equal(grid.root.children.length, 1);
});

test("Л2 a slot with a real tooltip still has a name a screen reader can read", () => {
  // The guild bank is the one caller that passes both a `title` and a `tooltip`
  // (`GuildBankModel.ts:87` and `GuildBank.ts:174`), and a filled slot's only children are an
  // `<img alt="">` and the stack badge — so when `title` stopped being written the button's
  // accessible name became «20», or nothing at all for a single item.
  const grid = new SlotGrid();
  grid.render([
    { icon: "/icons/cloth.png", count: 20, quality: 2, title: "Мифриловый слиток", tooltip: () => ({ title: "Мифриловый слиток" }) },
    { icon: "/icons/one.png", title: "Ткань Пустоты", tooltip: () => ({ title: "Ткань Пустоты" }) },
  ]);

  const [stack, single] = grid.root.children;
  assert.equal(stack.getAttribute("aria-label"), "Мифриловый слиток");
  assert.equal(single.getAttribute("aria-label"), "Ткань Пустоты");
  assert.equal(stack.children.at(-1).textContent, "20", "the badge is still the only text in there");
  // The browser's own tooltip stays off when there is a real one, which is why the name had to
  // move to `aria-label` rather than back to `title`.
  assert.equal(stack.title, undefined);
});

test("Л2 a tooltip already on screen is rebuilt when a late answer lands", () => {
  // An item's spell rows are asked for at the moment the tooltip is built, so the name always
  // arrives after it is up; without a redraw the line keeps its number until the pointer leaves.
  let name = undefined;
  const target = document.createElement("button");
  attachTooltip(target, () => ({ title: "Камень возвращения", lines: [`Использование: ${name ?? "Заклинание 8690"}`] }));

  const shown = () => document.body.children.at(-1);
  refreshTooltip();
  assert.equal(shown(), undefined, "nothing is on screen, so there is nothing to redraw");

  target.listeners.get("pointerenter")();
  assert.equal(shown().children[1].textContent, "Использование: Заклинание 8690");

  name = "Возвращение";
  refreshTooltip();
  assert.equal(shown().children[1].textContent, "Использование: Возвращение");
  assert.equal(shown().hidden, false);

  // Once the pointer has left there is nothing to redraw, and a late answer must not put the
  // tooltip back on screen over whatever the cursor is on now.
  target.listeners.get("pointerleave")();
  name = "Что-то ещё";
  refreshTooltip();
  assert.equal(shown().hidden, true);
  assert.equal(shown().children[1].textContent, "Использование: Возвращение");
});

test("a panel builds its own window and joins the layout", () => {
  const attached = [];
  const viewport = document.createElement("div");
  usePanelHost({ viewport, attach: (element) => attached.push(element) });

  const panel = new Panel({ id: "test-panel", title: "Проверка" });
  assert.equal(panel.root.id, "test-panel");
  assert.equal(panel.root.className, "game-window");
  assert.equal(panel.visible, false, "a new panel does not appear until it is opened");
  assert.deepEqual(attached, [panel.root], "the layout has to know about it, or it will not drag");
  assert.equal(viewport.children.length, 1);

  const [header, body] = panel.root.children;
  assert.equal(header.children[0].textContent, "Проверка");
  assert.equal(body, panel.body);

  panel.toggle();
  assert.equal(panel.visible, true);
  panel.title = "Другое имя";
  assert.equal(header.children[0].textContent, "Другое имя");

  // The close button hides the panel and tells whoever asked to be told.
  let closed = 0;
  const withClose = new Panel({ id: "closable", title: "X", onClose: () => closed++ });
  withClose.show();
  withClose.root.children[0].children[1].listeners.get("click")();
  assert.equal(withClose.visible, false);
  assert.equal(closed, 1);
});
