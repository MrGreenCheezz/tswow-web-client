// 06.10-render-fix — owner, 06.10: «вода хорошо, остальное все ещё белое». Magma, slime, green lava
// and orange slime drew white: their material multiplied the white stand-in band colour by the
// strip's alpha ripple and never used the strip's RGB, which is where their colour lives. This file
// checks that a magma/slime surface ends up with a textured material whose colour comes from its
// strip, both against the new gateway (v2 table, family strips) and the fallback (v1 body, 404 on
// the family route, so the class strip stands in).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { LiquidTextureClient, buildLiquidMaterial } from "../dist/code/browser/Water.js";

const ROWS = {
  1: { soundBank: 0, family: "lake_a", textures: ["XTextures\\river\\lake_a.%d.blp"] },
  2: { soundBank: 1, family: "ocean_h", textures: ["XTextures\\ocean\\ocean_h.%d.blp"] },
  3: { soundBank: 2, family: "lava", textures: ["XTextures\\lava\\lava.%d.blp"] },
  4: { soundBank: 3, family: "slime", textures: ["XTextures\\slime\\slime.%d.blp"] },
  15: { soundBank: 2, family: "lavagreen", textures: ["XTextures\\LavaGreen\\lavagreen.%d.blp"] },
  181: { soundBank: 0, family: "lavaorange", textures: ["XTEXTURES\\LavaOrange\\LavaOrange.%d.blp"] },
};
const CLASSES = { 1: "water", 2: "ocean", 3: "magma", 4: "slime", 15: "magma", 181: "magma" };

/** The colour statement the liquid hook puts where `map_fragment` was. */
function colourLines(liquid) {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
  };
  liquid.material.onBeforeCompile(shader);
  return shader.fragmentShader.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("diffuseColor.rgb"));
}

/** Whether the surface's RGB is taken from its strip (the only place lava/slime colour exists). */
function usesStripColour(liquid) {
  return colourLines(liquid).some((line) => /\bsampledDiffuseColor\.rgb\b/.test(line));
}

const settle = async (turns = 8) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function mockGateway(handler) {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return handler(String(url));
  };
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    const texture = new THREE.Texture();
    texture.name = String(url);
    setImmediate(() => onLoad(texture));
    return texture;
  };
  return {
    fetched,
    restore: () => { globalThis.fetch = originalFetch; THREE.TextureLoader.prototype.load = originalLoad; },
  };
}

const json = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });

async function stripFor(client, surface) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const strip = client.get(surface);
    if (strip) return strip;
    await settle();
  }
  return undefined;
}

for (const [label, handler, expected] of [
  ["new gateway (v2 table, family strips)", (url) => url.includes("/dbc/liquid-types")
    ? json({ version: 2, classes: CLASSES, rows: ROWS })
    : json({ frames: 30 }), {
    magma: "/liquid/magma.png", slime: "/liquid/slime.png",
    "magma|lavagreen": "/liquid/family/lavagreen.png", "magma|lavaorange": "/liquid/family/lavaorange.png",
  }],
  ["fallback (v1 body, no family route)", (url) => {
    if (url.includes("/dbc/liquid-types")) return json(CLASSES);
    if (url.includes("/liquid/family/")) return json(undefined, 404);
    return json({ frames: 30 });
  }, {
    magma: "/liquid/magma.png", slime: "/liquid/slime.png",
    "magma|lavagreen": "/liquid/magma.png", "magma|lavaorange": "/liquid/magma.png",
  }],
]) {
  test(`magma/slime surfaces get a textured, strip-coloured material — ${label}`, async () => {
    const mock = mockGateway(handler);
    try {
      const client = new LiquidTextureClient("ws://glow.test/world", () => 1_000);
      void client.classes;
      await settle();
      for (const [surface, path] of Object.entries(expected)) {
        const strip = await stripFor(client, surface);
        assert.ok(strip, `${surface}: a strip arrives`);
        assert.equal(strip.texture.name, `http://glow.test${path}`, `${surface}: the strip it draws with`);
        const liquid = buildLiquidMaterial(surface, strip);
        assert.equal(liquid.material.map === strip.texture, true, `${surface}: the strip is the material's map`);
        assert.equal(liquid.material.color.getHex(), 0xffffff);
        assert.equal(liquid.uniforms.liquidShallowColour.value.getHex(), 0xffffff,
          "the band colour stays the white stand-in, so the strip must supply the hue");
        assert.equal(usesStripColour(liquid), true, `${surface}: colour comes from the strip, not white × ripple`);
        liquid.material.dispose();
      }
      client.dispose();
    } finally {
      mock.restore();
    }
  });
}

test("water and ocean keep their band colour with the strip alpha as ripple", () => {
  for (const surface of ["water", "ocean", "water|fast_a"]) {
    const liquid = buildLiquidMaterial(surface, { texture: new THREE.Texture(), frames: 30 });
    assert.deepEqual(colourLines(liquid), ["diffuseColor.rgb *= liquidBody * liquidRipple;"]);
    assert.equal(usesStripColour(liquid), false, `${surface}: the strip RGB is unpacked noise, not water`);
    liquid.material.dispose();
  }
});
