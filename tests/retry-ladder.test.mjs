// 1.24 / М-A7b-2: the retry ladder shared by the splat, light and horizon clients.
import assert from "node:assert/strict";
import test from "node:test";
import { RETRY_LADDER_STEPS_MS, RetryLadder } from "../dist/code/browser/RetryLadder.js";
import { IMAGE_RETRY_BACKOFF_MS } from "../dist/code/browser/CharacterAtlas.js";

function clock(start = 1_000) {
  const time = { now: start };
  return { time, now: () => time.now };
}

test("the ladder's steps are the texture backoff's 2 s / 8 s / 30 s", () => {
  assert.deepEqual([...RETRY_LADDER_STEPS_MS], [...IMAGE_RETRY_BACKOFF_MS]);
  assert.deepEqual([...RETRY_LADDER_STEPS_MS], [2_000, 8_000, 30_000]);
});

test("a key never failed is not waiting and is ready to ask", () => {
  const ladder = new RetryLadder(undefined, clock().now);
  assert.equal(ladder.waiting("a"), false);
  assert.equal(ladder.ready("a"), true);
  assert.equal(ladder.attempts("a"), 0);
  assert.equal(ladder.exhausted("a"), false);
  assert.equal(ladder.size, 0);
});

test("1st failure waits 2 s, 2nd 8 s, 3rd 30 s, the 4th is exhausted", () => {
  const { time, now } = clock();
  const ladder = new RetryLadder(undefined, now);
  for (const [attempt, wait] of [[1, 2_000], [2, 8_000], [3, 30_000]]) {
    ladder.failed("a");
    assert.equal(ladder.attempts("a"), attempt);
    assert.equal(ladder.waiting("a"), true);
    time.now += wait - 1;
    assert.equal(ladder.ready("a"), false, `attempt ${attempt} is not ready 1 ms early`);
    time.now += 1;
    assert.equal(ladder.ready("a"), true, `attempt ${attempt} is ready after ${wait} ms`);
    assert.equal(ladder.exhausted("a"), false);
  }
  ladder.failed("a");
  assert.equal(ladder.exhausted("a"), true);
  time.now += 1e9;
  assert.equal(ladder.ready("a"), false, "an exhausted key is never asked again");
  assert.equal(ladder.exhaustedCount(), 1);
});

test("a permanent failure (404) is exhausted at once", () => {
  const { time, now } = clock();
  const ladder = new RetryLadder(undefined, now);
  ladder.failed("gone", true);
  assert.equal(ladder.exhausted("gone"), true);
  time.now += 1e9;
  assert.equal(ladder.ready("gone"), false);
});

test("clear forgets one key, retain forgets keys outside the active set", () => {
  const ladder = new RetryLadder(undefined, clock().now);
  ladder.failed("a");
  ladder.failed("b");
  ladder.failed("c");
  ladder.clear("a");
  assert.equal(ladder.waiting("a"), false);
  assert.equal(ladder.ready("a"), true);
  ladder.retain(new Set(["b"]));
  assert.equal(ladder.waiting("b"), true);
  assert.equal(ladder.waiting("c"), false);
  assert.equal(ladder.size, 1);
  ladder.reset();
  assert.equal(ladder.size, 0);
});

test("a failure after a success starts the ladder from the first step again", () => {
  const { time, now } = clock();
  const ladder = new RetryLadder(undefined, now);
  ladder.failed("a");
  ladder.failed("a");
  ladder.clear("a");
  ladder.failed("a");
  time.now += 2_000;
  assert.equal(ladder.ready("a"), true);
});

test("a NaN step waits forever rather than not at all", () => {
  const { time, now } = clock();
  const ladder = new RetryLadder([Number.NaN], now);
  ladder.failed("a");
  time.now += 1e9;
  assert.equal(ladder.ready("a"), false);
  assert.equal(ladder.exhausted("a"), true);
});
