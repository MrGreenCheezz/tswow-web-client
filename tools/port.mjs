// Port checks for the .bat launchers, so they start only what is missing and open the page only
// once it can work.
//
//   node tools/port.mjs check <port>                 exit 0 when something listens on 127.0.0.1:<port>
//   node tools/port.mjs wait <port>... [--timeout <s>] [--open <url>]
//                                                   wait until all listen, then optionally open <url>

import { execFile } from "node:child_process";
import net from "node:net";

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
if (!["check", "wait"].includes(command) || ports.length === 0 || ports.some((port) => !Number.isInteger(port))) {
  console.error("usage: node tools/port.mjs check <port> | wait <port>... [--timeout <s>] [--open <url>]");
  process.exit(2);
}

if (command === "check") process.exit((await listening(ports[0])) ? 0 : 1);

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
