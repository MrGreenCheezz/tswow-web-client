import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";

test("model texture loader exposes frozen exact pending/terminal stats", () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  const requests = new Map();
  THREE.TextureLoader.prototype.load = function (url, onLoad, _onProgress, onError) {
    const texture = new THREE.Texture();
    requests.set(url, { texture, onLoad, onError });
    return texture;
  };
  try {
    const loader = new ModelTextureLoader({ cache: true });
    const pending = loader.load("pending.blp");
    assert.deepEqual(loader.stats, { pending: 1, ready: 0, failed: 0, error: 0, generation: 0 });
    assert.ok(Object.isFrozen(loader.stats));

    requests.get("pending.blp").onLoad(pending);
    requests.get("pending.blp").onError(new Error("late failure"));
    assert.deepEqual(loader.stats, { pending: 0, ready: 1, failed: 0, error: 0, generation: 1 });

    const failed = loader.load("failed.blp");
    requests.get("failed.blp").onError(new Error("missing"));
    requests.get("failed.blp").onLoad(failed);
    assert.deepEqual(loader.stats, { pending: 0, ready: 1, failed: 1, error: 1, generation: 2 });
    assert.equal(loader.status(failed), "failed");

    const cached = loader.load("pending.blp");
    assert.strictEqual(cached, pending, "a settled cache hit does not create a request");
    assert.deepEqual(loader.stats, { pending: 0, ready: 1, failed: 1, error: 1, generation: 2 });
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});

test("model texture loader settles synchronous throws without hiding an exact failed request", () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  let throwLoad = true;
  let callbacks;
  THREE.TextureLoader.prototype.load = function (_url, onLoad, _onProgress, onError) {
    if (throwLoad) throw new Error("sync failure");
    const texture = new THREE.Texture();
    callbacks = { texture, onLoad, onError };
    return texture;
  };
  try {
    const loader = new ModelTextureLoader();
    assert.throws(() => loader.load("sync.blp"), /sync failure/);
    assert.deepEqual(loader.stats, { pending: 0, ready: 0, failed: 1, error: 1, generation: 1 });

    throwLoad = false;
    const recovered = loader.load("sync.blp");
    assert.deepEqual(loader.stats, { pending: 1, ready: 0, failed: 1, error: 1, generation: 1 });
    callbacks.onLoad(recovered);
    assert.deepEqual(loader.stats, { pending: 0, ready: 1, failed: 1, error: 1, generation: 2 });
    assert.equal(loader.status(recovered), "ready",
      "same-URL success belongs to its own request and cannot heal the earlier failed request");
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});

test("renderer has one generic texture entry point and a frozen readiness wiring", () => {
  const source = readFileSync("src/browser/WorldRenderer3D.ts", "utf8");
  assert.equal(
    (source.match(/#textureLoader\.load/g) ?? []).length,
    1,
    "only #loadWorldTexture may call the generic TextureLoader directly",
  );
  assert.match(source, /#loadWorldTexture\(\s*url: string/);
  assert.match(source, /get benchmarkReadiness\(\): Readonly<BenchmarkRendererReadinessInput>/);
  assert.match(source, /modelTexturesPending:\s*this\.#textures\.stats\.pending\s*\+\s*this\.#spellTextures\.stats\.pending/);
  assert.match(source,
    /const worldMaterialTextures = this\.#worldMaterials\.textureReadiness/);
  assert.match(source,
    /worldTexturesPending:\s*this\.#worldTexturesPending\s*\+\s*worldMaterialTextures\.pending/);
  assert.match(source,
    /worldTexturesErrors:\s*this\.#worldTextureErrors\.size\s*\+\s*worldMaterialTextures\.error/);
  assert.match(source,
    /worldTexturesGeneration:\s*this\.#worldTextureGeneration\s*\+\s*this\.#worldMaterialGenerationOffset\s*\+\s*worldMaterialTextures\.generation\s*\+\s*this\.#worldMaterials\.revision/);
  assert.match(source, /persistentStateVisuals/);
  assert.match(source, /transientVisuals:\s*this\.#visuals\.length\s*-\s*persistentStateVisuals/);
  assert.match(source, /return Object\.freeze\(\{\s*renderFrameActive:/s);
});
