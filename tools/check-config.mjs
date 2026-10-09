import "./env.mjs";

import { existsSync, readdirSync, statSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  clientDirectory,
  dbcDirectory,
  mapsDirectory,
  moduleDirectories,
  vmapsDirectory,
} from "./paths.mjs";
import { inspectClientDataImplementations } from "./client-data.mjs";

function directoryResult(label, resolver, marker) {
  let directory;
  try {
    directory = resolver();
  } catch (error) {
    return { level: "error", label, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      return { level: "error", label, message: `${directory} is not a directory` };
    }
  } catch (error) {
    return { level: "error", label, message: `${directory} cannot be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (marker && !existsSync(resolve(directory, marker))) {
    return { level: "error", label, message: `${directory} does not contain ${marker}` };
  }
  return { level: "ok", label, message: directory };
}

function optionalDirectoryResult(label, resolver, purpose) {
  let directory;
  try {
    directory = resolver();
  } catch (error) {
    return {
      level: "warning",
      label,
      message: `${purpose} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      return { level: "warning", label, message: `${purpose} is unavailable: ${directory} is not a directory` };
    }
  } catch (error) {
    return {
      level: "warning",
      label,
      message: `${purpose} is unavailable: ${directory} cannot be inspected (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return { level: "ok", label, message: directory };
}

function hasExtension(directory, extension) {
  try {
    return readdirSync(directory).some((entry) => entry.toLowerCase().endsWith(extension));
  } catch {
    return false;
  }
}

/**
 * 10.04, the doctor's copy of `src/gateway/ModuleWritePolicy.ts` (the gateway itself asserts the
 * TS one at start-up; this file runs before anything is compiled). `MODULE_UI_WRITE=1` is only for
 * a gateway bound to loopback that trusts only loopback pages. Kept equal by
 * `tests/gateway-module-write-guard.test.mjs`, which runs both over one table.
 */
function loopbackHostname(hostname) {
  const host = String(hostname).trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "::ffff:127.0.0.1";
}

function loopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && loopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function moduleWriteProblem(env = process.env) {
  if (env.MODULE_UI_WRITE !== "1") return undefined;
  const host = env.GATEWAY_HOST ?? "127.0.0.1";
  const origins = (env.ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  const problems = [];
  if (!loopbackHostname(host)) problems.push(`GATEWAY_HOST=${host}`);
  if (origins.includes("*")) problems.push("ALLOWED_ORIGINS contains *");
  const foreign = origins.filter((origin) => origin !== "*" && !loopbackOrigin(origin));
  if (foreign.length > 0) problems.push(`ALLOWED_ORIGINS has non-loopback ${foreign.join(", ")}`);
  if (problems.length === 0) return undefined;
  return "MODULE_UI_WRITE=1 requires GATEWAY_HOST=127.0.0.1 and ALLOWED_ORIGINS listing only loopback "
    + `pages (no *, no other hosts); now: ${problems.join("; ")}. `
    + "Set MODULE_UI_WRITE=0 or make the gateway loopback-only.";
}

export function inspectConfiguration() {
  const results = [];
  const [major] = process.versions.node.split(".").map(Number);
  results.push(
    major >= 22
      ? { level: "ok", label: "Node.js", message: process.versions.node }
      : { level: "error", label: "Node.js", message: `${process.versions.node}; version 22 or newer is required` },
  );

  const dbc = directoryResult("DBC data", dbcDirectory, "Map.dbc");
  const maps = directoryResult("Map data", mapsDirectory);
  const vmaps = directoryResult("VMap data", vmapsDirectory);
  results.push(dbc, maps, vmaps);
  if (maps.level === "ok" && !hasExtension(maps.message, ".map")) {
    results.push({ level: "error", label: "Map data", message: `${maps.message} contains no .map files` });
  }
  if (vmaps.level === "ok" && !hasExtension(vmaps.message, ".vmtile")) {
    results.push({ level: "error", label: "VMap data", message: `${vmaps.message} contains no .vmtile files` });
  }

  results.push(optionalDirectoryResult(
    "WoW client",
    clientDirectory,
    "on-demand MPQ asset generation",
  ));

  const clientData = inspectClientDataImplementations();
  const unavailableClientData = clientData.filter((entry) => !entry.available);
  results.push(unavailableClientData.length === 0
    ? {
      level: "ok",
      label: "Generated client data",
      message: "local animation, GlobalStrings and class-icon implementations are available",
    }
    : {
      level: "error",
      label: "Generated client data",
      message: `${unavailableClientData.map((entry) => entry.name).join(", ")} use neutral stubs; `
        + "configure your own dataset/client sources and run `npm run client-data:generate` before gameplay",
    });

  for (const module of moduleDirectories()) {
    const directory = resolve(module.root);
    results.push({
      level: existsSync(directory) ? "ok" : "warning",
      label: `Modules (${module.source})`,
      message: existsSync(directory)
        ? `${directory}${module.inner ? ` (per-module ${module.inner}/)` : ""}`
        : `${directory} is absent; this module source will be empty`,
    });
  }

  results.push({
    level: "ok",
    label: "Gateway",
    message: `${process.env.GATEWAY_HOST ?? "127.0.0.1"}:${process.env.GATEWAY_PORT ?? "8090"}`,
  });
  const writeProblem = moduleWriteProblem();
  results.push(writeProblem === undefined
    ? { level: "ok", label: "Module writes", message: process.env.MODULE_UI_WRITE === "1" ? "on, loopback only" : "off" }
    : { level: "error", label: "Module writes", message: writeProblem });
  results.push({
    level: "ok",
    label: "Backends",
    message: `auth ${process.env.AUTH_HOST ?? "127.0.0.1"}:${process.env.AUTH_PORT ?? "3724"}, `
      + `world ${process.env.WORLD_HOST ?? "127.0.0.1"}:${process.env.WORLD_PORT ?? "8085"}`,
  });
  return results;
}

/**
 * 10.19: whether auth, world and the gateway answer at all — a plain TCP connect, closed at once,
 * no protocol. Only for the doctor: `assertGatewayConfiguration` must not wait on the backends,
 * because the gateway has to start while auth or world are down. A silent port is a `warning`.
 */
export async function inspectBackends({ env = process.env, connect = netConnect, timeoutMs = 1000 } = {}) {
  const targets = [
    ["Auth server", env.AUTH_HOST ?? "127.0.0.1", env.AUTH_PORT ?? "3724", "auth is not running: nobody can log in"],
    ["World server", env.WORLD_HOST ?? "127.0.0.1", env.WORLD_PORT ?? "8085", "world is not running: realms stay offline"],
  ];
  if (env.GATEWAY_HOST || env.GATEWAY_PORT) {
    const host = env.GATEWAY_HOST ?? "127.0.0.1";
    targets.push(["Gateway", host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host,
      env.GATEWAY_PORT ?? "8090", "the gateway is not running"]);
  }
  return Promise.all(targets.map(([label, host, port, missing]) => new Promise((resolveResult) => {
    let settled = false;
    const finish = (level, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveResult({ level, label, message });
    };
    const socket = connect({ host, port: Number(port) });
    const timer = setTimeout(() => finish("warning", `${host}:${port} does not answer — ${missing}`), timeoutMs);
    socket.once("connect", () => finish("ok", `${host}:${port} answers`));
    socket.once("error", () => finish("warning", `${host}:${port} does not answer — ${missing}`));
  })));
}

export function assertGatewayConfiguration() {
  const errors = inspectConfiguration().filter((entry) => entry.level === "error");
  if (errors.length > 0) {
    throw new Error(`Gateway configuration is not ready:\n${errors.map((entry) => `- ${entry.label}: ${entry.message}`).join("\n")}`);
  }
}

function printReport(results) {
  for (const result of results) {
    const prefix = result.level === "ok" ? "OK" : result.level === "warning" ? "WARN" : "ERROR";
    console.log(`${prefix.padEnd(5)} ${result.label}: ${result.message}`);
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  const results = [...inspectConfiguration(), ...await inspectBackends()];
  printReport(results);
  const errors = results.filter((result) => result.level === "error").length;
  const warnings = results.filter((result) => result.level === "warning").length;
  console.log(`\nConfiguration: ${errors} error(s), ${warnings} warning(s).`);
  if (errors > 0) process.exitCode = 1;
}
