// 6.31 (26.10, owner: «Чародейские стрелы … после сужения вновь расходятся»): a missile's model plays InFlight (144)
// and, when its sequence flag 0x1 says so, one cycle of it over the whole flight — as Wow.exe's Missile_C does
// (wowdecomp Missile_C.cpp). The flag travels from the M2 through the spell models' artifacts (visual-spell-v1).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { encodeWvaAnimations } from "../tools/wvm.mjs";
import { isSpellModelPath, visualModelNamespace } from "../tools/visual-model-key.mjs";
import {
  WVA_CLIP_SEQUENCE_FLAGS, WVA_CLIP_STRIDE, decodeWvaAnimations, decodeWvaAnimationsPacked,
} from "../dist/code/browser/Wvm.js";
import {
  MISSILE_ANIM_IN_FLIGHT, MISSILE_ANIM_STAND, missileSequence, missileSequenceTime,
} from "../dist/code/browser/MissileSequence.js";

const out = () => ({ animation: -1, timeScale: -1 });

test("InFlight with the stretch flag spans the whole flight; without it, its own speed; without 144, Stand", () => {
  // Arcane Missiles: a 1 s InFlight, flags 0x61, a 2.5 s flight (50 yards at 20).
  const arcane = missileSequence({ seconds: 1, flags: 0x61 }, 2.5, out());
  assert.equal(arcane.animation, MISSILE_ANIM_IN_FLIGHT);
  assert.equal(arcane.timeScale, 0.4);
  // The three bolts meet once, at the arrival — never spread again on the way.
  assert.equal(missileSequenceTime(1.25, arcane.timeScale, 1), 0.5, "halfway through the flight, halfway through the cycle");
  assert.ok(missileSequenceTime(2.499, arcane.timeScale, 1) > 0.99, "the cycle ends with the flight");
  const plain = missileSequence({ seconds: 1, flags: 0x20 }, 2.5, out());
  assert.deepEqual(plain, { animation: MISSILE_ANIM_IN_FLIGHT, timeScale: 1 }, "no flag: InFlight at its own speed");
  assert.deepEqual(missileSequence({ seconds: 1, flags: undefined }, 2.5, out()), { animation: MISSILE_ANIM_IN_FLIGHT, timeScale: 1 },
    "an artifact without flags (before visual-spell-v1) keeps the clip's own speed");
  assert.deepEqual(missileSequence(undefined, 2.5, out()), { animation: MISSILE_ANIM_STAND, timeScale: 1 });
  assert.deepEqual(missileSequence({ seconds: 1, flags: 1 }, 0, out()), { animation: MISSILE_ANIM_STAND, timeScale: 1 },
    "no distance to cover: Stand");
});

const clip = (animationId, extra = {}) => ({
  animationId, duration: 1000, blendTime: 0, movingSpeed: Number.NaN, variationNext: -1, variationIndex: animationId === 0 ? 0 : 1,
  channels: [{ bone: 0, kind: 0, interpolation: 1, times: [0, 1000], values: [0, 0, 0, 1, 0, 0] }],
  ...extra,
});

test("the sequence flags travel in a 12-byte extras record only where the generator put them", () => {
  const flagged = encodeWvaAnimations(1, [clip(0, { sequenceFlags: 0x21 }), clip(144, { sequenceFlags: 0x61 })]);
  const data = flagged.buffer.slice(flagged.byteOffset, flagged.byteOffset + flagged.byteLength);
  const clips = decodeWvaAnimations(data, 1);
  assert.deepEqual(clips.map((entry) => entry.sequenceFlags), [0x21, 0x61]);
  const packed = decodeWvaAnimationsPacked(data, 1);
  assert.equal(packed.clipTable[WVA_CLIP_STRIDE + WVA_CLIP_SEQUENCE_FLAGS], 0x61, "the worker's packed form carries it too");

  const plain = encodeWvaAnimations(1, [clip(0), clip(144)]);
  const plainData = plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
  const extras = plain.indexOf("WVX1");
  assert.ok(extras > 0);
  assert.equal(plain.readUInt16LE(extras + 4), 8, "every other artifact keeps its 8-byte records, byte for byte");
  assert.deepEqual(decodeWvaAnimations(plainData, 1).map((entry) => entry.sequenceFlags), [undefined, undefined]);
  assert.ok(Number.isNaN(decodeWvaAnimationsPacked(plainData, 1).clipTable[WVA_CLIP_SEQUENCE_FLAGS]));
});

test("only the spell models turn over to visual-spell-v1, in the tools and in the gateway alike", async () => {
  assert.equal(visualModelNamespace("Spells\\Arcane_Missile_Lvl3.m2"), "visual-spell-v1");
  assert.equal(visualModelNamespace("spells/Fireball_Missile_High.M2"), "visual-spell-v1");
  assert.equal(visualModelNamespace("World\\Tree.m2"), "visual-v24");
  assert.equal(visualModelNamespace("World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo"), "visual-wmo-v27");
  assert.equal(isSpellModelPath("Item\\Spells\\x.m2"), false, "a folder named Spells deeper down is not a spell model");
  const gateway = await readFile(new URL("../src/gateway/Gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /if \(\/\^spells\[\\\\\/\]\/\.test\(lower\)\) return "visual-spell-v1";/);
  assert.match(gateway, /visualModelCacheNamespace\("spells\\\\a\.m2"\)/, "the visual generation names the new namespace");
  const generator = await readFile(new URL("../tools/generate-visual-model.mjs", import.meta.url), "utf8");
  assert.match(generator, /const extensions = current \|\| v24;/, "a gateway still on visual-v24 gets its own bytes");
  assert.match(generator, /if \(current && isSpellModelPath\(modelPath\) && skeleton\)/, "flags only under the new name");
});

test("the renderer plays a flight's model through missileSequence", async () => {
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /if \(!this\.#sequenceSpellModel\(visual, now, client\) && !this\.#sequenceMissileModel\(visual, now, client\)\) \{/);
  assert.match(renderer, /const pick = missileSequence\(\{ seconds: clip\.duration, flags: missileInFlightFlags\.get\(template\) \}, flight, _missilePick\);/);
});
