import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_, tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const node = {
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parentElement: undefined,
      style: {
        setProperty(name, value) { this[name] = String(value); },
        removeProperty(name) { delete this[name]; delete this[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; },
      },
      dataset: {}, className: "", hidden: false, textContent: "",
      classList: { add(...names) { node.className += names.join(" "); } },
      addEventListener() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
      remove() { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node); },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

async function fixture(xml, render = false) {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Animations.xml",
    "interface/framexml/animations.xml": "<Ui>" + xml + "</Ui>",
  }) });
  const inventory = await boot.load();
  assert.equal(inventory.errors.length, 0, JSON.stringify(inventory.errors));
  const renderer = render
    ? new FrameXmlDomRenderer(fakeDocument().createElement("section"), { bridge: boot.bridge })
    : undefined;
  renderer?.mount(boot.roots);
  return {
    boot,
    run(source) {
      const result = boot.vm.execute(source, "@animation-transform-test");
      assert.equal(result.ok, true, result.error);
    },
    frame(name) { return boot.bridge.getFrame(name); },
    element(name) { return renderer?.elementFor(boot.bridge.getFrame(name)); },
    tick(seconds) { boot.bridge.tick(seconds); },
    value(name) { return boot.vm.getGlobal(name); },
    close() { renderer?.destroy(); boot.close(); },
  };
}

function translation(transform) {
  const match = /translate\(([-\d.e+]+)px,\s*([-\d.e+]+)px\)/.exec(transform ?? "");
  return match && [Number(match[1]), Number(match[2])];
}

test("ordered Translation moves the painted region after its first order, without changing anchors or SetScale", async () => {
  const fx = await fixture('<Frame name="Owner" scale=".5" width="100" height="40">'
    + '<Anchors><Anchor point="TOPLEFT"><Offset x="20" y="-10"/></Anchor></Anchors>'
    + '<Animations><AnimationGroup name="Move">'
    + '<Alpha duration="1" order="1" change="-.2"/>'
    + '<Translation offsetX="40" offsetY="-10" duration="2" order="2"/>'
    + '</AnimationGroup></Animations></Frame>', true);
  try {
    const owner = fx.frame("Owner");
    const painted = fx.element("Owner");
    const authoredPoints = [...owner.points];
    assert.equal(painted.style.left, "10px");
    assert.equal(painted.style.top, "5px");
    let geometryWrites = 0;
    for (const key of ["left", "top", "width", "height"]) {
      let value = painted.style[key];
      Object.defineProperty(painted.style, key, {
        configurable: true, get: () => value,
        set(next) { geometryWrites += 1; value = next; },
      });
    }
    fx.run("Move:Play()");
    fx.tick(1);
    assert.equal(owner.animationTransform, undefined, "the second order has not begun");
    fx.tick(1);
    assert.deepEqual(translation(owner.animationTransform), [20, 5], "positive WoW Y is negative CSS Y");
    assert.deepEqual(translation(painted.style.transform), [20, 5]);
    assert.equal(owner.scale, .5);
    assert.deepEqual(owner.points, authoredPoints);
    assert.equal(painted.style.left, "10px");
    assert.equal(painted.style.top, "5px");
    assert.equal(geometryWrites, 0, "animation ticks only change the transform");
    fx.tick(1);
    assert.equal(owner.animationTransform, undefined, "the completed group restores authored geometry");
    assert.equal(painted.style.transform, "translateX(-25%) translateY(-25%) scale(0.5)");
  } finally { fx.close(); }
});

test("Rotation and Scale use their own origins and expose the stock Lua setters", async () => {
  const fx = await fixture('<Frame name="Owner" width="80" height="60">'
    + '<Animations><AnimationGroup name="SpinGrow">'
    + '<Rotation name="Turn" degrees="90" duration="2"><Origin point="TOPLEFT"><Offset><AbsDimension x="5" y="-3"/></Offset></Origin></Rotation>'
    + '<Scale name="Grow" scaleX="2" scaleY=".5" duration="2"><Origin point="BOTTOMRIGHT"/></Scale>'
    + '</AnimationGroup></Animations></Frame>', true);
  try {
    fx.run('TurnDegrees = Turn:GetDegrees(); TurnPoint, TurnX, TurnY = Turn:GetOrigin(); '
      + 'GrowX, GrowY = Grow:GetScale(); SpinGrow:Play()');
    assert.equal(fx.value("TurnDegrees"), 90);
    assert.deepEqual([fx.value("TurnPoint"), fx.value("TurnX"), fx.value("TurnY")], ["TOPLEFT", 5, -3]);
    assert.deepEqual([fx.value("GrowX"), fx.value("GrowY")], [2, .5]);
    fx.tick(1);
    const transform = fx.element("Owner").style.transform;
    assert.match(transform, /translate\(-50%, -50%\) translate\(5px, 3px\) rotate\(/);
    assert.match(transform, /translate\(50%, 50%\) scale\(1\.5, 0\.75\) translate\(-50%, -50%\)/);
    const radians = Number(/rotate\(([-\d.e+]+)rad\)/.exec(transform)?.[1]);
    assert.ok(Math.abs(radians + Math.PI / 4) < 1e-10);
    assert.equal(fx.element("Owner").style.transformOrigin, "50% 50%");
    assert.equal(fx.frame("Owner").scale, 1);
    fx.run('SpinGrow:Stop(); Turn:SetRadians(3.141592653589793); Grow:SetScale(.5, 3); '
      + 'Turn:SetOrigin("RIGHT", 0, 0); SpinGrow:Play(); '
      + 'NewDegrees = Turn:GetDegrees(); NewPoint = Turn:GetOrigin()');
    assert.ok(Math.abs(fx.value("NewDegrees") - 180) < 1e-10);
    assert.equal(fx.value("NewPoint"), "RIGHT");
    fx.tick(1);
    assert.match(fx.frame("Owner").animationTransform, /translate\(50%, 0%\).*rotate\(/);
    assert.match(fx.frame("Owner").animationTransform, /scale\(0\.75, 2(?:\.0)?\)/);
  } finally { fx.close(); }
});

test("a bouncing transform reverses, pauses, and clears on parent Hide before replay", async () => {
  const fx = await fixture('<Frame name="Parent"><Frames><Frame name="Owner" width="50" height="20">'
    + '<Animations><AnimationGroup name="Motion" looping="BOUNCE">'
    + '<Translation offsetX="40" offsetY="0" duration="1"/>'
    + '</AnimationGroup></Animations></Frame></Frames></Frame>');
  try {
    fx.run("Mover = Motion:GetAnimations(); Mover:SetOffset(40, 0); "
      + "OffsetX, OffsetY = Mover:GetOffset(); Motion:Play()");
    assert.deepEqual([fx.value("OffsetX"), fx.value("OffsetY")], [40, 0]);
    fx.tick(.5);
    assert.deepEqual(translation(fx.frame("Owner").animationTransform), [20, 0]);
    fx.tick(.5);
    assert.deepEqual(translation(fx.frame("Owner").animationTransform), [40, 0]);
    fx.tick(.5);
    assert.deepEqual(translation(fx.frame("Owner").animationTransform), [20, 0]);
    fx.run("Motion:Pause()");
    fx.tick(5);
    assert.deepEqual(translation(fx.frame("Owner").animationTransform), [20, 0]);
    fx.run("Parent:Hide(); HiddenStopped = Motion:IsStopped()");
    assert.equal(fx.value("HiddenStopped"), true);
    assert.equal(fx.frame("Owner").animationTransform, undefined);
    fx.run("Parent:Show(); Motion:Play()");
    assert.equal(fx.frame("Owner").animationTransform, undefined);
    fx.tick(.25);
    assert.deepEqual(translation(fx.frame("Owner").animationTransform), [10, 0]);
    fx.run("Owner:StopAnimating()");
    assert.equal(fx.frame("Owner").animationTransform, undefined);
  } finally { fx.close(); }
});

let clientDirectory;
try { clientDirectory = (await import("../tools/paths.mjs")).clientDirectory(); } catch {}

test("the original 3.3.5a AlertFrames Translation declaration moves after its first order", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { openClientArchives } = await import("../tools/mpq.mjs");
  const archives = await openClientArchives(clientDirectory);
  let stockXml;
  try {
    const bytes = await archives.read("Interface/FrameXML/AlertFrames.xml");
    stockXml = bytes && new TextDecoder().decode(bytes);
  } finally { await archives.close(); }
  const declaration = /<Translation\s+offsetX="260"\s+offsetY="0"\s+duration="0\.85"\s+order="2"\s*\/>/.exec(stockXml ?? "")?.[0];
  assert.ok(declaration, "the original achievement alert Translation is present");
  const fx = await fixture('<Frame name="StockShine"><Animations><AnimationGroup name="StockAnim">'
    + '<Alpha change="1" duration=".2" order="1"/>' + declaration
    + '</AnimationGroup></Animations></Frame>');
  try {
    fx.run("StockAnim:Play()");
    fx.tick(.2);
    assert.equal(fx.frame("StockShine").animationTransform, undefined);
    fx.tick(.425);
    assert.deepEqual(translation(fx.frame("StockShine").animationTransform), [130, 0]);
    fx.tick(.425);
    assert.equal(fx.frame("StockShine").animationTransform, undefined);
  } finally { fx.close(); }
});
