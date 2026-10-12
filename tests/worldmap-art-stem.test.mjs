import assert from "node:assert/strict";
import test from "node:test";
import { bestTextureStem, textureStems } from "../tools/generate-worldmap-art.mjs";

// 3.54: the world map art generator publishes a whole numbered run from one requested tile. Taking
// every trailing digit as the tile number sent Outland's continent map — `Expansion01\Expansion011.blp`
// … `Expansion0112.blp`, stem `Expansion01` — to a run of `Expansion1.blp…` that is not in the
// client: all twelve tiles answered 404 and the map stayed blank. Netherstorm's `Area52` overlay too.

const W = "Interface\\WorldMap\\";
function archivesWith(...runs) {
  const files = new Set();
  for (const [stem, count] of runs) for (let index = 1; index <= count; index++) files.add(`${stem}${index}.blp`.toLowerCase());
  return { has: async (path) => files.has(path.toLowerCase()) };
}

test("a numbered name splits into a stem and a tile number of one or two digits, no leading zero", () => {
  assert.deepEqual(textureStems(`${W}Elwynn\\Elwynn3.blp`), [`${W}Elwynn\\Elwynn`]);
  assert.deepEqual(textureStems(`${W}Elwynn\\Elwynn11.blp`), [`${W}Elwynn\\Elwynn1`, `${W}Elwynn\\Elwynn`]);
  assert.deepEqual(textureStems(`${W}Elwynn\\Elwynn10.blp`), [`${W}Elwynn\\Elwynn`]);
  assert.deepEqual(textureStems(`${W}Expansion01\\Expansion011.blp`),
    [`${W}Expansion01\\Expansion01`, `${W}Expansion01\\Expansion0`]);
  assert.deepEqual(textureStems(`${W}Cosmic\\Cosmic-Outland-Highlight.blp`), []);
});

test("the archives decide: the run that holds the requested tile, the longest winning", async () => {
  const archives = archivesWith(
    [`${W}Elwynn\\Elwynn`, 12],
    [`${W}Expansion01\\Expansion01`, 12],
    [`${W}Netherstorm\\Area52`, 1],
    [`${W}Naxxramas\\Naxxramas1_`, 12],
  );
  assert.equal(await bestTextureStem(`${W}Elwynn\\Elwynn11.blp`, archives), `${W}Elwynn\\Elwynn`);
  assert.equal(await bestTextureStem(`${W}Elwynn\\Elwynn1.blp`, archives), `${W}Elwynn\\Elwynn`);
  assert.equal(await bestTextureStem(`${W}Expansion01\\Expansion011.blp`, archives), `${W}Expansion01\\Expansion01`);
  assert.equal(await bestTextureStem(`${W}Expansion01\\Expansion0110.blp`, archives), `${W}Expansion01\\Expansion01`);
  assert.equal(await bestTextureStem(`${W}Expansion01\\Expansion0112.blp`, archives), `${W}Expansion01\\Expansion01`);
  assert.equal(await bestTextureStem(`${W}Netherstorm\\Area521.blp`, archives), `${W}Netherstorm\\Area52`);
  assert.equal(await bestTextureStem(`${W}Naxxramas\\Naxxramas1_7.blp`, archives), `${W}Naxxramas\\Naxxramas1_`);
  assert.equal(await bestTextureStem(`${W}Elwynn\\Elwynn13.blp`, archives), undefined, "not in the client: no run");
});
