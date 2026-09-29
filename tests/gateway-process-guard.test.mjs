// 1.03, the third layer: the gateway's process-level safety net (src/gateway/ProcessGuard.ts).
// Socket noise is one journal line and the process goes on; anything else — a programmer's error, or
// noise arriving faster than noise does — is the whole stack in the journal and one orderly
// shutdown(1). Driven through a fake EventEmitter and a fake clock: nothing here touches `process`.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import * as ProcessGuard from "../dist/code/gateway/ProcessGuard.js";

const { createShutdown, installProcessGuard, isSocketNoise, listeningServerError, stopsAccepting } = ProcessGuard;

const SOCKET_NOISE_CODES = [
  "ECONNRESET", "EPIPE", "ECONNABORTED", "ETIMEDOUT", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END",
  "ERR_STREAM_PREMATURE_CLOSE", "ERR_SOCKET_CLOSED",
];

function socketError(code) {
  return Object.assign(new Error(`read ${code}`), { code, syscall: "read" });
}

function acceptError(code) {
  return Object.assign(new Error(`accept ${code}`), { code, syscall: "accept" });
}

/** A thrown value on which every property read, and every conversion to a string, throws. */
function unreadable() {
  const trap = () => { throw new Error("no, you may not look"); };
  return new Proxy({}, { get: trap, has: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
}

function guarded(options = {}) {
  const target = new EventEmitter();
  const lines = [];
  const shutdowns = [];
  let clock = 1_000_000;
  const remove = installProcessGuard({
    target,
    log: (...args) => lines.push(args.map(String).join(" ")),
    shutdown: (code) => shutdowns.push(code),
    now: () => clock,
    ...options,
  });
  return { target, lines, shutdowns, remove, advance: (ms) => { clock += ms; } };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

/** createShutdown over a close the test finishes, fails or never ends, with a fake exit and timer. */
function shutdownHarness() {
  const exits = [];
  const lines = [];
  const timers = [];
  let closes = 0;
  let finish;
  let fail;
  const shutdown = createShutdown({
    close: () => {
      closes++;
      return new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    },
    exit: (code) => exits.push(code),
    log: (line) => lines.push(line),
    setTimer: (callback, ms) => { timers.push({ callback, ms }); },
  });
  return { shutdown, exits, lines, timers, closes: () => closes, finish: () => finish(), fail: (error) => fail(error) };
}

test("isSocketNoise knows the socket-level codes and nothing a programmer wrote", () => {
  for (const code of SOCKET_NOISE_CODES) assert.equal(isSocketNoise(socketError(code)), true, code);
  // Fixed at its source (UpgradeGuard), never silenced here.
  assert.equal(isSocketNoise(Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" })), false);
  assert.equal(isSocketNoise(new TypeError("Cannot read properties of undefined (reading 'send')")), false);
  assert.equal(isSocketNoise(undefined), false);
  assert.equal(isSocketNoise("ECONNRESET"), false);
  assert.equal(isSocketNoise({ code: 104 }), false);
});

test("ERR_HTTP_HEADERS_SENT is application code, not the network: a defect", () => {
  // Thrown synchronously by writeHead/setHeader on a response already answered; no peer causes it.
  const error = Object.assign(new Error("Cannot set headers after they are sent to the client"), {
    code: "ERR_HTTP_HEADERS_SENT",
  });
  assert.equal(isSocketNoise(error), false);
  const guard = guarded();
  guard.target.emit("uncaughtException", error, "uncaughtException");
  assert.deepEqual(guard.shutdowns, [1]);
  assert.ok(guard.lines.some((line) => line.includes(error.stack)), guard.lines.join("\n"));
});

test("an accept failure is never socket noise, whatever its code: the guard shuts down", () => {
  // On Windows the listening socket never accepts again after one (uv__process_tcp_accept_req).
  const reset = acceptError("ECONNRESET");
  assert.equal(stopsAccepting(reset), true);
  assert.equal(stopsAccepting(acceptError("EMFILE")), true);
  assert.equal(stopsAccepting(socketError("ECONNRESET")), false);
  assert.equal(stopsAccepting(undefined), false);
  assert.equal(isSocketNoise(reset), false);
  const guard = guarded();
  guard.target.emit("uncaughtException", reset, "uncaughtException");
  assert.deepEqual(guard.shutdowns, [1]);
});

test("a listening server's accept failure is thrown on with a clear line; any other server error is only logged", () => {
  const lines = [];
  const log = (line) => lines.push(line);
  const failure = acceptError("EMFILE");
  assert.throws(() => listeningServerError(failure, log), (thrown) => thrown === failure);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /stopped accepting connections \(accept EMFILE\)/);
  const other = Object.assign(new Error("something else went wrong"), { code: "EIO" });
  listeningServerError(other, log);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /HTTP server error/);
  assert.ok(lines[1].includes(other.stack), "with its stack");
});

test("socket noise through uncaughtException is one journal line, and no shutdown", () => {
  const guard = guarded();
  guard.target.emit("uncaughtException", socketError("ECONNRESET"), "uncaughtException");
  assert.deepEqual(guard.shutdowns, []);
  assert.equal(guard.lines.length, 1);
  assert.match(guard.lines[0], /ECONNRESET/);
  assert.equal(guard.lines[0].includes("\n"), false, "one line, not a stack");
});

test("a programmer's error is journalled with its whole stack and shuts down with 1, exactly once", () => {
  const guard = guarded();
  const error = new TypeError("Cannot read properties of undefined (reading 'handleUpgrade')");
  guard.target.emit("uncaughtException", error, "uncaughtException");
  guard.target.emit("uncaughtException", new RangeError("a second failure while closing"), "uncaughtException");
  assert.deepEqual(guard.shutdowns, [1]);
  assert.ok(guard.lines.some((line) => line.includes(error.stack)), guard.lines.join("\n"));
  assert.ok(guard.lines.some((line) => line.includes("a second failure while closing")), "the second is journalled too");
});

test("a thrown value that cannot even be read is a defect, and the listener itself never throws", () => {
  // A throw out of an `uncaughtException` listener ends the process at once with exit code 7.
  const guard = guarded();
  assert.equal(isSocketNoise(unreadable()), false);
  assert.equal(stopsAccepting(unreadable()), false);
  assert.doesNotThrow(() => guard.target.emit("uncaughtException", unreadable(), "uncaughtException"));
  assert.doesNotThrow(() => guard.target.emit("unhandledRejection", unreadable(), Promise.resolve()));
  assert.deepEqual(guard.shutdowns, [1]);
  assert.ok(guard.lines.length >= 2, guard.lines.join("\n"));
});

test("a guard whose own bookkeeping fails still shuts down rather than throw", () => {
  const guard = guarded({ now: () => { throw new Error("the clock broke"); } });
  assert.doesNotThrow(() => guard.target.emit("uncaughtException", socketError("ECONNRESET"), "uncaughtException"));
  assert.deepEqual(guard.shutdowns, [1]);
});

test("twenty-one socket errors inside ten seconds are no longer noise", () => {
  const guard = guarded();
  for (let index = 0; index < 20; index++) guard.target.emit("uncaughtException", socketError("EPIPE"));
  assert.deepEqual(guard.shutdowns, []);
  assert.equal(guard.lines.length, 20);
  guard.advance(9_999);
  const last = socketError("EPIPE");
  guard.target.emit("uncaughtException", last);
  assert.deepEqual(guard.shutdowns, [1]);
  assert.ok(guard.lines.some((line) => line.includes(last.stack)), "the burst ends with the whole stack");
});

test("the burst window slides: the same errors spread past ten seconds never add up", () => {
  const guard = guarded();
  for (let index = 0; index < 20; index++) guard.target.emit("uncaughtException", socketError("ECONNRESET"));
  guard.advance(10_000);
  for (let index = 0; index < 20; index++) guard.target.emit("uncaughtException", socketError("ECONNRESET"));
  assert.deepEqual(guard.shutdowns, []);
  guard.target.emit("uncaughtException", socketError("ECONNRESET"));
  assert.deepEqual(guard.shutdowns, [1], "and the window still counts what is inside it");
});

test("the burst limit is configurable", () => {
  const guard = guarded({ burst: { count: 2, windowMs: 1_000 } });
  guard.target.emit("uncaughtException", socketError("ETIMEDOUT"));
  guard.target.emit("uncaughtException", socketError("ETIMEDOUT"));
  assert.deepEqual(guard.shutdowns, []);
  guard.target.emit("uncaughtException", socketError("ETIMEDOUT"));
  assert.deepEqual(guard.shutdowns, [1]);
});

test("unhandledRejection is classified the same way", () => {
  const guard = guarded();
  guard.target.emit("unhandledRejection", socketError("ERR_STREAM_PREMATURE_CLOSE"), Promise.resolve());
  assert.deepEqual(guard.shutdowns, []);
  assert.equal(guard.lines.length, 1);
  const error = new TypeError("route handler failed");
  guard.target.emit("unhandledRejection", error, Promise.resolve());
  assert.deepEqual(guard.shutdowns, [1]);
  assert.ok(guard.lines.some((line) => line.includes(error.stack)), guard.lines.join("\n"));
});

test("a rejection that is not an Error still shuts down, and says what it was", () => {
  const guard = guarded();
  guard.target.emit("unhandledRejection", "just a string", Promise.resolve());
  assert.deepEqual(guard.shutdowns, [1]);
  assert.ok(guard.lines.some((line) => line.includes("just a string")), guard.lines.join("\n"));
});

test("removing the guard takes both listeners off", () => {
  const guard = guarded();
  assert.equal(guard.target.listenerCount("uncaughtException"), 1);
  assert.equal(guard.target.listenerCount("unhandledRejection"), 1);
  guard.remove();
  assert.equal(guard.target.listenerCount("uncaughtException"), 0);
  assert.equal(guard.target.listenerCount("unhandledRejection"), 0);
  guard.target.emit("uncaughtException", new TypeError("after removal"));
  assert.deepEqual(guard.shutdowns, []);
  assert.deepEqual(guard.lines, []);
});

test("shutdown closes once, and a defect's exit code survives the Ctrl+C that was already closing", async () => {
  const run = shutdownHarness();
  run.shutdown(0);
  run.shutdown(1, 5_000);
  assert.equal(run.closes(), 1);
  assert.deepEqual(run.exits, []);
  run.finish();
  await settled();
  assert.deepEqual(run.exits, [1]);
});

test("shutdown without a cap waits for the close, as a Ctrl+C always has", async () => {
  const run = shutdownHarness();
  run.shutdown(0);
  assert.deepEqual(run.timers, []);
  run.finish();
  await settled();
  assert.deepEqual(run.exits, [0]);
});

test("a close that hangs is cut off by the cap, the journal says so, and nothing exits twice", async () => {
  const run = shutdownHarness();
  run.shutdown(1, 5_000);
  assert.deepEqual(run.timers.map((timer) => timer.ms), [5_000]);
  run.timers[0].callback();
  assert.deepEqual(run.exits, [1]);
  assert.match(run.lines.join("\n"), /did not finish within 5000 ms/);
  run.finish();
  await settled();
  assert.deepEqual(run.exits, [1]);
});

test("a close that fails still leaves, with an exit code of at least 1", async () => {
  const run = shutdownHarness();
  run.shutdown(0);
  run.fail(new Error("server.close failed"));
  await settled();
  assert.deepEqual(run.exits, [1]);
  assert.match(run.lines.join("\n"), /server\.close failed/);
});
