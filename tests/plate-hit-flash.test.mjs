import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PLATE_HIT_FLASH_MS,
  drawPlate,
  plateHitFlash,
  plateLayout,
} from "../dist/code/browser/NamePlate.js";
import { notePlateHit, plateHitAt } from "../dist/code/browser/ui/OverlayModel.js";

// V8: a landed blow whitens the plate's health bar — the impact beside the rising number.

test("the flash is full on impact and gone after its window", () => {
  assert.equal(PLATE_HIT_FLASH_MS, 350);
  assert.equal(plateHitFlash(1000, 1000), 1);
  assert.ok(Math.abs(plateHitFlash(1175, 1000) - 0.5) < 1e-9);
  assert.equal(plateHitFlash(1350, 1000), 0, "the window ends, it does not linger");
  assert.equal(plateHitFlash(2000, 1000), 0);
  assert.equal(plateHitFlash(1000, undefined), 0, "no blow means no light");
  assert.equal(plateHitFlash(999, 1000), 0, "a clock going backwards is not a flash");
});

test("only landed damage is remembered, and only the recent blows", () => {
  notePlateHit(11n, "damage", 47, 5000);
  assert.equal(plateHitAt(11n), 5000);
  notePlateHit(11n, "taken", 12, 5100);
  assert.equal(plateHitAt(11n), 5100, "the newer blow wins");
  notePlateHit(12n, "heal", 100, 5200);
  notePlateHit(13n, "power", 30, 5200);
  notePlateHit(14n, "miss", 0, 5200);
  notePlateHit(15n, "damage", 0, 5200);
  notePlateHit(0n, "damage", 10, 5200);
  assert.equal(plateHitAt(12n), undefined, "a heal never whitens a bar");
  assert.equal(plateHitAt(13n), undefined);
  assert.equal(plateHitAt(14n), undefined, "nor does a miss");
  assert.equal(plateHitAt(15n), undefined, "nor a zero blow");
  assert.equal(plateHitAt(0n), undefined);
  for (let index = 0; index < 70; index++) notePlateHit(BigInt(100 + index), "damage", 1, 6000 + index);
  assert.equal(plateHitAt(100n), undefined, "an AoE pull keeps the recent blows, not the first");
  assert.equal(plateHitAt(169n), 6069);
});

function fakeContext(log) {
  return {
    font: "", textAlign: "", textBaseline: "", lineWidth: 1, strokeStyle: "", fillStyle: "",
    globalAlpha: 1,
    save() { log.push("save"); },
    restore() { log.push("restore"); },
    strokeText() {}, fillText() {},
    measureText() { return { width: 0 }; },
    fillRect(x, y, width, height) { log.push(["fill", this.fillStyle, this.globalAlpha, x, y, width, height]); },
    strokeRect() {},
  };
}

const plate = (hitFlash) => ({
  guid: 21n, name: "Кабан", level: 5, reaction: 2, classColour: undefined,
  health: 0.5, healthCurrent: 50, healthMax: 100,
  raidMark: undefined, questMark: undefined, rank: 0,
  cast: undefined, target: false, lootable: false, tappedByOther: false, hitFlash,
});

test("a flashing plate paints white over the bar and nothing without one", () => {
  const box = plateLayout({ cast: undefined, target: false }, 100, 200);
  const lit = [];
  drawPlate(fakeContext(lit), box, plate(1));
  const white = lit.filter((entry) => Array.isArray(entry) && entry[1] === "#ffffff");
  assert.equal(white.length, 1, "one white sheet over the bar");
  assert.equal(white[0][2], 0.55, "capped alpha: light, not a blank plate");
  assert.ok(lit.includes("save") && lit.includes("restore"), "the alpha never leaks into the cast bar");

  const calm = [];
  drawPlate(fakeContext(calm), box, plate(0));
  assert.deepEqual(calm.filter((entry) => Array.isArray(entry) && entry[1] === "#ffffff"), [],
    "no blow means no white");
  const missing = [];
  drawPlate(fakeContext(missing), box, { ...plate(undefined), hitFlash: undefined });
  assert.deepEqual(missing.filter((entry) => Array.isArray(entry) && entry[1] === "#ffffff"), [],
    "an old plate without the field paints as before");
});

test("the frame resolves the flash and the world feeds it from combat", async () => {
  const source = await readFile(new URL("../src/browser/ui/NamePlates.ts", import.meta.url), "utf8");
  assert.match(source, /hitFlash: plateHitFlash\(now, plateHitAt\(object\.guid\)\)/,
    "each plate carries its own resolved fraction");
  const enter = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(enter, /notePlateHit\(text\.guid, text\.kind, text\.amount, performance\.now\(\)\)/,
    "the FLOATING_TEXT funnel feeds the flash beside the numbers and the voices");
});
