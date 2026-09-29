import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch { clientDirectory = undefined; }

const root = fileURLToPath(new URL("../", import.meta.url));

test("mounted stock MerchantFrame confirms a rare token purchase exactly once", {
  skip: clientDirectory ? false : "no selected 3.3.5a client",
}, () => {
  // A stock callback that loops synchronously cannot be stopped by a JS test timer in the same
  // process. Keep this full MPQ/widget path in a bounded child and print its last reached stage.
  const child = spawnSync(process.execPath,
    ["--import", "./tools/register-test-sources.mjs", "./tests/fixtures/framexml-mounted-token-probe.mjs"],
    { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
  assert.equal(child.error, undefined, output);
  assert.equal(child.status, 0, output);
  const stages = new Map((child.stdout ?? "").split(/\r?\n/)
    .filter((line) => line.startsWith('{"label":'))
    .map((line) => JSON.parse(line))
    .map((row) => [row.label, row]));
  assert.equal(stages.get("boot-complete")?.luaFailed, 0, output);
  assert.equal(stages.get("boot-complete")?.unhandled, 0, output);
  assert.equal(stages.get("merchant-open")?.row, "Эмблемный предмет", output);
  assert.equal(stages.get("merchant-click")?.clicked, true, output);
  assert.equal(stages.get("merchant-click")?.popups[0]?.visible, true, output);
  assert.equal(stages.get("popup-which")?.which, "CONFIRM_PURCHASE_TOKEN_ITEM", output);
  assert.deepEqual(stages.get("cancel-click")?.buys, [], "Cancel must not submit a purchase");
  assert.equal(stages.get("cancel-click")?.visible, false, output);
  assert.equal(stages.get("merchant-reclick")?.visible, true, output);
  assert.deepEqual(stages.get("accept-click")?.buys, [{ slot: 9, count: 1 }],
    "Accept sends exactly one request with the source vendor slot");
  assert.equal(stages.get("accept-click")?.visible, false, output);
  assert.deepEqual(stages.get("accept-click")?.luaErrors, [], output);
});
