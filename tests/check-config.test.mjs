import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

// The doctor loads `.env` on import; the test must see only what it passes.
process.env.WEBCLIENT_SKIP_ENV = "1";
const { inspectBackends } = await import("../tools/check-config.mjs");

/** 10.19: `npm run doctor` says whether auth/world answer, as a warning and never as an error. */

function listen() {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function closedPort() {
  const server = await listen();
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a listening backend is ok and a silent one is a warning", async () => {
  const server = await listen();
  try {
    const open = server.address().port;
    const closed = await closedPort();
    const results = await inspectBackends({
      env: { AUTH_HOST: "127.0.0.1", AUTH_PORT: String(open), WORLD_HOST: "127.0.0.1", WORLD_PORT: String(closed) },
      timeoutMs: 2000,
    });
    assert.deepEqual(results.map((result) => [result.label, result.level]), [
      ["Auth server", "ok"],
      ["World server", "warning"],
    ]);
    assert.match(results[1].message, /does not answer/);
    assert.ok(results.every((result) => result.level !== "error"), "a stopped backend is not a configuration error");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a backend that never answers times out as a warning", async () => {
  const results = await inspectBackends({
    env: {},
    timeoutMs: 20,
    // A socket that neither connects nor fails: only the timer can end it.
    connect: () => ({ once() {}, destroy() {} }),
  });
  assert.deepEqual(results.map((result) => result.level), ["warning", "warning"]);
});

test("the gateway is checked only when the configuration names it", async () => {
  const labels = (await inspectBackends({
    env: { GATEWAY_PORT: "1" }, timeoutMs: 20, connect: () => ({ once() {}, destroy() {} }),
  })).map((result) => result.label);
  assert.deepEqual(labels, ["Auth server", "World server", "Gateway"]);
});
