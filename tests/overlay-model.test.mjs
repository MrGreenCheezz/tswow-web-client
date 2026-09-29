import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BUBBLE_MAX_CHARS, BUBBLE_MAX_MS, BUBBLE_MIN_MS, FLOATER_LIFE_MS,
  addFloater, bubbleLifetime, expire, floaterOffset, floatingAmountText, putBubble,
} from "../dist/code/browser/ui/OverlayModel.js";
import { createCamera, projectPoint } from "../dist/code/browser/SimpleScene.js";

const currentOverlay = await import(`../src/browser/ui/OverlayModel.ts?relevance=${Date.now()}`);

test("floating combat text is limited to the player and the player's current target", () => {
  const relevant = currentOverlay.floatingCombatTextRelevant;
  assert.equal(typeof relevant, "function");
  assert.equal(relevant(10n, 10n, 20n), true, "the player's own status is visible");
  assert.equal(relevant(20n, 10n, 20n), true, "the current target's status is visible");
  assert.equal(relevant(30n, 10n, 20n), false, "an unrelated NPC/player is hidden");
  assert.equal(relevant(0n, 10n, 20n), false, "an absent unit is hidden");
  assert.equal(relevant(20n, 10n, undefined), false, "an old target stops being relevant immediately");
});

test("changing target removes already-visible numbers from the old target", () => {
  const list = [];
  for (const guid of [10n, 20n, 30n]) {
    currentOverlay.addFloater(list, { guid, text: "-1", kind: "damage", critical: false }, 0);
  }
  currentOverlay.removeIrrelevantFloaters(list, 10n, 20n);
  assert.deepEqual(list.map((entry) => entry.guid), [10n, 20n]);
  currentOverlay.removeIrrelevantFloaters(list, 10n, undefined);
  assert.deepEqual(list.map((entry) => entry.guid), [10n], "the old target disappears immediately");
});

test("the DOM overlay applies the combat relevance policy before allocating a floater", async () => {
  const source = await readFile(new URL("../src/browser/ui/HeadOverlay.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function showFloatingText(");
  const end = source.indexOf("/**", start + 1);
  const handler = source.slice(start, end);
  assert.match(handler, /floatingCombatTextRelevant\(guid, world\.state\.selfGuid, world\.targetGuid\)/);
  assert.ok(handler.indexOf("floatingCombatTextRelevant") < handler.indexOf("addFloater"));
  const updateStart = source.indexOf("export function updateHeadOverlay(");
  const updateEnd = source.indexOf("const bounds =", updateStart);
  const update = source.slice(updateStart, updateEnd);
  assert.match(update, /removeIrrelevantFloaters\(floaters, selfGuid, world\?\.targetGuid\)/);
  assert.ok(update.indexOf("removeIrrelevantFloaters") < update.indexOf("floaters.length === 0"));
});

test("a second line from the same unit replaces the first bubble", () => {
  // Stacking them would put a column of speech over one head and hide the unit under its own
  // words; the original client shows the last thing said and nothing else.
  const list = [];
  putBubble(list, 7n, "первое", 0);
  putBubble(list, 7n, "второе", 100);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "второе");
  putBubble(list, 8n, "чужое", 100);
  assert.equal(list.length, 2, "a different unit gets its own");
});

test("a long line stays up longer, within a floor and a ceiling", () => {
  assert.equal(bubbleLifetime("да"), BUBBLE_MIN_MS);
  assert.equal(bubbleLifetime("я".repeat(1000)), BUBBLE_MAX_MS);
  assert.equal(bubbleLifetime("я".repeat(50)) > BUBBLE_MIN_MS, true);
});

test("a wall of text is cut, because the chat log already has all of it", () => {
  const list = [];
  putBubble(list, 7n, "я".repeat(BUBBLE_MAX_CHARS + 50), 0);
  assert.equal(list[0].text.length, BUBBLE_MAX_CHARS);
  assert.equal(list[0].text.endsWith("…"), true);
});

test("two hits landing in the same millisecond get different lanes", () => {
  const list = [];
  addFloater(list, { guid: 7n, text: "-10", kind: "damage", critical: false }, 0);
  addFloater(list, { guid: 7n, text: "-20", kind: "damage", critical: false }, 0);
  assert.notEqual(list[0].lane, list[1].lane);
  // A different unit is somewhere else on screen entirely, so it starts from the first lane again.
  addFloater(list, { guid: 8n, text: "-30", kind: "damage", critical: false }, 0);
  assert.equal(list[2].lane, 0);
});

test("a lane is free again once its number has risen out of the way", () => {
  const list = [];
  addFloater(list, { guid: 7n, text: "-10", kind: "damage", critical: false }, 0);
  addFloater(list, { guid: 7n, text: "-20", kind: "damage", critical: false }, FLOATER_LIFE_MS);
  assert.equal(list[1].lane, 0);
});

test("a number rises the whole way and fades over the last of it", () => {
  const list = [];
  addFloater(list, { guid: 7n, text: "-10", kind: "damage", critical: false }, 0);
  const start = floaterOffset(list[0], 0);
  // Compared by distance rather than by value: a rise of zero comes out as `-0`, which is not
  // strictly equal to `0` — the same trap that once failed the terrain normal test.
  assert.equal(Math.abs(start.dy) < 1e-9, true);
  assert.equal(start.opacity, 1);
  assert.equal(floaterOffset(list[0], FLOATER_LIFE_MS / 2).dy < 0, true, "up, not down");
  assert.equal(floaterOffset(list[0], FLOATER_LIFE_MS).opacity, 0);
});

test("damage comes off, a heal goes on, and a miss is a word", () => {
  assert.equal(floatingAmountText("damage", 1234), "-1234");
  assert.equal(floatingAmountText("taken", 47), "-47");
  assert.equal(floatingAmountText("heal", 560), "+560");
  assert.equal(floatingAmountText("power", 20), "+20");
  assert.equal(floatingAmountText("miss", 0), "промах");
  assert.equal(floatingAmountText("miss", 0, "уклонение"), "уклонение");
});

test("expire drops what is over and keeps what is not", () => {
  const list = [];
  addFloater(list, { guid: 7n, text: "-1", kind: "damage", critical: false }, 0);
  addFloater(list, { guid: 8n, text: "-2", kind: "damage", critical: false }, 1000);
  expire(list, FLOATER_LIFE_MS);
  assert.equal(list.length, 1);
  assert.equal(list[0].guid, 8n);
});

test("a bubble is anchored above the drawn body, not inside it", () => {
  // The same projection the canvas overlay uses, so a bubble and a name plate agree to the pixel.
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const camera = createCamera(player, 0, -0.4, 20);
  const feet = projectPoint({ x: 20, y: 0, z: 0 }, camera, 800, 600);
  const crown = projectPoint({ x: 20, y: 0, z: 2 }, camera, 800, 600);
  assert.ok(feet && crown);
  assert.equal(crown.y < feet.y, true, "the head is higher on screen than the feet");
});

test("a unit behind the camera has no anchor at all", () => {
  // `projectPoint` answers undefined rather than a mirrored point, and the overlay must skip it
  // rather than clamp: a clamped bubble sits over the wrong part of the screen.
  const camera = createCamera({ x: 0, y: 0, z: 0, orientation: 0 }, 0, 0, 20);
  assert.equal(projectPoint({ x: -100, y: 0, z: 2 }, camera, 800, 600), undefined);
});

test("the anchor is in world axes; the scene's swap belongs to three.js alone", () => {
  // The WebGL scene places nodes at (x, z, -y). Applying that here would move a unit due north
  // vertically up the screen instead of into the distance.
  const camera = createCamera({ x: 0, y: 0, z: 0, orientation: 0 }, 0, 0, 20);
  const ahead = projectPoint({ x: 30, y: 0, z: 2 }, camera, 800, 600);
  const north = projectPoint({ x: 30, y: 10, z: 2 }, camera, 800, 600);
  assert.ok(ahead && north);
  assert.equal(Math.abs(north.y - ahead.y) < 1, true, "moving along y is sideways, not upwards");
  assert.equal(Math.abs(north.x - ahead.x) > 10, true);
});
