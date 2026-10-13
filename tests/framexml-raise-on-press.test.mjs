import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

// Plan item 3.48 (13.10): the raise Wow.exe 3.3.5a 12340 runs on a press and on Frame:Raise() — 0x0048e9a0 →
// CSimpleTop 0x004951a0(frame, 1): the frame if toplevel, else its nearest toplevel ancestor, else nothing; to the
// top of its strata only when a frame of its strata at its level or above, not its own descendant, overlaps it
// (0x00494d20). The UI root's mouse-down (0x00495470) runs it on the frame that took the press, before the title
// region and OnMouseDown.

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_namespace, tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    const node = {
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined, attributes, style,
      dataset: {}, hidden: false, className: "", src: "", textContent: "", value: "", disabled: false,
      classList: { add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); } },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
      insertBefore(child, reference) {
        child.parentElement = node;
        const index = node.children.indexOf(reference);
        if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
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

globalThis.document ??= fakeDocument();

const WINDOWS = `
  UIParent = CreateFrame("Frame", "UIParent")
  UIParent:SetSize(1248, 768)
  local function window(name, level, x, y, toplevel)
    local frame = CreateFrame("Frame", name, UIParent)
    frame:SetSize(200, 200)
    frame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", x, -y)
    frame:SetFrameLevel(level)
    frame:SetToplevel(toplevel)
    frame:EnableMouse(true)
    return frame
  end
  A = window("A", 1, 0, 0, true)
  B = window("B", 5, 100, 100, true)    -- overlaps A
  C = window("C", 2, 600, 0, true)      -- overlaps nothing but its own child
  CChild = CreateFrame("Frame", "CChild", C)
  CChild:SetAllPoints(C)
  CChild:SetFrameLevel(8)
  D = window("D", 1, 50, 50, false)     -- not toplevel, overlaps A and B
  Ghost = window("Ghost", 3, 650, 50, false) -- over C, hidden
  Ghost:Hide()
  Low = window("Low", 1, 0, 300, true)  -- under A, touching B's bottom edge
  Far = window("Far", 7, 0, 520, true)  -- in Low's columns, below it
  Inner = CreateFrame("Button", "Inner", A)
  Inner:SetSize(20, 20)
  Inner:SetPoint("TOPLEFT", A, "TOPLEFT", 10, -10)
  Inner:SetFrameLevel(9)
  Seen = nil
  Inner:SetScript("OnMouseDown", function() Seen = A:GetFrameLevel() end)
`;

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "raise", []);
  assert.ok(fn, code);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

async function booted() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Windows.lua",
      "interface/framexml/windows.lua": WINDOWS,
    }), subset: ["Windows.lua"], exercise: false,
  });
  await boot.load();
  return boot;
}

const levels = (boot) => lua(boot, "return A:GetFrameLevel(), B:GetFrameLevel(), C:GetFrameLevel(), D:GetFrameLevel()", 4);

test("Raise: a toplevel frame goes to the top of its strata only when something overlaps it", async () => {
  const boot = await booted();
  try {
    assert.deepEqual(boot.errors, []);
    assert.deepEqual(levels(boot), [1, 5, 2, 1]);
    lua(boot, "C:Raise()", 0);
    assert.deepEqual(levels(boot), [1, 5, 2, 1], "only C's own child and a hidden frame lie over it: neither counts");
    assert.deepEqual(lua(boot, "Low:Raise() return Low:GetFrameLevel()"), [1], "Far shares its columns, not its rows; B only touches it");
    lua(boot, "D:Raise()", 0);
    assert.deepEqual(levels(boot), [1, 5, 2, 1], "D is not toplevel and has no toplevel ancestor: nothing");
    lua(boot, "A:Raise()", 0);
    assert.deepEqual(levels(boot), [10, 5, 2, 1], "above the strata's highest, its own child Inner (9) included");
    lua(boot, "A:Raise()", 0);
    assert.deepEqual(levels(boot), [10, 5, 2, 1], "nothing at its level or above overlaps it now: it stays");
    lua(boot, "B:Raise()", 0);
    assert.deepEqual(levels(boot), [10, 11, 2, 1], "A overlaps B from above");
    lua(boot, "Inner:Raise()", 0);
    assert.deepEqual(levels(boot), [12, 11, 2, 1], "a child raises its toplevel ancestor");
    lua(boot, "B:Hide() A:Raise()", 0);
    assert.deepEqual(levels(boot), [12, 11, 2, 1], "a hidden frame overlaps nothing");
  } finally {
    boot.close();
  }
});

test("a press raises the frame that took it, before its OnMouseDown", async () => {
  const boot = await booted();
  const host = document.createElement("section");
  host.offsetWidth = 1248; host.offsetHeight = 768;
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  try {
    renderer.mount(boot.roots);
    boot.bridge.touch();
    const node = renderer.elementFor(boot.bridge.getFrame("Inner"));
    assert.ok(node);
    const event = { type: "mousedown", clientX: 15, clientY: 15, button: 0, target: node, preventDefault() {}, stopPropagation() {} };
    node.dispatchEvent(event);
    assert.equal(boot.vm.getGlobal("Seen"), 10, "A rose (B overlaps it) before Inner's OnMouseDown ran");
    node.dispatchEvent(event);
    assert.deepEqual(levels(boot), [10, 5, 2, 1], "once per press, whichever listeners it reaches");
    assert.deepEqual(boot.errors, []);
  } finally {
    renderer.destroy?.();
    boot.close();
  }
});
