import assert from "node:assert/strict";
import test from "node:test";
import {
  FrameXmlAddonLoader,
  loadFrameXmlAddon,
  normalizeFrameXmlAddonPath,
  parseFrameXmlAddonToc,
} from "../dist/code/browser/ui/framexml_compat/FrameXmlAddonLoader.js";

function bundle(overrides = {}) {
  return {
    name: "LoaderAddon",
    toc: "## Interface: 30300\n## Title: Loader test\n# comment\nFolder\\A.XML\nMain.lua\n",
    files: {
      "folder/a.xml": `<Ui><Frame name="BeforeInclude" virtual="true" alpha="0.5"/><Include file="B.xml"/><Frame name="UsesNested" inherits="Nested"/></Ui>`,
      "folder/b.xml": `<Ui><Include file="nested\\C.XML"/><Frame name="UsesBefore" inherits="BeforeInclude"/></Ui>`,
      "folder/nested/c.xml": `<Ui><Frame name="Nested" virtual="true"/><Frame name="IncludedRoot"/> <Script file="Scripts\\Handler.LUA"/></Ui>`,
      "folder/nested/scripts/handler.lua": "return { inert = true }",
      "main.lua": "return true",
      ...overrides.files,
    },
    ...overrides,
  };
}

test("TOC metadata/comments and XML/Lua entries retain source order", () => {
  const parsed = parseFrameXmlAddonToc("\uFEFF## Interface: 30300\n# ignored\n### another comment\nA.XML\n\nB.lua\nreadme.txt\n");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.metadata, { Interface: "30300" });
  assert.deepEqual(parsed.entries, [
    { path: "a.xml", kind: "xml" },
    { path: "b.lua", kind: "lua" },
  ]);
});

test("nested relative Include files load depth-first and share one template registry", () => {
  const result = loadFrameXmlAddon(bundle());
  assert.equal(result.ok, true, result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  assert.deepEqual(result.xmlFiles, ["folder/nested/c.xml", "folder/b.xml", "folder/a.xml"]);
  assert.deepEqual(result.luaChunks.map((chunk) => [chunk.path, chunk.origin]), [
    ["folder/nested/scripts/handler.lua", "script"],
    ["main.lua", "toc"],
  ]);
  assert.equal(result.bridge.registry.get("BeforeInclude")?.name, "BeforeInclude");
  assert.equal(result.bridge.getFrame("UsesBefore")?.attributes.alpha, "0.5");
  assert.equal(result.bridge.getFrame("UsesNested")?.name, "UsesNested");
  assert.deepEqual(result.roots.map((root) => root.name), ["IncludedRoot", "UsesBefore", "UsesNested"]);
});

test("an included template keeps source-order precedence over a parent declaration before it", () => {
  const result = loadFrameXmlAddon({
    name: "OrderedAddon",
    toc: "A.xml",
    files: {
      "A.xml": `<Ui><Frame name="X" virtual="true" alpha="a"/><Include file="B.xml"/><Frame name="Uses" inherits="X"/></Ui>`,
      "B.xml": `<Ui><Frame name="X" virtual="true" alpha="b"/></Ui>`,
    },
  });
  assert.equal(result.ok, true, result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  assert.equal(result.bridge.getFrame("Uses")?.attributes.alpha, "b");
});

test("Script file source is inert and never receives a runtime evaluator", () => {
  const result = new FrameXmlAddonLoader().loadAddon({
    name: "InertAddon",
    toc: "A.xml",
    files: {
      "A.xml": `<Ui><Script file="Code.lua"/><Frame name="Root"/></Ui>`,
      "code.lua": "throw new Error('must not execute')",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.luaChunks.length, 1);
  assert.equal(result.luaChunks[0].source, "throw new Error('must not execute')");
});

test("missing, cycle, traversal and bounded expansion diagnostics include addon/file context", () => {
  const result = loadFrameXmlAddon({
    name: "SafeAddon",
    toc: "A.xml",
    files: {
      "A.xml": `<Ui><Include file="B.xml"/><Include file="../escape.xml"/><Include file="Missing.xml"/></Ui>`,
      "B.xml": `<Ui><Include file="A.xml"/></Ui>`,
    },
  }, { limits: { maxDepth: 4 } });
  assert.equal(result.ok, false);
  const text = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
  assert.match(text, /\[SafeAddon\/b\.xml\].*cycle/i);
  assert.match(text, /\[SafeAddon\/a\.xml\].*traversal/i);
  assert.match(text, /\[SafeAddon\/a\.xml\].*missing/i);
});

test("an unsupported XML root cannot register a template for a later TOC file", () => {
  const result = loadFrameXmlAddon({
    name: "IsolatedAddon",
    toc: "Bad.xml\nLater.xml",
    files: {
      "Bad.xml": `<Bad><Frame name="Poison" virtual="true" alpha="0.1"/></Bad>`,
      "Later.xml": `<Ui><Frame name="ShouldNotBuild" inherits="Poison"/></Ui>`,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.bridge.registry.get("Poison"), undefined);
  assert.equal(result.bridge.getFrame("ShouldNotBuild"), undefined);
});

test("path normalization rejects absolute, URL, traversal and encoded traversal names", () => {
  assert.deepEqual(normalizeFrameXmlAddonPath("Folder\\UI.XML"), { path: "folder/ui.xml" });
  for (const path of ["/UI.xml", "//host/UI.xml", "https://host/UI.xml", "C:\\UI.xml", "../UI.xml", "Folder/%2e%2e/UI.xml"]) {
    assert.equal("error" in normalizeFrameXmlAddonPath(path), true, path);
  }
});

test("loader bounds resource count, source bytes, include depth and expanded operations", () => {
  const base = {
    name: "BoundedAddon",
    toc: "A.xml",
    files: {
      "A.xml": `<Ui><Include file="B.xml"/></Ui>`,
      "B.xml": "<Ui><Frame name=\"B\"/></Ui>",
      "unused.lua": "return true",
    },
  };
  assert.match(loadFrameXmlAddon(base, { limits: { maxFiles: 2 } }).diagnostics.map((item) => item.message).join(" "), /file limit/);
  assert.match(loadFrameXmlAddon(base, { limits: { maxBytes: 4 } }).diagnostics.map((item) => item.message).join(" "), /byte budget/);
  assert.match(loadFrameXmlAddon(base, { limits: { maxDepth: 0 } }).diagnostics.map((item) => item.message).join(" "), /depth/);
  assert.match(loadFrameXmlAddon(base, { limits: { maxEntries: 1 } }).diagnostics.map((item) => item.message).join(" "), /entry limit/);
});
