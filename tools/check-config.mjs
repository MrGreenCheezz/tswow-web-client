import "./env.mjs";

import { existsSync, readdirSync, statSync } from "node:fs";
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
  results.push({
    level: "ok",
    label: "Backends",
    message: `auth ${process.env.AUTH_HOST ?? "127.0.0.1"}:${process.env.AUTH_PORT ?? "3724"}, `
      + `world ${process.env.WORLD_HOST ?? "127.0.0.1"}:${process.env.WORLD_PORT ?? "8085"}`,
  });
  return results;
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
  const results = inspectConfiguration();
  printReport(results);
  const errors = results.filter((result) => result.level === "error").length;
  const warnings = results.filter((result) => result.level === "warning").length;
  console.log(`\nConfiguration: ${errors} error(s), ${warnings} warning(s).`);
  if (errors > 0) process.exitCode = 1;
}
