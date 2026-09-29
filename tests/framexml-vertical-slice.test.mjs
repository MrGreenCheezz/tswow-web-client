import assert from "node:assert/strict";
import test from "node:test";
import {
  FrameXmlTemplateRegistry,
  parseFrameXml,
} from "../dist/code/browser/ui/framexml_compat/FrameXmlParser.js";
import { FrameXmlUiBridge } from "../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js";

test("FrameXML parser reads a bounded Ui tree and rejects malformed XML deterministically", () => {
  const parsed = parseFrameXml(`<?xml version="1.0"?>
    <Ui><Frame name="Root"><Size><AbsDimension x="100" y="50"/></Size>
      <FontString name="Title" text="A &amp; B"/>
    </Frame></Ui>`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.root?.name, "Ui");
  assert.equal(parsed.root?.children[0]?.attributes.name, "Root");
  assert.equal(parsed.root?.children[0]?.children[1]?.attributes.text, "A & B");

  const malformed = parseFrameXml("<Ui><Frame></Ui>");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.root, undefined);
  assert.match(malformed.diagnostics.join(" "), /does not match/);

  const dtd = parseFrameXml('<!DOCTYPE Ui SYSTEM "file:///outside.xml"><Ui/>');
  assert.equal(dtd.ok, false);
  assert.equal(dtd.root, undefined);
  assert.match(dtd.diagnostics.join(" "), /DOCTYPE.*not supported/i);

  const unknownEntity = parseFrameXml('<Ui><Frame text="A &unknown;"/></Ui>');
  assert.equal(unknownEntity.ok, false);
  assert.match(unknownEntity.diagnostics.join(" "), /unsupported XML entity/i);

  const cdata = parseFrameXml('<Ui><Frame><![CDATA[A &amp; B]]></Frame></Ui>');
  assert.equal(cdata.ok, true);
  assert.equal(cdata.root?.children[0]?.text, "A &amp; B");
});

test("virtual templates resolve comma-separated inherits transitively in stable order", () => {
  const registry = new FrameXmlTemplateRegistry();
  const result = registry.registerDocument(`<Ui>
    <Frame name="Base" virtual="true" alpha="0.2"><Texture name="BaseTexture" file="base"/></Frame>
    <Frame name="Overlay" virtual="true" alpha="0.7"><FontString name="OverlayText"/></Frame>
    <Button name="Derived" virtual="true" inherits="Base, Overlay" alpha="0.9"/>
    <Frame name="CycleA" virtual="true" inherits="CycleB"/>
    <Frame name="CycleB" virtual="true" inherits="CycleA"/>
  </Ui>`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.templates.map((template) => template.name), ["Base", "Overlay", "Derived", "CycleA", "CycleB"]);
  const resolved = registry.resolve("Derived");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.element?.attributes.alpha, "0.9");
  assert.deepEqual(resolved.element?.children.map((child) => child.name), ["Texture", "FontString"]);
  const cycle = registry.resolve("CycleA");
  assert.equal(cycle.ok, false);
  assert.match(cycle.diagnostics.join(" "), /cycle/i);

  const bridge = new FrameXmlUiBridge(registry);
  const loaded = bridge.loadAddon(`<Ui><Frame name="TemplateOnly" virtual="true"/><Frame inherits="Base"/></Ui>`);
  assert.equal(loaded.roots.length, 1);
  assert.match(loaded.roots[0].name, /^__framexml_/);
  const created = bridge.CreateFrame("Frame", undefined, undefined, "Base");
  assert.ok(created);
  assert.match(created.name, /^__framexml_/);
  const parent = bridge.CreateFrame("Frame", "CreatedParent");
  const child = bridge.CreateFrame("Button", "CreatedChild", parent);
  assert.ok(child);
  assert.equal(parent?.children[0], child);
});

test("nested Size dimensions bind to frame width/height and retain inherited axes", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui>
    <Frame name="SizedBase" virtual="true"><Size><AbsDimension x="100" y="50"/></Size></Frame>
    <Frame name="SizedDerived" inherits="SizedBase"><Size><AbsDimension x="240"/></Size></Frame>
  </Ui>`);
  assert.equal(loaded.roots.length, 1);
  assert.equal(loaded.roots[0].attributes.width, "240");
  assert.equal(loaded.roots[0].attributes.height, "50");
});

test("bridge instantiates supported frame types, declarations and capability API", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui>
    <Button name="CompatButton" hidden="true" inherits="ClickTemplate">
      <Scripts><OnLoad>RegisterEvent(self, "PLAYER_LOGIN")</OnLoad><OnEvent>-- handler</OnEvent></Scripts>
      <Events><Event name="PLAYER_LOGIN"/></Events>
      <Anchors><Anchor point="CENTER"><Offset x="4" y="-2"/></Anchor></Anchors>
      <FontString name="Label"/><Texture name="Icon"/>
    </Button>
  </Ui>`);
  // Unknown template is isolated to this frame; no native HUD mutation occurs.
  assert.equal(loaded.ok, false);
  assert.equal(loaded.nativeHudUnaffected, true);
  assert.equal(loaded.roots.length, 0);
  assert.match(loaded.diagnostics.map((diagnostic) => diagnostic.message).join(" "), /not registered/);

  const healthy = bridge.loadAddon(`<Ui><Button name="CompatButton" hidden="true">
    <Scripts><OnLoad>ignored without an adapter</OnLoad></Scripts><Events><Event name="PLAYER_LOGIN"/></Events>
    <FontString name="Label"/><Texture name="Icon"/></Button></Ui>`);
  assert.equal(healthy.roots.length, 1);
  const button = healthy.roots[0];
  assert.equal(button.type, "Button");
  assert.equal(button.visible, false);
  assert.equal(button.children.map((child) => child.type).join(","), "FontString,Texture");
  assert.equal(button.registeredEvents.has("PLAYER_LOGIN"), true);
  assert.equal(button.loaded, true);
  assert.equal(bridge.Show(button), true);
  assert.equal(button.visible, true);
  assert.equal(bridge.SetText(button.children[0], "Ready"), true);
  assert.equal(button.children[0].text, "Ready");
  assert.equal(bridge.SetTexture(button.children[1], "Interface\\Icons\\Spell"), true);
  assert.equal(button.children[1].texture, "Interface\\Icons\\Spell");
  assert.equal(bridge.SetPoint(button, "TOPLEFT", undefined, "TOPLEFT", 4, -2), true);
  assert.equal(button.points[0].x, 4);
  assert.equal(bridge.dispatchEvent("PLAYER_LOGIN"), 1);
});

test("nested widgets keep their own script declarations when wrapped by Frames", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui><Frame name="Parent"><Scripts><OnLoad>parent</OnLoad></Scripts>
    <Frames><Frame name="Child"><Scripts><OnLoad>child</OnLoad></Scripts></Frame></Frames>
  </Frame></Ui>`);
  assert.equal(loaded.roots.length, 1);
  assert.equal(loaded.roots[0].scriptSources.get("OnLoad"), "parent");
  assert.equal(loaded.roots[0].children[0].scriptSources.get("OnLoad"), "child");
});

test("anchors resolve parent and forward sibling references after the tree is built", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui>
    <Frame name="Parent"><Frames><Frame name="Child"><Anchors>
      <Anchor point="TOPLEFT" relativeTo="$parent"/>
    </Anchors></Frame></Frames></Frame>
    <Frame name="Before"><Anchors><Anchor point="CENTER" relativeTo="After"/></Anchors></Frame>
    <Frame name="After"/>
  </Ui>`);
  const parent = loaded.roots.find((frame) => frame.name === "Parent");
  const child = parent?.children[0];
  assert.equal(child?.points[0]?.relativeTo?.name, "Parent");
  const before = loaded.roots.find((frame) => frame.name === "Before");
  assert.equal(before?.points[0]?.relativeTo?.name, "After");
});

test("a broken template is isolated to its frame while a sibling still loads", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon(`<Ui>
    <Frame name="Broken" inherits="MissingTemplate"/>
    <Frame name="Healthy"><Button name="ChildButton"/></Frame>
  </Ui>`);
  assert.equal(loaded.nativeHudUnaffected, true);
  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.roots.map((frame) => frame.name), ["Healthy"]);
  assert.equal(loaded.roots[0].children[0].type, "Button");
  assert.match(loaded.diagnostics.map((diagnostic) => diagnostic.message).join(" "), /MissingTemplate/);
});

test("malformed documents with a recoverable root are not instantiated", () => {
  const bridge = new FrameXmlUiBridge();
  const loaded = bridge.loadAddon("noise<Frame name=\"ShouldNotLoad\"/>");
  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.roots, []);
  assert.equal(bridge.getFrame("ShouldNotLoad")?.name, undefined);
  assert.match(loaded.diagnostics.map((diagnostic) => diagnostic.message).join(" "), /usable root/);
});

test("rejected roots cannot register templates for a later addon", () => {
  const bridge = new FrameXmlUiBridge();
  const rejected = bridge.loadAddon(`<Bad><Frame name="Poison" virtual="true"/></Bad>`);
  assert.equal(rejected.ok, false);
  assert.equal(bridge.registry.get("Poison"), undefined);
  const later = bridge.loadAddon(`<Ui><Frame name="UsesPoison" inherits="Poison"/></Ui>`);
  assert.equal(later.ok, false);
  assert.deepEqual(later.roots, []);
});

test("Lua scripts stay behind explicit runtime adapter and callback events are isolated", () => {
  const calls = [];
  const bridge = new FrameXmlUiBridge(undefined, {
    runtime: {
      name: "test-sandbox",
      luaVersion: "5.1-compatible adapter",
      execute(source, context) {
        calls.push({ source, event: context.event, frame: context.frame.name });
        context.ui.SetText(context.frame, context.event ?? "loaded");
      },
    },
  });
  const loaded = bridge.loadAddon(`<Ui><Frame name="EventsFrame"><Scripts>
    <OnLoad>self:SetText("loaded")</OnLoad><OnEvent>self:SetText(event)</OnEvent>
  </Scripts><Events><Event name="PLAYER_LOGIN"/></Events></Frame></Ui>`);
  const frame = loaded.roots[0];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, undefined);
  assert.equal(frame.text, "loaded");
  assert.equal(bridge.dispatchEvent("PLAYER_LOGIN", 123), 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].event, "PLAYER_LOGIN");
  assert.equal(frame.text, "PLAYER_LOGIN");
});

test("SetScript replaces the XML handler and nil unregisters it", () => {
  const calls = [];
  const bridge = new FrameXmlUiBridge(undefined, {
    runtime: {
      name: "test-sandbox",
      luaVersion: "5.1-compatible adapter",
      execute(source) {
        calls.push(`lua:${source}`);
      },
    },
  });
  const loaded = bridge.loadAddon(`<Ui><Frame name="ScriptFrame"><Scripts>
    <OnEvent>xml-handler</OnEvent>
  </Scripts><Events><Event name="PLAYER_LOGIN"/></Events></Frame></Ui>`);
  const frame = loaded.roots[0];
  assert.equal(bridge.SetScript(frame, "OnEvent", () => calls.push("callback")), true);
  bridge.dispatchEvent("PLAYER_LOGIN");
  assert.deepEqual(calls, ["callback"]);
  assert.equal(bridge.SetScript(frame, "OnEvent", null), true);
  bridge.dispatchEvent("PLAYER_LOGIN");
  assert.deepEqual(calls, ["callback"]);
});
