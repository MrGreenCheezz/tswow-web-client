import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scaleFrameXmlStage } from "../dist/code/browser/framexml/FrameXmlStageScale.js";

// 3.52: the in-world interface's stage is scaled by `zoom`, not by a `scale()` transform. Measured in
// headless Chrome (two 128-grey pictures on black, joined where the quest window's parchment joins):
// with the transform the join pixels came out 96–114 at stage scales 1.40625, 1.265625, 1.171875 and
// 0.9375; with zoom 128 at all four. The world map's tiles inside the scaled WorldMapDetailFrame:
// 12 of 18 stage/SetScale combinations seamed with a transform inside a zoomed stage, 0 of 18 with
// zoom at both levels (see framexml-dom-scale.test.mjs for the frame level).

function stubStage() {
  return { style: { transform: "scale(1.5)", zoom: "", isolation: "" } };
}

test("the stage is zoomed to the window, with no scale transform left on it", () => {
  const stage = stubStage();
  scaleFrameXmlStage(stage, 1.40625);
  assert.equal(stage.style.zoom, "1.40625");
  assert.equal(stage.style.transform, "", "a scale transform would put every join between device pixels");
  assert.equal(stage.style.isolation, "isolate", "the stacking context the transform made is kept");
});

test("both stages that host the stock interface are scaled through it", () => {
  for (const file of ["src/browser/framexml/FrameXmlWorldMount.ts", "src/browser/framexml/main.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /scaleFrameXmlStage\(stage, /, `${file} scales its stage through the zoom`);
    assert.doesNotMatch(source, /stage\.style\.transform = `scale\(/, `${file} writes no scale transform`);
  }
});
