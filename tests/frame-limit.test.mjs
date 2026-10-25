import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FRAME_LIMIT, FrameLimiter, HIDDEN_FPS, effectiveFrameLimit, frameLimitOverride,
} from "../dist/code/browser/FrameLimit.js";
import { defaultSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";

/** How many of `seconds` worth of refreshes at `hz` a limiter at `fps` accepts. */
function accepted(hz, fps, seconds = 2, jitter = 0) {
  const limiter = new FrameLimiter(() => fps);
  let count = 0;
  for (let index = 0; index < hz * seconds; index++) {
    const wobble = jitter === 0 ? 0 : (index % 2 === 0 ? jitter : -jitter);
    if (limiter.due(index * 1000 / hz + wobble)) count++;
  }
  return count / seconds;
}

test("25.10: the limiter holds a loop on vsync at the limit, not the display's rate", () => {
  assert.equal(accepted(144, 72), 72, "every other refresh at 144 Hz");
  assert.equal(accepted(144, 72, 2, 0.8), 72, "jitter does not cost a whole extra refresh");
  assert.equal(accepted(60, 72), 60, "a 60 Hz display is below the limit: every refresh");
  const sixty = accepted(144, 60);
  assert.ok(sixty >= 58 && sixty <= 62, `60 on 144 Hz averages 60 (2 and 3 refreshes), got ${sixty}`);
  assert.equal(accepted(144, 0), 144, "0 is the display's rate");
  const fast = accepted(240, 144);
  assert.ok(fast >= 115 && fast <= 144, `144 on 240 Hz stays under the limit on refreshes it can keep, got ${fast}`);
});

test("25.10: after a stall the limiter starts again from now instead of a catch-up burst", () => {
  const limiter = new FrameLimiter(() => 72);
  assert.equal(limiter.due(0), true);
  assert.equal(limiter.due(500), true);
  assert.equal(limiter.due(500 + 1000 / 144), false, "no second frame on the next refresh");
  assert.equal(limiter.due(500 + 2000 / 144), true);
});

test("25.10: a hidden page runs at the hidden rate; the setting and the URL override", () => {
  assert.equal(effectiveFrameLimit(false, 72), 72);
  assert.equal(effectiveFrameLimit(true, 72), HIDDEN_FPS);
  assert.equal(effectiveFrameLimit(true, 0), HIDDEN_FPS, "unlimited still idles when hidden");
  assert.equal(effectiveFrameLimit(true, 5), 5);
  assert.equal(effectiveFrameLimit(false, 0), 0);
  assert.equal(frameLimitOverride("?framelimit=0"), 0);
  assert.equal(frameLimitOverride("?a=1&framelimit=144"), 144);
  assert.equal(frameLimitOverride("?framelimit="), undefined);
  assert.equal(frameLimitOverride("?framelimit=x"), undefined);
  assert.equal(frameLimitOverride(""), undefined);
  const definition = settingDefinition("frameLimit");
  assert.equal(definition.group, "Графика");
  assert.equal(defaultSettings().frameLimit, DEFAULT_FRAME_LIMIT);
  assert.equal(DEFAULT_FRAME_LIMIT, 72);
});
