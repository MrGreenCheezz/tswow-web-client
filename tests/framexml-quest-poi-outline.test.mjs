// Plan item 3.13 (04.10, L6): the QuestPOIFrame's outline, merging and hit test as Wow.exe 3.3.5a 12340 does
// them (0x58ed80 smoothing with the NTempest Catmull-Rom spline 0x4c3830..0x4c4da0, basis 0xac37b8; 0x58f1a0
// build; 0x58e310 merge; 0x58e0d0 hit test; 0x9830d0 crossing test; read 2026-10-04).
import assert from "node:assert/strict";
import test from "node:test";

const {
  questPoiOutline, questPoiInside, questPoiDrawnBlob, questPoiMergeBlobs, questPoiHitTest, QUEST_POI_SPLINE_POINTS,
} = await import("../dist/code/browser/framexml/FrameXmlQuestPoiOutline.js");
const { FrameXmlQuestPoiModel, frameXmlQuestPoiDrawnShapes } = await import("../dist/code/browser/framexml/FrameXmlQuestPoi.js");
const { setQuestPoiFrameAdapter } = await import("../dist/code/browser/glue/GlueQuestPoiFrame.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

const SQUARE = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
const box = (u0, v0, u1, v1) => [{ u: u0, v: v0 }, { u: u1, v: v0 }, { u: u1, v: v1 }, { u: u0, v: v1 }];

test("the outline: raw points without smoothing; with it, 20 arc-length samples of a closed Catmull-Rom", () => {
  assert.deepEqual(questPoiOutline(SQUARE, false), SQUARE);
  assert.equal(QUEST_POI_SPLINE_POINTS, 20);
  const outline = questPoiOutline(SQUARE, true);
  assert.equal(outline.length, 20);
  // t = 0.01 is 0.04 of the first edge (four equal segments): CR(p3, p0, p1, p2; 0.04) = (2.2336, -1.92).
  assert.deepEqual(outline[0], { x: 2, y: -2 }, "control points p[n-1], p0, p1, p2 and the uniform basis");
  // t = 0.26 is 0.04 into the second edge: (101.92, 2.2336).
  assert.deepEqual(outline[5], { x: 102, y: 2 });
  assert.ok(outline.every((point) => Number.isInteger(point.x) && Number.isInteger(point.y)), "whole yards");
  assert.ok(outline.some((point) => point.y < -10), "the spline bulges past the edge, as Catmull-Rom does");
  assert.equal(questPoiOutline(SQUARE, true, 8).length, 8, "SetNumSplinePoints");
  // Long and short edges: by segment parameter each edge would get 5 samples; by length the short
  // edges (whose spline bulges out past x = 1000 and below x = 0) get fewer.
  const strip = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 10 }, { x: 0, y: 10 }];
  const samples = questPoiOutline(strip, true);
  const right = samples.filter((point) => point.x > 1000).length;
  const left = samples.filter((point) => point.x < 0).length;
  assert.ok(right > 0 && right <= 3 && left > 0 && left <= 3, `by arc length: ${right} and ${left} on the short edges`);
});

test("the crossing test", () => {
  const square = box(0, 0, 1, 1);
  assert.equal(questPoiInside(square, 0.5, 0.5), true);
  assert.equal(questPoiInside(square, 1.5, 0.5), false);
  assert.equal(questPoiInside(square, 0.5, -0.1), false);
  const triangle = [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 0, v: 1 }];
  assert.equal(questPoiInside(triangle, 0.2, 0.2), true);
  assert.equal(questPoiInside(triangle, 0.8, 0.8), false);
  assert.equal(questPoiInside([], 0, 0), false);
});

test("merging: the smaller box goes into the larger past the threshold; its objectives join, four at most", () => {
  const big = questPoiDrawnBlob(1, box(0, 0, 0.5, 0.5));
  const small = questPoiDrawnBlob(2, box(0.1, 0.1, 0.2, 0.2));
  const away = questPoiDrawnBlob(3, box(0.7, 0.7, 0.8, 0.8));
  questPoiMergeBlobs([small, big, away], 0.25);
  assert.deepEqual([small.active, big.active, away.active], [false, true, true]);
  assert.deepEqual(big.objectives, [1, 2]);
  assert.deepEqual(away.objectives, [3], "boxes that do not overlap never merge");
  // Half out: one corner of four inside is 0.25, not more than the threshold.
  const edge = questPoiDrawnBlob(4, box(0.4, 0.4, 0.6, 0.6));
  const host = questPoiDrawnBlob(5, box(0, 0, 0.5, 0.5));
  questPoiMergeBlobs([host, edge], 0.25);
  assert.equal(edge.active, true);
  questPoiMergeBlobs([host, edge], 0.2);
  assert.equal(edge.active, false);
  assert.deepEqual(host.objectives, [5, 4]);
  // Equal boxes: the later one goes into the earlier.
  const first = questPoiDrawnBlob(6, box(0, 0, 0.3, 0.3));
  const second = questPoiDrawnBlob(7, box(0, 0, 0.3, 0.3));
  questPoiMergeBlobs([first, second], 0.25);
  assert.deepEqual([first.active, second.active, first.objectives], [true, false, [6, 7]]);
  // Full: a fifth objective is not added.
  const full = questPoiDrawnBlob(1, box(0, 0, 1, 1));
  full.objectives.push(2, 3, 4);
  const fifth = questPoiDrawnBlob(5, box(0.4, 0.4, 0.5, 0.5));
  questPoiMergeBlobs([full, fifth], 0.25);
  assert.deepEqual([fifth.active, full.objectives], [false, [1, 2, 3, 4]]);
  // A blob gone into one still goes into a later one, and a merged blob carries its list on.
  const a = questPoiDrawnBlob(10, box(0.1, 0.1, 0.2, 0.2));
  const b = questPoiDrawnBlob(11, box(0, 0, 0.5, 0.5));
  const c = questPoiDrawnBlob(12, box(0.05, 0.05, 0.45, 0.45));
  questPoiMergeBlobs([a, b, c], 0.25);
  assert.deepEqual([a.active, b.active, c.active], [false, true, false]);
  assert.deepEqual([b.objectives, c.objectives], [[11, 10, 12], [12, 10]]);
});

test("the hit test: the last blob under the point answers; a shorter later list leaves the rest", () => {
  const into = [0, 0, 0, 0];
  const blobs = [
    { points: box(0, 0, 0.5, 0.5), objectives: [1, 2, 3] },
    { points: box(0.2, 0.2, 0.3, 0.3), objectives: [9] },
  ];
  assert.equal(questPoiHitTest(blobs, 0.25, 0.25, into), 1);
  assert.deepEqual(into, [9, 2, 3, 0]);
  into.fill(0);
  assert.equal(questPoiHitTest(blobs, 0.1, 0.1, into), 3);
  assert.deepEqual(into, [1, 2, 3, 0]);
  assert.equal(questPoiHitTest(blobs, 0.9, 0.9, into), 0);
});

const blob = (fields) => ({ index: 0, objectiveIndex: -1, map: 0, worldMapAreaId: 12, floor: 0, priority: 0, flags: 0, points: [], ...fields });
const square = (x, y, size) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];

/** The world square [-1000, 0]² on [0, 1]², as in framexml-quest-poi. */
function poiContext(quests, blobs) {
  return {
    enabled: () => true,
    quests: () => quests,
    blobs: (id) => blobs[id],
    point: (b, x, y) => (b.map === 0 && x >= -1000 && x <= 0 && y >= -1000 && y <= 0 ? { u: -y / 1000, v: -x / 1000 } : undefined),
    player: () => ({ x: -500, y: -500 }),
    leaderBoardLine: () => undefined,
  };
}

const STYLE = { smoothing: false, splinePoints: 20, merging: true, mergeThreshold: 0.25 };

test("DrawQuestBlob's build: smoothed outlines on the map, overlapping blobs of an open quest merged", () => {
  const quests = [{ questId: 7, logIndex: 4, complete: false, watched: true, mask: 0b11 }];
  const blobs = { 7: [
    blob({ objectiveIndex: 0, points: square(-700, -700, 400) }),
    blob({ objectiveIndex: 1, points: square(-600, -600, 50) }),
    blob({ objectiveIndex: 1, points: square(-990, -990, 100) }),
  ] };
  const merged = frameXmlQuestPoiDrawnShapes(poiContext(quests, blobs), 7, STYLE);
  assert.deepEqual(merged.shapes.map((shape) => shape.objectives), [[0, 1], [1]],
    "the small blob went into the big one; the corner one does not overlap");
  const flat = frameXmlQuestPoiDrawnShapes(poiContext(quests, blobs), 7, { ...STYLE, merging: false });
  assert.deepEqual(flat.shapes.map((shape) => shape.objectives), [[0], [1], [1]], "unsmoothed and unmerged: three");
  const smooth = frameXmlQuestPoiDrawnShapes(poiContext(quests, blobs), 7, { ...STYLE, smoothing: true });
  assert.equal(smooth.shapes[0].points.length, 20);
  assert.equal(smooth.shapes.length, 1, "the corner blob's spline leaves the map: not drawn");
  const met = [{ ...quests[0], complete: true, mask: -1 }];
  assert.equal(frameXmlQuestPoiDrawnShapes(poiContext(met, blobs), 7, STYLE).shapes.length, 3, "a met quest: nothing merges");
  const model = new FrameXmlQuestPoiModel(poiContext(quests, blobs));
  assert.equal(model.shapes(7, STYLE).shapes.length, 2);
  assert.equal(model.shapes(7).shapes.length, 3, "without a style: the raw shapes as before");
});

async function bootBlobFrame() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Blob.xml",
      "interface/framexml/blob.xml": `<Ui>
        <Frame name="UIParent"><Size x="1024" y="768"/></Frame>
        <QuestPOIFrame name="Blob" parent="UIParent"><Size x="1002" y="668"/></QuestPOIFrame>
      </Ui>`,
    }),
    subset: ["Blob.xml"],
    exercise: false,
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@quest-poi-outline", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  return { boot, run };
}

test("QuestPOIFrame: the build is taken at DrawQuestBlob in the frame's style; the tooltip names the merged objectives", async () => {
  const quests = [{ questId: 7, logIndex: 4, complete: false, watched: true, mask: 0b11 }];
  const blobs = { 7: [
    blob({ objectiveIndex: 0, points: square(-700, -700, 400) }),
    blob({ objectiveIndex: 1, points: square(-600, -600, 50) }),
  ] };
  const model = new FrameXmlQuestPoiModel(poiContext(quests, blobs));
  const asked = [];
  const paints = [];
  const release = setQuestPoiFrameAdapter({
    shapes: (id, style) => { asked.push([id, style?.smoothing, style?.mergeThreshold]); return model.shapes(id, style); },
    logIndex: (id) => (id === 7 ? 4 : 0),
    paint: (_frame, ids, _style, drawn) => paints.push([[...ids], drawn?.map((entry) => entry?.shapes.length)]),
  });
  const { boot, run } = await bootBlobFrame();
  try {
    run(`Blob:EnableSmoothing(false) Blob:SetMergeThreshold(0.5)`);
    run(`Blob:DrawQuestBlob(7, true)`);
    assert.deepEqual(asked, [[7, false, 0.5]], "built once, in the frame's style");
    assert.deepEqual(paints.at(-1), [[7], [1]], "the painter gets the build: one merged blob");
    // The big square covers u, v in [0.3, 0.7]; the merged small one sat at [0.55, 0.6].
    assert.deepEqual(run(`return Blob:UpdateMouseOverTooltip(0.4, 0.4)`, 2), [4, 2]);
    assert.deepEqual(run(`return Blob:GetNumTooltips(), Blob:GetTooltipIndex(1), Blob:GetTooltipIndex(2), Blob:GetTooltipIndex(3)`, 4),
      [2, 0, 1, 0]);
    for (let index = 0; index < 5; index++) run(`Blob:UpdateMouseOverTooltip(0.4, 0.4)`);
    assert.equal(asked.length, 1, "the per-frame hit test never rebuilds");
    assert.deepEqual(run(`return Blob:UpdateMouseOverTooltip(0.9, 0.9)`, 2), [undefined, undefined]);
    assert.deepEqual(run(`return Blob:GetNumTooltips()`, 1), [0]);
    run(`Blob:DrawQuestBlob(7, false) Blob:DrawQuestBlob(7, true)`);
    assert.equal(asked.length, 2, "drawn again: built again");
    assert.deepEqual(boot.errors, []);
  } finally {
    release();
    boot.close();
  }
});
