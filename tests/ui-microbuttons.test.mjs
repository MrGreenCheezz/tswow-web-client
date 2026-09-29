import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * The journal, social panel, world map and calendar had no mouse entry point: only hotkeys
 * and slash commands. These four buttons are that entry point, so this pins the markup to
 * the wiring — a mistyped id would otherwise fail silently behind `?.`.
 */
test("micro buttons exist in markup and are wired to their toggles", async () => {
  const [markup, wiring] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Windows.ts", import.meta.url), "utf8"),
  ]);
  for (const [id, toggle] of [
    ["quest-toggle", "toggleQuestLog"],
    ["social-toggle", "toggleSocialPanel"],
    ["worldmap-toggle", "toggleWorldMap"],
    ["calendar-toggle", "toggleCalendar"],
  ]) {
    assert.match(markup, new RegExp(`id="${id}"[^>]*type="button"`), `${id} is a button in markup`);
    assert.match(markup, new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`), `${id} names itself`);
    assert.ok(wiring.includes(`getElementById("${id}")`), `${id} is wired`);
    assert.ok(wiring.includes(`${toggle}()`), `${id} calls ${toggle}`);
  }
  for (const toggle of ["toggleQuestLog", "toggleSocialPanel", "toggleWorldMap", "toggleCalendar"]) {
    assert.match(wiring, new RegExp(`import \\{[^}]*${toggle}[^}]*\\}`), `${toggle} is imported`);
  }
});
