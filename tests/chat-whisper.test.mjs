import assert from "node:assert/strict";
import test from "node:test";

function makeNode(tag, id) {
  const node = {
    tagName: String(tag).toUpperCase(), id: id ?? "", children: [], dataset: {},
    className: "", textContent: "", hidden: false, tabIndex: -1, value: "", checked: false,
    listeners: new Map(), attributes: new Map(), style: {},
    append(...children) { for (const child of children) { child.parentNode = node; node.children.push(child); } },
    replaceChildren(...children) { node.children = [...children]; for (const child of children) child.parentNode = node; },
    remove() {},
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
    createTextNode: (text) => ({ textContent: text }),
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
const dock = await import("../dist/code/browser/ui/ChatDock.js");

function playerMessage(overrides = {}) {
  return {
    type: 1, language: 0, senderGuid: 2n, senderName: "", receiverGuid: 0n,
    receiverName: "", channel: "", text: "привет", tag: 0, achievementId: 0, ...overrides,
  };
}

function fakeWorld(objects) {
  return {
    state: { selfGuid: 1n, objects },
    displayName: (guid) => (guid === 2n ? "Маг" : `0x${guid.toString(16)}`),
  };
}

function senders(line) {
  const walk = (node, out = []) => {
    out.push(node);
    for (const child of node.children ?? []) walk(child, out);
    return out;
  };
  return walk(line).filter((node) => node.className === "chat-sender");
}

test("a player sender is clickable and drafts a whisper", () => {
  game.world = fakeWorld(new Map([[2n, { guid: 2n, typeId: 4 }]]));
  try {
    assert.equal(dock.whisperTarget(playerMessage()), "Маг");
    const line = dock.renderChatLine(playerMessage());
    const [sender] = senders(line);
    assert.ok(sender, "the name renders as its own node");
    assert.equal(sender.textContent, "Маг");
  } finally {
    game.world = undefined;
  }
});

test("self, creatures and nameless lines stay plain text", () => {
  game.world = fakeWorld(new Map([
    [2n, { guid: 2n, typeId: 4 }],
    [3n, { guid: 3n, typeId: 3 }],
  ]));
  try {
    assert.equal(dock.whisperTarget(playerMessage({ senderGuid: 1n })), undefined, "own echoes");
    assert.equal(dock.whisperTarget(playerMessage({ senderGuid: 3n, senderName: "Кабан" })), undefined, "creatures");
    assert.equal(dock.whisperTarget(playerMessage({ senderGuid: 0n })), undefined, "nameless system lines");
    const line = dock.renderChatLine(playerMessage({ senderGuid: 3n, senderName: "Кабан" }));
    assert.equal(senders(line).length, 0);
  } finally {
    game.world = undefined;
  }
});
