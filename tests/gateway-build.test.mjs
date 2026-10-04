// 10.11 (L10) — the gateway is compiled on its own (tsconfig.gateway.json, tools/build-gateway.mjs):
// the import walk that decides its freshness sees exactly what tsc compiles, the gateway touches
// browser code only through type imports, a stale dist/code is noticed, and a build whose output
// lacks a module the gateway loads is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  gatewaySources, importSpecifiers, missingRuntimeImports, runtimeBrowserImports, staleGatewaySource,
} from "../tools/gateway-sources.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const buildScript = join(root, "tools", "build-gateway.mjs");

/** A throwaway checkout: `files` maps a relative path to its text; returns the root. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "webclient-gateway-build-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function age(dir, path, secondsAgo) {
  const at = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(join(dir, path), at, at);
}

const GATEWAY_CONFIG = JSON.stringify({ extends: "./tsconfig.json", include: ["src/gateway/**/*.ts", "src/generated/client-data/*.ts"] });

test("import specifiers: static, side-effect, dynamic and re-exports; type-only ones are marked", () => {
  const found = importSpecifiers([
    'import { a, type B } from "./A.js";',
    'import type { C } from "../browser/C.js";',
    "import {\n  type D,\n  type E,\n} from '../browser/D.js';",
    'export * from "./F.js";',
    'export type { G } from "./G.js";',
    'import "./side.js";',
    'const lazy = await import("./Lazy.js");',
    'import { readFile } from "node:fs";',
    "// a comment: helpers come from \"./NotAnImport.js\" one day",
  ].join("\n"));
  assert.deepEqual(found.map(({ specifier, typeOnly }) => `${specifier}${typeOnly ? " (type)" : ""}`), [
    "./A.js", "../browser/C.js (type)", "../browser/D.js (type)", "./F.js", "./G.js (type)", "./side.js", "./Lazy.js", "node:fs",
  ]);
});

test("the walk finds exactly the files tsc compiles for tsconfig.gateway.json", () => {
  const listed = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(root, "tsconfig.gateway.json"), "--listFilesOnly"], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(listed.status, 0, listed.stderr);
  const source = resolve(root, "src");
  const fromTsc = listed.stdout.split(/\r?\n/).filter(Boolean).map((file) => resolve(file))
    .filter((file) => !relative(source, file).startsWith("..")).map((file) => relative(root, file).replaceAll("\\", "/")).sort();
  const fromWalk = gatewaySources(root).map((file) => relative(root, file).replaceAll("\\", "/"));
  assert.ok(fromTsc.includes("src/gateway/main.ts") && fromTsc.length > 50, `tsc listed ${fromTsc.length} files`);
  assert.deepEqual(fromWalk, fromTsc);
});

test("the gateway reaches browser modules only through type imports", () => {
  assert.deepEqual(runtimeBrowserImports(root), []);
  const dir = fixture({
    "tsconfig.gateway.json": GATEWAY_CONFIG,
    "src/gateway/main.ts": 'import type { Wvm } from "../browser/Wvm.js";\nimport { helper } from "../world/Helper.js";\n',
    "src/world/Helper.ts": 'import { draw } from "../browser/Draw.js";\nexport const helper = draw;\n',
    "src/browser/Wvm.ts": "export interface Wvm { readonly x: number }\n",
    "src/browser/Draw.ts": "export const draw = 1;\n",
  });
  try {
    assert.deepEqual(runtimeBrowserImports(dir), [{ from: "src/world/Helper.ts", specifier: "../browser/Draw.js" }],
      "a value import two steps away is found; the type import is not");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dist/code is stale when a gateway source is newer or never compiled; other sources do not count", () => {
  const dir = fixture({
    "tsconfig.json": "{}",
    "tsconfig.gateway.json": GATEWAY_CONFIG,
    "src/gateway/main.ts": 'import { a } from "./A.js";\n',
    "src/gateway/A.ts": 'import type { T } from "../browser/T.js";\nexport const a = 1;\n',
    "src/browser/T.ts": "export type T = number;\n",
    "src/browser/Page.ts": "export const page = 1;\n",
    "src/generated/client-data/animations.ts": "export const ANIMATION_DATA_AVAILABLE = true as const;\n",
    "dist/code/gateway/main.js": "", "dist/code/gateway/A.js": "", "dist/code/browser/T.js": "",
    "dist/code/generated/client-data/animations.js": "",
  });
  try {
    for (const path of ["tsconfig.json", "tsconfig.gateway.json", "src/gateway/main.ts", "src/gateway/A.ts",
      "src/browser/T.ts", "src/generated/client-data/animations.ts"]) age(dir, path, 60);
    for (const path of ["dist/code/gateway/main.js", "dist/code/gateway/A.js", "dist/code/browser/T.js",
      "dist/code/generated/client-data/animations.js"]) age(dir, path, 30);
    assert.equal(staleGatewaySource(dir), undefined, "everything compiled after its source");
    age(dir, "src/browser/Page.ts", 0);
    assert.equal(staleGatewaySource(dir), undefined, "a page-only source does not make the gateway stale");
    age(dir, "src/browser/T.ts", 0);
    assert.deepEqual(staleGatewaySource(dir), { source: "src/browser/T.ts", reason: "changed" },
      "a type the gateway imports is compiled with it");
    age(dir, "src/browser/T.ts", 60);
    age(dir, "tsconfig.gateway.json", 0);
    assert.deepEqual(staleGatewaySource(dir), { source: "tsconfig.gateway.json", reason: "changed" });
    age(dir, "tsconfig.gateway.json", 60);
    rmSync(join(dir, "dist/code/generated/client-data/animations.js"));
    assert.deepEqual(staleGatewaySource(dir), { source: "src/generated/client-data/animations.ts", reason: "never compiled" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build-gateway --check exits 0 for a stale build and 1 for a current one, compiling nothing", () => {
  const dir = fixture({
    "tsconfig.json": "{}",
    "tsconfig.gateway.json": GATEWAY_CONFIG,
    "src/gateway/main.ts": "export {};\n",
    "dist/code/gateway/main.js": "",
  });
  const check = () => spawnSync(process.execPath, [buildScript, "--check", `--root=${dir}`], { encoding: "utf8", windowsHide: true });
  try {
    age(dir, "src/gateway/main.ts", 60);
    age(dir, "tsconfig.json", 60);
    age(dir, "tsconfig.gateway.json", 60);
    age(dir, "dist/code/gateway/main.js", 30);
    const current = check();
    assert.equal(current.status, 1, current.stderr);
    age(dir, "src/gateway/main.ts", 0);
    const stale = check();
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /src\/gateway\/main\.ts/);
    // L10-review: tsc reads tsconfig files with comments and trailing commas, so the walk does too;
    // only a file tsc could not read either is "unknown".
    writeFileSync(join(dir, "tsconfig.gateway.json"),
      '{\n  // the gateway alone\n  "extends": "./tsconfig.json", /* roots */ "include": ["src/gateway/**/*.ts",],\n}\n');
    age(dir, "tsconfig.gateway.json", 60);
    const commented = check();
    assert.equal(commented.status, 0, `${commented.stdout}${commented.stderr}`);
    assert.match(commented.stdout, /src\/gateway\/main\.ts/, "still the stale source, not an unreadable tsconfig");
    writeFileSync(join(dir, "tsconfig.gateway.json"), '{ "include": [');
    const unknown = check();
    assert.equal(unknown.status, 2, "a check that cannot run is neither stale nor current");
    assert.match(unknown.stdout, /freshness unknown/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a build output that lacks a module the gateway loads is reported", () => {
  const out = fixture({
    "gateway/main.js": 'import { a } from "./A.js";\nimport "./Gone.js";\nconst lazy = () => import("./Lazy.js");\n',
    "gateway/A.js": 'export * from "../world/W.js";\n',
    "world/W.js": "export const w = 1;\n",
    "gateway/Lazy.js": 'import { x } from "../world/Missing.js";\n',
  });
  try {
    const result = missingRuntimeImports(out, ["gateway/main.js"]);
    assert.deepEqual(result.missing, [
      { from: "gateway/Lazy.js", specifier: "../world/Missing.js" },
      { from: "gateway/main.js", specifier: "./Gone.js" },
    ]);
    assert.deepEqual(result.reached, ["gateway/A.js", "gateway/Lazy.js", "gateway/main.js", "world/W.js"]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// L10-review: the build itself, end to end, with a stand-in for tsc that writes a given main.js (the
// real compiler is covered by the walk-versus-tsc test above). This is `pregateway` once package.json
// points it here: exit 0 starts the gateway, anything else stops `npm run gateway`.
function buildFixture(config, mainJs) {
  return fixture({
    "tsconfig.json": "{}",
    "tsconfig.gateway.json": config,
    "src/gateway/main.ts": "export {};\n",
    "built-main.js": mainJs,
    "node_modules/typescript/bin/tsc": 'const fs = require("node:fs");\n'
      + 'fs.mkdirSync("dist/code/gateway", { recursive: true });\n'
      + 'fs.copyFileSync("built-main.js", "dist/code/gateway/main.js");\n',
  });
}
const build = (dir) => spawnSync(process.execPath, [buildScript, `--root=${dir}`], { encoding: "utf8", windowsHide: true });

test("build-gateway refuses an output that lacks a module the gateway loads, and passes a complete one", () => {
  const broken = buildFixture(GATEWAY_CONFIG, 'import "./Gone.js";\n');
  const complete = buildFixture(GATEWAY_CONFIG, "export {};\n");
  try {
    const refused = build(broken);
    assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /gateway[\\/]main\.js imports \.\/Gone\.js/);
    const built = build(complete);
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    assert.match(built.stdout, /Gateway built: 1 modules/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
    rmSync(complete, { recursive: true, force: true });
  }
});

test("a compiled gateway is not held back when its output cannot be checked", () => {
  // tsc accepts a bare directory in include; the walk understands only dir/**/*.ts and dir/*.ts.
  const dir = buildFixture(JSON.stringify({ extends: "./tsconfig.json", include: ["src/gateway"] }), "export {};\n");
  try {
    const built = build(dir);
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    assert.match(built.stderr, /could not check/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
