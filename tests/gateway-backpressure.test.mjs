// 10.14 — a bridge pauses reading the side that is ahead instead of dropping the session at 4 MiB.
//
// A real gateway on port 0 bridges a real `ws` client to a TCP stub standing in for the worldserver.
// The limits are shrunk (kilobytes, not megabytes) so a pause happens long before loopback's own
// socket buffers would hide it; what is asserted is the behaviour, not the default numbers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import WebSocket from "ws";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { BRIDGE_FLOW_DEFAULTS, BridgeStats, bridgeFlowLimits } from "../dist/code/gateway/BridgeStats.js";

const ORIGIN = "http://127.0.0.1:5173";
const FLOW = { highBytes: 64 * 1024, lowBytes: 16 * 1024, hardLimitBytes: 2 * 1024 * 1024, pauseLimitMs: 20_000, checkMs: 25 };

/** Deterministic bytes, so order and completeness are one hash. */
function pattern(offset, length) {
  const chunk = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index++) chunk[index] = ((offset + index) * 31 + ((offset + index) >>> 11)) & 0xff;
  return chunk;
}

/** A worldserver stand-in. `onConnection` gets each bridged socket. */
async function backendStub(onConnection) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Writes `total` bytes respecting the socket's own backpressure; reports progress as it goes. */
function sendPattern(socket, total, progress) {
  return new Promise((resolve) => {
    let sent = 0;
    const pump = () => {
      while (sent < total && !socket.destroyed) {
        const length = Math.min(64 * 1024, total - sent);
        const ok = socket.write(pattern(sent, length));
        sent += length;
        progress.sent = sent;
        if (!ok) {
          socket.once("drain", pump);
          return;
        }
      }
      resolve(sent);
    };
    socket.once("close", () => resolve(sent));
    pump();
  });
}

function openClient(port, path = "/world") {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin: ORIGIN });
    client.on("error", () => {});
    client.once("open", () => resolve(client));
    client.once("unexpected-response", (_, response) => reject(new Error(`upgrade answered ${response.statusCode}`)));
  });
}

/** Waits until `read()` has not changed for `quietMs`, or `limitMs` passes. */
async function settle(read, quietMs = 400, limitMs = 10_000) {
  const started = Date.now();
  let last = read();
  let since = Date.now();
  while (Date.now() - started < limitMs) {
    await delay(25);
    const now = read();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return now;
  }
  return last;
}

async function withLogs(run) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => { lines.push(parts.join(" ")); };
  try {
    return await run(lines);
  } finally {
    console.log = original;
  }
}

async function gatewayTo(port, flow = FLOW) {
  return startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port },
    world: { host: "127.0.0.1", port },
    allowedOrigins: [ORIGIN],
    datasetPollMs: 0,
    bridgeFlow: flow,
    logBackpressure: true,
  });
}

test("a slow browser pauses the world stream instead of losing the session, and gets every byte in order", async () => {
  const TOTAL = 24 * 1024 * 1024;
  const progress = { sent: 0 };
  let finished;
  const backend = await backendStub((socket) => { finished = sendPattern(socket, TOTAL, progress); });
  await withLogs(async (lines) => {
    const gateway = await gatewayTo(backend.port);
    try {
      const client = await openClient(gateway.port);
      client.pause();
      const hash = createHash("sha256");
      let received = 0;
      let closed;
      client.on("message", (data) => {
        hash.update(data);
        received += data.byteLength;
      });
      client.once("close", (code, reason) => { closed = { code, reason: reason.toString() }; });

      // The browser reads nothing. Without the pause the gateway would read the whole 24 MiB into
      // its send queue; with it the stub's writes stall once the sockets in between are full.
      const stalledAt = await settle(() => progress.sent);
      assert.ok(stalledAt < TOTAL, `the backend is held back while the browser is not reading (sent ${stalledAt} of ${TOTAL})`);
      assert.equal(closed, undefined, "the session is still open");

      client.resume();
      const deadline = Date.now() + 30_000;
      while (received < TOTAL && Date.now() < deadline && closed === undefined) await delay(20);
      assert.equal(closed, undefined, `the session survived the slow reader: ${JSON.stringify(closed)}`);
      assert.equal(received, TOTAL, "every byte arrived");
      assert.equal(await finished, TOTAL);
      const expected = createHash("sha256");
      for (let offset = 0; offset < TOTAL; offset += 64 * 1024) expected.update(pattern(offset, Math.min(64 * 1024, TOTAL - offset)));
      assert.equal(hash.digest("hex"), expected.digest("hex"), "in order");

      client.close();
      const line = await (async () => {
        for (let wait = 0; wait < 200; wait++) {
          const found = lines.find((text) => text.startsWith("Gateway bridge world closed"));
          if (found) return found;
          await delay(10);
        }
        return undefined;
      })();
      assert.ok(line, `one line per closed bridge: ${JSON.stringify(lines)}`);
      const peak = Number(/peak to client (\d+) KiB/.exec(line)?.[1]);
      const pauses = Number(/pauses (\d+) client/.exec(line)?.[1]);
      assert.ok(pauses >= 1, `the bridge paused: ${line}`);
      // A paused socket can still deliver the chunk already read: the queue never passes the high
      // mark by more than one read (64 KiB) plus framing — memory per slow player is bounded.
      assert.ok(peak <= (FLOW.highBytes + 160 * 1024) / 1024, `queue towards the browser bounded: ${line}`);
      assert.doesNotMatch(line, /127\.0\.0\.1|::1/, "the log line carries no address");
    } finally {
      await gateway.close();
      await backend.close();
    }
  });
});

test("a browser that stops reading for longer than the pause limit is dropped, not held for ever", async () => {
  const progress = { sent: 0 };
  let backendClosed = false;
  const backend = await backendStub((socket) => {
    socket.once("close", () => { backendClosed = true; });
    void sendPattern(socket, 64 * 1024 * 1024, progress);
  });
  await withLogs(async (lines) => {
    const gateway = await gatewayTo(backend.port, { ...FLOW, pauseLimitMs: 300 });
    try {
      const client = await openClient(gateway.port);
      client.pause();
      const started = Date.now();
      while (!backendClosed && Date.now() - started < 10_000) await delay(20);
      assert.equal(backendClosed, true, "the worldserver socket is closed once the pause outlives its limit");
      assert.ok(progress.sent < 64 * 1024 * 1024, "and it never had to stream everything into memory");
      client.terminate();
      for (let wait = 0; wait < 200 && !lines.some((text) => text.includes("Client is too slow")); wait++) await delay(10);
      assert.ok(lines.some((text) => text.includes("(Client is too slow)")), `the reason is logged: ${JSON.stringify(lines)}`);
    } finally {
      await gateway.close();
      await backend.close();
    }
  });
});

test("a server that stops reading pauses the browser's stream; it resumes when the server drains", async () => {
  const MESSAGE = 60 * 1024;
  const COUNT = 200;
  let backendSocket;
  const backendHash = createHash("sha256");
  let backendReceived = 0;
  const backend = await backendStub((socket) => {
    backendSocket = socket;
    socket.pause();
    socket.on("data", (data) => {
      backendHash.update(data);
      backendReceived += data.byteLength;
    });
  });
  await withLogs(async (lines) => {
    const gateway = await gatewayTo(backend.port);
    try {
      const client = await openClient(gateway.port);
      let closed;
      client.once("close", (code) => { closed = code; });
      const expected = createHash("sha256");
      for (let index = 0; index < COUNT; index++) {
        const payload = pattern(index * MESSAGE, MESSAGE);
        expected.update(payload);
        client.send(payload, { binary: true });
      }
      // The server reads nothing. Loopback on Windows absorbs megabytes in the kernel on both
      // sides, so the evidence of the pause is the bridge's own count (its log line), not the
      // browser's queue.
      await settle(() => client.bufferedAmount);
      assert.equal(backendReceived, 0, "the stub really is not reading");
      assert.equal(closed, undefined);

      backendSocket.resume();
      const deadline = Date.now() + 30_000;
      while (backendReceived < MESSAGE * COUNT && Date.now() < deadline && closed === undefined) await delay(20);
      assert.equal(closed, undefined, "the session survived the slow server");
      assert.equal(backendReceived, MESSAGE * COUNT);
      assert.equal(backendHash.digest("hex"), expected.digest("hex"), "in order");
      client.close();
      for (let wait = 0; wait < 200 && !lines.some((text) => text.startsWith("Gateway bridge")); wait++) await delay(10);
      const line = lines.find((text) => text.startsWith("Gateway bridge"));
      assert.ok(Number(/\/ (\d+) server/.exec(line ?? "")?.[1]) >= 1, `the server side paused: ${line}`);
      // Paused, the browser's socket delivers at most what was already read: one read's worth of
      // messages past the high mark, never the 12 MB the browser queued.
      const peak = Number(/to server (\d+) KiB/.exec(line ?? "")?.[1]);
      assert.ok(peak <= (FLOW.highBytes + 160 * 1024) / 1024, `queue towards the server bounded: ${line}`);
    } finally {
      await gateway.close();
      await backend.close();
    }
  });
});

// Review 02.10: closing a WebSocket whose socket is paused cannot read the browser's answering close
// frame, so `ws` would hold the session (and its per-address slot) until its own 30 s close timer.
test("a session dropped while the browser's stream is paused closes at once, not after the close timeout", async () => {
  let backendSocket;
  const backend = await backendStub((socket) => {
    backendSocket = socket;
    socket.pause();
  });
  await withLogs(async (lines) => {
    const gateway = await gatewayTo(backend.port, { ...FLOW, pauseLimitMs: 300 });
    try {
      const client = await openClient(gateway.port);
      let closedAt;
      client.once("close", () => { closedAt = Date.now(); });
      for (let index = 0; index < 200; index++) client.send(pattern(index * 60 * 1024, 60 * 1024), { binary: true });
      const started = Date.now();
      const closedLine = () => lines.find((text) => text.startsWith("Gateway bridge world closed"));
      while (!closedLine() && Date.now() - started < 8_000) await delay(25);
      const line = closedLine();
      assert.ok(line, `the bridge closed well before ws's 30 s close timer: ${JSON.stringify(lines)}`);
      assert.match(line, /\(Backend is too slow\)/);
      assert.ok(Number(/\/ (\d+) server/.exec(line)?.[1]) >= 1, `the server side paused first: ${line}`);
      while (closedAt === undefined && Date.now() - started < 8_000) await delay(25);
      assert.ok(closedAt !== undefined, "the browser saw the close too");
      void backendSocket;
    } finally {
      await gateway.close();
      await backend.close();
    }
  });
});

test("flow limits refuse a combination that would undo the pause", () => {
  assert.deepEqual({ ...bridgeFlowLimits() }, { ...BRIDGE_FLOW_DEFAULTS });
  assert.equal(BRIDGE_FLOW_DEFAULTS.highBytes, 1024 * 1024);
  assert.equal(BRIDGE_FLOW_DEFAULTS.lowBytes, 256 * 1024);
  assert.equal(BRIDGE_FLOW_DEFAULTS.hardLimitBytes, 16 * 1024 * 1024);
  assert.equal(BRIDGE_FLOW_DEFAULTS.pauseLimitMs, 30_000);
  assert.throws(() => bridgeFlowLimits({ lowBytes: 2 * 1024 * 1024 }), /lowBytes/);
  assert.throws(() => bridgeFlowLimits({ hardLimitBytes: 512 * 1024 }), /hardLimitBytes/);
  assert.throws(() => bridgeFlowLimits({ pauseLimitMs: 0 }), /positive/);
  assert.throws(() => bridgeFlowLimits({ checkMs: Number.NaN }), /positive/);
});

test("bridge stats count overlapping pauses once and describe them without an address", () => {
  const stats = new BridgeStats();
  stats.observe("client", 300 * 1024);
  stats.observe("client", 100 * 1024);
  stats.observe("backend", 2048);
  stats.paused("client", 1_000);
  stats.paused("backend", 1_200);
  stats.resumed(1_500);
  stats.paused("client", 2_000);
  assert.equal(stats.clientPauses, 2);
  assert.equal(stats.backendPauses, 1);
  assert.equal(stats.pausedMs, 500);
  const line = stats.describe("world", "Client is too slow", 2_250);
  assert.equal(stats.pausedMs, 750, "a pause still open at close is counted to the close");
  assert.equal(line, "Gateway bridge world closed (Client is too slow): peak to client 300 KiB, to server 2 KiB; "
    + "pauses 2 client / 1 server, paused 750 ms");
});
