// 10.11 (L10): builds the gateway alone — src/gateway and what it imports — into dist/code.
//
// `npm run gateway` used to build everything first (`pregateway`: `npm run build`, i.e. the
// protocol generators, tsc over all of src and `vite build`): a type error in any page file kept
// the gateway from starting, and `vite build` emptied dist/web while tools/start-server.mjs was
// serving it. The gateway needs none of the page. tsconfig.gateway.json compiles src/gateway, what
// it imports, and the client-data implementations tools/start-gateway.mjs checks, into the same
// dist/code with the same options. The page, Electron and `npm test` keep `npm run build`.
//
//   node tools/build-gateway.mjs             compile into dist/code. Exit: tsc's code when it found
//                                            errors in the gateway's sources, 1 when the output
//                                            lacks a module the gateway loads, else 0
//   node tools/build-gateway.mjs --check     compile nothing: exit 0 when dist/code is older than
//                                            the gateway's sources (rebuild), 1 when it is current
//                                            (the convention of gateway-build-stale.mjs, so a .bat
//                                            can say `--check && rebuild`), 2 when it cannot tell;
//                                            electron/gateway.cjs asks
//   --out-dir=<dir>                          compile there instead; dist/code is left untouched
//   --root=<dir>                             another checkout (tests)

import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gatewayRoots, gatewaySources, missingRuntimeImports, staleGatewaySource } from "./gateway-sources.mjs";

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const thisCheckout = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(option("root") ?? thisCheckout);
const defaultOut = join(root, "dist", "code");

if (process.argv.includes("--check")) {
  let stale;
  try {
    stale = staleGatewaySource(root);
  } catch (error) {
    // Not 1: a check that could not run must not read as "current".
    console.log(`Gateway build freshness unknown: ${error.message}`);
    process.exit(2);
  }
  if (stale === undefined) {
    console.log("Gateway build is current.");
    process.exit(1);
  }
  console.log(`Gateway build is stale: ${stale.source} ${stale.reason === "never compiled" ? "was never compiled" : "changed after the last build"}.`);
  process.exit(0);
}

const outDir = resolve(root, option("out-dir") ?? defaultOut);
if (root === resolve(thisCheckout)) {
  // A fresh checkout has no client-data implementations yet; the neutral stubs let it compile, and
  // start-gateway.mjs then says which tables still have to be generated (as after `npm run build`).
  const { ensureClientDataStubs } = await import("./client-data.mjs");
  const created = ensureClientDataStubs();
  if (created.length > 0) console.log(`Created neutral client-data implementation(s): ${created.join(", ")}`);
}

const started = performance.now();
const compiled = spawnSync(process.execPath, [
  join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.gateway.json"),
  ...(outDir === defaultOut ? [] : ["--outDir", outDir]),
], { cwd: root, stdio: "inherit", windowsHide: true });
if (compiled.error) throw compiled.error;
const seconds = ((performance.now() - started) / 1000).toFixed(1);

// Whatever the gateway can load at run time has to be in the output: walk the compiled JavaScript
// from every module the tsconfig names (main.js, and the gateway modules tools import from dist).
const sourceRoot = join(root, "src");
const toOutput = (source) => relative(sourceRoot, source).replace(/\.ts$/, ".js");
// L10-review: this check guards the gateway; when it cannot run (a tsconfig shape the walk does not
// read), tsc's verdict alone decides, so `npm run gateway` is not stopped by its own safety net.
let reached = [];
let missing = [];
let modules;
try {
  const entries = gatewayRoots(root).filter((source) => !source.endsWith(".d.ts")).map(toOutput);
  ({ reached, missing } = missingRuntimeImports(outDir, entries));
  modules = gatewaySources(root).filter((source) => !source.endsWith(".d.ts")).length;
} catch (error) {
  console.warn(`Could not check the build output for missing modules: ${error.message}`);
}
for (const { from, specifier } of missing) {
  console.error(`Gateway build is incomplete: ${from} imports ${specifier}, which ${relative(root, outDir)} does not have.`);
}
const pageModules = reached.filter((file) => file.startsWith("browser/"));
if (pageModules.length > 0) console.warn(`Note: the gateway loads page modules at run time: ${pageModules.join(", ")}`);

if (compiled.status !== 0) {
  console.error(`tsc found errors in the gateway's sources (exit ${compiled.status}).`);
  process.exit(compiled.status ?? 1);
}
if (missing.length > 0) process.exit(1);
console.log(modules === undefined
  ? `Gateway built in ${seconds} s -> ${relative(root, outDir) || "."} (output not checked)`
  : `Gateway built: ${modules} modules, ${reached.length} loaded at run time, in ${seconds} s -> ${relative(root, outDir) || "."}`);
