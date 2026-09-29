import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";

async function isolatedHints(say) {
  const source = await readFile(new URL("../src/browser/ui/WelcomeHints.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(
    (name) => {
      if (name === "./Notices.js") return { notice: (text) => say.push(text) };
      return new Proxy({}, { get: () => () => {} });
    },
    module, module.exports);
  return module.exports;
}

test("hints show once ever and stay silent afterwards", async () => {
  const { maybeShowWelcomeHints, WELCOME_HINTS } = await isolatedHints([]);
  assert.ok(WELCOME_HINTS.length >= 3, "movement, targeting and windows are all covered");
  let seen = false;
  const said = [];
  const deps = { shown: () => seen, markShown: () => { seen = true; }, say: (text) => said.push(text) };
  maybeShowWelcomeHints(deps);
  assert.equal(seen, true, "the first showing is remembered");
  assert.deepEqual(said, [...WELCOME_HINTS]);
  said.length = 0;
  maybeShowWelcomeHints(deps);
  assert.deepEqual(said, [], "a veteran's alt never sees them again");
});
