import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.18 (L5c, 04.10): the world exit of Wow.exe 3.3.5a 12340 (0x00528c30, read-only Ghidra,
// .runtime/re-2026-09-30/a2-3-review/d4.txt) raises, in this order and each once:
//   CINEMATIC_STOP (event 0x169) — only while a cinematic plays (its flag 0xbd07fc), which also stops it;
//   INSTANCE_LOCK_STOP (0x279) — always: UIParent hides the INSTANCE_LOCK dialog (UIParent.lua:876);
//   PLAYER_LEAVING_WORLD (0x100) — last.
// Event ids from the name table at 0x00c24eb0. The exit runs on the player's destruction behind a
// loading screen (0x006e6020) and in the UI teardown (0x00528f00) before PLAYER_LOGOUT.
const { frameXmlWorldExitEvents } = await import("../dist/code/browser/framexml/FrameXmlWorldExit.js");
const { createFrameXmlWorldEntry } = await import("../dist/code/browser/framexml/FrameXmlWorldEntry.js");
const { FrameXmlLoginState } = await import("../dist/code/browser/framexml/FrameXmlLoginEdge.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");

const SELF = 0x10n;

test("the world exit's events, in Wow.exe's order", () => {
  assert.deepEqual([...frameXmlWorldExitEvents(false)], ["INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);
  assert.deepEqual([...frameXmlWorldExitEvents(true)], ["CINEMATIC_STOP", "INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);
});

function loadingScreen(inCinematic) {
  const world = new EventBus();
  const store = new EventBus();
  const fired = [];
  const entry = createFrameXmlWorldEntry();
  entry.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => 0 },
    { world, store, selfGuid: () => SELF, ...(inCinematic ? { inCinematic } : {}) });
  return { world, store, fired, entry };
}

test("a loading screen's leave is the whole world exit, once", () => {
  const { world, store, fired } = loadingScreen();
  world.emit("WORLD_TRANSFER", { mapId: 571 });
  assert.deepEqual(fired, ["INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);
  world.emit("WORLD_TRANSFER", { mapId: 571 });
  assert.equal(fired.length, 2, "a second SMSG_NEW_WORLD before the entry is no second exit");
  store.emit("OBJECT_CREATED", { guid: SELF, typeId: 4 });
  assert.deepEqual(fired, ["INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD", "PLAYER_ENTERING_WORLD"]);
});

test("a cinematic still playing at the leave is stopped first", () => {
  let playing = true;
  const { world, fired } = loadingScreen(() => playing);
  world.emit("WORLD_TRANSFER", { mapId: 0 });
  assert.deepEqual(fired, ["CINEMATIC_STOP", "INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD"]);
  playing = false;
});

test("the UI teardown in the world: regen, the world exit, then the logout", () => {
  const login = new FrameXmlLoginState();
  login.observe("PLAYER_ENTERING_WORLD");
  assert.deepEqual([...login.teardownEvents(() => true)],
    ["PLAYER_REGEN_ENABLED", "INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD", "PLAYER_LOGOUT"]);
  assert.deepEqual([...login.teardownEvents(() => true)], ["PLAYER_LOGOUT"], "out of the world: no second exit");
  const idle = new FrameXmlLoginState();
  idle.observe("PLAYER_ENTERING_WORLD");
  assert.deepEqual([...idle.teardownEvents()], ["INSTANCE_LOCK_STOP", "PLAYER_LEAVING_WORLD", "PLAYER_LOGOUT"]);
});
