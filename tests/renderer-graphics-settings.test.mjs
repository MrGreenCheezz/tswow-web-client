import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The bench draws with a player's settings through RendererGraphicsSettings.ts; the page draws with
// them through ui/Settings.ts. Both must push the same renderer setters with the same setting ids,
// or a bench run "with the owner's settings" quietly draws something else.

/** Every renderer setter call and every setting id it reads, in source order. */
function wiring(source, receiver) {
  const calls = [...source.matchAll(new RegExp(`${receiver}\\??\\.(set[A-Z][A-Za-z]*)\\??\\.?\\(`, "g"))].map((match) => match[1]);
  return { calls, ids: [...source.matchAll(/setting(?:Boolean|Number)\(values, "([^"]+)"\)/g)].map((match) => match[1]) };
}

test("the bench's settings helper pushes exactly the renderer settings the page does", async () => {
  const page = await readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8");
  const helper = await readFile(new URL("../src/browser/RendererGraphicsSettings.ts", import.meta.url), "utf8");
  const start = page.indexOf("export function applySettings(");
  const end = page.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "applySettings is where the page pushes its settings");
  const pageWiring = wiring(page.slice(start, end), "game\\.renderer");
  const helperWiring = wiring(helper, "renderer");
  assert.ok(pageWiring.calls.length >= 13, "the page's renderer setters were found");
  assert.deepEqual(helperWiring.calls, pageWiring.calls, "same setters, same order");
  const graphics = pageWiring.ids.filter((id) => helperWiring.ids.includes(id));
  assert.deepEqual(helperWiring.ids, graphics, "same setting ids read for the renderer");
  for (const id of ["experimentalSceneryShadows", "experimentalAmbientOcclusion", "grassRadius", "objectDistance"]) {
    assert.ok(helperWiring.ids.includes(id), id);
  }
});
