// A gateway client built from an https:// origin (glue passes gatewayOrigin, not the ws:// address)
// must keep https: turning it into http: is blocked as mixed content on a page served over https.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("no gateway client maps an https origin to http", () => {
  const offenders = sources("src").filter((path) =>
    readFileSync(path, "utf8").includes('url.protocol = url.protocol === "wss:" ? "https:" : "http:";'));
  assert.deepEqual(offenders, []);
});
