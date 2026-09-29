import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { webGlContextCanSubmit } from "../dist/code/browser/WorldRenderer3D.js";

test("context-loss submission guard is fail-closed", () => {
  assert.equal(webGlContextCanSubmit({ isContextLost: () => false }), true);
  assert.equal(webGlContextCanSubmit({ isContextLost: () => true }), false);
  assert.equal(webGlContextCanSubmit({ isContextLost: () => { throw new Error("lost"); } }), false);
  assert.equal(webGlContextCanSubmit(undefined), false);
});

test("world draw receipt is created only after both renderer submissions", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const drawStart = source.indexOf("  draw(\n");
  const drawEnd = source.indexOf("\n  #resetFrameCounters(): void {", drawStart);
  assert.ok(drawStart >= 0 && drawEnd > drawStart, "draw source boundary must exist");
  const draw = source.slice(drawStart, drawEnd);

  assert.match(source, /export interface WorldSubmissionReceipt\s*\{[\s\S]*readonly submitted: true;[\s\S]*readonly submissionSerial: number;/);
  assert.match(draw, /\): WorldSubmissionReceipt \| undefined \{/);

  const guard = draw.indexOf("if (!player?.position) {");
  const earlyReturn = draw.indexOf("return undefined;", guard);
  const sky = draw.indexOf("this.#renderer.render(this.#skyScene, this.#camera);");
  const world = draw.indexOf("this.#renderer.render(this.#scene, this.#camera);");
  const contextGuard = draw.indexOf("if (!webGlContextCanSubmit(submissionContext)) return undefined;", world);
  const finallyBlock = draw.indexOf("} finally {", world);
  const receipt = draw.indexOf("return Object.freeze({ submitted: true as const, submissionSerial });");
  assert.ok(guard >= 0 && earlyReturn > guard, "missing player exits without a receipt");
  assert.ok(sky > earlyReturn && world > sky && contextGuard > world && finallyBlock > contextGuard && receipt > finallyBlock,
    "receipt must follow sky, world, post-render context proof, and renderer cleanup");

  // P3. The underwater overlay is the one pass allowed between the world render and the context
  // proof, and its position is the whole design: after the world so it tints a finished frame,
  // inside the same try so it inherits `autoClear = false`, and before the proof so a context lost
  // while it draws still cannot produce a receipt. Anything else appearing in that gap is a
  // regression, not a refactor.
  const overlay = draw.indexOf("this.#drawUnderwaterOverlay(now);", world);
  assert.ok(overlay > world && overlay < contextGuard,
    "the underwater overlay is submitted after the world pass and before the context proof");
  assert.equal(draw.indexOf("this.#renderer.render(", overlay), -1,
    "no further renderer submission may follow the overlay inside draw()");

  // P4. The glow chain wraps the three submissions above rather than joining them, and every part
  // of that is load-bearing. `#beginFullscreenGlow` binds the offscreen buffer *before* the sky
  // pass, or the sky would land on the canvas and the world beside it; the composite runs after the
  // overlay, so the tint is part of the frame that blooms; and the release sits in `finally`,
  // because a throw between them would otherwise leave the renderer pointed at a render target and
  // the next portrait would be drawn inside it. The chain's own four submissions deliberately live
  // in helpers below `#resetFrameCounters`, which is why the assertion above still holds.
  const glowBegin = draw.indexOf("const glow = this.#beginFullscreenGlow();");
  const glowCompose = draw.indexOf("this.#composeFullscreenGlow(glow);", overlay);
  const glowEnd = draw.indexOf("this.#endFullscreenGlow(glow);", finallyBlock);
  assert.ok(glowBegin > earlyReturn && glowBegin < sky,
    "the offscreen target is bound before the sky pass");
  assert.ok(glowCompose > overlay && glowCompose < contextGuard,
    "the glow composite runs after the underwater overlay and before the context proof");
  assert.ok(glowEnd > finallyBlock,
    "the render target is handed back in the same finally that restores autoClear");

  assert.match(draw, /Number\.isSafeInteger\(this\.#submissionSerial\)/);
  assert.match(draw, /this\.#submissionSerial >= Number\.MAX_SAFE_INTEGER/);
  assert.match(draw, /Number\.isSafeInteger\(submissionSerial\)/);
  assert.ok(draw.indexOf("this.#submissionSerial = submissionSerial;") > world);

  const resetStart = source.indexOf("  resetReplayEpoch(rngSeed: number): void {");
  const resetEnd = source.indexOf("\n  /** Leaves deterministic evolution", resetStart);
  assert.ok(resetStart >= 0 && resetEnd > resetStart, "reset source boundary must exist");
  assert.equal(source.slice(resetStart, resetEnd).includes("#submissionSerial"), false,
    "replay reset must not rewind the lifetime submission serial");
});

test("world terrain update pins its complete CPU dependency ring and clears invalid centres", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  #updateTerrain(");
  const end = source.indexOf("\n  /**\n   * The ground beyond the ring", start);
  assert.ok(start >= 0 && end > start, "terrain update source boundary must exist");
  const update = source.slice(start, end);

  assert.match(update, /if \(map === undefined \|\| !center\) \{[\s\S]*terrainClient\?\.setActiveTiles\(undefined, \[\]\);[\s\S]*return;/,
    "an invalid map or centre clears stale pins");
  assert.match(update, /terrainClient\?\.setActiveTiles\(map, plan\.dependencies\);/,
    "the renderer pins every dependency selected by the bounded streaming plan");
  assert.match(update, /const grids = plan\.visible;/,
    "only the plan's visible 3x3 enters foreground builds");

  const invalid = update.indexOf("if (map === undefined || !center) {");
  const invalidClear = update.indexOf("this.clearTerrain();", invalid);
  const invalidSplat = update.indexOf("splatClient?.setActiveTiles(undefined, []);", invalid);
  const invalidCpu = update.indexOf("terrainClient?.setActiveTiles(undefined, []);", invalid);
  assert.ok(invalidClear > invalid && invalidSplat > invalidClear && invalidCpu > invalidSplat,
    "invalid terrain detaches renderer materials before splat eviction and CPU pin clearing");

  const visible = update.indexOf("if (plan !== this.#terrainPlan)");
  const removal = update.indexOf("this.#removeTerrain", visible);
  const splatPins = update.indexOf("splatClient?.setActiveTiles(map, plan.retained);", visible);
  const build = update.indexOf("for (const grid of grids)", splatPins);
  assert.ok(visible >= 0 && removal > visible && splatPins > removal && build > splatPins,
    "old materials are detached before retained splat eviction and new tile lookup");
  assert.match(source, /public clearTerrain\(\): void \{[\s\S]*this\.#removeTerrain/,
    "public terrain cleanup reuses the normal removal path");
});

test("terrain tile builds are staggered so a tile crossing cannot hitch one frame", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /const TERRAIN_BUILD_BUDGET = 1;/,
    "the stagger budget is a named constant beside the other build budgets");
  assert.match(source, /const TERRAIN_REPAIR_STEPS = 128;/);
  const start = source.indexOf("  #updateTerrain(");
  const end = source.indexOf("\n  /**\n   * The ground beyond the ring", start);
  assert.ok(start >= 0 && end > start, "terrain update source boundary must exist");
  const update = source.slice(start, end);
  assert.match(update, /let terrainBuilds = 0;/, "the build count resets every frame");
  assert.match(update, /this\.#terrainRepairsPending = 0;/, "visible repair demand resets every frame");
  assert.match(update, /if \(!isCenterTile && terrainBuilds >= TERRAIN_BUILD_BUDGET\) continue;/,
    "a skipped tile keeps its stale state and is rebuilt on a later frame rather than dropped");
  assert.match(update, /terrainBuilds\+\+;/, "only completed builds spend the budget");
  assert.match(update, /step < TERRAIN_REPAIR_STEPS && performance\.now\(\) < deadline/,
    "repair work is bounded by both the time allowance and the step cap");
  assert.match(update, /const settled = this\.#terrains\.get\(key\);/,
    "a budgeted-out tile has no entry until its build runs");
});

test("terrain pins reuse a stable streaming plan between centre and approach changes", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  #updateTerrain(");
  const end = source.indexOf("\n  /**\n   * The ground beyond the ring", start);
  assert.ok(start >= 0 && end > start, "terrain update source boundary must exist");
  const update = source.slice(start, end);
  assert.match(update, /if \(plan !== this\.#terrainPlan\) \{/,
    "pin ring and removals are skipped while the streaming plan is unchanged");
  assert.match(update, /const grids = plan\.visible;/,
    "the revision loop reuses the cached footprint instead of rebuilding it");
});

test("missing-player draw and world teardown release renderer users before splat ownership", async () => {
  const rendererSource = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const drawStart = rendererSource.indexOf("  draw(\n");
  const drawEnd = rendererSource.indexOf("\n  #resetFrameCounters(): void {", drawStart);
  const draw = rendererSource.slice(drawStart, drawEnd);
  const guard = draw.indexOf("if (!player?.position) {");
  const clear = draw.indexOf("this.clearTerrain();", guard);
  const splat = draw.indexOf("splatClient?.setActiveTiles(undefined, []);", guard);
  const cpu = draw.indexOf("terrainClient?.setActiveTiles(undefined, []);", guard);
  assert.ok(guard >= 0 && clear > guard && splat > clear && cpu > splat,
    "draw without a player detaches materials before splat eviction");

  const context = await readFile(new URL("../src/browser/game/Context.ts", import.meta.url), "utf8");
  const contextStart = context.indexOf("export function clearWorldContext(): void {");
  const contextEnd = context.indexOf("\n}", contextStart);
  const cleanup = context.slice(contextStart, contextEnd);
  const contextClear = cleanup.indexOf("game.renderer?.clearTerrain();");
  const contextDispose = cleanup.indexOf("game.terrainSplat?.dispose();");
  const dropSplat = cleanup.indexOf("game.terrainSplat = undefined;");
  assert.ok(contextClear >= 0 && contextDispose > contextClear && dropSplat > contextDispose,
    "world teardown drops material users, disposes splats, then drops references");

  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const player = loop.indexOf("const player = world?.state.selfGuid");
  const branch = loop.indexOf("if (world && player?.position && !worldPanel.hidden)", player);
  const noPlayer = loop.slice(player, branch);
  const liveClear = noPlayer.indexOf("game.renderer?.clearTerrain();");
  const liveSplat = noPlayer.indexOf("game.terrainSplat?.setActiveTiles(undefined, []);");
  assert.ok(liveClear >= 0 && liveSplat > liveClear,
    "the live no-player path releases renderer users before emptying the splat active set");
});

test("the production loop updates terrain pins after state drain and before loading", async () => {
  const source = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const frameStart = source.indexOf("function frame(now: number): void {");
  const frameEnd = source.indexOf("\n}\n\n/**\n * One frame", frameStart);
  assert.ok(frameStart >= 0 && frameEnd > frameStart, "frame source boundary must exist");
  const frame = source.slice(frameStart, frameEnd);
  const drained = frame.indexOf("drainWorldState();");
  const pins = frame.indexOf("updateTerrainActiveTiles");
  const loading = frame.indexOf("updateLoadingScreen(now);");
  const rendererBranch = frame.indexOf("if (renderer) {");
  assert.ok(drained >= 0 && pins > drained && loading > pins,
    "active terrain pins must be refreshed after state drain and before loading readiness");
  assert.ok(pins < rendererBranch,
    "the live terrain pin caller must be outside the renderer/WebGL branch");

  const helperStart = source.indexOf("function updateTerrainActiveTiles");
  const helperEnd = source.indexOf("\n}\n\nfunction frame", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "terrain pin helper boundary must exist");
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /if \(world\?\.mapId === undefined \|\| !player\?\.position\) \{[\s\S]*setActiveTiles\(undefined, \[\]\);/,
    "no world, map, or player clears stale active pins");
  assert.match(helper, /terrainGridDependencyFootprint\(player\.position\.x, player\.position\.y\)/,
    "valid player positions use the clipped dependency footprint");
  assert.match(helper, /if \(grids\.length === 0\) \{[\s\S]*setActiveTiles\(undefined, \[\]\);/,
    "an out-of-map player centre also clears stale active pins");
});
