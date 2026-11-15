import assert from "node:assert/strict";
import test from "node:test";

// 3.46 (follow-up, 15.11, lane misc8): GetAddOnInfo's url as Wow.exe reads it on the glue screens — a `## Secure`
// add-on's `Interface\AddOns\<n>\<n>.url`, the text after its first `=` (0x5f86a0 → 0x5f4fb0 → 0x5f4b00, 0x5f74b0) —
// and the one `.url` path the gateway's /client/file serves (gateway/AddonUrlPath.ts).
const { glueAddonUrlFromFile, glueTocSecure } = await import("../dist/code/browser/glue/GlueAddonUrl.js");
const { GlueAddonList } = await import("../dist/code/browser/glue/GlueAddons.js");
const { validClientFilePath } = await import("../dist/code/gateway/Gateway.js");
const { validClientFilePath: generatorValidClientFilePath } = await import("../tools/generate-client-file.mjs");

test("the .url file: the text after the first =, trailing CR/LF/spaces cut (0x5f4b00)", () => {
  assert.equal(glueAddonUrlFromFile("[InternetShortcut]\r\nURL=https://example.test/addon\r\n"), "https://example.test/addon");
  assert.equal(glueAddonUrlFromFile("URL=a=b  \n"), "a=b");
  assert.equal(glueAddonUrlFromFile("no equals sign"), undefined);
  assert.equal(glueAddonUrlFromFile("URL=\r\n"), undefined, "empty: nil (0x5f74b0)");
  assert.equal(glueTocSecure("## Title: X\r\n## Secure: 1\r\n"), true);
  assert.equal(glueTocSecure("## Secure: 0\n"), false);
  assert.equal(glueTocSecure("## Title: X\n"), false);
});

test("GetAddOnInfo's fourth value: a Secure add-on's url, nil for the others (not even asked for)", async () => {
  const tocs = { Signed: "## Interface: 30300\n## Secure: 1\n", Plain: "## Interface: 30300\n" };
  const asked = [];
  const list = new GlueAddonList({
    load: async () => ({ installed: [{ name: "Signed", enabled: true, loadOnDemand: false }, { name: "Plain", enabled: true, loadOnDemand: false }], checkAddonVersion: false }),
    readToc: async (name) => tocs[name],
    readUrl: async (name) => { asked.push(name); return "[InternetShortcut]\r\nURL=https://example.test/signed\r\n"; },
  });
  await list.load();
  const globals = new Map();
  list.install({ registerGlobal: (name, fn) => { globals.set(name, fn); } });
  const info = (index) => globals.get("GetAddOnInfo")([index]);
  const byName = new Map([1, 2].map((index) => [info(index)[0], info(index)]));
  assert.equal(byName.get("Signed")[3], "https://example.test/signed");
  assert.equal(byName.get("Plain")[3], undefined);
  assert.deepEqual(asked, ["Signed"]);
});

test("the gateway serves an add-on's own <n>\\<n>.url and no other .url", () => {
  for (const [path, ok] of [
    ["Interface\\AddOns\\Signed\\Signed.url", true],
    ["Interface/AddOns/signed/SIGNED.URL", true],
    ["Interface\\AddOns\\Signed\\Other.url", false],
    ["Interface\\AddOns\\Signed\\Sub\\Signed.url", false],
    ["Interface\\GlueXML\\GlueXML.url", false],
    ["Signed.url", false],
    ["Interface\\AddOns\\..\\..\\WTF\\WTF.url", false],
  ]) {
    assert.equal(validClientFilePath(path), ok, path);
    assert.equal(generatorValidClientFilePath(path), ok, `generator: ${path}`);
  }
});
