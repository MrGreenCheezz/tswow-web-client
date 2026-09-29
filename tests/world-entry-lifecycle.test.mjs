import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EventBus } from "../dist/code/world/EventBus.js";
import { WorldEntryLifecycle } from "../dist/code/browser/app/WorldEntryLifecycle.js";

test("logout removes packet and store listeners before another character enters", () => {
  const lifecycle = new WorldEntryLifecycle();
  const packets = new EventBus();
  const store = new EventBus();
  const seen = [];
  const oldGeneration = lifecycle.begin();
  lifecycle.track(packets.on("LOGOUT_CHANGED", () => seen.push("old packet")));
  lifecycle.track(store.on("UNIT_HEALTH", () => seen.push("old store")));
  packets.emit("LOGOUT_CHANGED", { pending: false, complete: false });
  assert.deepEqual(seen, ["old packet"]);

  lifecycle.retire();
  assert.equal(lifecycle.isCurrent(oldGeneration), false);
  assert.equal(packets.listenerCount("LOGOUT_CHANGED"), 0);
  assert.equal(store.listenerCount("UNIT_HEALTH"), 0);
  packets.emit("LOGOUT_CHANGED", { pending: false, complete: true });
  store.emit("UNIT_HEALTH", { guid: 1n });
  assert.deepEqual(seen, ["old packet"], "retired character cannot update a returned screen");

  const newGeneration = lifecycle.begin();
  lifecycle.track(packets.on("LOGOUT_CHANGED", () => seen.push("new packet")));
  packets.emit("LOGOUT_CHANGED", { pending: false, complete: false });
  assert.deepEqual(seen, ["old packet", "new packet"]);
  assert.equal(lifecycle.isCurrent(newGeneration), true);
  lifecycle.retire();
  assert.equal(packets.listenerCount("LOGOUT_CHANGED"), 0);
});

test("a reply from a retired character login is gated before rebuilding world clients", async () => {
  const source = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(source,
    /const location = await world\.loginCharacter\(character\.guid\);[\s\S]{0,250}?if \(!entryLifecycle\.isCurrent\(generation\) \|\| game\.world !== world\) return;/);
  assert.match(source,
    /if \(!entryLifecycle\.isCurrent\(generation\) \|\| game\.world !== world\) return;\s*hideLoadingScreen\(\);/,
    "a late rejection cannot hide the new world loading screen");
});
