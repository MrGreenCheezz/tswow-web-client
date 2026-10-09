// 10.11 — `port.mjs check-gateway` tells the gateway from any other program on its port.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../tools/port.mjs", import.meta.url));

/** Runs the script without blocking this process, which is serving the port it probes. */
function check(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "check-gateway", String(port)], { stdio: "ignore", windowsHide: true });
    child.once("exit", (code) => resolve(code));
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("the gateway's /health is 0, another HTTP server is 2, a closed port is 1", async () => {
  const gateway = createServer((request, response) => {
    if (request.url === "/health") response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    else response.writeHead(404).end();
  });
  const stranger = createServer((request, response) => response.writeHead(200).end("hello"));
  const gatewayPort = await listen(gateway);
  const strangerPort = await listen(stranger);
  const closed = createTcpServer();
  const closedPort = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  try {
    assert.equal(await check(gatewayPort), 0);
    assert.equal(await check(strangerPort), 2, "a 200 without the gateway's body is not the gateway");
    assert.equal(await check(closedPort), 1);
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => stranger.close(resolve));
  }
});

// Review 02.10: the owner's gateway can hold its one thread for over a second (a DBC index being
// built). Silence is not a stranger's answer: start-dev.bat must not refuse to start for it.
test("a gateway that answers /health late is still the gateway, not a stranger", async () => {
  const sockets = new Set();
  const busy = createServer((request, response) => {
    setTimeout(() => response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}'), 1_600);
  });
  busy.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const busyPort = await listen(busy);
  // And one that accepts but never answers at all: taken for a busy gateway, as the TCP check did.
  const silent = createServer(() => {});
  silent.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const silentPort = await listen(silent);
  try {
    assert.equal(await check(busyPort), 0);
    assert.equal(await check(silentPort), 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => busy.close(resolve));
    await new Promise((resolve) => silent.close(resolve));
  }
});
