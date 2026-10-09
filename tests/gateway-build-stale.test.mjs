// L10-review (10.11) — tools/gateway-build-stale.mjs is what online\start-server.bat asks before it
// serves dist/web to players ("rebuild when src\ is newer than the build"). It judged the whole build
// by dist/code alone, which was right while only `npm run build` wrote dist/code. Since
// tools/build-gateway.mjs (10.11) also writes dist/code — the gateway and every file it imports,
// src/world and src/protocol included, which the page bundles too — a source the gateway shares
// with the page looked "current" after a gateway-only build while dist/web still held the old code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A throwaway checkout with this checkout's gateway-build-stale.mjs; `files` maps paths to text. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "webclient-build-stale-"));
  mkdirSync(join(dir, "tools"));
  copyFileSync(join(root, "tools", "gateway-build-stale.mjs"), join(dir, "tools", "gateway-build-stale.mjs"));
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

const check = (dir) => spawnSync(process.execPath, [join(dir, "tools", "gateway-build-stale.mjs")], { encoding: "utf8", windowsHide: true });

test("a full build is current; a source edited after it is stale", () => {
  const dir = fixture({
    "src/world/Shared.ts": "export const shared = 1;\n",
    "src/browser/Page.ts": "export const page = 1;\n",
    "dist/code/world/Shared.js": "", "dist/code/browser/Page.js": "",
    "dist/web/index.html": "",
  });
  try {
    for (const path of ["src/world/Shared.ts", "src/browser/Page.ts"]) age(dir, path, 60);
    for (const path of ["dist/code/world/Shared.js", "dist/code/browser/Page.js"]) age(dir, path, 40);
    age(dir, "dist/web/index.html", 30);
    assert.equal(check(dir).status, 1, "everything built after its source");
    age(dir, "src/browser/Page.ts", 0);
    const stale = check(dir);
    assert.equal(stale.status, 0);
    assert.match(stale.stdout, /src[\\/]browser[\\/]Page\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gateway-only build of a shared source leaves the page stale", () => {
  const dir = fixture({
    "src/world/Shared.ts": "export const shared = 1;\n",
    "src/browser/Page.ts": "export const page = 1;\n",
    "dist/code/world/Shared.js": "", "dist/code/browser/Page.js": "",
    "dist/web/index.html": "",
  });
  try {
    // Full build 40 s ago; Shared.ts edited 20 s ago; build-gateway compiled it again 10 s ago.
    age(dir, "src/browser/Page.ts", 60);
    age(dir, "dist/code/browser/Page.js", 40);
    age(dir, "dist/web/index.html", 40);
    age(dir, "src/world/Shared.ts", 20);
    age(dir, "dist/code/world/Shared.js", 10);
    const stale = check(dir);
    assert.equal(stale.status, 0, "dist/web predates src/world/Shared.ts, so the page players get is old");
    assert.match(stale.stdout, /src[\\/]world[\\/]Shared\.ts/);
    assert.match(stale.stdout, /dist[\\/]web/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a built page only dist/code counts (the Vite dev server serves the page)", () => {
  const dir = fixture({
    "src/world/Shared.ts": "export const shared = 1;\n",
    "dist/code/world/Shared.js": "",
  });
  try {
    age(dir, "src/world/Shared.ts", 20);
    age(dir, "dist/code/world/Shared.js", 10);
    assert.equal(check(dir).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
