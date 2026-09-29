import assert from "node:assert/strict";
import test from "node:test";

// Aura packets arrive for every unit in view, and every one of them — and every metadata batch —
// ran `showAuras`, which rebuilt the player's and the target's icons from scratch. The strips are
// now drawn again only when one of their own inputs changed; the renderer's stealth map, which is
// about everybody, is still recomputed every time.

function fakeDocument() {
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      hidden: false, tabIndex: -1, listeners: new Map(), attributes: new Map(), style: {},
      append(...children) { node.children.push(...children); for (const child of children) child.parentNode = node; },
      prepend(...children) { node.children.unshift(...children); for (const child of children) child.parentNode = node; },
      replaceChildren(...children) { node.children = [...children]; for (const child of children) child.parentNode = node; },
      remove() {},
      addEventListener(name, handler) { node.listeners.set(name, handler); },
      querySelector() { return make("button"); },
      setAttribute(name, value) { node.attributes.set(name, String(value)); node[name] = String(value); },
      getAttribute(name) { return node.attributes.get(name) ?? null; },
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        contains(name) { return node.className.split(" ").includes(name); },
        toggle(name, enabled) { enabled ? this.add(name) : node.className = node.className.split(" ").filter((item) => item !== name).join(" "); },
      },
      getBoundingClientRect() { return { left: 0, top: 0, bottom: 20, width: 40, height: 40, right: 40 }; },
    };
    return node;
  };
  return {
    createElement: make,
    body: make("body"),
    documentElement: make("html"),
    getElementById: () => make("div"),
    querySelectorAll: () => [],
  };
}

globalThis.document = fakeDocument();
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };

const { showAuras, updateAuraDurations } = await import("../dist/code/browser/ui/Auras.js");
const { playerAuras, targetAuras } = await import("../dist/code/browser/ui/Dom.js");
const { game } = await import("../dist/code/browser/game/Context.js");

const same = (left, right) => left.length === right.length && left.every((node, index) => node === right[index]);
const spell = (id, name, effectAura = [0, 0, 0]) => ({ id, name, iconId: 0, passive: false, effectAura });

test("a crowd's aura packets leave the player's and the target's icons alone", () => {
  let appearances = 0;
  game.renderer = { setUnitAuraAppearance() { appearances += 1; } };
  game.gatewayOrigin = undefined;
  game.spells = new Map([[101, spell(101, "Щит")], [202, spell(202, "Яд")], [1784, spell(1784, "Незаметность", [16, 0, 0])]]);
  let selfAura = { slot: 0, spellId: 101, flags: 0x10 | 0x08, casterLevel: 80, applications: 1 };
  const targetAura = { slot: 0, spellId: 202, flags: 0x80 | 0x08, casterLevel: 80, applications: 1, expiresAt: 5000 };
  const auras = new Map([[1n, new Map([[0, selfAura]])], [2n, new Map([[0, targetAura]])]]);
  game.world = {
    state: { selfGuid: 1n }, targetGuid: 2n, auras,
    aurasFor(guid) { return [...(auras.get(guid)?.values() ?? [])]; },
  };
  try {
    showAuras();
    const player = [...playerAuras.children];
    const target = [...targetAuras.children];
    assert.equal(player.length, 1);
    assert.equal(target.length, 1);
    const drawnAppearances = appearances;

    // Two hundred neighbours' auras change, one packet each.
    for (let index = 0; index < 200; index += 1) {
      auras.set(BigInt(1000 + index), new Map([[0, { slot: 0, spellId: 1784, flags: 0x10, casterLevel: 1, applications: 1 }]]));
      showAuras();
    }
    assert.ok(same(playerAuras.children, player), "the player's icons were not rebuilt");
    assert.ok(same(targetAuras.children, target), "nor the target's");
    assert.equal(appearances, drawnAppearances + 200, "the stealth map still follows every unit");
    updateAuraDurations(2000);
    assert.equal(target[0].children.at(-1).textContent, "3.0", "the target's timer is still running");

    // The player's own aura changes: that strip, and only that one, is drawn again.
    selfAura = { ...selfAura, applications: 2 };
    auras.set(1n, new Map([[0, selfAura]]));
    showAuras();
    assert.ok(!same(playerAuras.children, player), "the player's strip follows its own aura");
    assert.ok(same(targetAuras.children, target));

    // A metadata row replaced (a batch landing) redraws the strip that shows it.
    game.spells.set(202, spell(202, "Смертельный яд"));
    showAuras();
    assert.ok(!same(targetAuras.children, target), "new metadata redraws the target's icon");
    assert.equal(targetAuras.children[0].attributes.get("aria-label"), "Смертельный яд");

    // A new target is a different strip even with nothing else moving.
    const redrawn = [...targetAuras.children];
    game.world.targetGuid = 1n;
    showAuras();
    assert.ok(!same(targetAuras.children, redrawn));
  } finally {
    game.world = undefined;
    game.renderer = undefined;
    game.spells = new Map();
  }
});
