import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const terrainSplat = await readFile(new URL("../src/browser/TerrainSplat.ts", import.meta.url), "utf8");
const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
const wmoOcclusion = await readFile(new URL("../src/browser/WmoOcclusion.ts", import.meta.url), "utf8");
const gateway = await readFile(new URL("../src/gateway/Gateway.ts", import.meta.url), "utf8");
const fingerprint = await readFile(new URL("../src/gateway/DatasetFingerprint.ts", import.meta.url), "utf8");
const visualTileGenerator = await readFile(new URL("../tools/generate-visual-tile.mjs", import.meta.url), "utf8");

function currentPortalSelector() {
  const source = wmoOcclusion.replace(/^import[^\n]*\n/gm, "").replaceAll("export ", "");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(`${javascript}; return selectWmoPortalGroups;`)();
}

function rendererConstant(name) {
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(\\d[\\d_]*)`).exec(renderer);
  assert.ok(match, `${name} constant exists`);
  return Number(match[1].replaceAll("_", ""));
}

test("terrain micro-normal does not paint either chunk or tile boundaries into the light", () => {
  assert.doesNotMatch(terrainSplat, /fract\(vSplatUv\s*\*\s*16\.0\)/,
    "a repeated 16x16 mask paints the authored chunk grid into the light");
  assert.doesNotMatch(terrainSplat, /terrainTileEdge(?:Distance|Footprint|Width|Fade)/,
    "even a one-tile edge mask paints a straight zero-normal strip along every ADT join");
  assert.doesNotMatch(terrainSplat, /smoothstep\(0\.0,\s*0\.012,\s*terrainTileEdgeDistance\)/,
    "a fixed 0.012 tile-UV fade is a visible 6.4-yard strip on every tile side");
  assert.match(terrainSplat, /terrainMicroGradient\s*\*=\s*0\.08\s*\*\s*terrainMicroOutlierFade\s*\*\s*terrainDistanceFade/,
    "only implausible derivative spikes and distance should bound the subtle profile");
});

test("portal refinement seeds both the camera and the player so a third-person doorway cannot empty the inn", () => {
  const select = currentPortalSelector();
  const groups = [
    {
      bounds: { minX: -0.5, minY: -0.5, minZ: -0.5, maxX: 0.5, maxY: 0.5, maxZ: 0.5 },
      indoor: true, exterior: false, portalStart: 0, portalCount: 1,
    },
    {
      bounds: { minX: 1.5, minY: -0.5, minZ: -0.5, maxX: 2.5, maxY: 0.5, maxZ: 0.5 },
      indoor: true, exterior: false, portalStart: 1, portalCount: 1,
    },
  ];
  const portals = {
    // The portal is outside the camera aperture. Camera-only traversal therefore cannot reach
    // room 1; the player's containing room is the conservative second seed that keeps it present.
    vertices: new Float32Array([10, 10, 0, 11, 10, 0, 10, 11, 0]),
    definitions: [{ startVertex: 0, vertexCount: 3 }],
    references: [{ portal: 0, group: 1 }, { portal: 0, group: 0 }],
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const selected = select(
    groups, portals, [0, 1],
    { x: 0, y: 0, z: 0 }, identity,
    { x: 2, y: 0, z: 0 },
  );
  assert.deepEqual(selected.groups, [0, 1]);
  assert.equal(selected.used, true);
  assert.equal(selected.culled, 0);

  assert.match(renderer,
    /#wmoViewerModel\.set\(player\.x,\s*player\.z,\s*-player\.y\)\.applyMatrix4\(placed\.worldToModel\)/,
    "the production caller must convert WoW x/y/z into the renderer's x/z/-y scene frame before model space");
  assert.match(renderer,
    /selectWmoPortalGroups\([\s\S]*?this\.#wmoCameraModel,[\s\S]*?this\.#wmoModelToClip\.elements,[\s\S]*?this\.#wmoViewerModel,[\s\S]*?\)/,
    "a selector-only fix is inert unless the renderer passes the player seed");
});

test("an indoor WMO fog record never replaces the whole scene fog seen through a door", () => {
  const start = renderer.indexOf("  #applyWmoFogCandidate(): void {");
  const end = renderer.indexOf("\n  }", start) + 4;
  assert.ok(start >= 0 && end > start, "WMO fog application seam exists");
  const method = renderer.slice(start, end);
  assert.doesNotMatch(method, /this\.#scene\.fog|fog\.color|fog\.near|fog\.far/,
    "Goldshire's peach 83-yard MFOG is room metadata, not a global outdoor fog state");
  assert.match(method, /#wmoInteriorFog/,
    "the authored room record stays available to the WMO-only material path");
});

test("Goldshire inn furniture cannot be evicted by the interior draw quota while still in the room", () => {
  // Placement 71414 contains 338 MODD records. Measured from its real visual tiles, 107 are within
  // 10 yards and 275 within 20, so the old quota of 120 made ordinary camera/player movement swap
  // visible tables and chairs for nearer bottles and cutlery even though everything remained in
  // range. Static duplicates are instanced later, so this is placement admission, not 338 draws.
  const drawBudget = rendererConstant("INTERIOR_BUDGET");
  const warmBudget = rendererConstant("ENVIRONMENT_WARM_INTERIOR_BUDGET");
  assert.ok(drawBudget >= 338, `interior draw budget ${drawBudget} cannot hold Goldshire inn's 338 doodads`);
  assert.ok(warmBudget >= drawBudget * 3,
    `warm interior budget ${warmBudget} must retain three previous ${drawBudget}-placement view sectors`);
});

test("legacy visual tiles are invalidated once so indoor MODR lighting reaches every map", () => {
  assert.match(visualTileGenerator, /generation:\s*["']visual-tile-v3["']/,
    "new visual-tile stamps need an explicit generator generation");
  assert.match(gateway, /ensureCurrent\(filename,\s*\{\s*generation:\s*["']visual-tile-v3["']\s*\}\)/,
    "the route must reject tiles built before WMO group ownership was available");
  assert.match(fingerprint, /options\.generation[\s\S]{0,180}?stamp\?*\.generation/,
    "cache validation must compare the route's requested generation with its stamp");
  assert.match(visualTileGenerator,
    /wmo-doodad-light-v1\\0\$\{rootPath\.toLowerCase\(\)\}/,
    "the persistent WMO parse cache is keyed by a normalized root path, not by one ADT");
  assert.match(visualTileGenerator,
    /stampIsCurrent\(destination,\s*archives,\s*inputs\)[\s\S]{0,900}parseWmoDoodadSets\(rootData,\s*groups\)/,
    "a current source-stamped root cache must avoid rereading every WMO group for each city tile");
  assert.match(visualTileGenerator,
    /validParsedWmoDoodadSets\(cached\.sets\)[\s\S]{0,1400}writeFile\(temporary,[\s\S]{0,300}rename\(temporary,\s*destination\)/,
    "cached JSON must be structurally validated and atomically published before it is trusted");
  assert.match(visualTileGenerator, /paths:\s*\[rootPath,\s*\.\.\.groupPaths\]/,
    "a changed MODR/MOCV group must invalidate the shared root parse cache");
});
