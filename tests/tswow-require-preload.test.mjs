import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import test from "node:test";

const sourcePath = resolve(process.env.TSWOW_SOURCE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../tswow"),
  "tswow-scripts/addons/RequirePreload.ts");
let fixture;
try {
  const source = await readFile(sourcePath, "utf8");
  const require = createRequire(sourcePath);
  const ts = require("typescript");
  const lua = require("typescript-to-lua");
  // Exercise the source plugin in memory; this does not build/deploy addons or touch client files.
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Script(`(function(require, module, exports) {${js}\n})`, { filename: sourcePath })
    .runInThisContext()(require, module, module.exports);
  fixture = { ts, lua, plugin: module.exports.RequirePreload };
} catch (error) {
  if (error.code !== "ENOENT" && error.code !== "MODULE_NOT_FOUND") throw error;
}

const options = { skip: fixture ? false : "TSWoW source and compiler dependencies are not installed" };

function transform(fileName, isModule = true) {
  const { ts, lua, plugin } = fixture;
  const original = lua.createBlock([lua.createExpressionStatement(
    lua.createCallExpression(lua.createIdentifier("register_ui"), []),
  )]);
  original.luaLibFeatures = new Set(["feature"]);
  original.trivia = "-- preserved addon comment";
  const result = plugin.visitors[ts.SyntaxKind.SourceFile]({}, {
    isModule, sourceFile: { fileName }, superTransformNode: () => [original],
  });
  return { result, original };
}

test("TSWoW executes root addon entrypoints even when module names contain addon/shared", options, () => {
  for (const root of ["F:\\tswowRoot\\tswow-install\\modules\\", "/srv/tswow/modules/"]) {
    for (const moduleName of ["simple-button-addon", "creator-shared-addon", "ordinary-module", "creator-package/child-addon"]) {
      const { result, original } = transform(`${root}${moduleName}/addon/addon.ts`);
      assert.equal(result, original, `${moduleName}: root UI code must execute directly, not wait in an unrequired factory`);
    }
  }
});

test("TSWoW registers addon and shared imports using directory segments and preserves nested names", options, () => {
  const cases = [
    ["/srv/modules/simple-button-addon/addon/Panel.ts", "TSAddons.simple-button-addon.addon.Panel"],
    ["/srv/modules/simple-button-addon/shared/Messages.ts", "TSAddons.simple-button-addon.shared.Messages"],
    ["/srv/modules/creator-shared-tool/shared/SharedMessages.ts", "TSAddons.creator-shared-tool.shared.SharedMessages"],
    ["/srv/modules/ordinary-module/shared/addon-protocol.ts", "TSAddons.ordinary-module.shared.addon-protocol"],
    ["F:\\tswow\\modules\\simple-button-addon\\addon\\widgets\\addon\\Button.tsx", "TSAddons.simple-button-addon.addon.widgets.addon.Button"],
    ["/srv/modules/creator-package/child-addon/shared/index.ts", "TSAddons.creator-package.child-addon.shared"],
    ["/srv/bin/include-addon/ClientNetwork.ts", "ClientNetwork"],
  ];
  for (const [fileName, moduleName] of cases) {
    const { result, original } = transform(fileName);
    const call = result.statements[0].expression;
    assert.equal(call.expression.text, "tstl_register_module");
    assert.equal(call.params[0].value, moduleName, fileName);
    assert.equal(call.params[1].body, original);
    assert.equal(result.luaLibFeatures, original.luaLibFeatures);
    assert.equal(result.trivia, original.trivia);
  }
});

test("TSWoW leaves non-module addon scripts executable", options, () => {
  const { result, original } = transform("/srv/modules/simple-button-addon/addon/addon.ts", false);
  assert.equal(result, original);
});
