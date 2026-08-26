import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectClientDataDirectory } from "../tools/client-data.mjs";

test("client-data inspection reads the implementations that will actually execute", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-client-data-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await Promise.all([
    writeFile(join(directory, "animations.js"), "export const ANIMATION_DATA_AVAILABLE = true;\n"),
    writeFile(join(directory, "globalStrings.js"), "export const GLOBAL_STRING_DATA_AVAILABLE = false;\n"),
    writeFile(join(directory, "classIcons.js"), "export const CLASS_ICON_DATA_AVAILABLE = true;\n"),
  ]);

  const inspected = inspectClientDataDirectory(directory, ".js");
  assert.deepEqual(
    inspected.map(({ name, available }) => ({ name, available })),
    [
      { name: "animations", available: true },
      { name: "globalStrings", available: false },
      { name: "classIcons", available: true },
    ],
  );
});

test("a missing built implementation is unavailable rather than silently accepted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-client-data-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const inspected = inspectClientDataDirectory(directory, ".js");
  assert.equal(inspected.every((entry) => !entry.available), true);
  assert.equal(inspected.every((entry) => entry.reason === "implementation is missing"), true);
});
