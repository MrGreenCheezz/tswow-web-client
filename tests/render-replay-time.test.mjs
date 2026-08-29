import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as THREE from "three";
import {
  cloneRenderFrameTime,
  validateRenderFrameTime,
} from "../dist/code/browser/WorldRenderer3D.js";
import { WeatherEffect } from "../dist/code/browser/WeatherEffect.js";

test("render frame time validation accepts only finite non-negative deterministic tickets", () => {
  const input = { nowMs: 1_500.25, elapsedSeconds: 1 / 60, frameIndex: 90 };
  assert.equal(validateRenderFrameTime(input), undefined);
  const cloned = cloneRenderFrameTime(input);
  assert.deepEqual(cloned, input);
  assert.notEqual(cloned, input);
  assert.equal(Object.isFrozen(cloned), true);
  assert.deepEqual(JSON.parse(JSON.stringify(cloned)), cloned);

  for (const malformed of [
    null,
    undefined,
    {},
    { ...input, nowMs: -1 },
    { ...input, nowMs: Number.NaN },
    { ...input, nowMs: Number.POSITIVE_INFINITY },
    { ...input, elapsedSeconds: -0.001 },
    { ...input, elapsedSeconds: Number.NaN },
    { ...input, elapsedSeconds: Number.POSITIVE_INFINITY },
    { ...input, frameIndex: -1 },
    { ...input, frameIndex: 1.5 },
    { ...input, frameIndex: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => validateRenderFrameTime(malformed), /RenderFrameTime|nowMs|elapsedSeconds|frameIndex/);
    assert.throws(() => cloneRenderFrameTime(malformed), /RenderFrameTime|nowMs|elapsedSeconds|frameIndex/);
  }
});

test("weather reset rewinds only its evolution clock", () => {
  const effect = new WeatherEffect(() => undefined);
  const camera = new THREE.Vector3(4, 5, 6);
  try {
    effect.update(camera, 0.375);
    const material = effect.object.material;
    const firstTime = material.uniforms.uTime.value;
    effect.update(camera, 0.375);
    assert.notEqual(material.uniforms.uTime.value, firstTime);

    effect.reset();
    effect.update(camera, 0.375);
    assert.equal(material.uniforms.uTime.value, firstTime);
    assert.deepEqual(effect.object.position.toArray(), camera.toArray());

    effect.reset(2.5);
    assert.equal(material.uniforms.uTime.value, 2.5);
    for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => effect.reset(seconds), /seconds/);
      assert.equal(material.uniforms.uTime.value, 2.5);
    }
  } finally {
    effect.dispose();
  }
});

test("draw routes supplied evolution time without replacing wall-clock telemetry", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const drawStart = source.indexOf("  draw(\n");
  const drawEnd = source.indexOf("\n  #resetFrameCounters(): void {", drawStart);
  const draw = source.slice(drawStart, drawEnd);
  assert.ok(drawStart >= 0 && drawEnd > drawStart, "draw source boundary must exist");
  assert.match(draw, /wmoFloor\?: StaticWmoFloor,\s*frameTime\?: RenderFrameTime,[\s\S]*?gameObjectMetadataRevision\?: number,\s*\): WorldSubmissionReceipt \| undefined/);
  assert.match(draw, /frameTime === undefined\s*\? undefined\s*: cloneRenderFrameTime\(frameTime\)/);

  const liveStart = draw.indexOf("if (evolutionTime === undefined) {");
  const suppliedStart = draw.indexOf("} else {", liveStart);
  const branchEnd = draw.indexOf("\n    }", suppliedStart);
  assert.ok(liveStart >= 0 && suppliedStart > liveStart && branchEnd > suppliedStart,
    "live and supplied evolution-time branches must exist");
  const liveBranch = draw.slice(liveStart, suppliedStart);
  const suppliedBranch = draw.slice(suppliedStart, branchEnd);
  assert.equal((liveBranch.match(/performance\.now\(\)/g) ?? []).length, 1);
  assert.equal(liveBranch.includes("Math.min(0.1"), true, "live elapsed keeps the existing clamp");
  assert.equal(liveBranch.includes("this.#lastFrame = now;"), true);
  assert.equal(suppliedBranch.includes("now = evolutionTime.nowMs;"), true);
  assert.equal(suppliedBranch.includes("elapsed = evolutionTime.elapsedSeconds;"), true);
  assert.equal(suppliedBranch.includes("performance.now()"), false);
  assert.equal(suppliedBranch.includes("Math.min"), false);
  assert.equal(suppliedBranch.includes("this.#lastFrame"), false);

  for (const call of [
    "this.#updateEnvironment(player.position, objects, environmentClient, elapsed);",
    "this.#updateGameObjects(state, player.position, environmentClient, gameObjectMetadata,\n      gameObjectMetadataRevision, transportPaths, now, elapsed);",
    "this.#updateVisuals(now, elapsed, environmentClient);",
    "this.#updateEffects(player.position, now, elapsed);",
    "this.#updateBatchColours(now);",
    "this.#updateWeather(elapsed);",
    "updateLiquidMaterial(material, liquidClass, this.#lightSample, now / 1000);",
  ]) {
    assert.equal(draw.includes(call), true, `${call} must consume the selected evolution time`);
  }
  assert.match(draw, /this\.#updateUnits\([\s\S]*?now, elapsed,/);

  const beginStart = source.indexOf("  beginRenderFrame(): void {");
  const endStart = source.indexOf("  endRenderFrame(): number | undefined {");
  const timingEnd = source.indexOf("  /** Drops pending GPU queries", endStart);
  const timing = source.slice(beginStart, timingEnd);
  assert.ok(beginStart >= 0 && endStart > beginStart && timingEnd > endStart);
  assert.equal((timing.match(/performance\.now\(\)/g) ?? []).length, 2);
  assert.equal(timing.includes("this.#gpuTimer.beginFrame()"), true);
  assert.equal(timing.includes("this.#gpuTimer.endFrame()"), true);
  assert.equal(timing.includes("frameTime"), false);

  const observeStart = source.indexOf("  observeFrame(timestamp: number): number | undefined {");
  const observeEnd = source.indexOf("\n  }", observeStart);
  assert.equal(source.slice(observeStart, observeEnd).includes("frameTime"), false);
});
