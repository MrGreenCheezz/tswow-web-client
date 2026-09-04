import assert from "node:assert/strict";
import test from "node:test";

function fakeDocument() {
  const stats = { created: 0, appended: 0, removed: 0, replaced: 0, attributes: 0, messageAttributes: 0 };
  const doc = {
    stats,
    activeElement: undefined,
    createElement: (tag) => {
      stats.created += 1;
      return make(tag);
    },
    createElementNS: (_namespace, tag) => {
      stats.created += 1;
      return make(tag);
    },
    getElementById: () => undefined,
  };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
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
      classList: {
        add(...names) {
          node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" ");
        },
      },
      addEventListener(name, listener) {
        const current = listeners.get(name) ?? [];
        current.push(listener);
        listeners.set(name, current);
      },
      setAttribute(name, value) {
        if (name === "data-framexml-message-index") node.messageLine = true;
        stats.attributes += 1;
        if (node.messageLine) stats.messageAttributes += 1;
        attributes.set(name, String(value));
      },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        stats.appended += children.length;
        for (const child of children) {
          child.parentElement = node;
          node.children.push(child);
        }
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
      messageLine: false,
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
  assert.ok(chat && element);
  const layer = element.children.find((child) => child.getAttribute("data-framexml-message-layer") === "true");
  assert.ok(layer);
  return { bridge, chat, layer, renderer };
}

test("sequential bounded messages incrementally append and shift without rebuilding", () => {
  const { bridge, chat, layer, renderer } = runtime(128);
  const baseline = { ...document.stats };
  for (let index = 0; index < 1000; index += 1) {
    bridge.AddMessage(chat, `message-${index}`, 1, 0.5, 0, index, false, `access-${index}`);
    renderer.sync();
  }

  assert.equal(document.stats.created - baseline.created, 1000);
  assert.equal(document.stats.appended - baseline.appended, 1000);
  assert.equal(document.stats.removed - baseline.removed, 1000 - 128);
  assert.equal(document.stats.replaced - baseline.replaced, 0);
  assert.equal(document.stats.messageAttributes - baseline.messageAttributes, 3000);
  assert.ok(document.stats.attributes - baseline.attributes < 10000, "attribute work stays linear in new messages");
  assert.equal(layer.children.length, 128);
  assert.deepEqual(
    layer.children.map((line) => line.textContent),
    Array.from({ length: 128 }, (_, index) => `message-${index + 872}`),
  );
  assert.equal(layer.children[0].getAttribute("data-framexml-access-id"), "access-872");
  assert.equal(layer.children[127].getAttribute("data-framexml-line-id"), "999");
  assert.equal(layer.children[0].getAttribute("data-framexml-message-index"), "873");
  assert.equal(layer.children[127].getAttribute("data-framexml-message-index"), "1000");
  renderer.destroy();
});

test("arbitrary message removal and clear use the full replacement fallback", () => {
  const { bridge, chat, layer, renderer } = runtime(4);
  bridge.AddMessage(chat, "keep", 1, 1, 1, 1, false, "keep");
  bridge.AddMessage(chat, "drop-one", 1, 1, 1, 2, false, "drop");
  bridge.AddMessage(chat, "drop-two", 1, 1, 1, 3, false, "drop");
  const beforeRemove = document.stats.replaced;
  bridge.RemoveMessagesByAccessID(chat, "drop");
  assert.equal(document.stats.replaced, beforeRemove + 1);
  assert.deepEqual(layer.children.map((line) => line.textContent), ["keep"]);

  const beforeClear = document.stats.replaced;
  bridge.ClearMessageFrame(chat);
  assert.equal(document.stats.replaced, beforeClear + 1);
  assert.equal(layer.children.length, 0);
  renderer.destroy();
});
