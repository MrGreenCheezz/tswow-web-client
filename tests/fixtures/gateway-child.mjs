// The real `startGateway`, alone in a child process, for tests/gateway-upgrade-hardening.test.mjs.
//
// A child because the defects under test end a process: inside `node:test` a crash of the gateway
// would look like a random failure of whichever test ran beside it. Deliberately WITHOUT
// ProcessGuard — with it installed the tests would prove the safety net, not the upgrade handler.
// Loopback only, on a port the system picks; nothing here touches the owner's gateway on 8090.
//
// The parent forks this file with its own `--import ./tools/register-test-sources.mjs`, so the
// `dist/code` import below runs the current TypeScript sources.
//
// Environment: GATEWAY_CHILD_ORIGIN — the one allowed Origin; GATEWAY_CHILD_THROWING_ORIGIN — an
// Origin whose allow-list lookup throws, the stand-in for any unexpected exception in the handler;
// GATEWAY_CHILD_SILENT=1 — never report the port (the harness must then kill this process; should it
// not, the process leaves by itself after 20 s rather than hold a test run open).
// IPC: sends { port } once listening; answers { id, ask: "sockets" } with the number of TCP sockets
// this process holds, and { id, ask: "server-error", code, syscall } by emitting that error on the
// HTTP server from an I/O-like callback, as libuv's accept callback does — where nothing but the
// server's own 'error' listener stands between it and the end of the process.
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { createServer as createTcpServer } from "node:net";

const origin = process.env.GATEWAY_CHILD_ORIGIN ?? "http://127.0.0.1:5173";
const throwingOrigin = process.env.GATEWAY_CHILD_THROWING_ORIGIN;

// The one handle on the gateway's HTTP server a test needs, taken without a seam in Gateway.ts:
// the builtin's live ESM binding is re-pointed before Gateway.js is imported.
const createHttpServer = http.createServer;
let httpServer;
http.createServer = (...args) => (httpServer = createHttpServer(...args));
syncBuiltinESMExports();

// The auth and world servers: accepts and holds every connection, so a bridged WebSocket stays
// open for as long as the test keeps its client.
const held = new Set();
const backend = createTcpServer((socket) => {
  socket.on("error", () => {});
  held.add(socket);
  socket.once("close", () => held.delete(socket));
});
await new Promise((resolve, reject) => {
  backend.once("error", reject);
  backend.listen(0, "127.0.0.1", resolve);
});
const target = { host: "127.0.0.1", port: backend.address().port };

class AllowedOrigins extends Array {
  includes(value) {
    if (throwingOrigin !== undefined && value === throwingOrigin) throw new TypeError("allowed-origin lookup failed");
    return super.includes(value);
  }
}

const { startGateway } = await import("../../dist/code/gateway/Gateway.js");
const gateway = await startGateway({
  host: "127.0.0.1",
  port: 0,
  auth: target,
  world: target,
  allowedOrigins: AllowedOrigins.from([origin]),
  datasetPollMs: 0,
});

process.on("message", (message) => {
  if (message?.ask === "sockets") {
    process.send({
      id: message.id,
      sockets: process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length,
      connections: gateway.connections(),
      backend: held.size,
    });
  } else if (message?.ask === "server-error") {
    const { code, syscall } = message;
    const error = Object.assign(new Error(`${syscall ?? "server"} ${code}`), { code, ...(syscall ? { syscall } : {}) });
    setImmediate(() => {
      httpServer.emit("error", error);
      process.send({ id: message.id, emitted: true });
    });
  }
});
// A parent that goes away takes this process with it rather than leaving a listener behind.
process.once("disconnect", () => process.exit(0));
if (process.env.GATEWAY_CHILD_SILENT === "1") setTimeout(() => process.exit(3), 20_000).unref();
else process.send({ port: gateway.port });
