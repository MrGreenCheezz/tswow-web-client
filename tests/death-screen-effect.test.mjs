import assert from "node:assert/strict";
import test from "node:test";
import { deathScreenActive } from "../dist/code/browser/ui/DeathScreenEffect.js";
import { PLAYER_FLAGS_GHOST, PLAYER_FLAGS_RESTING } from "../dist/code/browser/ui/WindowBindings.js";

/**
 * The whole decision behind the grey screen, and the only part of slice P2 that can be wrong
 * without a browser: the layer, the fade and the stacking order are CSS, but which of the two
 * states the world has to be grey for is a reading of the protocol.
 */

test("the grey is on for a body on the ground and for a released spirit alike", () => {
  // The killing blow lands first and moves no flag: health reaches zero while PLAYER_FLAGS is
  // still whatever it was.
  assert.equal(deathScreenActive(true, 0), true);
  // Releasing the spirit is the opposite case and the one a health check cannot see at all — the
  // spirit body walks around with full health, and only the flag says it is not alive.
  assert.equal(deathScreenActive(false, PLAYER_FLAGS_GHOST), true);
  // And the overlap in the middle, which is most of the time actually spent dead.
  assert.equal(deathScreenActive(true, PLAYER_FLAGS_GHOST), true);
});

test("nothing else about a living character turns it on", () => {
  assert.equal(deathScreenActive(false, 0), false);
  // The bit next door. `PLAYER_FLAGS_RESTING` is 0x20 and GHOST is 0x10, and a mask read one bit
  // out would grey the screen of everyone sitting in an inn — which is exactly the confusion the
  // constant block in `WindowBindings` was written to stop.
  assert.equal(PLAYER_FLAGS_GHOST, 0x10);
  assert.equal(PLAYER_FLAGS_RESTING, 0x20);
  assert.equal(deathScreenActive(false, PLAYER_FLAGS_RESTING), false);
  // Every other flag in the word at once, minus the ghost bit: still alive, still in colour.
  assert.equal(deathScreenActive(false, 0xffff_ffff & ~PLAYER_FLAGS_GHOST), false);
});
