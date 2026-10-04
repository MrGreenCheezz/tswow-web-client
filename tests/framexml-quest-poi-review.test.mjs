// Plan item 3.13, review of L6 (04.10): rules of the icon spread and the blob merge that the L6 tests left open.
// Wow.exe 3.3.5a 12340, read 2026-10-04 (descriptions only):
// - 0x5e2eb0: R comes from the WorldMapArea's |LocLeft − LocRight| truncated to whole yards before the
//   24/1024 scale (FABS, then the float-to-int call 0x88b9c0, then FILD at 0x5e3224..0x5e3237); a blob
//   replaces the icon blob only with a lower priority or a strictly nearer centre at the same priority.
// - 0x58e310: a blob is taken as the absorbing side only while it is still drawn (the drawn byte at +0x88 is
//   tested when the outer loop reaches it); a blob merged away earlier never takes another in.
import assert from "node:assert/strict";
import test from "node:test";

const { questPoiIconBlob, questPoiSpreadIcons } = await import("../dist/code/browser/framexml/FrameXmlQuestPoiLayout.js");
const { questPoiDrawnBlob, questPoiMergeBlobs } = await import("../dist/code/browser/framexml/FrameXmlQuestPoiOutline.js");

const seat = (x, y) => ({ x, y, movable: true, met: false });

test("R is 24 × trunc(width) / 1024: a fractional width does not reach the next whole yard", () => {
  // trunc(2133.9) = 2133 → R = 49.9921875, R² < 2500: two icons stop exactly 50 apart. With the untruncated
  // width R² is 2501.3 and they would take another round to 54.
  const pair = [seat(0, 0), seat(10, 0)];
  questPoiSpreadIcons(pair, 2133.9, 0.6);
  assert.deepEqual(pair.map(({ x, y }) => [x, y]), [[-20, 0], [30, 0]]);
});

test("the icon blob: at one priority an equally near later blob does not take the icon", () => {
  const blobs = [{ objectiveIndex: 1, priority: 0, x: 10, y: 0 }, { objectiveIndex: 2, priority: 0, x: -10, y: 0 }];
  const best = questPoiIconBlob(blobs, () => true, (blob) => blob, { x: 0, y: 0 });
  assert.equal(best?.objectiveIndex, 1);
});

test("a blob merged away earlier takes no later blob in", () => {
  const box = (u0, v0, u1, v1) => [{ u: u0, v: v0 }, { u: u1, v: v0 }, { u: u1, v: v1 }, { u: u0, v: v1 }];
  // A and B have equal boxes, so B (later) is the one tested: two of its five points are inside A → into A.
  const a = questPoiDrawnBlob(1, box(0, 0, 10, 10));
  const b = questPoiDrawnBlob(2, [{ u: 5, v: 5 }, { u: 9, v: 5 }, { u: 15, v: 5 }, { u: 15, v: 15 }, { u: 5, v: 15 }]);
  // C lies inside B only; its box does not reach A's.
  const c = questPoiDrawnBlob(3, box(12, 12, 14, 14));
  questPoiMergeBlobs([a, b, c], 0.25);
  assert.deepEqual([a.active, b.active, c.active], [true, false, true], "C stays drawn: B is no longer a host");
  assert.deepEqual([a.objectives, b.objectives, c.objectives], [[1, 2], [2], [3]]);
});
