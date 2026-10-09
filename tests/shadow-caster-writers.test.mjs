import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// P2-01a: the cascades draw only what is registered in the caster list, so a `castShadow` written
// anywhere without its `#shadowCasters.set(...)` beside it is a shadow that silently disappears.
// P2-02a: the scenery walk became per-mesh and per-room helpers.
const WRITERS = new Set(["#syncSceneryShadows", "#applySceneryShadowFlags", "#syncWmoRoomShadow", "#applyUnitShadow"]);
const NEAR = 3;

export function castShadowWriters(text) {
  const lines = text.split("\n");
  const found = [];
  let method = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // Class members sit at two spaces: `#name(`, `name(`, `readonly #name = (`, `get name(`, `* #name(`.
    const member = /^ {2}(?:(?:private|public|static|readonly|async|get|set|override)\s+|\*\s*)*(#?[A-Za-z_$][\w$]*)\s*(?:[(<=]|:)/.exec(line);
    if (member) method = member[1];
    if (!/\.castShadow\s*=(?!=)/.test(line)) continue;
    if (/this\.#sun\.castShadow\s*=/.test(line)) continue;
    const window = lines.slice(Math.max(0, index - NEAR), index + NEAR + 1).join("\n");
    found.push({ line: index + 1, method, registered: window.includes("#shadowCasters.set(") });
  }
  return found;
}

test("every castShadow writer in the renderer registers the caster list beside it", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const writers = castShadowWriters(source);
  assert.ok(writers.length >= 6, `found ${writers.length} writers`);
  for (const writer of writers) {
    assert.ok(WRITERS.has(writer.method), `line ${writer.line}: castShadow written in ${writer.method}`);
    assert.ok(writer.registered, `line ${writer.line} (${writer.method}): no #shadowCasters.set( within ${NEAR} lines`);
  }
});

test("the scan sees a writer added in another method", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const mutated = source.replace("  #applyUnitShadow(unit: RenderedUnit, enabled: boolean): void {",
    "  #elsewhere(mesh: THREE.Mesh): void {\n    mesh.castShadow = true;\n  }\n\n  #applyUnitShadow(unit: RenderedUnit, enabled: boolean): void {");
  assert.notEqual(mutated, source);
  const stray = castShadowWriters(mutated).filter((writer) => !WRITERS.has(writer.method) || !writer.registered);
  assert.equal(stray.length, 1);
  assert.equal(stray[0].method, "#elsewhere");
});
