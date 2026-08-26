import assert from "node:assert/strict";
import test from "node:test";
import {
  cooldownDuration, cooldownFraction, cooldownFractionFromRemaining, cooldownLabel, cooldownView,
  fillFraction, stackLabel,
} from "../dist/code/browser/ui/Widgets.js";

// The widget kit builds DOM, which these tests have none of; what is worth testing is the
// arithmetic every panel would otherwise write again, and get wrong at the edges.

test("a bar fill is clamped, and an unknown maximum reads as empty rather than NaN", () => {
  assert.equal(fillFraction(50, 100), 0.5);
  assert.equal(fillFraction(0, 100), 0);
  // A dead unit and a unit whose health has not arrived both have to draw as an empty bar, and
  // 450/undefined would otherwise reach the stylesheet as "NaN%".
  assert.equal(fillFraction(undefined, 100), 0);
  assert.equal(fillFraction(450, undefined), 0);
  assert.equal(fillFraction(450, 0), 0, "a maximum of zero is not a division");
  assert.equal(fillFraction(-5, 100), 0);
  assert.equal(fillFraction(150, 100), 1, "overhealed is full, not 150%");
});

test("a cooldown sweep runs from full to empty and stops there", () => {
  assert.equal(cooldownFraction(1_000, 1_000, 4_000), 1);
  assert.equal(cooldownFraction(3_000, 1_000, 4_000), 0.5);
  assert.equal(cooldownFraction(5_000, 1_000, 4_000), 0);
  assert.equal(cooldownFraction(9_000, 1_000, 4_000), 0, "a finished cooldown does not go negative");
  assert.equal(cooldownFraction(1_000, 1_000, 0), 0, "no duration is no sweep, not a division by zero");
  assert.equal(cooldownFractionFromRemaining(4_000, 4_000), 1);
  assert.equal(cooldownFractionFromRemaining(2_000, 4_000), 0.5);
  assert.equal(cooldownFractionFromRemaining(0, 4_000), 0);
  assert.equal(cooldownFractionFromRemaining(9_000, 4_000), 1, "a delayed packet cannot overfill the sweep");
  assert.equal(cooldownFractionFromRemaining(1_000, 0), 0);
});

test("cooldown totals and labels stay readable at the short/long boundary", () => {
  assert.equal(cooldownDuration(undefined, 0, 1_500), 1_500);
  assert.equal(cooldownDuration(undefined, undefined), 0);
  assert.equal(cooldownLabel(0), "");
  assert.equal(cooldownLabel(1_250), "1.3");
  assert.equal(cooldownLabel(10_000), "10с");
  assert.equal(cooldownLabel(10_001), "11с");
});

test("a server cooldown snapshot drives the sweep, and the longer GCD still wins", () => {
  const own = cooldownView(3_000, 2_000, 9_000, 0, 0, { startedAt: 1_000, duration: 4_000 });
  assert.equal(own.remaining, 2_000);
  assert.equal(own.duration, 4_000, "the snapshot is authoritative over the authored fallback");
  assert.equal(own.fraction, 0.5);

  const gcd = cooldownView(1_500, 500, 2_000, 1_250, 1_500);
  assert.equal(gcd.remaining, 1_250);
  assert.equal(gcd.fraction, 1_250 / 1_500);

  const gcdOverOwn = cooldownView(1_500, 500, 60_000, 1_250, 1_500);
  assert.equal(gcdOverOwn.duration, 1_500, "a winning GCD must not inherit the spell's long cooldown");
  assert.equal(gcdOverOwn.fraction, 1_250 / 1_500);
});

test("a stack count is written only when there is a stack", () => {
  assert.equal(stackLabel(0), "");
  assert.equal(stackLabel(1), "", "one of something is not written on the slot");
  assert.equal(stackLabel(20), "20");
  assert.equal(stackLabel(999), "999");
  assert.equal(stackLabel(1_000), "1k", "four figures do not fit in a slot corner");
  assert.equal(stackLabel(12_500), "12k");
});
