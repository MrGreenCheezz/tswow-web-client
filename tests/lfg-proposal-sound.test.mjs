import assert from "node:assert/strict";
import test from "node:test";

// G6: the dungeon invitation arrives with the original client's ready-check sound — once per
// invitation, never per repaint.

function makeNode(tag, id) {
  const node = {
    tagName: String(tag).toUpperCase(), id: id ?? "", children: [], dataset: {},
    className: "", textContent: "", hidden: false, tabIndex: -1, value: "", checked: false,
    listeners: new Map(), attributes: new Map(), style: {},
    append(...children) { for (const child of children) { child.parentNode = node; node.children.push(child); } },
    replaceChildren(...children) { node.children = [...children]; for (const child of children) child.parentNode = node; },
    remove() {},
    insertBefore(child, before) {
      child.parentNode = node;
      const at = before ? node.children.indexOf(before) : -1;
      if (at < 0) node.children.push(child);
      else node.children.splice(at, 0, child);
    },
    addEventListener(name, handler) { node.listeners.set(name, handler); },
    setAttribute(name, value) { node.attributes.set(name, String(value)); },
    getAttribute(name) { return node.attributes.get(name) ?? null; },
    classList: {
      add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
      contains(name) { return node.className.split(" ").includes(name); },
    },
    querySelector() { return makeNode("button"); },
  };
  return node;
}

function fakeDocument() {
  const byId = new Map();
  return {
    createElement: (tag) => makeNode(tag),
    body: makeNode("body"),
    documentElement: makeNode("html"),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeNode("div", id));
      return byId.get(id);
    },
    querySelectorAll: () => [],
    __byId: byId,
  };
}

globalThis.document = fakeDocument();
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const social = await import("../dist/code/browser/ui/Social.js");

const proposal = (tag) => ({
  tag,
  dungeonEntry: (6 << 24) | 258,
  players: [{ self: true, answered: false, accepted: false, roles: 8 }],
});

function fakeWorld() {
  return {
    lfgProposal: undefined,
    lfgStatus: undefined,
    lfgQueue: undefined,
    lfgMessage: undefined,
    lfgSearching: false,
    lfgRolesChosen: new Set(),
    lfgPlayerInfo: { dungeons: [], locks: [] },
    state: { selfGuid: 1n, objects: new Map() },
    itemTemplate: () => undefined,
    requestDungeonLocks() {},
  };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test("the invitation chimes once, and the next invitation chimes again", async () => {
  const played = [];
  game.sound = { play: (kit) => played.push(kit.name) };
  game.soundKits = { named: (name) => (name === "ReadyCheck" ? 77 : undefined), kit: (id) => ({ id, name: "ReadyCheck" }) };
  game.spells = new Map();
  const world = fakeWorld();
  game.world = world;
  try {
    world.lfgProposal = proposal("first");
    social.showLfg();
    assert.deepEqual(played, ["ReadyCheck"], "the invitation announces itself");

    social.showLfg();
    social.showLfg();
    assert.deepEqual(played, ["ReadyCheck"], "repaints of the same invitation stay silent");

    world.lfgProposal = undefined;
    social.showLfg();
    assert.deepEqual(played, ["ReadyCheck"], "the prompt going away is not an invitation");
    // The interface throttles its own noises inside 120 ms; the next invitation is a later moment.
    await sleep(150);
    world.lfgProposal = proposal("second");
    social.showLfg();
    assert.deepEqual(played, ["ReadyCheck", "ReadyCheck"], "a new invitation chimes again");
  } finally {
    game.world = undefined;
    game.sound = undefined;
    game.soundKits = undefined;
  }
});
