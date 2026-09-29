// Loads one browser module on its own, with its imports replaced.
//
// A native panel imports the DOM handles, the world context and a dozen siblings, so testing one
// rule in it through the real module graph needs a browser. This transpiles the single file to
// CommonJS and hands it a `require` that answers from `modules`: every import the test names gets
// what the test passed, real or fake, and every other import gets an empty stub whose members are
// no-op functions. A module whose values the code under test really reads (ActionBarProtocol's
// arithmetic, the bindings table, the world context shared with another real module) therefore
// has to be passed in as is — the stub answers `undefined` to every call and is not iterable.
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sources = new URL("../../src/", import.meta.url);

/** Any module under src/, by its path without the extension: `isolatedModule("browser/input/Actions", …)`. */
export async function isolatedModule(path, modules = {}) {
  const source = await readFile(new URL(`${path}.ts`, sources), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  new Function("require", "exports", js)((name) => modules[name] ?? new Proxy({}, {
    get: () => () => {},
  }), exports);
  return exports;
}

/** A module under src/browser/ui/, by its file name: `isolatedUi("ActionBar", …)`. */
export function isolatedUi(file, modules) {
  return isolatedModule(`browser/ui/${file}`, modules);
}
