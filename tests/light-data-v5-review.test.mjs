// 05.10-A7b-5 review — defects found in the light payload v5 slice and the deferred overlay hook:
// a ghost against an old (v4) gateway, a ghost under lava, the ghost fade across a relog, and the
// magma/slime underwater overlay coloured from the liquid's light with one depth-darkening path.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveLighting } from "../dist/code/browser/LightClient.js";
import { GhostLightFade, GHOST_LIGHT_FADE_MS } from "../dist/code/browser/LightStateFade.js";
import {
  UNDERWATER_LAKE_TINT, UNDERWATER_SURFACE_HANDOFF, underwaterFogStrength, underwaterOverlayFrame,
} from "../dist/code/browser/WorldRenderer3D.js";

function colourSet(colour, fog = colour) {
  const colours = {};
  for (const channel of ["diffuse", "ambient", "skyTop", "skyUpper", "skyMiddle", "skyLower",
    "skyHorizon", "fog", "oceanClose", "oceanFar", "riverClose", "riverFar"]) {
    colours[channel] = { times: [0], values: [channel === "fog" ? fog : colour] };
  }
  return { colours, fogEnd: { times: [0], values: [600] }, fogScale: { times: [0], values: [0.5] },
    waterShallowAlpha: 0.5, waterDeepAlpha: 0.9, oceanShallowAlpha: 0.6, oceanDeepAlpha: 1 };
}
function v5Set(colour, fog) {
  const set = colourSet(colour, fog);
  for (const name of ["sunColour", "sunHalo", "cloudA", "cloudB", "extra8", "extra13"]) {
    set.colours[name] = { times: [0], values: [0x010203] };
  }
  return set;
}

/** The light of every call below: (entry, underwater, ghost, liquidType, depth, storm). */
const at = (entry, underwater, ghost, liquidType, depth, storm = 0) => resolveLighting(entry, 0, 0, 1440, storm, 3,
  undefined, undefined, 1, undefined, undefined, underwater, ghost, liquidType, depth);

// An old gateway: no slot 4, no liquids, no sky channels — the v4 body.
const V4_ENTRY = {
  fallback: 1, fallbackLightId: 1, fallbackStorm: 2, fallbackUnderwater: 3,
  params: { 1: colourSet(0x808080), 2: colourSet(0x202020), 3: colourSet(0x0000ff) },
  volumes: [],
  lights: { 1: { params: 1, stormParams: 2, underwaterParams: 3 } },
};

test("(a) v4 body: a ghost sees exactly today's light — storm and underwater included", () => {
  for (const [underwater, storm] of [[false, 1], [true, 0], [true, 1], [false, 0.5]]) {
    const alive = at(V4_ENTRY, underwater, 0, undefined, 0, storm);
    for (const ghost of [1, 0.5]) {
      const dead = at(V4_ENTRY, underwater, ghost, undefined, 0, storm);
      assert.deepEqual(dead, alive, `ghost ${ghost}, underwater ${underwater}, storm ${storm}`);
    }
  }
});

const V5_ENTRY = {
  fallback: 1, fallbackLightId: 1, fallbackUnderwater: 2, fallbackDeath: 3,
  params: {
    1: v5Set(0x808080), 2: v5Set(0x0000ff), 3: v5Set(0x400000),
    4: v5Set(0x00ff00), 5: v5Set(0xff8000, 0xc04010), 6: v5Set(0x00ffff),
  },
  volumes: [],
  lights: {
    1: { params: 1, underwaterParams: 2, deathParams: 3 },
    7: { params: 4, underwaterParams: 5, deathParams: 6 },
  },
  liquids: { 2: { maxDarkenDepth: 30, fogDarken: 0.5, ambDarken: 0.5, dirDarken: 0.25 }, 3: { lightId: 7 } },
};

test("(d) v5: a ghost under lava or deep ocean sees the map's death light, not the liquid's", () => {
  const ghostInLava = at(V5_ENTRY, true, 1, 3, 5);
  assert.equal(ghostInLava.colours.ambient.r, 0x40 / 255, "the map's death set 3, not Light 7's slot 4");
  assert.equal(ghostInLava.colours.ambient.g, 0);
  const ghostDeep = at(V5_ENTRY, true, 1, 2, 30);
  assert.equal(ghostDeep.fogEnd, 600, "no ocean darkening over the death light");
  assert.equal(ghostDeep.colours.ambient.r, 0x40 / 255);
});

test("(c) the darkening edits only this frame's sample: repeated frames do not compound", () => {
  const first = at(V5_ENTRY, true, 0, 2, 30);
  const second = at(V5_ENTRY, true, 0, 2, 30);
  assert.equal(second.fogEnd, first.fogEnd);
  assert.equal(second.colours.ambient.b, first.colours.ambient.b);
  assert.equal(V5_ENTRY.params[2].colours.ambient.values[0], 0x0000ff, "the table is never written");
});

test("the sample says when a liquid's light and its depth darkening are in it", () => {
  const lava = at(V5_ENTRY, true, 0, 3, 2);
  assert.equal(lava.liquidLight, true);
  assert.equal(lava.liquidDarkens, false);
  const ocean = at(V5_ENTRY, true, 0, 2, 0);
  assert.equal(ocean.liquidLight, false);
  assert.equal(ocean.liquidDarkens, true, "known to darken even at the surface");
  const dry = at(V5_ENTRY, false, 0, 2, 0);
  assert.equal(dry.liquidLight, false);
  assert.equal(dry.liquidDarkens, false);
  const turning = at(V5_ENTRY, true, 0.5, 3, 2);
  assert.equal(turning.liquidLight, true, "a ghost turning under lava keeps the living half's lava light");
  assert.equal(at(V5_ENTRY, true, 0.5, 2, 2).liquidDarkens, true);
  const old = at(V4_ENTRY, true, 0, 2, 10);
  assert.equal(old.liquidLight, false);
  assert.equal(old.liquidDarkens, false);
});

test("(d) the ghost fade starts settled again after the world was not drawn for a fade's length", () => {
  const fade = new GhostLightFade();
  assert.equal(fade.weight(false, 0), 0);
  assert.equal(fade.weight(false, 16), 0);
  // Logged out alive, back at the character screen, in again as a ghost: never seen alive.
  assert.equal(fade.weight(true, 16 + GHOST_LIGHT_FADE_MS + 500), 1);
  // Within a session the turn still fades, frame by frame.
  const now = 16 + GHOST_LIGHT_FADE_MS + 500;
  assert.equal(fade.weight(false, now + 16), 1);
  assert.equal(fade.weight(false, now + 16 + 1000), 0.5);
});

// ---- the overlay hook ------------------------------------------------------------------------

const magma = (height) => ({ height, entry: 3, flags: 0x04 });
const ocean = (height) => ({ height, entry: 2, flags: 0x02 });

test("7.10 overlay: magma and slime take the tint of the liquid's light fog", () => {
  const light = at(V5_ENTRY, true, 0, 3, 4);
  const frame = underwaterOverlayFrame(magma(10), 6, 0.12, "magma", light);
  assert.ok(frame, "drawn under lava once its light is known");
  assert.ok(Math.abs(frame.tint[0] - 0xc0 / 255) < 1e-9);
  assert.ok(Math.abs(frame.tint[1] - 0x40 / 255) < 1e-9);
  assert.ok(Math.abs(frame.tint[2] - 0x10 / 255) < 1e-9);
  assert.equal(frame.fogStrength, underwaterFogStrength(4, false));
  assert.equal(underwaterOverlayFrame(magma(10), 6, 0.12, "slime", light)?.canal, false);
  // Without the liquid's light (old gateway, zone light, nothing pushed) it stays undrawn, as before.
  assert.equal(underwaterOverlayFrame(magma(10), 6, 0.12, "magma", at(V4_ENTRY, true, 0, 3, 4)), undefined);
  assert.equal(underwaterOverlayFrame(magma(10), 6, 0.12, "magma", undefined), undefined);
  assert.equal(underwaterOverlayFrame(magma(10), 6, 0.12, "magma"), undefined);
});

test("7.10 overlay: the ocean is darkened by depth once — by the light when it knows how", () => {
  const deep = at(V5_ENTRY, true, 0, 2, 20);
  const frame = underwaterOverlayFrame(ocean(30), 10, 0.12, "ocean", deep);
  assert.equal(frame.fogStrength, UNDERWATER_SURFACE_HANDOFF, "the light darkens; the overlay holds");
  assert.deepEqual([...frame.tint], [...UNDERWATER_LAKE_TINT], "water keeps the reference tint");
  // An old gateway: no darkening in the light, so the overlay deepens as it always did.
  const old = underwaterOverlayFrame(ocean(30), 10, 0.12, "ocean", at(V4_ENTRY, true, 0, 2, 20));
  assert.equal(old.fogStrength, underwaterFogStrength(20, false));
  assert.ok(old.fogStrength > UNDERWATER_SURFACE_HANDOFF);
  // A lake has no darkening columns: unchanged.
  const lake = underwaterOverlayFrame({ height: 30, entry: 1, flags: 1 }, 10, 0.12, "water", at(V5_ENTRY, true, 0, 1, 20));
  assert.equal(lake.fogStrength, underwaterFogStrength(20, false));
});
