// 1.03: no request and no connection reset can end the gateway process.
//
// Every attack runs against the real `startGateway` in a child process (tests/fixtures/gateway-child.mjs)
// on an ephemeral loopback port, never the owner's 8090, and without ProcessGuard: what is proved here
// is the upgrade handler itself. Resets come in series of fifty because a single RST races the
// refusal's own write and survives often enough to hide the defect (see `resetSeries`).
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

const ORIGIN = "http://127.0.0.1:5173";
const FOREIGN_ORIGIN = "http://evil.example";
const THROWING_ORIGIN = "http://throws.example";
const SERIES = 50;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/gateway-child.mjs", import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `message` may be a function, read only when the time is up (say, for the output so far). */
async function withTimeout(promise, ms, message) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(typeof message === "function" ? message() : message)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** A WebSocket upgrade written byte for byte: `fetch` and `ws` would normalise the path first. */
function upgradeRequest(path, origin) {
  return `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
    + "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
}

async function startChild({ env: extraEnv = {}, readyTimeoutMs = 60_000 } = {}) {
  const env = { ...process.env, GATEWAY_CHILD_ORIGIN: ORIGIN, GATEWAY_CHILD_THROWING_ORIGIN: THROWING_ORIGIN, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(fixture, [], {
    cwd: repositoryRoot,
    env,
    // The --import hooks this file runs under, so the child loads the same (current) sources.
    execArgv: process.execArgv.filter((argument) => !argument.startsWith("--test")),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const pending = new Map();
  let listening;
  const ready = new Promise((resolve) => { listening = resolve; });
  child.on("message", (message) => {
    if (typeof message?.port === "number") listening(message.port);
    else pending.get(message?.id)?.(message);
  });
  const died = exited.then((exit) => { throw new Error(`the gateway child exited (${JSON.stringify(exit)}):\n${output}`); });
  let port;
  try {
    port = await withTimeout(Promise.race([ready, died]), readyTimeoutMs, "not ready");
  } catch (error) {
    // A child that is alive but never reports its port would otherwise hold the run open until the
    // wrapper's own timeout: kill it, wait for it to be gone, and only then fail.
    if (child.exitCode !== null || child.signalCode !== null) throw error;
    child.kill();
    const exit = await exited;
    throw new Error(`the gateway child did not report its port within ${readyTimeoutMs} ms; killed it `
      + `(${JSON.stringify(exit)}):\n${output}`, { cause: error });
  }
  let nextId = 0;
  return {
    port,
    exited,
    output: () => output,
    /** One IPC question: `sockets`, or `server-error` with the `code` and `syscall` to emit. */
    ask(question, details = {}) {
      const id = ++nextId;
      const reply = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.send({ ...details, id, ask: question }, (error) => { if (error) reject(error); });
      });
      return withTimeout(Promise.race([reply, died]), 10_000, () => `no answer to ${question}:\n${output}`)
        .finally(() => pending.delete(id));
    },
    /** Waits a moment for a crash to land, then insists there was none. */
    async assertAlive(context) {
      const outcome = await Promise.race([exited, delay(500).then(() => "alive")]);
      assert.equal(outcome, "alive", `the gateway process died ${context}: ${JSON.stringify(outcome)}\n${output}`);
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

/** A raw client that keeps its half of the connection open until told otherwise; undefined if refused. */
function openRaw(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    socket.on("error", () => {});
    socket.once("connect", () => resolve(socket));
    socket.once("close", () => resolve(undefined));
  });
}

/** The status line the gateway answers a raw request with, or undefined when it answers nothing. */
async function statusOf(port, request) {
  const socket = await openRaw(port);
  if (!socket) return undefined;
  return new Promise((resolve) => {
    let text = "";
    const finish = (status) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => finish(undefined), 5_000);
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\r\n")) finish(Number(/^HTTP\/1\.1 (\d{3}) /.exec(text)?.[1]));
    });
    socket.once("end", () => finish(undefined));
    socket.once("close", () => finish(undefined));
    socket.write(request);
  });
}

/** Resolves once the gateway has answered on `socket` (or closed it, or after two seconds). */
function answered(socket) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 2_000);
    socket.once("data", done);
    socket.once("end", done);
    socket.once("close", done);
  });
}

/**
 * `count` upgrades, each ended by a reset (RST); returns how many went out before the port closed.
 *
 * What the two halves prove differs. The second half resets each connection only after the refusal
 * has been read: a refusal that leaves its socket half-open (`socket.end()` without `destroy`) meets
 * that RST as `read ECONNRESET`, every time, so these catch a refusal that does not close. The first
 * half is a burst — every connection open before any request is written, then each request followed
 * at once by its RST — so the gateway often finds the RST already in when it writes its refusal
 * (`write ECONNRESET`). That half is a race: it catches a missing per-socket `error` listener only
 * with some probability. The reliable guard for that listener is the `refuseUpgrade` unit test with a
 * Duplex whose write fails.
 */
async function resetSeries(port, request, count = SERIES) {
  const burst = [];
  for (let index = 0; index < Math.ceil(count / 2); index++) {
    const socket = await openRaw(port);
    if (!socket) break;
    burst.push(socket);
  }
  for (const socket of burst) {
    socket.write(request);
    socket.resetAndDestroy();
  }
  let sent = burst.length;
  if (sent < Math.ceil(count / 2)) return sent;
  for (; sent < count; sent++) {
    const socket = await openRaw(port);
    if (!socket) break;
    socket.write(request);
    await answered(socket);
    socket.resetAndDestroy();
  }
  return sent;
}

function health(port) {
  return new Promise((resolve) => {
    const call = httpRequest({ host: "127.0.0.1", port, path: "/health", agent: false, headers: { connection: "close" } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
    call.once("error", (error) => resolve(`failed: ${error.code ?? error.message}`));
    call.setTimeout(5_000, () => call.destroy(new Error("timed out")));
    call.end();
  });
}

function openWebSocket(port, path) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin: ORIGIN });
    socket.on("error", () => {});
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_, response) => reject(new Error(`the upgrade was answered ${response.statusCode}`)));
    socket.once("error", reject);
  });
}

/** Eight bridged sockets from one address: MAX_BRIDGED_SOCKETS_PER_ADDRESS, so the ninth is a 503. */
async function exhaustPerAddressLimit(gateway) {
  const clients = [];
  for (let index = 0; index < 8; index++) clients.push(await openWebSocket(gateway.port, index % 2 ? "/world" : "/auth"));
  // Every bridge has reached the backend: from here the child's socket count is steady.
  const started = Date.now();
  let state = await gateway.ask("sockets");
  while (state.backend < 8 && Date.now() - started < 10_000) {
    await delay(25);
    state = await gateway.ask("sockets");
  }
  assert.equal(state.backend, 8, `eight bridges reach the backend: ${JSON.stringify(state)}`);
  assert.deepEqual(state.connections, { auth: 4, world: 4 });
  return { clients, state };
}

test("originAllowed is the one Origin rule: an exact entry or `*`, and never no Origin at all", async () => {
  const { originAllowed } = await import("../dist/code/gateway/UpgradeGuard.js");
  assert.equal(originAllowed(ORIGIN, [ORIGIN]), true);
  assert.equal(originAllowed(FOREIGN_ORIGIN, [ORIGIN]), false);
  assert.equal(originAllowed(`${ORIGIN}/`, [ORIGIN]), false, "compared as written, not normalised");
  assert.equal(originAllowed(FOREIGN_ORIGIN, ["*"]), true);
  assert.equal(originAllowed(undefined, ["*"]), false);
  assert.equal(originAllowed(undefined, []), false);
});

test("routeUpgrade checks the Origin first, then a path that parses, then the two routes", async () => {
  const { routeUpgrade } = await import("../dist/code/gateway/UpgradeGuard.js");
  const route = (url, origin, allowedOrigins = [ORIGIN]) =>
    routeUpgrade({ url, headers: origin === undefined ? {} : { origin } }, { allowedOrigins });
  assert.deepEqual(route("/auth", ORIGIN), { kind: "auth" });
  assert.deepEqual(route("/world?realm=1", ORIGIN), { kind: "world" });
  assert.deepEqual(route("/auth", FOREIGN_ORIGIN), { kind: "refuse", status: 403 });
  assert.deepEqual(route("/auth", undefined), { kind: "refuse", status: 403 });
  // A foreign page is refused before its path is ever parsed.
  assert.deepEqual(route("//[::1", FOREIGN_ORIGIN), { kind: "refuse", status: 403 });
  assert.deepEqual(route("//[::1", ORIGIN), { kind: "refuse", status: 400 });
  assert.deepEqual(route("/nope", ORIGIN), { kind: "refuse", status: 404 });
  assert.deepEqual(route(undefined, ORIGIN), { kind: "refuse", status: 404 });
  assert.deepEqual(route("/world", "http://192.168.1.25:5173", ["*"]), { kind: "world" });
});

test("refuseUpgrade answers the status and destroys the socket, also when the peer has gone", async () => {
  const { refuseUpgrade } = await import("../dist/code/gateway/UpgradeGuard.js");
  const closed = (stream) => Promise.race([new Promise((resolve) => stream.once("close", resolve)), delay(1_000)]);
  let written = "";
  const healthy = new Duplex({ read() {}, write(chunk, _, done) { written += chunk; done(); } });
  refuseUpgrade(healthy, 403);
  await closed(healthy);
  assert.equal(written, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  assert.equal(healthy.destroyed, true, "destroyed once the answer is out, not left half-open");

  const reset = new Duplex({
    read() {},
    write(_, __, done) { done(Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" })); },
  });
  refuseUpgrade(reset, 503);
  await closed(reset);
  assert.equal(reset.destroyed, true, "a failed write still ends in destroy, and its 'error' is not thrown");
});

test("an unparseable upgrade path is answered 400 and the gateway lives", async () => {
  const gateway = await startChild();
  try {
    const request = upgradeRequest("//[::1", ORIGIN);
    assert.equal(await statusOf(gateway.port, request), 400, `GET //[::1 is refused as a bad request:\n${gateway.output()}`);
    await gateway.assertAlive("after GET //[::1");
    assert.equal(await health(gateway.port), 200);
  } finally {
    await gateway.stop();
  }
});

for (const branch of [
  { status: 400, path: "//[::1", origin: ORIGIN },
  { status: 403, path: "/auth", origin: FOREIGN_ORIGIN },
  { status: 404, path: "/nope", origin: ORIGIN },
  { status: 503, path: "/auth", origin: ORIGIN, exhaust: true },
]) {
  test(`${SERIES} upgrades reset on the ${branch.status} branch do not end the gateway`, async () => {
    const gateway = await startChild();
    let clients = [];
    try {
      if (branch.exhaust) ({ clients } = await exhaustPerAddressLimit(gateway));
      const request = upgradeRequest(branch.path, branch.origin);
      assert.equal(await statusOf(gateway.port, request), branch.status, `the branch under test:\n${gateway.output()}`);
      const sent = await resetSeries(gateway.port, request);
      await gateway.assertAlive(`after ${sent} of ${SERIES} resets on the ${branch.status} branch`);
      assert.equal(sent, SERIES, "every connection of the series was accepted");
      assert.equal(await health(gateway.port), 200);
      assert.equal(await statusOf(gateway.port, request), branch.status, "and the branch still answers the same");
    } finally {
      for (const client of clients) client.terminate();
      await gateway.stop();
    }
  });
}

test("refused clients that never close leave no socket open in the gateway", async () => {
  const gateway = await startChild();
  const refused = [];
  let clients = [];
  try {
    const exhausted = await exhaustPerAddressLimit(gateway);
    clients = exhausted.clients;
    const live = exhausted.state.sockets;
    const branches = [
      { status: 403, request: upgradeRequest("/auth", FOREIGN_ORIGIN) },
      { status: 404, request: upgradeRequest("/nope", ORIGIN) },
      { status: 503, request: upgradeRequest("/world", ORIGIN) },
    ];
    for (let index = 0; index < 100; index++) {
      const branch = branches[index % branches.length];
      const socket = await openRaw(gateway.port);
      assert.ok(socket, `connection ${index} was accepted:\n${gateway.output()}`);
      const client = { socket, status: branch.status, text: "" };
      socket.setEncoding("latin1").on("data", (chunk) => { client.text += chunk; });
      socket.write(branch.request);
      refused.push(client);
    }
    await delay(1_000);
    const after = await gateway.ask("sockets");
    assert.ok(after.sockets <= live,
      `${after.sockets - live} of 100 refused sockets are still open in the gateway (live bridges hold ${live})`);
    for (const client of refused) assert.match(client.text, new RegExp(`^HTTP/1\\.1 ${client.status} `), "each got its answer first");
    await gateway.assertAlive("after 100 half-open refusals");
    assert.equal(await health(gateway.port), 200);
  } finally {
    for (const client of refused) client.socket.destroy();
    for (const client of clients) client.terminate();
    await gateway.stop();
  }
});

test("an exception inside the upgrade handler is answered 500 and the gateway lives", async () => {
  const gateway = await startChild();
  try {
    assert.equal(await statusOf(gateway.port, upgradeRequest("/auth", THROWING_ORIGIN)), 500, gateway.output());
    await gateway.assertAlive("after an exception in the upgrade handler");
    assert.match(gateway.output(), /allowed-origin lookup failed/, "the exception is in the log");
    assert.equal(await health(gateway.port), 200);
  } finally {
    await gateway.stop();
  }
});

test("an accept failure ends the gateway with a clear line instead of leaving it deaf", async () => {
  // On Windows the listening socket never accepts again after one; the process guard (not in this
  // child) turns the throw into an orderly shutdown(1), and without it Node ends the process.
  const gateway = await startChild();
  try {
    await assert.rejects(gateway.ask("server-error", { code: "EMFILE", syscall: "accept" }), /gateway child exited/);
    const exit = await gateway.exited;
    assert.notEqual(exit.code, 0, JSON.stringify(exit));
    assert.match(gateway.output(), /stopped accepting connections \(accept EMFILE\)/);
  } finally {
    await gateway.stop();
  }
});

test("any other error on the HTTP server after listen is logged and the gateway lives", async () => {
  const gateway = await startChild();
  try {
    await gateway.ask("server-error", { code: "EIO" });
    await gateway.assertAlive("after an HTTP server error that is not an accept failure");
    assert.match(gateway.output(), /HTTP server error/);
    assert.equal(await health(gateway.port), 200);
    const socket = await openWebSocket(gateway.port, "/auth");
    socket.terminate();
  } finally {
    await gateway.stop();
  }
});

test("a child that never reports its port is killed, not left running", async () => {
  // The silent child would leave by itself after 20 s; failing well before that is the kill.
  const started = Date.now();
  await assert.rejects(startChild({ env: { GATEWAY_CHILD_SILENT: "1" }, readyTimeoutMs: 2_000 }),
    /did not report its port within 2000 ms; killed it/);
  assert.ok(Date.now() - started < 15_000, `the child was gone after ${Date.now() - started} ms`);
});
