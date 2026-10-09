// Port checks for the .bat launchers, so they start only what is missing and open the page only
// once it can work.
//
//   node tools/port.mjs check <port>                 exit 0 when something listens on 127.0.0.1:<port>
//   node tools/port.mjs check-gateway <port>         exit 0 when the WebClient gateway answers /health
//                                                   there, 1 when nothing listens, 2 when something else does
//   node tools/port.mjs wait <port>... [--timeout <s>] [--open <url>]
//                                                   wait until all listen, then optionally open <url>

import { execFile } from "node:child_process";
import http from "node:http";
import net from "node:net";

/** How long a busy gateway may take to answer /health before it is taken for a silent one. */
const HEALTH_TIMEOUT_MS = 5000;

/**
 * 10.11: whether the gateway — not just anything — holds the port. A bare TCP connect took any
 * process on 8090 for the gateway, so start-dev.bat started no gateway and the page then failed
 * against a stranger. `/health` answers `{"status":"ok"…}` (Gateway.ts) and nothing else here.
 * "gateway", "other" (an answer that is not ours), "silent" (accepted, no answer in time — a busy
 * gateway, as before 10.11) or "none" (the connection failed).
 */
function gatewayAnswers(port) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    const request = http.get({ host: "127.0.0.1", port, path: "/health", timeout: HEALTH_TIMEOUT_MS }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { if (body.length < 4096) body += chunk; });
      response.on("end", () => settle(response.statusCode === 200 && /"status"\s*:\s*"ok"/.test(body) ? "gateway" : "other"));
      response.on("error", () => settle("other"));
    });
    // Review 02.10: a connection that is accepted but not answered is a busy gateway (one thread,
    // building an index), not a stranger — only a real answer that is not ours says "other".
    request.once("timeout", () => {
      settle("silent");
      request.destroy();
    });
    request.once("error", () => settle("none"));
  });
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  const [value] = rest.splice(index, 2).slice(1);
  return value;
};
const timeoutSeconds = Number(flag("--timeout") ?? 300);
const openUrl = flag("--open");
const ports = rest.map(Number);
if (!["check", "check-gateway", "wait"].includes(command) || ports.length === 0
  || ports.some((port) => !Number.isInteger(port))) {
  console.error("usage: node tools/port.mjs check <port> | check-gateway <port> | wait <port>... [--timeout <s>] [--open <url>]");
  process.exit(2);
}

if (command === "check") process.exit((await listening(ports[0])) ? 0 : 1);
if (command === "check-gateway") {
  const answer = await gatewayAnswers(ports[0]);
  if (answer === "gateway") process.exit(0);
  if (answer === "silent") {
    console.error(`Port ${ports[0]} accepted a connection but did not answer /health in ${HEALTH_TIMEOUT_MS / 1000} s; `
      + "taking it for a busy gateway.");
    process.exit(0);
  }
  if (answer === "none" && !(await listening(ports[0]))) process.exit(1);
  console.error(`Port ${ports[0]} is taken by something that is not the WebClient gateway.`);
  process.exit(2);
}

const deadline = Date.now() + timeoutSeconds * 1000;
for (const port of ports) {
  while (!(await listening(port))) {
    if (Date.now() > deadline) {
      console.error(`Port ${port} did not open within ${timeoutSeconds} s.`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (openUrl) execFile("cmd.exe", ["/c", "start", "", openUrl], { windowsHide: true });
