import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  cancelGroundTarget,
  pendingGroundTarget,
  spellEffectRadius,
} from "../dist/code/browser/game/GroundTarget.js";

// G10: the reticle must never trap the player — Esc and right-click cancel it, and the
// SpellRadius ring (red when out of range) shows what the click would do.

test("cancelGroundTarget drops the arming and both visual pushes at once", () => {
  const cleared = [];
  const renderer = {
    setGroundTargetPreview: (preview) => cleared.push(["ground", preview]),
    setGameObjectPreview: (preview) => cleared.push(["object", preview]),
  };
  const previousRenderer = game.renderer;
  game.groundTarget = 133;
  game.groundTargetItem = { bag: 0, slot: 1, guid: 7n };
  game.renderer = renderer;
  try {
    cancelGroundTarget();
    assert.equal(pendingGroundTarget(), undefined, "no pending spell survives a cancel");
    assert.equal(game.groundTargetItem, undefined, "nor does its item");
    assert.deepEqual(cleared, [["ground", undefined], ["object", undefined]],
      "rings and ghost vanish with the arming, not on the next frame");
  } finally {
    game.renderer = previousRenderer;
    game.groundTarget = undefined;
    game.groundTargetItem = undefined;
  }
});

test("Escape backs out of the reticle before windows, target or menu", async () => {
  const source = await readFile(new URL("../src/browser/input/Controls.ts", import.meta.url), "utf8");
  assert.match(source, /if \(pendingGroundTarget\(\) !== undefined\) \{\s+cancelGroundTarget\(\);/,
    "backOut() cancels the reticle first");
});

test("right-click cancels an armed reticle instead of interacting", async () => {
  const source = await readFile(new URL("../src/browser/input/Controls.ts", import.meta.url), "utf8");
  assert.match(source, /releasedRight && clicked\(2\)\) \{\s+cancelGroundTarget\(\);/,
    "an unmoved right press while armed cancels");
});

test("the live reticle draws the SpellRadius ring and reddens it out of range", async () => {
  assert.equal(spellEffectRadius({ effectRadius: [0, 10, 6] }), 10, "the widest effect wins");
  assert.equal(spellEffectRadius(undefined), 0, "no row means a point marker, not a fabricated ring");
  const preview = await readFile(new URL("../src/browser/game/GroundTargetPreview.ts", import.meta.url), "utf8");
  assert.match(preview, /radius: spellEffectRadius\(metadata\)/, "the ring is the DBC radius");
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /preview\.inRange \? 0x63d6a0 : 0xff5f4a/, "out of range is red");
});
