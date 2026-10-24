import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WorldCpuWindow, fpsCounterText } from "../dist/code/browser/ui/FpsCounterText.js";

/**
 * 25.10 (12.14): the FPS line says what a world frame cost the processor («ЦП мира»), in the worker and in the page,
 * so a player reads whether 40 FPS is the processor (1000 / 40 = 25 ms ≈ ЦП мира) or a wait for something else.
 */

test("the FPS line carries the world frame's CPU when there is one", () => {
  assert.equal(fpsCounterText(71.8, 13.9, 20.8, 38.4, 25.06),
    "мир 38 FPS · ЦП мира 25.1 мс · интерфейс 72 FPS · кадр 13.9 мс · макс. 20.8 мс");
  assert.equal(fpsCounterText(40.2, 24.9, 34.7, undefined, 23.96), "40 FPS · ЦП мира 24.0 мс · кадр 24.9 мс · макс. 34.7 мс");
  // No world frame in the half second (a loading screen): the line stays as it was.
  assert.equal(fpsCounterText(59.9, 16.7, 18.2, 50.6, undefined), "мир 51 FPS · интерфейс 60 FPS · кадр 16.7 мс · макс. 18.2 мс");
});

test("the CPU window averages the frames since the last line and starts over", () => {
  const window = new WorldCpuWindow();
  assert.equal(window.take(), undefined);
  window.note(20);
  window.note(30);
  window.note(Number.NaN);
  window.note(-1);
  assert.equal(window.take(), 25);
  assert.equal(window.take(), undefined, "a line without frames shows no stale number");
  window.note(12);
  window.reset();
  assert.equal(window.take(), undefined);
});

test("both world paths feed the line: after an in-page draw and per render-worker results", async () => {
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const notes = loop.match(/noteWorldFrameCpu\((milliseconds|rendererElapsed)\)/g) ?? [];
  assert.deepEqual(notes.sort(), ["noteWorldFrameCpu(milliseconds)", "noteWorldFrameCpu(rendererElapsed)"]);
  const counter = await readFile(new URL("../src/browser/ui/FpsCounter.ts", import.meta.url), "utf8");
  assert.match(counter, /fpsCounterText\([^)]*worldCpu\.take\(\)\)/);
});
