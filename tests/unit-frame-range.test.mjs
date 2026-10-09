import assert from "node:assert/strict";
import test from "node:test";

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {},
    className: "", textContent: "", hidden: true, title: "",
    style: { setProperty() {} },
    listeners: new Map(),
    append(...children) { node.children.push(...children); },
    replaceChildren(...children) { node.children = [...children]; },
    addEventListener(name, handler) { node.listeners.set(name, handler); },
    setAttribute() {},
    classList: {
      add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
      remove(...names) { node.className = node.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
      toggle(name, force) {
        const has = node.className.split(" ").includes(name);
        if ((force === undefined && !has) || force) node.classList.add(name);
        else if ((force === undefined && has) || !force) node.classList.remove(name);
      },
      contains(name) { return node.className.split(" ").includes(name); },
    },
  };
  return node;
}

globalThis.document = { createElement: (tag) => makeNode(tag) };

const { UnitFrame } = await import("../dist/code/browser/ui/UnitFrame.js");
// The reason is the interface's tooltip (4.01), read back with getTip rather than from `title`.
const { getTip } = await import("../dist/code/browser/ui/Widgets.js");

function snapshot() {
  return {
    guid: 2n, name: "Сопартиец", classId: 1, level: 80,
    health: 5000, maxHealth: 8000, power: 100, maxPower: 100, powerType: 0,
    dead: false, online: true, away: false, inGrid: true,
    raidMark: undefined, reaction: undefined,
  };
}

test("an out-of-range member fades with a reason, and coming back clears it", () => {
  const frame = new UnitFrame({ kind: "party", size: "full" });
  frame.show(snapshot(), { outOfRange: true });
  assert.equal(frame.root.hidden, false);
  assert.ok(frame.root.className.split(" ").includes("is-out-of-range"));
  assert.match(getTip(frame.root), /дальности/);
  frame.show(snapshot(), { outOfRange: false });
  assert.ok(!frame.root.className.split(" ").includes("is-out-of-range"));
  assert.equal(getTip(frame.root) ?? "", "");
});

test("an unknown range leaves the frame exactly as it was", () => {
  const frame = new UnitFrame({ kind: "raid", size: "grid" });
  frame.show(snapshot(), {});
  assert.ok(!frame.root.className.split(" ").includes("is-out-of-range"));
  assert.equal(getTip(frame.root) ?? "", "");
});
