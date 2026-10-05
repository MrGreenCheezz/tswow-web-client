// 05.10: review of slice E (05.10-A7a-E) — motion scripts are data a TSWoW module can ship, so a hostile or
// broken ScriptBody must fail to "no motion" instead of throwing into the frame; a missile launched late
// still lands with its impact; a chain beam names `.tga` textures the client loads as `.blp`.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { MOTION_OUT, compileMissileScript, missileProgram } from "../dist/code/browser/MissileScript.js";
import { flyMissileInstance, launchMissile, missileSample, stepMissile } from "../dist/code/browser/MissileFlight.js";
import { ChainBeams, beamTexturePath } from "../dist/code/browser/ChainBeam.js";

const none = { point: () => false };

test("deeply nested scripts are a compile failure, never a thrown RangeError", () => {
  const scripts = [
    `transUp = ${"(".repeat(20_000)}1${")".repeat(20_000)}`,
    `transUp = ${"-".repeat(50_000)}1`,
    `transUp = 2${"^2".repeat(50_000)}`,
    `${"if 1 < 2 then ".repeat(5_000)}transUp = 1${" end".repeat(5_000)}`,
  ];
  for (const script of scripts) {
    let result;
    assert.doesNotThrow(() => { result = compileMissileScript(script); }, script.slice(0, 20));
    assert.equal(result.ok, false, script.slice(0, 20));
    assert.doesNotThrow(() => missileProgram(script));
    assert.equal(missileProgram(script), undefined);
  }
  // Lua 5.1's limit, not the JS stack's: 250 parentheses are "too many syntax levels" there too.
  const levels = compileMissileScript(`transUp = ${"(".repeat(250)}1${")".repeat(250)}`);
  assert.equal(levels.ok, false);
  assert.match(levels.reason, /syntax levels/);
  // Ordinary nesting (Lua 5.1 allows 200 syntax levels) still compiles.
  assert.equal(compileMissileScript(`transUp = ${"(".repeat(40)}1${")".repeat(40)}`).ok, true);
});

test("Object.prototype names are ordinary unassigned globals, not inputs, outputs or functions", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(compileMissileScript(`transUp = ${name} * 2`).ok, false, `arithmetic on nil '${name}'`);
    assert.equal(compileMissileScript(`transUp = ${name}(1)`).ok, false, `'${name}' is no function`);
  }
  const result = compileMissileScript("toString = 3\nconstructor = 4\ntransUp = toString + constructor");
  assert.equal(result.ok, true);
  const out = new Float64Array(12);
  result.program.evaluate(new Float64Array(12), out);
  assert.equal(out[MOTION_OUT.transUp], 7, "assigned like any extra global");
});

test("a script that fails while running is dropped and the missile flies straight (0x00700350 → 0x00701230)", () => {
  // Compiles (a left-associative chain is one syntax level in Lua) but nests deeper than any JS stack.
  const script = `transUp = 1${" + 1".repeat(200_000)}`;
  const state = launchMissile({ from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, motion: { id: 1, script, count: 1 } },
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0, 1000);
  const out = missileSample();
  let flying;
  assert.doesNotThrow(() => { flying = stepMissile(state, { x: 10, y: 0, z: 0 }, 500, out); });
  assert.equal(flying, true);
  assert.equal(out.position.z, 0, "no offset from a failed run");
  assert.equal(state.program, undefined, "the script is dropped for good");
  assert.equal(stepMissile(state, { x: 10, y: 0, z: 0 }, 1000, out), false, "and still arrives on schedule");
});

test("a missile first flown after a hitch still arrives when its impact kit plays", () => {
  const instance = { startedAt: 0, endsAt: 1000, flight: { from: { x: 0, y: 0, z: 0 }, to: { x: 30, y: 0, z: 0 } } };
  const out = missileSample();
  assert.equal(flyMissileInstance(instance, 400, none, out), true, "first visible frame 400 ms late");
  let now = 400;
  while (flyMissileInstance(instance, (now += 16), none, out) && now < 5000) { /* fly */ }
  assert.ok(now <= 1016, `arrived with the impact (1000 ms), not 400 ms after it: ${now}`);
  const late = { startedAt: 0, endsAt: 1000, flight: { from: { x: 0, y: 0, z: 0 }, to: { x: 30, y: 0, z: 0 } } };
  assert.equal(flyMissileInstance(late, 1200, none, out), false, "a missile first seen after its arrival is not drawn");
});

test("beam textures named .tga load as .blp, as the client loads every texture", () => {
  assert.equal(beamTexturePath("Textures\\SpellChainEffects\\SummonGhoulsLightning.tga"),
    "Textures\\SpellChainEffects\\SummonGhoulsLightning.blp");
  assert.equal(beamTexturePath("Textures\\SpellChainEffects\\Beam_DrainLife.BLP"), "Textures\\SpellChainEffects\\Beam_DrainLife.BLP");
  const asked = [];
  const beams = new ChainBeams(new THREE.Group(), (path) => {
    asked.push(path);
    return { texture: new THREE.Texture({ width: 1, height: 1 }), release() {} };
  });
  const effect = { id: 1, texture: "Textures\\SpellChainEffects\\SummonGhoulsLightning.tga", width: 1, avgSegLen: 1, noiseScale: 0,
    texCoordScale: 0, textureLength: 1, segDuration: 0, segDelay: 0, flags: 0, jointCount: 0, color: [255, 255, 255, 255],
    blendMode: 2, renderLayer: 0 };
  beams.add({}, [{ effect, from: { guid: 1n, attachment: 22, point: { x: 0, y: 0, z: 0 } },
    to: { attachment: 34, point: { x: 5, y: 0, z: 0 } }, startedAt: 0, endsAt: 1000 }]);
  beams.update(10, none, undefined, new THREE.Vector3(0, 10, 0));
  assert.deepEqual(asked, ["Textures\\SpellChainEffects\\SummonGhoulsLightning.blp"]);
});

test("a beam whose texture has not landed is not drawn (no black band while loading or when it is missing)", () => {
  const group = new THREE.Group();
  const texture = new THREE.Texture();
  const beams = new ChainBeams(group, () => ({ texture, release() {} }));
  const effect = { id: 1, texture: "Textures\\SpellChainEffects\\X.blp", width: 1, avgSegLen: 1, noiseScale: 0,
    texCoordScale: 0, textureLength: 1, segDuration: 0, segDelay: 0, flags: 0, jointCount: 0, color: [255, 255, 255, 255],
    blendMode: 2, renderLayer: 0 };
  beams.add({}, [{ effect, from: { guid: 1n, attachment: 22, point: { x: 0, y: 0, z: 0 } },
    to: { attachment: 34, point: { x: 5, y: 0, z: 0 } }, startedAt: 0, endsAt: 1000 }]);
  const eye = new THREE.Vector3(0, 10, 0);
  beams.update(10, none, undefined, eye);
  assert.equal(group.children.filter((child) => child.visible).length, 0, "pending texture: hidden");
  assert.equal(texture.version, 0, "no upload requested before the image exists");
  texture.image = { width: 1, height: 1 };
  beams.update(20, none, undefined, eye);
  assert.equal(group.children.filter((child) => child.visible).length, 1, "drawn once the image is there");
  assert.equal(texture.wrapS, THREE.RepeatWrapping);
});
