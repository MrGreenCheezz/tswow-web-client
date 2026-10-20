import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 2 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-parent-name.test.mjs
{
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");

test("$parent names use the nearest named ancestor while relativeTo=$parent stays immediate", () => {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Frame name="NamedParent">
      <Frame name="NamedChild">
        <Texture name="$parentDirectTexture"/>
      </Frame>
      <Frames>
        <Frame>
          <Scripts><OnLoad>
            AnonymousName = self:GetName()
            ImmediateParentName = self:GetParent():GetName()
          </OnLoad></Scripts>
          <Texture name="$parentFoo"/>
          <Frame name="$parentAnchored">
            <Anchors>
              <Anchor point="TOPLEFT" relativeTo="$parent"/>
              <Anchor point="TOPRIGHT" relativeTo="$parentFoo"/>
            </Anchors>
          </Frame>
        </Frame>
      </Frames>
    </Frame>
  </Ui>`);

  assert.equal(loaded.ok, true, loaded.diagnostics?.map((entry) => entry.message).join(" | "));

  const namedParent = bridge.getFrame("NamedParent");
  const namedChild = bridge.getFrame("NamedChild");
  const directTexture = bridge.getFrame("NamedChildDirectTexture");
  const nestedTexture = bridge.getFrame("NamedParentFoo");
  const anchored = bridge.getFrame("NamedParentAnchored");
  assert.ok(namedParent && namedChild && directTexture && nestedTexture && anchored);

  assert.equal(directTexture.parent, namedChild, "a direct named parent still expands $parent");
  assert.equal(nestedTexture.parent?.named, false, "the $parentFoo owner is an anonymous wrapper");
  assert.equal(nestedTexture.parent?.parent, namedParent);
  assert.equal(vm.getGlobal("AnonymousName"), undefined, "anonymous GetName() remains nil");
  assert.equal(vm.getGlobal("ImmediateParentName"), "NamedParent");

  assert.equal(anchored.parent?.named, false, "anchored child remains under anonymous wrapper");
  assert.equal(anchored.points.length, 2);
  assert.equal(anchored.points[0]?.relativeTo, anchored.parent,
    "relativeTo=$parent resolves the immediate layout parent");
  assert.notEqual(anchored.points[0]?.relativeTo, namedParent,
    "relativeTo=$parent must not use the nearest named ancestor");
  assert.equal(anchored.points[1]?.relativeTo, nestedTexture,
    "relativeTo=$parentFoo resolves through the nearest named ancestor");
  vm.close();
});
}

// ── framexml-parent-reparent.test.mjs
{
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
}
