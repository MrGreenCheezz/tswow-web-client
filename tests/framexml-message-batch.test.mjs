import assert from "node:assert/strict";
import test from "node:test";

// 02.10, plan item 3.01's cost review: a dungeon pull prints 20+ combat-log lines between two frames.
// The renderer syncs once per frame, so those lines reach it as one batch of revisions — and the
// incremental paint only took a single revision, so every such frame rebuilt all 300 lines of
// ChatFrame2 (each a handful of colour/hyperlink spans with five listeners). A batch whose result
// keeps the old lines in order and adds new ones after them is painted as removals at the top and
// appends at the bottom. Also: the sixth AddMessage argument (addToTop, Blizzard_CombatLog.lua:747).

function fakeDocument() {
  const stats = { created: 0, appended: 0, removed: 0, replaced: 0 };
  const doc = {
    stats,
    activeElement: undefined,
    createElement: (tag) => { stats.created += 1; return make(tag); },
    createElementNS: (_namespace, tag) => { stats.created += 1; return make(tag); },
    getElementById: () => undefined,
  };
  function make(tag) {
    const attributes = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    const node = {
      ownerDocument: doc,
      tagName: tag.toUpperCase(),
      children: [],
      parentElement: undefined,
      style,
      hidden: false,
      value: "",
      disabled: false,
      textContent: "",
      scrollTop: 0,
      className: "",
      classList: { add() {} },
      addEventListener() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        stats.appended += children.length;
        for (const child of children) { child.parentElement = node; node.children.push(child); }
      },
      replaceChildren(...children) {
        stats.replaced += 1;
        for (const child of node.children) child.parentElement = undefined;
        node.children = [];
        node.append(...children);
      },
      remove() {
        stats.removed += 1;
        const index = node.parentElement?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parentElement.children.splice(index, 1);
        node.parentElement = undefined;
      },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

globalThis.document = fakeDocument();
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

function find(root, name) {
  if (root.getAttribute("data-framexml-name") === name) return root;
  for (const child of root.children) {
    const result = find(child, name);
    if (result) return result;
  }
  return undefined;
}

function runtime(maxLines) {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><ScrollingMessageFrame name="ChatFrame" maxLines="${maxLines}" width="320" height="64"/></Ui>`);
  assert.equal(loaded.ok, true, loaded.diagnostics.map((entry) => entry.message).join("\n"));
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge });
  renderer.mount(loaded.roots);
  const chat = bridge.getFrame("ChatFrame");
  const element = find(host, "ChatFrame");
  const layer = element.children.find((child) => child.getAttribute("data-framexml-message-layer") === "true");
  assert.ok(chat && layer);
  return { bridge, chat, layer, renderer };
}

const texts = (layer) => layer.children.map((line) => line.textContent);

test("a burst of lines between two syncs appends them without rebuilding the window", () => {
  const { bridge, chat, layer, renderer } = runtime(32);
  for (let index = 0; index < 10; index++) bridge.AddMessage(chat, `old-${index}`);
  renderer.sync();
  const before = { ...document.stats };
  bridge.runInMutationBatch(() => { for (let index = 0; index < 5; index++) bridge.AddMessage(chat, `burst-${index}`); });
  renderer.sync();
  assert.equal(document.stats.replaced - before.replaced, 0, "no full rebuild");
  assert.equal(document.stats.created - before.created, 5);
  assert.deepEqual(texts(layer), [...Array.from({ length: 10 }, (_, i) => `old-${i}`), ...Array.from({ length: 5 }, (_, i) => `burst-${i}`)]);
  renderer.destroy();
});

test("a burst that overflows maxLines drops the oldest lines and appends the new ones", () => {
  const { bridge, chat, layer, renderer } = runtime(8);
  for (let index = 0; index < 8; index++) bridge.AddMessage(chat, `old-${index}`);
  renderer.sync();
  const before = { ...document.stats };
  bridge.runInMutationBatch(() => { for (let index = 0; index < 20; index++) bridge.AddMessage(chat, `burst-${index}`); });
  renderer.sync();
  // Every old line went; the window is the last eight of the burst. 20 created would be the naive
  // append-then-drop; a rebuild is what must not happen.
  assert.equal(document.stats.replaced - before.replaced, 1, "nothing survived: the full path");
  assert.deepEqual(texts(layer), Array.from({ length: 8 }, (_, i) => `burst-${i + 12}`));

  const mid = { ...document.stats };
  bridge.runInMutationBatch(() => { for (let index = 0; index < 3; index++) bridge.AddMessage(chat, `more-${index}`); });
  renderer.sync();
  assert.equal(document.stats.replaced - mid.replaced, 0, "five lines survive: incremental");
  assert.equal(document.stats.created - mid.created, 3);
  assert.equal(document.stats.removed - mid.removed, 3);
  assert.deepEqual(texts(layer), [...Array.from({ length: 5 }, (_, i) => `burst-${i + 15}`), "more-0", "more-1", "more-2"]);
  renderer.destroy();
});

test("a batch that removes from the middle still takes the full path", () => {
  const { bridge, chat, layer, renderer } = runtime(8);
  bridge.AddMessage(chat, "a", 1, 1, 1, 1, false, "keep");
  bridge.AddMessage(chat, "b", 1, 1, 1, 2, false, "drop");
  bridge.AddMessage(chat, "c", 1, 1, 1, 3, false, "keep");
  renderer.sync();
  const before = { ...document.stats };
  bridge.runInMutationBatch(() => { bridge.RemoveMessagesByAccessID(chat, "drop"); bridge.AddMessage(chat, "d"); });
  renderer.sync();
  assert.equal(document.stats.replaced - before.replaced, 1);
  assert.deepEqual(texts(layer), ["a", "c", "d"]);
  renderer.destroy();
});

test("AddMessage's sixth argument puts the line at the top, as the combat log refill expects", () => {
  const { bridge, chat, layer, renderer } = runtime(4);
  // Blizzard_CombatLog_RefilterUpdate walks newest → oldest with AddMessage(text, r, g, b, nil, true).
  for (const text of ["newest", "middle", "oldest"]) bridge.AddMessage(chat, text, 1, 1, 1, undefined, true);
  assert.deepEqual(chat.messageFrame.messages.map((m) => m.text), ["oldest", "middle", "newest"]);
  bridge.AddMessage(chat, "live", 1, 1, 1, undefined, false);
  assert.deepEqual(chat.messageFrame.messages.map((m) => m.text), ["oldest", "middle", "newest", "live"]);
  // Full: a line added at the top of a full window is the one that does not fit.
  bridge.AddMessage(chat, "older-still", 1, 1, 1, undefined, true);
  assert.deepEqual(chat.messageFrame.messages.map((m) => m.text), ["oldest", "middle", "newest", "live"]);
  renderer.sync();
  assert.deepEqual(texts(layer), ["oldest", "middle", "newest", "live"]);
  renderer.destroy();
});
