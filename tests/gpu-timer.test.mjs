import assert from "node:assert/strict";
import test from "node:test";
import { GpuTimer, MAX_PENDING_GPU_QUERIES } from "../dist/code/browser/GpuTimer.js";

class FakeGpuTimerGl {
  QUERY_RESULT_AVAILABLE = 0x8867;
  QUERY_RESULT = 0x8866;
  extension = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  supported = true;
  lost = false;
  disjoint = false;
  extensionRequests = 0;
  created = 0;
  queries = [];
  active = undefined;
  available = new Set();
  results = new Map();
  calls = [];
  deleted = [];
  lossAt = undefined;
  nullCreateWithLoss = false;

  getExtension(name) {
    this.extensionRequests++;
    this.calls.push(["extension", name]);
    return this.supported ? this.extension : null;
  }

  getParameter(parameter) {
    assert.equal(parameter, this.extension.GPU_DISJOINT_EXT);
    this.calls.push(["disjoint"]);
    return this.disjoint;
  }

  createQuery() {
    this.throwWithContextLoss("create");
    if (this.nullCreateWithLoss) {
      this.nullCreateWithLoss = false;
      this.lost = true;
      this.calls.push(["create-null"]);
      return null;
    }
    const query = { id: ++this.created };
    this.queries.push(query);
    this.calls.push(["create", query.id]);
    return query;
  }

  beginQuery(target, query) {
    assert.equal(target, this.extension.TIME_ELAPSED_EXT);
    assert.equal(this.active, undefined);
    this.calls.push(["begin", query.id]);
    this.throwWithContextLoss("begin");
    this.active = query;
  }

  endQuery(target) {
    assert.equal(target, this.extension.TIME_ELAPSED_EXT);
    assert.ok(this.active);
    this.calls.push(["end", this.active.id]);
    this.throwWithContextLoss("end");
    this.active = undefined;
  }

  getQueryParameter(query, parameter) {
    if (parameter === this.QUERY_RESULT_AVAILABLE) {
      this.calls.push(["available", query.id]);
      this.throwWithContextLoss("availability");
      return this.available.has(query);
    }
    assert.equal(parameter, this.QUERY_RESULT);
    assert.equal(this.available.has(query), true, "result is never read before availability");
    this.calls.push(["result", query.id]);
    return this.results.get(query);
  }

  deleteQuery(query) {
    this.deleted.push(query);
    this.calls.push(["delete", query.id]);
  }

  isContextLost() {
    return this.lost;
  }

  finish() {
    assert.fail("a timer query must never force GPU completion");
  }

  throwWithContextLoss(stage) {
    if (this.lossAt !== stage) return;
    this.lossAt = undefined;
    this.lost = true;
    this.active = undefined;
    throw new Error(`context lost during ${stage}`);
  }
}

test("an absent timer extension is unavailable rather than a zero-millisecond sample", () => {
  const gl = new FakeGpuTimerGl();
  gl.supported = false;
  const timer = new GpuTimer(gl);

  assert.equal(timer.beginFrame(), false);
  assert.deepEqual(timer.reading, {
    status: "unavailable",
    reason: "unsupported",
    pending: 0,
    dropped: 0,
  });
  assert.equal("milliseconds" in timer.reading, false);
  assert.equal(gl.created, 0);
});

test("polling is nonblocking and reads elapsed nanoseconds only after availability", () => {
  const gl = new FakeGpuTimerGl();
  const timer = new GpuTimer(gl);

  assert.equal(timer.beginFrame(), true);
  gl.calls.push(["sky"]);
  gl.calls.push(["clear-depth"]);
  gl.calls.push(["world"]);
  timer.endFrame();

  assert.deepEqual(timer.reading, { status: "pending", pending: 1, dropped: 0 });
  assert.equal(gl.calls.some(([call]) => call === "result"), false);
  assert.deepEqual(gl.calls.filter(([call]) => ["available", "disjoint", "result"].includes(call)), [
    ["disjoint"], ["disjoint"], ["available", 1],
  ], "every poll checks disjoint once, then retains an unavailable query without reading its result");
  assert.deepEqual(gl.calls.filter(([call]) => ["begin", "sky", "clear-depth", "world", "end"].includes(call)), [
    ["begin", 1], ["sky"], ["clear-depth"], ["world"], ["end", 1],
  ], "one query surrounds both passes and their depth clear");
});

test("available results are converted to milliseconds and their query is deleted", () => {
  const gl = new FakeGpuTimerGl();
  const timer = new GpuTimer(gl);

  timer.beginFrame();
  timer.endFrame();
  const query = gl.queries[0];
  gl.results.set(query, 4_250_000);
  gl.available.add(query);

  const pollAt = gl.calls.length;
  assert.deepEqual(timer.reading, {
    status: "available",
    milliseconds: 4.25,
    pending: 0,
    dropped: 0,
    count: 1,
    average: 4.25,
    worst: 4.25,
    longFrames: 0,
    p50: 4.25,
    p95: 4.25,
    p99: 4.25,
  });
  assert.deepEqual(gl.calls.slice(pollAt), [
    ["disjoint"], ["available", 1], ["result", 1], ["delete", 1],
  ], "the poll checks disjoint once before reading any available result");
  assert.deepEqual(gl.deleted, [query]);
  assert.ok(gl.calls.findIndex(([call]) => call === "begin") < gl.calls.findIndex(([call]) => call === "end"));
});

test("GPU samples retain an immutable bounded percentile window", () => {
  const gl = new FakeGpuTimerGl();
  const timer = new GpuTimer(gl);
  for (const milliseconds of [4, 1, 3, 2]) {
    assert.equal(timer.beginFrame(), true);
    timer.endFrame();
    const query = gl.queries.at(-1);
    gl.results.set(query, milliseconds * 1_000_000);
    gl.available.add(query);
    void timer.reading;
  }

  const reading = timer.reading;
  assert.deepEqual(reading, {
    status: "available",
    milliseconds: 2,
    pending: 0,
    dropped: 0,
    count: 4,
    average: 2.5,
    worst: 4,
    longFrames: 0,
    p50: 2,
    p95: 4,
    p99: 4,
  });
  assert.equal(Object.isFrozen(reading), true);
  assert.throws(() => { reading.p95 = 999; }, TypeError);
});

test("the pending ring has a hard cap and skips frames instead of accumulating queries", () => {
  const gl = new FakeGpuTimerGl();
  const timer = new GpuTimer(gl);

  for (let frame = 0; frame < MAX_PENDING_GPU_QUERIES + 2; frame++) {
    if (timer.beginFrame()) timer.endFrame();
  }

  assert.equal(gl.created, MAX_PENDING_GPU_QUERIES);
  assert.deepEqual(timer.reading, {
    status: "pending",
    pending: MAX_PENDING_GPU_QUERIES,
    dropped: 2,
  });
  assert.equal(gl.deleted.length, 0, "an unresolved in-flight query is not deleted merely to make room");
});

test("disjoint invalidates queued results, deletes them, and the next valid frame recovers", () => {
  const gl = new FakeGpuTimerGl();
  const timer = new GpuTimer(gl);
  timer.beginFrame();
  timer.endFrame();
  gl.results.set(gl.queries[0], 2_000_000);
  gl.available.add(gl.queries[0]);
  assert.equal(timer.reading.count, 1);
  timer.beginFrame();
  timer.endFrame();

  gl.disjoint = true;
  gl.available.add(gl.queries[1]);
  const disjointPollAt = gl.calls.length;
  assert.deepEqual(timer.reading, {
    status: "unavailable",
    reason: "disjoint",
    pending: 0,
    dropped: 1,
  });
  assert.equal("count" in timer.reading, false, "invalid timing epochs do not retain old percentiles");
  assert.equal(gl.deleted.length, 2, "the completed sample and invalid pending query are both released");
  assert.deepEqual(gl.calls.slice(disjointPollAt, disjointPollAt + 2), [
    ["disjoint"], ["delete", 2],
  ]);
  assert.equal(gl.calls.some(([call, id]) => call === "result" && id === 2), false,
    "a disjoint completed query is never read");

  gl.disjoint = false;
  assert.equal(timer.beginFrame(), true);
  timer.endFrame();
  assert.deepEqual(timer.reading, { status: "pending", pending: 1, dropped: 1 });
});

test("context loss drops query handles without GL deletion and reacquires the extension on restore", () => {
  const gl = new FakeGpuTimerGl();
  const timer = new GpuTimer(gl);
  timer.beginFrame();
  timer.endFrame();
  assert.equal(gl.extensionRequests, 1);

  gl.lost = true;
  assert.deepEqual(timer.reading, {
    status: "unavailable",
    reason: "context-lost",
    pending: 0,
    dropped: 1,
  });
  assert.equal(gl.deleted.length, 0, "query APIs are not called on a lost context");

  gl.lost = false;
  assert.equal(timer.beginFrame(), true);
  assert.equal(gl.extensionRequests, 2, "restoration obtains a fresh extension object");
  timer.endFrame();
});

test("context loss races inside create, begin, end and query polling never escape or delete on lost GL", () => {
  for (const stage of ["create", "begin", "end", "availability"]) {
    const gl = new FakeGpuTimerGl();
    const timer = new GpuTimer(gl);

    if (stage === "create" || stage === "begin") {
      gl.lossAt = stage;
      assert.doesNotThrow(() => assert.equal(timer.beginFrame(), false), stage);
    } else {
      assert.equal(timer.beginFrame(), true, stage);
      if (stage === "end") {
        gl.lossAt = stage;
        assert.doesNotThrow(() => timer.endFrame(), stage);
      } else {
        timer.endFrame();
        gl.lossAt = stage;
        assert.doesNotThrow(() => void timer.reading, stage);
      }
    }

    assert.equal(timer.reading.status, "unavailable", stage);
    assert.equal(timer.reading.reason, "context-lost", stage);
    assert.equal(gl.deleted.length, 0, `${stage}: lost-context query handles are only forgotten`);

    gl.lost = false;
    assert.equal(timer.beginFrame(), true, `${stage}: timer recovers after restoration`);
    assert.equal(gl.extensionRequests, 2, `${stage}: restoration reacquires the extension`);
    timer.endFrame();
  }
});

test("a null query created during a context-loss race invalidates the extension and recovers", () => {
  const gl = new FakeGpuTimerGl();
  const timer = new GpuTimer(gl);
  gl.nullCreateWithLoss = true;

  assert.equal(timer.beginFrame(), false);
  assert.equal(timer.reading.status, "unavailable");
  assert.equal(timer.reading.reason, "context-lost");
  assert.equal(gl.deleted.length, 0);

  gl.lost = false;
  assert.equal(timer.beginFrame(), true);
  assert.equal(gl.extensionRequests, 2);
  timer.endFrame();
});

test("a later invalid query does not delete or count an earlier completed query twice", () => {
  const gl = new FakeGpuTimerGl();
  const timer = new GpuTimer(gl);
  timer.beginFrame();
  timer.endFrame();
  timer.beginFrame();
  timer.endFrame();
  for (const query of gl.queries) gl.available.add(query);
  gl.results.set(gl.queries[0], 1_000_000);
  gl.results.set(gl.queries[1], Number.NaN);

  assert.deepEqual(timer.reading, {
    status: "unavailable",
    reason: "query-error",
    pending: 0,
    dropped: 1,
  });
  assert.deepEqual(gl.deleted.map((query) => query.id), [1, 2]);
  assert.equal(gl.deleted.filter((query) => query.id === 1).length, 1);
});

test("non-numeric WebGL query results are unavailable, never coerced to zero milliseconds", () => {
  for (const result of [null, false, "0"]) {
    const gl = new FakeGpuTimerGl();
    const timer = new GpuTimer(gl);
    timer.beginFrame();
    timer.endFrame();
    gl.available.add(gl.queries[0]);
    gl.results.set(gl.queries[0], result);

    const reading = timer.reading;
    assert.deepEqual(reading, {
      status: "unavailable",
      reason: "query-error",
      pending: 0,
      dropped: 1,
    });
    assert.equal("milliseconds" in reading, false);
  }
});

test("observer receives every completed query once when one poll drains several", () => {
  const gl = new FakeGpuTimerGl();
  const samples = [];
  const timer = new GpuTimer(gl, { onSample: (milliseconds) => samples.push(milliseconds) });
  for (const milliseconds of [1.25, 2.5]) {
    assert.equal(timer.beginFrame(), true);
    timer.endFrame();
    const query = gl.queries.at(-1);
    gl.available.add(query);
    gl.results.set(query, milliseconds * 1_000_000);
  }

  assert.equal(timer.reading.count, 2);
  assert.deepEqual(samples, [1.25, 2.5]);
  void timer.reading;
  assert.deepEqual(samples, [1.25, 2.5], "a later reading cannot replay stale completed values");
});

test("observer exceptions are swallowed for samples, unavailable transitions, and drops", () => {
  const gl = new FakeGpuTimerGl();
  const observer = {
    onSample() { throw new Error("sample observer"); },
    onUnavailable() { throw new Error("unavailable observer"); },
    onDropped() { throw new Error("drop observer"); },
  };
  const timer = new GpuTimer(gl, observer);
  assert.equal(timer.beginFrame(), true);
  timer.endFrame();
  gl.available.add(gl.queries[0]);
  gl.results.set(gl.queries[0], 1_000_000);
  assert.doesNotThrow(() => void timer.reading);
  assert.equal(timer.reading.milliseconds, 1);

  assert.equal(timer.beginFrame(), true);
  timer.endFrame();
  gl.disjoint = true;
  assert.doesNotThrow(() => void timer.reading);
  assert.equal(timer.reading.reason, "disjoint");
});

test("a beginQuery failure publishes query-error before its discard", () => {
  const gl = new FakeGpuTimerGl();
  const events = [];
  gl.beginQuery = function beginQuery(target, query) {
    assert.equal(target, this.extension.TIME_ELAPSED_EXT);
    this.calls.push(["begin", query.id]);
    throw new Error("begin failed");
  };
  const timer = new GpuTimer(gl, {
    onUnavailable: (reason) => events.push(["unavailable", reason]),
    onDropped: (count, reason) => events.push(["dropped", count, reason]),
  });

  assert.equal(timer.beginFrame(), false);
  assert.deepEqual(events, [
    ["unavailable", "query-error"],
    ["dropped", 1, "discarded"],
  ]);
});

test("observer reports unavailable transitions once and both queue and epoch discards", () => {
  const gl = new FakeGpuTimerGl();
  const unavailable = [];
  const dropped = [];
  const timer = new GpuTimer(gl, {
    onUnavailable: (reason) => unavailable.push(reason),
    onDropped: (count, reason) => dropped.push([count, reason]),
  });
  for (let frame = 0; frame < MAX_PENDING_GPU_QUERIES + 2; frame++) {
    if (timer.beginFrame()) timer.endFrame();
  }
  assert.deepEqual(dropped, [[1, "queue-full"], [1, "queue-full"]],
    "each queue refusal is reported at the point it happens");

  assert.equal(timer.resetEpoch(), undefined);
  assert.deepEqual(dropped, [
    [1, "queue-full"], [1, "queue-full"], [MAX_PENDING_GPU_QUERIES, "epoch-reset"],
  ], "reset reports every unresolved query with a distinct reason");
  assert.deepEqual(timer.reading, { status: "pending", pending: 0, dropped: 0 });

  gl.lost = true;
  void timer.reading;
  void timer.reading;
  assert.deepEqual(unavailable, ["context-lost"], "repeated reads do not repeat one unavailable state");
  gl.lost = false;
  assert.equal(timer.beginFrame(), true);
  timer.endFrame();
  gl.lost = true;
  void timer.reading;
  assert.deepEqual(unavailable, ["context-lost", "context-lost"],
    "recovery permits a later transition of the same reason to be reported");
});

test("unsupported is reported once at construction and preserved by epoch reset", () => {
  const unavailable = [];
  const timer = new GpuTimer(undefined, { onUnavailable: (reason) => unavailable.push(reason) });
  assert.deepEqual(unavailable, ["unsupported"]);
  void timer.reading;
  assert.equal(timer.resetEpoch(), "unsupported");
  assert.deepEqual(unavailable, ["unsupported"]);
});
