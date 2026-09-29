import assert from "node:assert/strict";
import test from "node:test";

// М2 «Новый DBC-маршрут», the browser half (docs/implementation/line-A3.ru.md): RetryingCatalogClient
// memoises a success, never a failure, retries on 2 → 5 → 15 → 60 s (the last pause repeating) for
// six attempts, then waits for retry(); a 404 is an older gateway without the route — one more
// attempt after 15 s. The clock and fetch are fakes, so nothing here waits or touches the network.
const {
  RetryingCatalogClient, CATALOG_MAX_ATTEMPTS, CATALOG_RETRY_DELAYS, CATALOG_STALE_GATEWAY_DELAY,
} = await import("../dist/code/browser/CatalogClient.js");

const ORIGIN = "http://127.0.0.1:8090";
const PATH = "/dbc/example?v=1";

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

/** Timers that fire only when the test advances them. */
function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    setTimeout(callback, milliseconds) {
      const timer = { at: now + milliseconds, milliseconds, callback };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    /** The pauses scheduled and not yet run. */
    get pending() {
      return timers.map((timer) => timer.milliseconds);
    },
    async advance(milliseconds) {
      const until = now + milliseconds;
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const due = timers[0];
        if (!due || due.at > until) break;
        timers.shift();
        now = due.at;
        due.callback();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

/** Answers in order: "network" throws like a refused connection, a number is a bare status. */
function scriptedFetch(answers) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const answer = answers.length ? answers.shift() : 404;
    if (answer === "network") throw new TypeError("Failed to fetch");
    if (typeof answer === "number") return new Response("", { status: answer });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const GOOD = { version: 1, rows: [1, 2, 3] };
const validate = (data) => (data?.version === 1 && Array.isArray(data.rows) ? data.rows : undefined);

function client(answers, options = {}) {
  const clock = fakeClock();
  const { fetch, calls } = scriptedFetch(answers);
  const catalog = new RetryingCatalogClient(ORIGIN, PATH, validate, { fetch, clock, ...options });
  const loaded = [];
  catalog.onLoaded = (value) => loaded.push(value);
  return { catalog, clock, calls, loaded };
}

test("the schedule is the plan's: 2, 5, 15 and 60 s, six attempts, 15 s after a 404", () => {
  assert.deepEqual([...CATALOG_RETRY_DELAYS], [2_000, 5_000, 15_000, 60_000]);
  assert.equal(CATALOG_MAX_ATTEMPTS, 6);
  assert.equal(CATALOG_STALE_GATEWAY_DELAY, 15_000);
});

test("two failures, then success: the rows land, after 2 s and then 5 s, and are memoised", async () => {
  const { catalog, clock, calls, loaded } = client(["network", 500, GOOD]);
  assert.equal(catalog.state, "idle");
  await catalog.load();
  assert.deepEqual(calls, [`${ORIGIN}${PATH}`], "the first attempt goes at once");
  assert.equal(catalog.state, "loading");
  assert.equal(catalog.lastStatus, 0, "a refused connection is status 0");
  assert.deepEqual(clock.pending, [2_000]);

  await clock.advance(1_999);
  assert.equal(calls.length, 1, "not before the pause is over");
  await clock.advance(1);
  assert.equal(calls.length, 2);
  assert.equal(catalog.lastStatus, 500);
  assert.deepEqual(clock.pending, [5_000], "the second pause is longer");

  await clock.advance(5_000);
  assert.equal(calls.length, 3);
  assert.equal(catalog.state, "ready");
  assert.deepEqual(catalog.value, [1, 2, 3]);
  assert.deepEqual(loaded, [[1, 2, 3]], "onLoaded is told once");
  assert.deepEqual(clock.pending, []);

  await catalog.load();
  await catalog.retry();
  await clock.advance(600_000);
  assert.equal(calls.length, 3, "a success is memoised: nothing asks again");
});

test("six failures end the cycle: failed, nothing scheduled, until retry() starts a new one", async () => {
  const { catalog, clock, calls, loaded } = client(["network", "network", 503, "network", 502, "network", GOOD]);
  await catalog.load();
  const pauses = [];
  while (clock.pending.length) {
    pauses.push(...clock.pending);
    await clock.advance(clock.pending[0]);
  }
  assert.deepEqual(pauses, [2_000, 5_000, 15_000, 60_000, 60_000], "60 s is the ceiling and repeats");
  assert.equal(calls.length, 6);
  assert.equal(catalog.state, "failed");

  await clock.advance(3_600_000);
  await catalog.load();
  assert.equal(calls.length, 6, "a failed client stays quiet: load() is not retry()");
  assert.equal(catalog.state, "failed");

  await catalog.retry();
  assert.equal(calls.length, 7, "the next world mount asks again at once");
  assert.equal(catalog.state, "ready");
  assert.deepEqual(loaded, [[1, 2, 3]]);
});

test("a 404 is an older gateway: one more attempt after 15 s, and a second 404 gives up at once", async () => {
  const { catalog, clock, calls } = client([404, 404, GOOD]);
  await catalog.load();
  assert.equal(catalog.lastStatus, 404);
  assert.deepEqual(clock.pending, [15_000]);
  await clock.advance(15_000);
  assert.equal(calls.length, 2);
  assert.equal(catalog.state, "failed", "the route is not there; asking every minute would be noise");
  assert.deepEqual(clock.pending, []);
  await catalog.retry();
  assert.equal(catalog.state, "ready", "a gateway restarted before the next mount answers");
});

test("a 400 is an older gateway on another ?v=: handled like a 404", async () => {
  const { catalog, clock, calls } = client([400, 400, GOOD]);
  await catalog.load();
  assert.equal(catalog.lastStatus, 400);
  assert.deepEqual(clock.pending, [15_000], "one more attempt after 15 s, not the short schedule");
  await clock.advance(15_000);
  assert.equal(calls.length, 2);
  assert.equal(catalog.state, "failed");
  await catalog.retry();
  assert.equal(catalog.state, "ready");
});

test("retry() while a retry is already scheduled asks nothing more", async () => {
  const { catalog, clock, calls } = client(["network", GOOD]);
  await catalog.load();
  assert.deepEqual(clock.pending, [2_000]);
  await catalog.retry();
  await catalog.retry();
  await catalog.load();
  assert.equal(calls.length, 1, "the scheduled attempt is the next request");
  assert.deepEqual(clock.pending, [2_000], "and still the only timer");
  await clock.advance(2_000);
  assert.equal(calls.length, 2);
  assert.equal(catalog.state, "ready");
});

test("a gateway restarted within the 15 s answers the second attempt", async () => {
  const { catalog, clock, calls } = client([404, GOOD]);
  await catalog.load();
  await clock.advance(15_000);
  assert.equal(calls.length, 2);
  assert.equal(catalog.state, "ready");
});

test("a 200 of the wrong shape is a failure to retry, not a value", async () => {
  const { catalog, clock, calls, loaded } = client([{ version: 2, rows: [] }, GOOD]);
  await catalog.load();
  assert.equal(catalog.state, "loading");
  assert.equal(catalog.value, undefined);
  assert.deepEqual(clock.pending, [2_000]);
  await clock.advance(2_000);
  assert.equal(calls.length, 2);
  assert.deepEqual(loaded, [[1, 2, 3]]);
});

test("concurrent load() calls share one request", async () => {
  const { catalog, calls } = client([GOOD]);
  const first = catalog.load();
  const second = catalog.load();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(catalog.state, "ready");
});

test("stop() ends the schedule and drops an answer that arrives afterwards; retry() starts over", async () => {
  const { catalog, clock, calls } = client(["network", GOOD]);
  await catalog.load();
  assert.deepEqual(clock.pending, [2_000]);
  catalog.stop();
  assert.deepEqual(clock.pending, []);
  assert.equal(catalog.state, "idle");
  await clock.advance(600_000);
  assert.equal(calls.length, 1);
  await catalog.retry();
  assert.equal(calls.length, 2, "the next world mount asks at once");
  assert.equal(catalog.state, "ready");

  let answer;
  const late = new RetryingCatalogClient(ORIGIN, PATH, validate, {
    clock: fakeClock(),
    fetch: () => new Promise((resolve) => { answer = resolve; }),
  });
  const loaded = [];
  late.onLoaded = (value) => loaded.push(value);
  const pending = late.load();
  late.stop();
  answer(new Response(JSON.stringify(GOOD), { status: 200 }));
  await pending;
  await settle();
  assert.equal(late.value, undefined, "the answer belongs to a disposed client");
  assert.deepEqual(loaded, []);
});
