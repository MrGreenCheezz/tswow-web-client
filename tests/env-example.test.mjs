import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

/**
 * 10.19 — every environment variable the code reads is named in `.env.example` (as a setting or in
 * a comment), so a setting cannot exist only in the source. Process-internal names are listed here.
 */

const root = new URL("../", import.meta.url);
const rootPath = root.pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Set by the launchers, Node or the OS, never by the owner. */
const INTERNAL = new Set([
  "GATEWAY_SUPERVISED", "WOWCLIENT_LOCAL_ASSET_NONCE", "WEBCLIENT_SKIP_ENV", "NODE_OPTIONS",
  "NODE_ENV", "NODE_COMPILE_CACHE", "NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_UNIQUE_ID",
  "PATH", "SystemRoot", "FENGARICONF",
]);

async function sources(directory, extensions) {
  const found = [];
  for (const entry of await readdir(join(rootPath, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...await sources(path, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

test("every environment variable the code reads is described in .env.example", async () => {
  const files = [
    ...await sources("src/gateway", [".ts"]),
    ...await sources("src/browser", [".ts"]),
    ...await sources("tools", [".mjs"]),
    ...(await sources("electron", [".cjs"])).filter((path) => !path.includes("node_modules")),
  ];
  const names = new Set();
  for (const file of files) {
    const text = await readFile(join(rootPath, file), "utf8");
    for (const match of text.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\])/g)) {
      names.add(match[1] ?? match[2]);
    }
  }
  const vite = await readFile(join(rootPath, "vite.config.mjs"), "utf8");
  for (const match of vite.matchAll(/\benv\.([A-Z_][A-Z0-9_]*)/g)) names.add(match[1]);
  assert.ok(names.size > 20, `the scan found the code's variables (${names.size})`);

  const example = await readFile(join(rootPath, ".env.example"), "utf8");
  const missing = [...names].filter((name) => !INTERNAL.has(name) && !new RegExp(`\\b${name}\\b`).test(example));
  assert.deepEqual(missing.sort(), [], "each of these needs a line (or a comment) in .env.example");
});
