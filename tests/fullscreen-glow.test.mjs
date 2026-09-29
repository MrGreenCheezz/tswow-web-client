// P4/P4b — the classic 3.3.5 full-screen glow (ffxGlow).
//
// What is worth a test here is not the pass count. It is that the offscreen frame is the same
// frame the canvas would have held — P4b makes three grade and encode into the render target rather
// than putting the curve back afterwards — that the authored strength travels from
// `LightParams.Glow` to the uniform without being invented anywhere along the way, and that the
// leaf, not the data, decides which of the two pipelines a frame takes.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as THREE from "three";

import {
  GLOW_BRIGHT_HEADROOM, GLOW_BRIGHT_KNEE, GLOW_BRIGHT_KNEE_DISPLAY, GLOW_MAX_STRENGTH,
  buildFullscreenGlowPasses, glowAddStrength, glowChainSize,
} from "../dist/code/browser/WorldRenderer3D.js";
import { TONE_SHOULDER_GLSL, toneShoulder } from "../dist/code/browser/LightingQuality.js";
import { resolveLighting } from "../dist/code/browser/LightClient.js";

const rendererSource = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");

/** three's own encode, transcribed in `tests/tone-mapping.test.mjs` from the same chunk. */
const linearToSrgb = (c) => (c < 0.0031308 ? c * 12.92 : 1.055 * c ** 0.41666 - 0.055);

test("the authored strength is clamped to the range the artists actually used", () => {
  // Measured over this dataset's 850 LightParams rows: every Glow is in [0, 1]. The clamp therefore
  // cannot move a single shipped zone, and exists for a hand-edited table.
  assert.equal(GLOW_MAX_STRENGTH, 1);
  assert.equal(glowAddStrength(0), 0, "Ironforge and Dalaran author exactly no glow");
  assert.equal(glowAddStrength(0.3), 0.3, "Stormwind");
  assert.equal(glowAddStrength(0.65), 0.65, "Elwynn, and the global default Light row 1");
  assert.equal(glowAddStrength(1), 1, "Darnassus");

  // Absent is not zero by accident: a gateway older than P4 answers a light table with no glow at
  // all, and the browser has to read that as "no glow" rather than as NaN in a uniform.
  assert.equal(glowAddStrength(undefined), 0);
  assert.equal(glowAddStrength(Number.NaN), 0);
  // Infinity is a broken table too, not "as much glow as possible".
  assert.equal(glowAddStrength(Number.POSITIVE_INFINITY), 0);
  assert.equal(glowAddStrength(-2), 0);
  assert.equal(glowAddStrength(4), 1);
});

test("the bright-pass knee is the tone shoulder's own knee, not a chosen number", () => {
  // Below the knee the curve is exactly the identity; above it, it bends. That is what makes 0.9
  // the value at which this client declares a channel to be a white core, and the glow blooms
  // precisely what the shoulder is already compressing.
  assert.equal(GLOW_BRIGHT_KNEE, 0.9);
  assert.equal(toneShoulder(GLOW_BRIGHT_KNEE), GLOW_BRIGHT_KNEE);
  assert.equal(toneShoulder(GLOW_BRIGHT_KNEE - 0.1), GLOW_BRIGHT_KNEE - 0.1);
  assert.ok(toneShoulder(GLOW_BRIGHT_KNEE + 0.05) < GLOW_BRIGHT_KNEE + 0.05,
    "anything above the knee is compressed, which is what makes it the knee");
});

test("P4b: the knee is carried into display space rather than reused as if nothing moved", () => {
  // The buffer the bright pass samples holds screen values now, so the same 0.9 read there would
  // be a different pixel entirely — exactly the trap `tests/tone-mapping.test.mjs` names when it
  // shows the reference reading its own 0.9 as a screen value.
  assert.ok(Math.abs(GLOW_BRIGHT_KNEE_DISPLAY - linearToSrgb(toneShoulder(GLOW_BRIGHT_KNEE))) < 1e-12,
    "the display knee is the linear knee through the curve and then through three's own encode");
  assert.equal(GLOW_BRIGHT_KNEE_DISPLAY.toFixed(6), "0.954688");
  assert.equal(Math.round(GLOW_BRIGHT_KNEE_DISPLAY * 255), 243,
    "sRGB 243 — the same byte tone-mapping's own table calls the first level the shoulder reaches");

  // And the size of the mistake that was avoided, in the units the shader works in.
  const wouldHaveBloomedFrom = ((GLOW_BRIGHT_KNEE + 0.055) / 1.055) ** 2.4;
  assert.ok(Math.abs(wouldHaveBloomedFrom - 0.78741) < 1e-4,
    `reusing the linear knee would start the bloom at linear ${wouldHaveBloomedFrom}`);
  assert.ok(wouldHaveBloomedFrom < GLOW_BRIGHT_KNEE,
    "that is below the knee, where the curve is still the identity and nothing is over-bright");

  // The white core is a *narrow* band on screen, and that is what the normalisation answers: the
  // shoulder's asymptote is 1.0, so every linear value from the knee upwards is folded into these
  // twelve levels. Measured on a hard-edged quad: raw excess gave a 4-byte halo, this one 90.
  assert.ok(Math.abs(GLOW_BRIGHT_HEADROOM - (1 - GLOW_BRIGHT_KNEE_DISPLAY)) < 1e-12);
  assert.equal(GLOW_BRIGHT_HEADROOM.toFixed(6), "0.045312");
  assert.equal(Math.round(GLOW_BRIGHT_HEADROOM * 255), 12,
    "twelve of 255 levels hold everything the curve calls over-bright");
  // A pixel exactly at the knee contributes nothing; one at screen white contributes all of it.
  const contribution = (display) => Math.max(display - GLOW_BRIGHT_KNEE_DISPLAY, 0) / GLOW_BRIGHT_HEADROOM;
  assert.equal(contribution(GLOW_BRIGHT_KNEE_DISPLAY), 0);
  assert.ok(Math.abs(contribution(1) - 1) < 1e-12);
  assert.equal(contribution(0.5), 0, "and nothing under the knee moves at all, as in P4");
});

test("the chain's buffers halve without ever asking for a zero-sized target", () => {
  assert.deepEqual({ ...glowChainSize(1280, 720) },
    { width: 1280, height: 720, halfWidth: 640, halfHeight: 360 });
  // An odd dimension halves down, so the blur never samples past the frame it came from.
  assert.deepEqual({ ...glowChainSize(1281, 721) },
    { width: 1281, height: 721, halfWidth: 640, halfHeight: 360 });
  // One pixel would halve to zero, and a zero-sized render target is one the driver refuses.
  assert.deepEqual({ ...glowChainSize(1, 1) },
    { width: 1, height: 1, halfWidth: 1, halfHeight: 1 });
  // A fractional drawing buffer floors the way `setSize` does.
  assert.deepEqual({ ...glowChainSize(1279.6, 719.2) },
    { width: 1279, height: 719, halfWidth: 639, halfHeight: 359 });
  for (const bad of [[0, 720], [1280, 0], [-4, 4], [Number.NaN, 8], [8, Number.POSITIVE_INFINITY]]) {
    assert.equal(glowChainSize(bad[0], bad[1]), undefined, `expected no chain for ${bad.join("x")}`);
  }
});

test("P4b: the composite only adds, because nothing was taken away to put back", () => {
  const passes = buildFullscreenGlowPasses();

  // P4 put the curve and the encode back here by hand, and paid for it: blending moved into linear
  // space and an additive card came out `208,201,251` where the direct path drew `255,255,255`.
  // P4b makes the render target display-referred instead, so re-applying either would be a second
  // grade on an already-graded frame.
  assert.equal(passes.composite.fragmentShader.includes(TONE_SHOULDER_GLSL), false,
    "the shoulder has already run, per material, on its way into the buffer");
  assert.equal(passes.composite.fragmentShader.includes("CustomToneMapping"), false);
  assert.equal(passes.composite.fragmentShader.includes("colorspace_fragment"), false,
    "the sRGB encode has already run too; a second one would gamma the frame twice");
  assert.equal(passes.composite.fragmentShader.includes("toneMappingExposure"), false,
    "no curve here means no exposure to declare for three to write");
  assert.match(passes.composite.fragmentShader,
    /texture2D\(source, vUV\)\.rgb\s*\+ texture2D\(glow, vUV\)\.rgb \* strength/,
    "the authored glow remains a display-space add");
  assert.match(passes.composite.fragmentShader,
    /\+ texture2D\(rays, vUV\)\.rgb \* rayStrength/,
    "the optional shafts share the same already-encoded additive composite");

  // Nothing in the chain may be tone mapped or re-encoded by three on the way to the canvas.
  for (const [name, material] of Object.entries({
    extract: passes.extract, blur: passes.blur, godRays: passes.godRays, composite: passes.composite,
  })) {
    assert.equal(material.toneMapped, false, `${name} must not let three apply the curve as well`);
    assert.equal(material.depthTest, false, `${name} tests no depth`);
    assert.equal(material.depthWrite, false, `${name} writes no depth`);
    assert.equal(material.transparent, false, `${name} covers every pixel it is drawn over`);
    assert.equal(material.fragmentShader.includes("colorspace_fragment"), false,
      `${name} writes the bytes it computed`);
  }

  // The bright pass is the difference between a glow and a veil: without it, Darnassus's authored
  // 1.0 would add the whole blurred frame back and double the picture. It reads the display knee,
  // because what it samples is display-referred.
  assert.match(passes.extract.fragmentShader,
    new RegExp(`max\\(colour - ${GLOW_BRIGHT_KNEE_DISPLAY.toFixed(6)}, 0\\.0\\) / ${GLOW_BRIGHT_HEADROOM.toFixed(6)}`),
    "the extract pass subtracts the display knee rather than scaling the whole frame");
  assert.equal(passes.extract.fragmentShader.includes(GLOW_BRIGHT_KNEE.toFixed(4)), false,
    "and never the linear one, which in this buffer would be a different pixel");

  // One geometry, four materials, one scene: the quad is re-dressed between passes.
  assert.equal(passes.quad.geometry.getAttribute("position").count, 3, "one full-screen triangle");
  assert.equal(passes.quad.frustumCulled, false, "the triangle reaches outside the ortho box");
  assert.equal(passes.scene.children.length, 1);
  assert.equal(passes.extract.uniforms.source, passes.blur.uniforms.source,
    "the passes share one source slot, which the chain rebinds before each draw");
  assert.equal(passes.godRays.uniforms.depth, passes.uniforms.depth,
    "the radial pass samples the resolved scene depth rather than a copied colour mask");
});

test("P4b: three 0.185.1 still treats a flagged render target as the canvas — the tripwire", async () => {
  // The whole slice rests on one internal flag, so it is asserted against the real three in
  // node_modules rather than against a quotation of it. A version that renames or drops either
  // expression fails here, loudly, instead of quietly handing the world back linear and un-curved
  // with no composite left to correct it. Precedent: `tests/tone-mapping.test.mjs`.
  const programs = await readFile(new URL(import.meta.resolve("three/src/renderers/webgl/WebGLPrograms.js")), "utf8");
  assert.match(programs, /if \( material\.toneMapped \)\s*\{\s*if \( currentRenderTarget === null \|\| currentRenderTarget\.isXRRenderTarget === true \)/,
    "the custom shoulder still compiles into a pass drawn into a flagged target");
  assert.match(programs, /outputColorSpace: \( currentRenderTarget === null \) \? renderer\.outputColorSpace : \( currentRenderTarget\.isXRRenderTarget === true \? currentRenderTarget\.texture\.colorSpace : ColorManagement\.workingColorSpace \),/,
    "and the sRGB encode still follows the flagged target's own texture colour space");

  // The other half: an sRGB byte target would otherwise be allocated SRGB8_ALPHA8 and the hardware
  // would encode a second time on store. `internalFormat` is the documented way out, and it is
  // honoured ahead of everything else.
  const textures = await readFile(new URL(import.meta.resolve("three/src/renderers/webgl/WebGLTextures.js")), "utf8");
  assert.match(textures, /function getInternalFormat\( internalFormatName, glFormat, glType, normalized, colorSpace, forceLinearTransfer = false \) \{\s*if \( internalFormatName !== null \) \{\s*if \( _gl\[ internalFormatName \] !== undefined \) return _gl\[ internalFormatName \];/,
    "an explicit internal format still wins over the colour-space inference");
  assert.match(textures, /if \( glType === _gl\.UNSIGNED_BYTE \) internalFormat = \( transfer === SRGBTransfer \) \? _gl\.SRGB8_ALPHA8 : _gl\.RGBA8;/,
    "which is what it is winning over, and why the option is not decoration");

  // And the flag survives being set on the object three hands back, in this three.
  const probe = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    internalFormat: "RGBA8",
  });
  probe.isXRRenderTarget = true;
  assert.equal(probe.isXRRenderTarget, true, "the flag sticks; the renderer asserts this too");
  assert.equal(probe.texture.colorSpace, THREE.SRGBColorSpace,
    "colorSpace is a RenderTarget option and reaches the texture the program reads it from");
  assert.equal(probe.texture.internalFormat, "RGBA8");
  assert.equal(probe.texture.type, THREE.UnsignedByteType);
  probe.dispose();
});

test("P4b: the scene target is display-referred and every buffer is eight-bit", () => {
  const create = rendererSource.slice(
    rendererSource.indexOf("#createFullscreenGlowTargets(size: GlowChainSize, godRays: boolean): GlowChainTargets | undefined {"),
    rendererSource.indexOf("#disposeFullscreenGlowTargets(): void {"));
  assert.ok(create.length > 0, "the allocator must exist");

  assert.match(create, /colorSpace: THREE\.SRGBColorSpace,/,
    "the flagged target's texture colour space is what three encodes the world into");
  assert.match(create, /internalFormat: "RGBA8",/,
    "so the hardware stores the bytes the shader wrote instead of encoding them again");
  assert.match(create, /\(scene as unknown as \{ isXRRenderTarget: boolean \}\)\.isXRRenderTarget = true;/,
    "the one line a three upgrade has to be re-read against");
  assert.match(create, /throw new Error\("three no longer accepts isXRRenderTarget on a WebGLRenderTarget"\);/,
    "a three that refuses the flag gets no chain rather than a wrong one");
  const allocatorDoc = rendererSource.slice(
    rendererSource.indexOf("   * The three buffers, at the sample count this context can actually give them."),
    rendererSource.indexOf("  #createFullscreenGlowTargets(size: GlowChainSize, godRays: boolean)"));
  assert.ok(allocatorDoc.includes("0.185.1"),
    "the doc names the three version the flag was verified against, so an upgrade knows what to re-check");
  assert.ok(allocatorDoc.includes("isXRRenderTarget") && allocatorDoc.includes("tone-parity"),
    "and names both the flag and the measurement that has to be re-run");

  // Eight bits everywhere, and no extension test left: display-referred eight bits is the canvas's
  // own precision, so the half-float preference P4 measured into existence has nothing to buy.
  assert.equal((create.match(/type: THREE\.UnsignedByteType,/g) ?? []).length, 2,
    "the scene target and the shared half-resolution constructor");
  assert.equal(create.includes("HalfFloatType"), false, "the linear intermediate is gone");
  assert.equal(create.includes("EXT_color_buffer_float"), false,
    "and with it the extension test that only existed to choose between the two");
  assert.equal(rendererSource.includes("readonly halfFloat: boolean;"), false,
    "nothing downstream still asks which precision the chain got");

  // The halves are deliberately left alone: they hold raw display-space excess written by shaders
  // that include no colorspace chunk, so making them sRGB would encode and decode around it.
  const half = create.slice(create.indexOf("const half = (name: string)"));
  assert.equal(half.includes("SRGBColorSpace"), false);
  assert.equal(half.includes("internalFormat"), false);

  // Multisampling stays P4's. Depth resolution remains absent for glow alone and is paid only by
  // the explicitly enabled depth-aware shafts.
  assert.match(create, /samples = Math\.max\(0, Math\.min\(4, this\.#renderer\.capabilities\.maxSamples\)\);/);
  assert.match(create, /new THREE\.DepthTexture\(size\.width, size\.height, THREE\.UnsignedIntType\)/);
  assert.match(create, /depthTexture,/);
  assert.match(create, /resolveDepthBuffer: godRays,/);
});

test("the post-process leaves decide the path, and OFF/OFF releases the buffers", () => {
  // Binary on purpose. A zone that authors no glow still pays the chain while the leaf is on:
  // dropping to the direct path whenever the strength rounds to zero would swap the whole colour
  // pipeline as the player walks into Ironforge.
  const beginAt = rendererSource.indexOf("#beginFullscreenGlow(): GlowChainTargets | undefined {");
  assert.ok(beginAt > 0, "the chain's entry point must exist");
  const begin = rendererSource.slice(beginAt, rendererSource.indexOf("#composeFullscreenGlow(", beginAt));
  assert.match(begin, /if \(!this\.#fullscreenGlowEnabled && !this\.#godRaysActive\(\) && !this\.#cinematic\.active\) return undefined;/,
    "every post leaf is read before any target is bound, so all OFF is the direct path");
  assert.equal(begin.includes("#glowStrength"), false,
    "the authored strength must not decide which pipeline the frame takes");
  const guard = begin.indexOf("if (!this.#fullscreenGlowEnabled && !this.#godRaysActive() && !this.#cinematic.active) return undefined;");
  const bind = begin.indexOf("this.#renderer.setRenderTarget(targets.scene);");
  assert.ok(guard >= 0 && bind > guard,
    "no render target is bound at all on the direct path");

  const setter = rendererSource.slice(
    rendererSource.indexOf("  setFullscreenGlow(enabled: boolean): void {"),
    rendererSource.indexOf("/** Restore the same neutral sky/light state"));
  assert.match(setter, /if \(!next && !this\.#godRaysActive\(\) && !this\.#cinematic\.active\) this\.#disposeFullscreenGlowTargets\(\);/,
    "turning glow off gives the video memory back unless the shafts still own the shared capture");

  // Glow retains its three submissions in the one order that works. The optional radial pass then
  // reuses blurB after the vertical result is safe in blurA, before the one final composite. All are
  // in a helper written below
  // `#resetFrameCounters` so the submission test still reads `draw()` as two renders.
  const composeAt = rendererSource.indexOf("#composeFullscreenGlow(targets: GlowChainTargets | undefined): void {");
  assert.ok(composeAt > 0, "the chain's composite must exist");
  const compose = rendererSource.slice(composeAt, rendererSource.indexOf("#endFullscreenGlow(", composeAt));
  assert.match(compose, /^\s*if \(!targets\) return;/m, "a direct frame never reaches a pass");
  const order = [
    "quad.material = this.#glowPasses.extract;",
    "this.#renderer.setRenderTarget(targets.blurA);",
    "quad.material = this.#glowPasses.blur;",
    "uniforms.direction.value.set(GLOW_BLUR_SPREAD / targets.halfWidth, 0);",
    "this.#renderer.setRenderTarget(targets.blurB);",
    "uniforms.direction.value.set(0, GLOW_BLUR_SPREAD / targets.halfHeight);",
    // Under the cinematic chain the classic radial pass is skipped (CinematicPost draws the shafts).
    "const rayStrength = this.#cinematic.active ? 0 : this.#prepareGodRays(targets);",
    "quad.material = this.#glowPasses.godRays;",
    "this.#renderer.setRenderTarget(targets.blurB);",
    "uniforms.strength.value = this.#fullscreenGlowEnabled ? this.#glowStrength : 0;",
    "quad.material = this.#glowPasses.composite;",
    "this.#renderer.setRenderTarget(null);",
  ];
  let at = -1;
  for (const step of order) {
    const next = compose.indexOf(step, at + 1);
    assert.ok(next > at, `the chain must run ${step} in order`);
    at = next;
  }
  assert.equal((compose.match(/this\.#renderer\.render\(scene, camera\);/g) ?? []).length, 5,
    "bright pass, two blurs, optional radial scattering and one composite");
});

test("every buffer the chain owns is visited, resized and released", () => {
  const visit = rendererSource.slice(
    rendererSource.indexOf("visitRetainedResources(visitor: RetainedResourceVisitor): void {"),
    rendererSource.indexOf("What the last frame cost, in the words the status line uses"));
  assert.match(visit, /this\.#glowPasses\.scene\.traverse\(visit\);/,
    "the fourth live scene is traversed beside the other three");
  assert.match(visit, /for \(const target of \[glow\.scene, glow\.blurA, glow\.blurB\]\) \{\s*visitor\.referenceGpuRenderTarget\(this, target\);/,
    "all three render targets are registered, by the shadow map's precedent");

  // The drawing buffer is not the only thing that invalidates them: a lost and restored context
  // leaves every dimension exactly where it was and every GL object behind them gone.
  const sync = rendererSource.slice(
    rendererSource.indexOf("#syncFullscreenGlowTargets(): void {"),
    rendererSource.indexOf("#createFullscreenGlowTargets("));
  assert.match(sync, /current\.contextGeneration === this\.#webGlContextGeneration/);
  assert.match(sync, /glowChainSize\(this\.#canvas\.width, this\.#canvas\.height\)/,
    "the chain is sized in drawing-buffer pixels, which is what the canvas holds");

  const resize = rendererSource.slice(
    rendererSource.indexOf("  #resize(): void {"),
    rendererSource.indexOf("Steps every emitter near the player"));
  const branch = resize.indexOf("this.#camera.updateProjectionMatrix();");
  assert.ok(resize.indexOf("this.#syncFullscreenGlowTargets();", branch) > branch,
    "the sync is outside the resize branch, or a restored context would never rebuild");
  // Measured, not guessed: `setRenderScale` returns early when the ratio it is handed is the one it
  // already holds — which is what an ordinary settings apply does — so a sync inside that branch
  // left a renderer that had just been switched back on with no buffers at all.
  const renderScale = rendererSource.slice(
    rendererSource.indexOf("  setRenderScale(scale: number): void {"),
    rendererSource.indexOf("  #resize(): void {"));
  const ratioBranch = renderScale.indexOf("this.#renderer.setSize(");
  assert.ok(renderScale.indexOf("this.#syncFullscreenGlowTargets();", ratioBranch) > ratioBranch,
    "render scale changes the drawing buffer outside a frame");
  assert.equal(renderScale.includes("if (Math.abs(this.#renderer.getPixelRatio() - wanted) < 1e-4) return;"), false,
    "an unchanged ratio must still reach the sync");

  for (const [name, source] of [
    ["clearWorldResources", rendererSource.slice(
      rendererSource.indexOf("this.#underwaterSurface = undefined;"),
      rendererSource.indexOf("  dispose(): void {"))],
    ["dispose", rendererSource.slice(
      rendererSource.indexOf("  dispose(): void {"),
      rendererSource.indexOf("The rings, laid on whatever the two marked units"))],
  ]) {
    assert.match(source, /this\.#disposeFullscreenGlowTargets\(\);/,
      `${name} releases the chain's buffers`);
  }
  assert.match(
    rendererSource.slice(rendererSource.indexOf("  dispose(): void {")),
    /this\.#glowPasses\.extract, this\.#glowPasses\.blur, this\.#glowPasses\.composite,/,
    "the original three pass materials are still disposed by name; the radial material is asserted separately");
});

test("LightParams.Glow reaches the browser through the gateway extractor", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadLightMetadata } = await import("../dist/code/gateway/LightMetadata.js");

  const directory = await mkdtemp(join(tmpdir(), "webclient-glow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const dbc = (fields, rows) => {
    const result = new Uint8Array(20 + rows.length * fields * 4 + 1);
    result.set(new TextEncoder().encode("WDBC"));
    const view = new DataView(result.buffer);
    view.setUint32(4, rows.length, true);
    view.setUint32(8, fields, true);
    view.setUint32(12, fields * 4, true);
    view.setUint32(16, 1, true);
    for (let row = 0; row < rows.length; row++) {
      for (let field = 0; field < fields; field++) {
        const value = rows[row][field] ?? 0;
        const at = 20 + (row * fields + field) * 4;
        if (typeof value === "object") view.setFloat32(at, value.f, true);
        else view.setInt32(at, value, true);
      }
    }
    return result;
  };

  // One map default naming parameter set 1 and one volume naming set 2.
  const stored = (yards) => ({ f: yards * 36 });
  const ZEROPOINT = 32 * 533.3333333333334;
  await writeFile(join(directory, "Light.dbc"), dbc(15, [
    [1, 0, 0, 0, 0, 0, 0, 1],
    [2, 0, stored(ZEROPOINT - 250), stored(80), stored(ZEROPOINT + 9000), stored(100), stored(200), 2],
  ]));
  // Field 4 is Glow. 0.65 is what the real Light row 1 resolves to (LightParams 12) and 0.30 is
  // Stormwind's own (LightParams 79); the third row proves a NaN cannot reach a uniform.
  await writeFile(join(directory, "LightParams.dbc"), dbc(9, [
    [1, 0, 0, 0, { f: 0.65 }],
    [2, 0, 0, 0, { f: 0.3 }],
    [3, 0, 0, 0, { f: Number.NaN }],
  ]));
  const bandRow = (id) => {
    const row = new Array(34).fill(0);
    row[0] = id;
    row[1] = 1;
    return row;
  };
  const ints = [];
  for (let id = 1; id <= 36; id++) ints.push(bandRow(id));
  await writeFile(join(directory, "LightIntBand.dbc"), dbc(34, ints));
  const floats = [];
  for (let id = 1; id <= 12; id++) floats.push(bandRow(id));
  await writeFile(join(directory, "LightFloatBand.dbc"), dbc(34, floats));

  const azeroth = (await loadLightMetadata(directory)).get(0);
  assert.ok(Math.abs(azeroth.params[1].glow - 0.65) < 1e-6,
    `expected the map default to carry 0.65, got ${azeroth.params[1].glow}`);
  assert.ok(Math.abs(azeroth.params[2].glow - 0.3) < 1e-6,
    `expected the volume to carry 0.30, got ${azeroth.params[2].glow}`);
});

test("the glow blends across a volume edge instead of stepping at it", () => {
  // The same slot/time logic as the four water alphas: not a band, one number per parameter set,
  // blended by the volume's own falloff weight. A step here would pop the whole screen as the
  // player walks out of Stormwind's 0.30 into Elwynn's 0.65.
  const channels = ["diffuse", "ambient", "skyTop", "skyUpper", "skyMiddle", "skyLower",
    "skyHorizon", "fog", "oceanClose", "oceanFar", "riverClose", "riverFar"];
  const set = (glow) => {
    const colours = {};
    for (const channel of channels) colours[channel] = { times: [0], values: [0x808080] };
    return {
      colours,
      fogEnd: { times: [0], values: [500] },
      fogScale: { times: [0], values: [0.25] },
      waterShallowAlpha: 0.5, waterDeepAlpha: 1, oceanShallowAlpha: 0.5, oceanDeepAlpha: 1,
      ...(glow === undefined ? {} : { glow }),
    };
  };
  const entry = {
    fallback: 1,
    fallbackLightId: 1,
    params: { 1: set(0.65), 2: set(0.3) },
    volumes: [{ id: 7, x: 100, y: 0, z: 0, innerRadius: 10, outerRadius: 50, params: 2 }],
    lights: {},
  };
  assert.equal(resolveLighting(entry, 0, 0, 720).glow, 0.65, "outside every volume, the map default");
  assert.equal(resolveLighting(entry, 100, 0, 720).glow, 0.3, "inside the inner radius, the volume");
  // Exactly half way along the falloff the smoothstep weight is 0.5, so the strength is too.
  const middle = resolveLighting(entry, 130, 0, 720).glow;
  assert.ok(Math.abs(middle - (0.65 + (0.3 - 0.65) * 0.5)) < 1e-9,
    `expected the midpoint of 0.65 and 0.30, got ${middle}`);
  assert.ok(middle < 0.65 && middle > 0.3, "and it is genuinely between the two");

  // A gateway older than P4 sends no glow at all. That has to read as no glow rather than as NaN
  // in a uniform — the same tolerance the browser gave the character-creation route.
  const old = {
    ...entry,
    params: { 1: set(undefined), 2: set(undefined) },
  };
  assert.equal(resolveLighting(old, 0, 0, 720).glow, 0);
  assert.equal(resolveLighting(old, 130, 0, 720).glow, 0);
});

test("the reversibility checklist is wired end to end", async () => {
  const read = async (path) => readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");
  const [model, settings, host, console_, main] = await Promise.all([
    read("ui/SettingsModel.ts"), read("ui/Settings.ts"),
    read("LiveFormalRenderBenchmarkHost.ts"), read("FormalRenderBenchmarkConsole.ts"), read("main.ts"),
  ]);

  assert.match(model, /id: "fullscreenGlow", label: "Полноэкранное свечение", group: "Эффекты", kind: "boolean", fallback: true,/,
    "the leaf exists and is ON by default — the owner asked for the WoW look");
  assert.match(settings, /setFullscreenGlow\?\.\(settingBoolean\(values, "fullscreenGlow"\)\)/,
    "the account's value is pushed into the renderer like every other graphics leaf");
  assert.match(rendererSource, /fullscreenGlow: this\.#fullscreenGlowEnabled,/,
    "the renderer reads its own applied value back");

  assert.match(host, /"setUnderwaterOverlay", "setFullscreenGlow",/,
    "the setter is an intercepted mutator, so an external call is drift and not a surprise");
  assert.match(host, /"setFullscreenGlow", \(\) => setFullscreenGlow\.call\(renderer, user\.fullscreenGlow\)/,
    "releasing the lease restores the account's value");
  assert.match(host, /fullscreenGlow: optionalBooleanSetting\(configuration, "fullscreenGlow"\)/,
    "a run measures the chain only where its own variant asked for it");
  assert.match(host, /setFullscreenGlow: "fullscreenGlow",/, "drift is reported by leaf name");
  assert.match(host, /fullscreenGlow: \(actual as unknown as Record<string, unknown>\)\.fullscreenGlow === true,/,
    "an absent readback reads as OFF, the same tolerance the experimental leaves get");
  assert.match(host, /fullscreenGlow: settingsModel!\.settingBoolean\(values, "fullscreenGlow"\)/);

  assert.match(console_, /base\.fullscreenGlow = false;/,
    "formal variants compare one pipeline against itself");
  assert.match(main, /fullscreenGlow: applied\.fullscreenGlow,/,
    "the run's metadata records what the renderer did, not what was asked of it");
});
