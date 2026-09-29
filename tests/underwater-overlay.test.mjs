import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  UNDERWATER_CANAL_TINT, UNDERWATER_CROSSING_BAND, UNDERWATER_LAKE_TINT,
  UNDERWATER_MAX_FOG, UNDERWATER_MENISCUS_YARDS, UNDERWATER_RIPPLE_YARDS,
  UNDERWATER_SURFACE_HANDOFF, WORLD_CAMERA_NEAR_PLANE, buildUnderwaterOverlay,
  underwaterCrossingBand, underwaterFogStrength, underwaterLiquidIsCanal, underwaterOverlayFrame,
} from "../dist/code/browser/WorldRenderer3D.js";
import { EYE_LIQUID_SAMPLE_BAND, eyeLiquidSurface } from "../dist/code/browser/game/Physics.js";
import {
  collisionLiquidEyeSubmerged, collisionModelLiquidAtEye,
} from "../dist/code/browser/game/CollisionLiquid.js";
import { transformCollisionMesh } from "../dist/code/browser/game/Collision.js";

const lake = (height) => ({ height, entry: 1, flags: 0x01 });
const canal = (height) => ({ height, entry: 13, flags: 0x01 });

// --- the numbers -------------------------------------------------------------------------------

test("P3-1 the crossing band is the near plane's half-height, never a flat number", () => {
  // wowee renderer.cpp:2871-2875: max(0.05, near * tan(fovY / 2)). At this client's camera —
  // 52 degrees through a near plane of 0.25 — that is 0.1219 yards of world, and it moves if
  // either of those two moves, which a compiled-in constant would not.
  assert.equal(WORLD_CAMERA_NEAR_PLANE, 0.25);
  assert.ok(Math.abs(underwaterCrossingBand(0.25, 52) - 0.12193314714146536) < 1e-12);
  assert.equal(UNDERWATER_CROSSING_BAND, underwaterCrossingBand(0.25, 52));
  // The floor, for a camera whose near plane is close enough to zero to make the band vanish.
  assert.equal(underwaterCrossingBand(0.001, 52), 0.05);
  assert.equal(underwaterCrossingBand(0.25, 0), 0.05);
  assert.equal(underwaterCrossingBand(Number.NaN, 52), 0.05);
  // The band the loop samples with is deliberately wider than the one the renderer decides with.
  assert.ok(EYE_LIQUID_SAMPLE_BAND > UNDERWATER_CROSSING_BAND);
});

test("P3-2 the canal tint belongs to three LiquidType rows and nothing else", () => {
  // wowee renderer.cpp:2911-2913. Row 13 is «WMO Water», which is what the vmap extractor writes
  // into LIQU for the models under Stormwind, so the city answers canal from either source.
  for (const entry of [5, 13, 17]) assert.equal(underwaterLiquidIsCanal(entry), true, `row ${entry}`);
  for (const entry of [0, 1, 2, 4, 6, 12, 14, 18, 181]) {
    assert.equal(underwaterLiquidIsCanal(entry), false, `row ${entry}`);
  }
  assert.deepEqual([...UNDERWATER_CANAL_TINT], [0.01, 0.04, 0.10]);
  assert.deepEqual([...UNDERWATER_LAKE_TINT], [0.03, 0.09, 0.18]);
});

test("P3-3 the tint hands over from the water plane at 0.38 and stops at 0.75", () => {
  // It does not start at zero: above the surface the view is darkened by looking through the water
  // plane itself, and once the eye is under, that plane is behind the camera. Starting near zero
  // made submerging brighten the scene.
  assert.equal(underwaterFogStrength(0, false), UNDERWATER_SURFACE_HANDOFF);
  assert.equal(underwaterFogStrength(0, true), 0.38);
  assert.equal(underwaterFogStrength(-5, false), 0.38, "the band above the surface holds the handoff");
  assert.ok(Math.abs(underwaterFogStrength(3, false) - 0.4918597593537185) < 1e-12);
  assert.ok(Math.abs(underwaterFogStrength(3, true) - 0.5752243754858246) < 1e-12);
  assert.ok(underwaterFogStrength(3, true) > underwaterFogStrength(3, false),
    "canal water fogs at 0.25 per yard against open water's 0.12");
  assert.ok(underwaterFogStrength(1000, false) <= UNDERWATER_MAX_FOG);
  assert.equal(underwaterFogStrength(Number.NaN, false), 0.38);
});

// --- activation --------------------------------------------------------------------------------

test("P3-4 the overlay activates a near-plane half-height before the eye crosses, and not sooner", () => {
  const band = UNDERWATER_CROSSING_BAND;
  const surface = lake(100);
  assert.equal(underwaterOverlayFrame(undefined, 100, band, "water"), undefined,
    "no surface is the ordinary frame and costs nothing");
  assert.equal(underwaterOverlayFrame(surface, 100 + band * 1.001, band, "water"), undefined,
    "a band above the surface is still a dry frame");
  assert.equal(underwaterOverlayFrame(surface, 200, band, "water"), undefined);
  assert.equal(underwaterOverlayFrame(surface, Number.NaN, band, "water"), undefined);
  assert.equal(underwaterOverlayFrame({ ...surface, height: Number.NaN }, 100, band, "water"), undefined);

  // Inside the band but above the surface: the near plane is cutting the water, so the pixels in
  // front of that cut are looking through it and are shaded, at the handoff strength.
  const crossing = underwaterOverlayFrame(surface, 100 + band * 0.5, band, "water");
  assert.ok(crossing);
  assert.equal(crossing.depth, 0, "the band above the surface is depth zero, not negative depth");
  assert.equal(crossing.fogStrength, 0.38);
  assert.equal(crossing.crossing, true, "a seam is still on screen");
  assert.deepEqual([...crossing.tint], [0.03, 0.09, 0.18]);

  // Under, but not yet a whole band under: the seam is still on screen.
  const straddling = underwaterOverlayFrame(surface, 100 - band * 0.5, band, "water");
  assert.equal(straddling.crossing, true);
  assert.ok(Math.abs(straddling.depth - band * 0.5) < 1e-12);

  // Fully under: the near plane is wholly below the surface, there is no seam left to draw, and
  // the shader is told to tint the whole view rather than test a plane behind the camera.
  const submerged = underwaterOverlayFrame(surface, 90, band, "water");
  assert.equal(submerged.crossing, false);
  assert.equal(submerged.depth, 10);
  assert.ok(Math.abs(submerged.fogStrength - underwaterFogStrength(10, false)) < 1e-12);
});

test("P3-5 canal water takes the darker tint from either source; magma and slime take none", () => {
  const band = UNDERWATER_CROSSING_BAND;
  const under = underwaterOverlayFrame(canal(50), 45, band, "water");
  assert.equal(under.canal, true);
  assert.deepEqual([...under.tint], [0.01, 0.04, 0.10]);
  assert.ok(Math.abs(under.fogStrength - underwaterFogStrength(5, true)) < 1e-12);
  assert.equal(underwaterOverlayFrame(lake(50), 45, band, "ocean").canal, false,
    "the ocean is open water and takes the open-water tint");

  // A decision, not an omission: both of the reference's tints are water, there is no authored
  // number anywhere for what magma or slime look like from the inside, and a dark blue lava lake
  // is a wrong answer where nothing at all is only a missing one.
  for (const liquidClass of ["magma", "slime"]) {
    assert.equal(underwaterOverlayFrame({ height: 50, entry: 3, flags: 0x04 }, 45, band, liquidClass),
      undefined, liquidClass);
  }
});

// --- which surface, and where it comes from ------------------------------------------------------

test("P3-6 the building wins over the map file, and only while its surface is over the eye", () => {
  const band = EYE_LIQUID_SAMPLE_BAND;
  const room = { height: 30, entry: 13, flags: 0 };
  const outdoor = { height: 80, entry: 1, flags: 0x01 };
  assert.equal(eyeLiquidSurface(28, band, room, outdoor), room,
    "the authoritative floor group is the room the camera is standing in");
  assert.equal(eyeLiquidSurface(40, band, room, outdoor), outdoor,
    "above the room's own water, the map file's lake overhead is the remaining answer");
  assert.equal(eyeLiquidSurface(28, band, undefined, outdoor), outdoor);
  assert.equal(eyeLiquidSurface(100, band, room, outdoor), undefined, "above both is no surface");
  assert.equal(eyeLiquidSurface(28, band, undefined, undefined), undefined);
  assert.equal(eyeLiquidSurface(Number.NaN, band, room, outdoor), undefined);
  // The band reaches upwards only.
  assert.equal(eyeLiquidSurface(80 + band * 0.5, band, undefined, outdoor), outdoor);
  assert.equal(eyeLiquidSurface(80 + band, band, undefined, outdoor), undefined);
});

test("P3-7 a WMO liquid hit carries its surface in world coordinates and still answers the light slot", () => {
  // The same fixture the collision suite measures the MLIQ interpolation on: one cell, corner
  // heights 0/10/20/40 in model space, placed at z = 10 with scale 2 and a 90 degree yaw.
  const cell = 533.3333333333334 / 128;
  const liquid = {
    tilesX: 1, tilesY: 1, cornerX: 0, cornerY: 0, cornerZ: 0, type: 13,
    heights: Float32Array.of(0, 10, 20, 40),
    flags: Uint8Array.of(0),
  };
  const group = {
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: cell, maxY: cell, maxZ: 50 },
    groupId: 904,
    liquid,
  };
  const placement = { x: 100, y: 200, z: 10, rotationX: 0, rotationY: 90, rotationZ: 0, scale: 2 };
  // Model (0.75, 0.75) of the cell interpolates to 27.5, so the surface stands at 10 + 2 × 27.5.
  // The eye is placed through the same forward transform the collision meshes go through.
  const placed = transformCollisionMesh(
    Float32Array.of(0.75 * cell, 0.75 * cell, 27), Uint32Array.of(0), placement,
  );
  const eye = { x: placed[0], y: placed[1], z: placed[2] };
  const under = collisionModelLiquidAtEye([group], 0, placement, eye);
  assert.ok(under, "the eye is a model yard under the surface");
  assert.ok(Math.abs(under.height - 27.5) < 1e-5, "height stays in the model's own space");
  assert.equal(under.worldHeight, 65, "world Z is the same point through the placement transform");
  assert.equal(collisionLiquidEyeSubmerged(under), true);

  // Half a world yard above the surface: invisible to the light slot, reported to the screen
  // effect, and the band is divided by the placement scale to reach model units.
  const above = { ...eye, z: 65 + 0.25 };
  assert.equal(collisionModelLiquidAtEye([group], 0, placement, above), undefined,
    "without a band this is the strict test the light slot has always asked");
  const banded = collisionModelLiquidAtEye([group], 0, placement, above, EYE_LIQUID_SAMPLE_BAND);
  assert.ok(banded, "with the band the surface is reported before the eye reaches it");
  assert.equal(banded.worldHeight, 65);
  assert.equal(collisionLiquidEyeSubmerged(banded), false,
    "a banded hit must not tell the light slot that the eye is under water");
  assert.equal(collisionLiquidEyeSubmerged(undefined), false);
  // Beyond the band, even a widened query says nothing.
  assert.equal(collisionModelLiquidAtEye(
    [group], 0, placement, { ...eye, z: 65 + 2 }, EYE_LIQUID_SAMPLE_BAND,
  ), undefined);
});

// --- where the pass sits, and what turns it off ---------------------------------------------------

test("P3-8 the overlay is its own scene, drawn only when all three answers say so", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  #drawUnderwaterOverlay(now: number): void {");
  const end = source.indexOf("\n  setLightingQuality(quality: number): void {", start);
  assert.ok(start >= 0 && end > start, "the overlay pass boundary must exist");
  const pass = source.slice(start, end);
  // It has to live outside `draw()`'s own source span, which the submission test slices between
  // `draw(` and `#resetFrameCounters` and reads as the frame itself.
  const drawEnd = source.indexOf("\n  #resetFrameCounters(): void {");
  assert.ok(drawEnd >= 0 && start > drawEnd, "the helper sits below the slice draw() is pinned by");

  const switchGuard = pass.indexOf("if (!this.#underwaterOverlayEnabled) return;");
  const surfaceGuard = pass.indexOf("if (!surface) return;");
  const frameGuard = pass.indexOf("if (!frame) return;");
  const submit = pass.indexOf("this.#renderer.render(this.#overlayScene, this.#overlayCamera);");
  assert.ok(switchGuard >= 0 && surfaceGuard > switchGuard && frameGuard > surfaceGuard && submit > frameGuard,
    "the switch, then the surface, then the geometry decide before a single GL call is made");
  // Deterministic replay: the seam ripples on the frame's own clock, never on wall time. Read
  // without the comments, one of which names the clock this must not use.
  const code = pass.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.match(code, /now \/ 1000/);
  assert.equal(code.includes("performance.now"), false);
  assert.match(pass, /this\.#camera\.position\.y/, "the eye is the camera's own, in scene units");

  assert.match(source, /this\.#overlayScene\.traverse\(visit\);/,
    "the third live scene is visited by the retained-resource walk like the other two");
  assert.match(source, /this\.#underwaterSurface = undefined;/,
    "a world teardown drops the observed surface");
});

test("P3-8b the overlay mesh is one textureless triangle that neither reads nor writes depth", () => {
  // The real thing rather than its source text: this is the object the renderer holds.
  const mesh = buildUnderwaterOverlay({
    invViewProj: { value: {} }, tint: { value: {} }, waterZ: { value: 0 }, params: { value: {} },
  });
  assert.equal(mesh.geometry.getAttribute("position").count, 3, "one triangle, not two");
  assert.equal(mesh.geometry.getIndex(), null);
  assert.equal(mesh.frustumCulled, false, "the triangle reaches outside the ortho box on purpose");
  const material = mesh.material;
  assert.equal(material.depthTest, false, "the world pass has already put its depth down");
  assert.equal(material.depthWrite, false);
  assert.equal(material.transparent, true);
  assert.equal(material.toneMapped, false);
  assert.equal(material.fog, false);
  // Nothing is sampled: the tint, the ripple and the meniscus are arithmetic, so this pass owns no
  // texture and registers none with the retained-resource visitor.
  for (const [name, uniform] of Object.entries(material.uniforms)) {
    assert.equal(uniform.value?.isTexture, undefined, name);
  }
  assert.equal(material.fragmentShader.includes("sampler"), false);
  assert.equal(material.fragmentShader.includes("texture"), false);
  // Both of the reference's shader includes are absent on purpose: the frame this blends into is
  // already tone mapped and encoded, and the reference presents through an UNORM swapchain, so its
  // constants are display-space numbers over display-space pixels.
  assert.equal(material.fragmentShader.includes("tonemapping_fragment"), false);
  assert.equal(material.fragmentShader.includes("colorspace_fragment"), false);
  // WebGL's clip volume runs -1..1 in depth, so the near plane is z = -1 and not the reference's 0.
  assert.match(material.fragmentShader, /vec4 clip = vec4\(vUV\.x \* 2\.0 - 1\.0, vUV\.y \* 2\.0 - 1\.0, -1\.0, 1\.0\);/);
  mesh.geometry.dispose();
  material.dispose();
});

test("P3-9 the switch is a leaf setting, a renderer mutator and a readback field", async () => {
  const model = await readFile(new URL("../src/browser/ui/SettingsModel.ts", import.meta.url), "utf8");
  assert.match(model, /id: "underwaterOverlay", label: "Эффект под водой", group: "Эффекты", kind: "boolean", fallback: true,/);
  const settings = await readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8");
  assert.match(settings, /setUnderwaterOverlay\?\.\(settingBoolean\(values, "underwaterOverlay"\)\)/,
    "applySettings pushes it like every other renderer-owned option");

  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /underwaterOverlay: this\.#underwaterOverlayEnabled,/,
    "the applied value is readable back for the formal benchmark");

  // Scout rule: a renderer mutator that the formal host does not know about fails a formal run.
  const host = await readFile(new URL("../src/browser/LiveFormalRenderBenchmarkHost.ts", import.meta.url), "utf8");
  const allowlist = host.slice(host.indexOf("const RENDERER_MUTATORS = ["), host.indexOf("] as const;\n\ntype RendererMutatorName"));
  assert.match(allowlist, /"setUnderwaterSurface"/, "the per-frame surface push is intercepted");
  assert.match(allowlist, /"setUnderwaterOverlay"/, "so is the switch");
  const restore = host.slice(host.indexOf("  #restoreUserGraphics(): void {"), host.indexOf("  #interceptRendererMutators("));
  assert.match(restore, /"setUnderwaterOverlay", \(\) => setUnderwaterOverlay\.call\(renderer, user\.underwaterOverlay\)/,
    "releasing the lease puts the account's own value back");
  assert.match(host, /underwaterOverlay: optionalBooleanSetting\(configuration, "underwaterOverlay"\)/,
    "a run measures the pass only where its variant asks for it");
});

test("P3-10 the loop pushes one surface per frame, from the query the light slot already made", async () => {
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const frameStart = loop.indexOf("function frame(now: number): void {");
  const frame = loop.slice(frameStart, loop.indexOf("\n}\n\n/**\n * One frame", frameStart));
  const lighting = frame.indexOf("game.renderer?.updateLighting(lightSample, half, underwater);");
  const push = frame.indexOf("game.renderer?.setUnderwaterSurface(underwaterSurface);");
  const branchEnd = frame.indexOf("\n    }\n", lighting);
  assert.ok(lighting >= 0 && push > branchEnd,
    "the surface is pushed outside the light branch, so a frame without game time clears it");
  assert.match(frame, /const wmoUnderwater = collisionLiquidEyeSubmerged\(wmoLiquid\);/,
    "the light slot reads its strict answer off the same hit the screen effect uses");
  assert.match(frame, /EYE_LIQUID_SAMPLE_BAND,\n\s*\)\n\s*: undefined;/,
    "the WMO query is the banded one");
});
