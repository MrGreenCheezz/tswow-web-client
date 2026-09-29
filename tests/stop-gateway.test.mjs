import test from "node:test";
import assert from "node:assert/strict";

import { isGatewayProcess, parseListeningPids } from "../tools/stop-gateway.mjs";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3306           0.0.0.0:0              LISTENING       5816
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       5744
  TCP    127.0.0.1:8090         0.0.0.0:0              LISTENING       14248
  TCP    127.0.0.1:8090         127.0.0.1:61234        ESTABLISHED     14248
  TCP    127.0.0.1:61234        127.0.0.1:8090         ESTABLISHED     5744
  TCP    [::]:18090             [::]:0                 LISTENING       777
  TCP    [::1]:8090             [::]:0                 LISTENING       14248
`;

test("only the listener on the exact gateway port is found", () => {
  assert.deepEqual(parseListeningPids(NETSTAT, 8090), [14248]);
  assert.deepEqual(parseListeningPids(NETSTAT, 18090), [777]);
  assert.deepEqual(parseListeningPids(NETSTAT, 3724), []);
});

test("only this client's gateway or its supervisor may be stopped", () => {
  const node = (commandLine) => ({ name: "node.exe", commandLine });
  assert.equal(isGatewayProcess(node("node  --enable-source-maps tools/start-gateway.mjs")), true);
  assert.equal(isGatewayProcess(node("node --enable-source-maps tools\\start-gateway.mjs")), true);
  assert.equal(isGatewayProcess(node('"F:\\tswowRoot\\WebClient\\.runtime\\node\\node.exe" '
    + '"F:\\tswowRoot\\WebClient\\dist\\code\\gateway\\main.js"')), true);
  // online\start-server.bat: the gateway and the page for other players in one process.
  assert.equal(isGatewayProcess(node("node --enable-source-maps tools\\start-server.mjs")), true);
  assert.equal(isGatewayProcess(node("node tools/start-servers.mjs")), false);
  // Neighbours on the same machine: Vite, the TSWoW console, a WebClient test run.
  assert.equal(isGatewayProcess(node('"node" "F:\\tswowRoot\\WebClient\\node_modules\\vite\\bin\\vite.js"')), false);
  assert.equal(isGatewayProcess(node("bin/node/node.exe -r source-map-support/register bin/scripts/runtime/runtime/TSWoW.js")), false);
  assert.equal(isGatewayProcess(node("node --test tests/stop-gateway.test.mjs")), false);
  assert.equal(isGatewayProcess(node("node tools/start-gateway.mjs.bak")), false);
  // A non-node process that happens to mention the script is not stopped.
  assert.equal(isGatewayProcess({ name: "cmd.exe", commandLine: "cmd /c node tools/start-gateway.mjs" }), false);
  assert.equal(isGatewayProcess(undefined), false);
});
