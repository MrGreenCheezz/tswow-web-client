// 26.10 (6.27, owner: «Удар грома продолжает вторую часть анимации ещё достаточно долго»): a spell model's tracks are
// sampled on its sequence's own time and hold their last key past it, as Wow.exe samples them. They used to wrap on
// their own key span: Thunder Clap's `ThunderClap_Cast_Base.m2` emitter is enabled 0–166 ms of a 4,933 ms Stand, and
// wrapped on 166 ms it spawned shockwave rings for the whole clip; its 466 ms batch fades blinked back on.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sampleTrack } from "../dist/code/browser/Particles.js";

const step = { interpolation: 0, globalSequence: -1, components: 1, tracks: [{ sequence: 0, times: [0, 166], values: [1, 0] }] };
const fade = { interpolation: 1, globalSequence: -1, components: 1, tracks: [{ sequence: 0, times: [0, 466], values: [1, 0] }] };
const none = new Uint32Array(0);

test("on the sequence's own time a track holds its last key: enabled 0–166 ms stays off, a 466 ms fade stays faded", () => {
  assert.equal(sampleTrack(step, 100, 0, none, 1, 0, undefined, true), 1);
  for (const ms of [166, 200, 400, 2000, 4900]) assert.equal(sampleTrack(step, ms, 0, none, 1, 0, undefined, true), 0, String(ms));
  assert.equal(sampleTrack(fade, 233, 0, none, 1, 0, undefined, true), 0.5);
  for (const ms of [466, 700, 3000]) assert.equal(sampleTrack(fade, ms, 0, none, 1, 0, undefined, true), 0, String(ms));
});

test("without it (a doodad's wall clock) the span is still the only period known: the old wrap", () => {
  assert.equal(sampleTrack(step, 200, 0, none, 1), 1, "200 ms wraps to 34 ms of the 166 ms span");
  assert.ok(sampleTrack(fade, 700, 0, none, 1) > 0, "the fade comes back on the wall clock");
});

test("wiring: spell effects pass their clip time (or a once-played model's age) as sequence time; the scratch frame carries it", async () => {
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /entry\.spell && \(entry\.spell\.action \|\| entry\.spell\.instance\.modelPlayback !== "hold"\) \? \{ inSequence: true \} : \{\}/);
  assert.match(renderer, /updateBatchColours\(visual\.built\.animatedBatches, visual\.action\.time \* 1000, now, undefined, true\)/);
  assert.match(renderer, /visual\.instance\.modelPlayback !== "hold"\); \/\/ 26\.10/);
  const render = await readFile(new URL("../src/browser/ParticleRender.ts", import.meta.url), "utf8");
  assert.match(render, /emitterFrame\.inSequence = frame\.inSequence;/);
  const particles = await readFile(new URL("../src/browser/Particles.ts", import.meta.url), "utf8");
  assert.equal((particles.match(/frame\.inSequence === true/g) ?? []).length, 5, "every emitter track read takes it");
});
