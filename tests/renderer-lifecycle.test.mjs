import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  disposeSkinnedInstance,
} from "../dist/code/browser/AnimatedModel.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";
import {
  worldBuiltModelCacheKey,
  worldResourceCacheKey,
} from "../dist/code/browser/WorldRenderer3D.js";

test("skinned instance disposal is exactly once and leaves shared model resources alone", () => {
  let stopped = 0;
  let uncached = 0;
  let skeletonDisposals = 0;
  let geometryDisposals = 0;
  let materialDisposals = 0;
  const root = {};
  const instance = {
    root,
    mesh: {
      geometry: { dispose: () => { geometryDisposals++; } },
      material: { dispose: () => { materialDisposals++; } },
    },
    mixer: {
      stopAllAction: () => { stopped++; },
      uncacheRoot: (value) => {
        assert.strictEqual(value, root);
        uncached++;
      },
    },
    skeleton: { dispose: () => { skeletonDisposals++; } },
  };

  disposeSkinnedInstance(instance);
  disposeSkinnedInstance(instance);

  assert.deepEqual({ stopped, uncached, skeletonDisposals }, {
    stopped: 1, uncached: 1, skeletonDisposals: 1,
  });
  assert.deepEqual({ geometryDisposals, materialDisposals }, {
    geometryDisposals: 0, materialDisposals: 0,
  });
});

test("texture cache clear is idempotent and ignores old-session completion", () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  const requests = [];
  THREE.TextureLoader.prototype.load = function (_url, onLoad, _onProgress, onError) {
    const texture = new THREE.Texture();
    requests.push({ texture, onLoad, onError });
    return texture;
  };
  try {
    const loader = new ModelTextureLoader({ cache: true });
    const oldTexture = loader.load("same-key.png");
    let oldDisposals = 0;
    oldTexture.addEventListener("dispose", () => { oldDisposals++; });

    loader.clear();
    loader.clear();
    assert.equal(oldDisposals, 1, "repeated clear does not dispose an old entry twice");

    const newTexture = loader.load("same-key.png");
    assert.notStrictEqual(newTexture, oldTexture, "a new session rebuilds the same logical key");
    requests[0].onLoad?.(oldTexture);
    assert.deepEqual(loader.stats, {
      pending: 1, ready: 0, failed: 0, error: 0, generation: 2,
    }, "the old completion cannot settle the new session request");

    requests[1].onLoad?.(newTexture);
    assert.deepEqual(loader.stats, {
      pending: 0, ready: 1, failed: 0, error: 0, generation: 3,
    });
    let newDisposals = 0;
    newTexture.addEventListener("dispose", () => { newDisposals++; });
    loader.clear();
    loader.clear();
    assert.equal(newDisposals, 1);
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});

test("renderer world cache keys include the monotonic session epoch", () => {
  assert.equal(worldResourceCacheKey(7, "Creature/Horse.m2"), "7|Creature/Horse.m2");
  assert.notEqual(
    worldResourceCacheKey(7, "Creature/Horse.m2"),
    worldResourceCacheKey(8, "Creature/Horse.m2"),
  );
  assert.notEqual(
    worldBuiltModelCacheKey(7, "model", "shared"),
    worldBuiltModelCacheKey(7, "unit", "shared"),
    "model and unit templates have disjoint ownership namespaces",
  );
});

test("renderer lifecycle routes realm and full teardown through one world clear", async () => {
  const [renderer, context, portrait] = await Promise.all([
    readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/game/Context.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/PortraitRenderer.ts", import.meta.url), "utf8"),
  ]);

  const clearStart = renderer.indexOf("  clearWorldResources(): void {");
  const clearEnd = renderer.indexOf("\n  dispose(): void {", clearStart);
  assert.ok(clearStart >= 0 && clearEnd > clearStart, "world clear and full dispose boundaries exist");
  const clear = renderer.slice(clearStart, clearEnd);
  for (const expected of [
    "this.#disposeEnvironment(rendered)",
    "this.#disposeGameObject(rendered)",
    "this.#clearUnitNode(unit)",
    "this.#builtModels.clear()",
    "this.#builtUnits.clear()",
    "this.#skinnedTemplates.clear()",
    "this.#baseUrl = \"\"",
    "this.#worldResourceEpoch++",
  ]) assert.ok(clear.includes(expected), `world clear must contain ${expected}`);
  assert.match(renderer, /#wvmBuild\([\s\S]*const cacheKey = this\.#builtCacheKey\(cache, key\);[\s\S]*cache\.get\(cacheKey\)/,
    "built-model lookup uses the session-qualified key");
  assert.match(renderer, /#loadWorldTexture\([\s\S]*const epoch = this\.#worldResourceEpoch;[\s\S]*epoch !== this\.#worldResourceEpoch/,
    "generic texture callbacks are guarded by the captured world epoch");

  const evictionStart = renderer.indexOf("  #evictBuiltModelCaches(): void {");
  const evictionEnd = renderer.indexOf("\n  #drawUnit(", evictionStart);
  const eviction = renderer.slice(evictionStart, evictionEnd);
  assert.match(eviction, /const liveAtlases = new Set<string>\(\);/);
  assert.match(eviction, /atlases\?\.commitPins\(liveAtlases, activeAtlases\)/,
    "character atlases retain their raw appearance keys rather than epoch-qualified build keys");
  assert.doesNotMatch(eviction, /commitPins\([^)]*worldResourceCacheKey/);

  const full = renderer.slice(clearEnd, renderer.indexOf("\n  /**", clearEnd));
  assert.ok(full.indexOf("this.clearWorldResources();") >= 0);
  assert.ok(full.indexOf("this.#renderer.dispose();") > full.indexOf("this.clearWorldResources();"));
  assert.match(full, /if \(this\.#disposed\) return;/);

  const contextStart = context.indexOf("export function clearWorldContext(): void {");
  const contextEnd = context.indexOf("\n}", contextStart);
  const contextClear = context.slice(contextStart, contextEnd);
  const rendererClear = contextClear.indexOf("game.renderer?.clearWorldResources();");
  const splatDispose = contextClear.indexOf("game.terrainSplat?.dispose();");
  const environmentDispose = contextClear.indexOf("game.environment?.dispose();");
  assert.ok(rendererClear >= 0 && splatDispose > rendererClear,
    "renderer releases all world users before realm-owned clients are disposed");
  assert.ok(environmentDispose > rendererClear,
    "old decoded model sources are detached only after renderer instances and builds are gone");

  assert.equal((renderer.match(/\.mixer\.uncacheRoot\(/g) ?? []).length, 0,
    "WorldRenderer3D uses the shared instance disposer on every removal path");
  assert.equal((portrait.match(/\.mixer\.uncacheRoot\(/g) ?? []).length, 0,
    "portraits use the shared instance disposer too");
});
