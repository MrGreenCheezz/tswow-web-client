import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { LUA_PATCHES, sourceHashes } from "../tools/lua-wasm/build.mjs";

// ARC-4: the committed Lua VM (src/browser/lua/lua51.wasm) is the one tools/lua-wasm/build.mjs makes
// from the committed sources. The toolchain is not in git, so this checks the manifest instead of
// rebuilding: artifact bytes and hash, every source's hash, the patches still applying exactly once,
// and the module's real imports and exports. `node tools/lua-wasm/build.mjs --check` rebuilds.

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("tools/lua-wasm/BUILD.json", root), "utf8"));
const wasm = readFileSync(new URL("src/browser/lua/lua51.wasm", root));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the artifact is the one the manifest describes", () => {
  assert.equal(manifest.artifact, "src/browser/lua/lua51.wasm");
  assert.equal(wasm.length, manifest.bytes);
  assert.equal(sha(wasm), manifest.sha256);
  assert.equal(manifest.exceptions, "legacy", "Node 22, Chromium ≥ 95 and Electron run the legacy form");
});

test("every source is the one the artifact was built from", () => {
  assert.deepEqual(sourceHashes(), manifest.sources,
    "a vendored or glue source changed: rebuild with `node tools/lua-wasm/build.mjs` (wasi-sdk 34.0) and commit both");
  assert.ok(existsSync(new URL("third_party/lua-5.1.5/COPYRIGHT", root)), "the MIT notice travels with the copy");
});

test("each Lua patch still matches its file exactly once", () => {
  for (const [file, find] of LUA_PATCHES) {
    const text = readFileSync(new URL(`third_party/lua-5.1.5/src/${file}`, root), "utf8").replaceAll("\r\n", "\n");
    assert.equal(text.split(find).length - 1, 1, `${file}: ${JSON.stringify(find).slice(0, 60)}`);
  }
  assert.deepEqual(manifest.patches.map((patch) => patch.file), LUA_PATCHES.map(([file]) => file));
});

test("imports and exports are the manifest's, and imports stay within the host the facade provides", () => {
  const module = new WebAssembly.Module(wasm);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}.${entry.name}`);
  const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
  assert.deepEqual(imports, manifest.imports);
  assert.deepEqual(exports, manifest.exports);
  const provided = new Set(["env.wl_host_call", "env.wl_tz_offset"]);
  for (const name of imports) {
    assert.ok(provided.has(name) || name.startsWith("wasi_snapshot_preview1."), `unexpected import ${name}`);
  }
  for (const name of ["memory", "_initialize", "wl_newstate", "wl_openlibs", "wl_pushjsfunction", "lua_pcall", "wl_loadbuffer"]) {
    assert.ok(exports.includes(name), `export ${name}`);
  }
});
