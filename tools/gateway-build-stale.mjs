// Whether dist/code is older than the TypeScript sources it is compiled from.
//
// The gateway runs dist/code/gateway/main.js, loaded once at start, so restarting it without a
// rebuild keeps serving yesterday's code: a route added to src/gateway since the last build answers
// 404 and the browser reports the feature as unavailable. restart-gateway.bat asks this script and
// rebuilds only when some src/**/*.ts has no compiled .js next to its dist path or is newer than it.
//
// Exit 0: stale (rebuild), printing the first stale source. Exit 1: dist/code is current.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(root, "src");
const outRoot = join(root, "dist", "code");
// L10-review (10.11): tools/build-gateway.mjs writes dist/code too — the gateway and what it imports,
// src/world and src/protocol included, which the page bundles as well — so dist/code alone no longer
// says the page is current. online\start-server.bat serves dist/web; `vite build` writes its
// index.html, so a source newer than that file is stale as well. No built page: dist/code alone.
let pageBuiltAt;
try {
  pageBuiltAt = statSync(join(root, "dist", "web", "index.html")).mtimeMs;
} catch {
  pageBuiltAt = undefined;
}

function* sources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) yield path;
  }
}

for (const source of sources(sourceRoot)) {
  const compiled = join(outRoot, relative(sourceRoot, source)).replace(/\.ts$/, ".js");
  let compiledTime;
  try {
    compiledTime = statSync(compiled).mtimeMs;
  } catch {
    console.log(`WebClient build is stale: ${relative(root, source)} was never compiled.`);
    process.exit(0);
  }
  if (statSync(source).mtimeMs > compiledTime) {
    console.log(`WebClient build is stale: ${relative(root, source)} changed after the last build.`);
    process.exit(0);
  }
  if (pageBuiltAt !== undefined && statSync(source).mtimeMs > pageBuiltAt) { // L10-review (10.11)
    console.log(`WebClient build is stale: ${relative(root, source)} changed after the last page build (dist/web).`);
    process.exit(0);
  }
}
process.exit(1);
