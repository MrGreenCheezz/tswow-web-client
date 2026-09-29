import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlDomRenderer } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag) };
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
      className: "",
      textContent: "",
      value: "",
      disabled: false,
      classList: { add(...names) { node.className = [...names].join(" "); } },
      addEventListener(name, listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1);
          child.parentElement = node;
          node.children.push(child);
        }
      },
      remove() {
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

function textureSource() {
  const acquired = [];
  const released = [];
  const held = new Map();
  return {
    acquired,
    released,
    acquire(path) {
      acquired.push(path);
      const url = `blob:${path}`;
      held.set(path, url);
      return url;
    },
    peek(path) { return held.get(path); },
    release(path) { released.push(path); },
    acquireEdge() { return undefined; },
    peekEdge() { return undefined; },
    releaseEdge() {},
  };
}

function effectivelyHidden(node) {
  for (let current = node; current; current = current.parentElement) {
    if (current.hidden) return true;
  }
  return false;
}

test("SetParent rehomes an existing DOM subtree and preserves ownership", () => {
  globalThis.document = fakeDocument();
  const bridge = new FrameXmlUiBridge();
  const first = bridge.CreateFrame("Frame", "ReparentFirst");
  const second = bridge.CreateFrame("Frame", "ReparentSecond");
  const child = bridge.CreateFrame("Texture", "ReparentTexture", first);
  assert.ok(first && second && child);
  bridge.SetTexture(child, "reparent-me");

  const textures = textureSource();
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge, textures });
  renderer.mount([first, second]);
  const firstElement = renderer.elementFor(first);
  const secondElement = renderer.elementFor(second);
  const childElement = renderer.elementFor(child);
  assert.ok(firstElement && secondElement && childElement);
  assert.equal(childElement.parentElement, firstElement);
  assert.deepEqual(textures.acquired, ["reparent-me.blp"]);

  bridge.Hide(second);
  const acquiredBeforeMove = [...textures.acquired];
  const releasedBeforeMove = [...textures.released];
  assert.equal(secondElement.hidden, true);

  assert.equal(bridge.SetParent(child, second), true);
  assert.equal(child.parent, second);
  assert.equal(first.children.includes(child), false);
  assert.equal(second.children.includes(child), true);
  assert.equal(childElement.parentElement, secondElement);
  assert.equal(effectivelyHidden(childElement), true);
  assert.deepEqual(textures.acquired, acquiredBeforeMove);
  assert.deepEqual(textures.released, releasedBeforeMove);

  assert.equal(bridge.SetParent(child, first), true);
  assert.equal(child.parent, first);
  assert.equal(childElement.parentElement, firstElement);
  assert.equal(effectivelyHidden(childElement), false);
  assert.deepEqual(textures.acquired, acquiredBeforeMove);
  assert.deepEqual(textures.released, releasedBeforeMove);

  assert.equal(bridge.SetParent(child, undefined), true);
  assert.equal(child.parent, undefined);
  assert.equal(childElement.parentElement, host);
  assert.equal(first.children.includes(child), false);
  assert.deepEqual(textures.acquired, acquiredBeforeMove);
  assert.deepEqual(textures.released, releasedBeforeMove);

  renderer.destroy();
  assert.deepEqual(textures.released, ["reparent-me.blp"]);
});

test("SetParent rejects foreign, self, and cyclic targets without mutation", () => {
  const bridge = new FrameXmlUiBridge();
  const root = bridge.CreateFrame("Frame", "ParentGuardRoot");
  const child = bridge.CreateFrame("Frame", "ParentGuardChild", root);
  const foreign = new FrameXmlUiBridge().CreateFrame("Frame", "Foreign");
  assert.ok(root && child && foreign);
  assert.equal(bridge.SetParent(child, foreign), false);
  assert.equal(child.parent, root);
  assert.equal(bridge.SetParent(root, child), false);
  assert.equal(root.parent, undefined);
  assert.equal(bridge.SetParent(child, child), false);
  assert.equal(child.parent, root);
});
