// A6 / 1.03 model of Gateway.ts `server.on("upgrade")` (startGateway) on an ephemeral 127.0.0.1 port of THIS
// process tree only. Nothing of the owner's gateway is touched. Uses the repo's real `ws`.
//   node upgrade-model.mjs <attack> <plain|guarded>
// plain   = the handler exactly as Gateway.ts:3440-3459 writes it today.
// guarded = the handler the 1.03 spec proposes: error listener first, URL parse in try, one refusal
//           helper that ends *and destroys*, an 'error' listener on the http server after listen.
// The parent spawns the model as a child, fires one attack, reports whether the child survived.
import { createServer } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "file:///F:/tswowRoot/WebClient/node_modules/ws/wrapper.mjs";

const ALLOWED = ["http://127.0.0.1:5173"];
const originAllowed = (origin) => origin !== undefined && (ALLOWED.includes("*") || ALLOWED.includes(origin));
const REASON = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 503: "Service Unavailable" };

if (process.argv[2] === "child") {
  const guarded = process.argv[3] === "guarded";
  const limit = Number(process.argv[4] ?? 8);
  const server = createServer((request, response) => { response.writeHead(200).end("ok"); });
  const auth = new WebSocketServer({ noServer: true });
  auth.on("connection", (webSocket) => { webSocket.on("error", () => {}); webSocket.close(1000); });
  let bridged = 0;
  const refuse = (socket, status) => {
    if (!guarded) { socket.end(`HTTP/1.1 ${status} ${REASON[status]}\r\n\r\n`); return; }
    socket.end(`HTTP/1.1 ${status} ${REASON[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };
  server.on("upgrade", (request, socket, head) => {
    if (guarded) socket.on("error", () => socket.destroy());
    const origin = request.headers.origin;
    if (!originAllowed(origin)) { refuse(socket, 403); return; }
    let pathname;
    if (guarded) {
      try { pathname = new URL(request.url ?? "/", "http://gateway.local").pathname; }
      catch { refuse(socket, 400); return; }
    } else {
      pathname = new URL(request.url ?? "/", "http://gateway.local").pathname;
    }
    if (pathname !== "/auth") { refuse(socket, 404); return; }
    if (bridged >= limit) { refuse(socket, 503); return; }
    auth.handleUpgrade(request, socket, head, (webSocket) => auth.emit("connection", webSocket, request));
  });
  server.listen(0, "127.0.0.1", () => {
    // Whether a later server 'error' (accept EMFILE) is survivable: only the guarded model listens.
    if (guarded) server.on("error", (error) => console.error("server error (kept alive):", error.code));
    process.send({ port: server.address().port });
  });
  process.on("message", (message) => {
    if (message === "connections") server.getConnections((error, count) => process.send({ connections: count }));
    if (message === "server-error") {
      try { server.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" })); process.send({ emitted: "survived" }); }
      catch (error) { process.send({ emitted: `threw ${error.code}` }); }
    }
  });
} else {
  const [attack, mode] = [process.argv[2], process.argv[3] ?? "plain"];
  const args = [fileURLToPath(import.meta.url), "child", mode, attack === "rst-503" ? "0" : "8"];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const { port } = await new Promise((resolve) => child.once("message", resolve));
  const sockets = [];
  const open = () => new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    socket.on("error", () => {});
    socket.once("connect", () => resolve(socket));
    sockets.push(socket);
  });
  const upgrade = (path, origin) =>
    `GET ${path} HTTP/1.1\r\nHost: x\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
    + "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
  const GOOD = "http://127.0.0.1:5173";
  const EVIL = "http://evil.example";
  let extra;
  if (attack === "bad-url") {
    (await open()).write(upgrade("//[::1", GOOD));
  } else if (attack === "rst-403") {
    const socket = await open(); socket.write(upgrade("/auth", EVIL)); socket.resetAndDestroy();
  } else if (attack === "rst-404") {
    const socket = await open(); socket.write(upgrade("/nope", GOOD)); socket.resetAndDestroy();
  } else if (attack === "rst-503") {
    const socket = await open(); socket.write(upgrade("/auth", GOOD)); socket.resetAndDestroy();
  } else if (attack === "rst-loop") {
    for (let index = 0; index < 50; index++) {
      const socket = await open(); socket.write(upgrade("/auth", EVIL)); socket.resetAndDestroy();
    }
  } else if (attack === "rst-valid") {
    const socket = await open(); socket.write(upgrade("/auth", GOOD)); socket.resetAndDestroy();
  } else if (attack === "linger-403") {
    // 200 refused upgrades whose clients never close: does the server keep 200 half-open sockets?
    for (let index = 0; index < 200; index++) (await open()).write(upgrade("/auth", EVIL));
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.send("connections");
    extra = { openAfterRefusals: (await new Promise((resolve) => child.once("message", resolve))).connections };
  } else if (attack === "server-error") {
    child.send("server-error");
    extra = await new Promise((resolve) => child.once("message", resolve));
  }
  const outcome = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("alive"), 1500))]);
  let health = "n/a";
  if (outcome === "alive") {
    health = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status, (e) => `fail ${e.message}`);
    child.kill();
  }
  console.log(JSON.stringify({ attack, mode, outcome, health, ...(extra ?? {}),
    stderr: stderr.split("\n").filter(Boolean).slice(0, 2) }));
  for (const socket of sockets) socket.destroy();
}
