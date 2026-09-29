import "./env.mjs";

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Stops the WebClient gateway that listens on GATEWAY_PORT, and nothing else.
 *
 * `restart-gateway.bat` calls this before it starts the gateway again: a TSWoW `build addon` or
 * `build data` rewrites the client patch chain, after which the running gateway answers 409
 * `client_patch_chain_changed` until it is restarted. The listener is found with `netstat -ano`,
 * and its command line is read from Win32_Process (a plain process query; no module of another
 * process is ever opened). Only a node process running `tools/start-gateway.mjs`,
 * `dist/code/gateway/main.js` or `tools/start-server.mjs` (the gateway and page for other players,
 * online\start-server.bat) is stopped; when the listener is the child of the opt-in supervisor,
 * the supervisor is stopped too, otherwise it would fork the gateway straight back.
 *
 *   node tools/stop-gateway.mjs [--dry-run]
 *
 * Exit codes: 0 — stopped, or nothing was listening; 1 — the port belongs to something else, or
 * the gateway did not let go of it in time.
 */

const GATEWAY_COMMAND = /(?:^|[\\/\s"])(?:tools[\\/]start-(?:gateway|server)\.mjs|dist[\\/]code[\\/]gateway[\\/]main\.js)(?:["\s]|$)/i;

/** PIDs listening on `port` (any local address) in `netstat -ano -p TCP` output. */
export function parseListeningPids(netstatText, port) {
  const pids = new Set();
  for (const line of netstatText.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") continue;
    if (columns[3].toUpperCase() !== "LISTENING") continue;
    const local = columns[1];
    const localPort = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 10);
    const pid = Number.parseInt(columns[4], 10);
    if (localPort === port && Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Whether a Win32_Process record is this client's gateway (or its opt-in supervisor). */
export function isGatewayProcess(record) {
  return Boolean(record)
    && /^node(?:\.exe)?$/i.test(record.name ?? "")
    && GATEWAY_COMMAND.test(record.commandLine ?? "");
}

function processRecord(pid) {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";`
    + ` if ($p) { [pscustomobject]@{ pid = $p.ProcessId; parent = $p.ParentProcessId;`
    + ` name = $p.Name; commandLine = $p.CommandLine } | ConvertTo-Json -Compress }`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return out ? JSON.parse(out) : undefined;
}

function listeningPids(port) {
  return parseListeningPids(execFileSync("netstat", ["-ano", "-p", "TCP"], {
    encoding: "utf8",
    windowsHide: true,
  }), port);
}

async function waitForPortFree(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (listeningPids(port).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return listeningPids(port).length === 0;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const port = Number.parseInt(process.env.GATEWAY_PORT ?? "8090", 10);
  const pids = listeningPids(port);
  if (pids.length === 0) {
    console.log(`Gateway: nothing listens on port ${port}.`);
    return 0;
  }
  const targets = [];
  for (const pid of pids) {
    const record = processRecord(pid);
    if (!isGatewayProcess(record)) {
      console.error(`Port ${port} is held by PID ${pid} (${record?.name ?? "unknown"}), `
        + "which is not the WebClient gateway. Nothing was stopped.");
      return 1;
    }
    const parent = record.parent ? processRecord(record.parent) : undefined;
    if (isGatewayProcess(parent)) targets.push(parent);
    targets.push(record);
  }
  for (const target of targets) {
    console.log(`${dryRun ? "Would stop" : "Stopping"} gateway PID ${target.pid}: ${target.commandLine}`);
    if (!dryRun) {
      try {
        process.kill(target.pid);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  if (dryRun) return 0;
  if (await waitForPortFree(port, 10_000)) {
    console.log(`Gateway stopped; port ${port} is free.`);
    return 0;
  }
  console.error(`Port ${port} is still in use 10 s after stopping the gateway.`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
