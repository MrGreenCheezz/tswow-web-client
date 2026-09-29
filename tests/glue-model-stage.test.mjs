import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  BLEND_ADD, BLEND_ALPHA, BLEND_ALPHA_KEY, BLEND_BLEND_ADD, BLEND_MOD, BLEND_MOD2X,
  BLEND_NO_ALPHA_ADD, BLEND_OPAQUE,
} from "../dist/code/browser/Wvm.js";
import { applyBlendMode } from "../dist/code/browser/ModelBuild.js";
import {
  GLUE_AUTHORED_ASPECT, GLUE_FIGURE_COMPENSATION_MAX_ASPECT, GLUE_LIGHT_INTENSITY_SCALE,
  GLUE_MAX_DIRECTIONAL_LIGHTS,
  GLUE_QUALITY_STEPS, GLUE_QUALITY_TARGET_MS, GLUE_SUBJECT_COVERAGE, GlueQualityController,
  glueDropAdditiveCoverage, glueFigureScaleCompensation, glueFlipMaterialSides, glueIsAdditive, glueModelLight, glueModelPath,
  glueScaleMirrors, glueSceneLighting, glueSceneVerticalFov, glueTextureName, glueViewCoverage,
  glueViewIsSubject, glueViewResolution, glueViewSignature, glueViewTickDivisor,
} from "../dist/code/browser/glue/GlueModelStage.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";
import { frameXmlTextureCandidates } from "../dist/code/browser/ui/framexml_compat/FrameXmlTextures.js";
import { glueLoginSceneModelIsVisible } from "../dist/code/browser/glue/GlueLoginScenePolicy.js";

// Two pure decisions the 3D layer makes before it touches WebGL: which file a glue model actually
// lives in, and what thirteen numbers out of `SetLight` mean.

test("a glue model path becomes the .m2 the gateway has", () => {
  // Measured against the running gateway: every one of these answers 400 as written and 200 as
  // `.m2`. `.mdx` is the Warcraft III extension and has never been what a 3.3.5 client ships.
  assert.equal(glueModelPath("Environments/Stars/SkywallSkyBox.mdx"),
    "Environments\\Stars\\SkywallSkyBox.m2");
  assert.equal(glueModelPath("creature/CustomCharacters/Archibald/Archibald.mdx"),
    "creature\\CustomCharacters\\Archibald\\Archibald.m2");
  assert.equal(glueModelPath("World/Generic/human/passive doodads/fog/sfx_fog_nasty_pink.mdx"),
    "World\\Generic\\human\\passive doodads\\fog\\sfx_fog_nasty_pink.m2");
  // A name that is already right is left alone, extension and separators both.
  assert.equal(glueModelPath("Interface\\Glues\\Models\\UI_MainMenu\\UI_MainMenu.m2"),
    "Interface\\Glues\\Models\\UI_MainMenu\\UI_MainMenu.m2");
  // No extension at all gets one; nothing stays nothing.
  assert.equal(glueModelPath("Character\\Human\\Male\\HumanMale"),
    "Character\\Human\\Male\\HumanMale.m2");
  assert.equal(glueModelPath(""), "");
  assert.equal(glueModelPath("   "), "");
});

test("the anonymous login scene keeps only its two direct-child character models", () => {
  const branch = { children: [] };
  const frame = (file, parent = branch, type = "Model") => {
    const value = { type, parent, children: [], model: { file } };
    parent.children.push(value);
    return value;
  };
  const archibald = frame("creature/CustomCharacters/Archibald/Archibald.mdx");
  const morethan = frame("creature\\CustomCharacters\\Morethan\\Morethan.mdx");
  const skywall = frame("Environments/Stars/SkywallSkyBox.mdx");
  const fog = frame("spells/Largebluegreenradiationfog.mdx");
  const cloud = frame("World/EXPANSION04/DOODADS/turtlezone/clouds/tu_clouds_01.mdx");

  assert.equal(glueLoginSceneModelIsVisible(archibald), true);
  assert.equal(glueLoginSceneModelIsVisible(morethan), true);
  assert.equal(glueLoginSceneModelIsVisible(skywall), false);
  assert.equal(glueLoginSceneModelIsVisible(fog), false);
  assert.equal(glueLoginSceneModelIsVisible(cloud), false);

  // A different branch represents charselect/create and UI sparkles, even when it carries Model
  // and ModelFFX widgets.  It remains governed by the bridge's ordinary visibility result.
  const unrelatedBranch = { children: [] };
  const charselectBackdrop = frame("Interface/Glues/Models/UI_Human/UI_Human.mdx", unrelatedBranch);
  const uiSparkle = frame("spells/UI_Sparkle.mdx", unrelatedBranch, "ModelFFX");
  assert.equal(glueLoginSceneModelIsVisible(charselectBackdrop), true);
  assert.equal(glueLoginSceneModelIsVisible(uiSparkle), true);
  assert.equal(glueLoginSceneModelIsVisible(uiSparkle, false), false);
});

test("SetLight's thirteen numbers are one ambient light and one directional light", () => {
  // The DEFAULT set `lgzg.lua`'s `SetModelLighting` drives every login model with.
  const light = glueModelLight([1, 0.5, 0.5, 0.5, 0, 0.2, 1, 1.5, 1, 1, 0.0, 1, 0.9]);
  assert.ok(light);
  assert.equal(light.ambientIntensity, 0.2);
  assert.deepEqual(
    [light.ambient.r, light.ambient.g, light.ambient.b].map((value) => Math.round(value * 1000) / 1000),
    [1, 1.5, 1],
  );
  assert.equal(light.diffuseIntensity, 1);
  assert.deepEqual(
    [light.diffuse.r, light.diffuse.g, light.diffuse.b].map((value) => Math.round(value * 1000) / 1000),
    [0, 1, 0.9],
  );
  // M2 is Z-up and the scene is Y-up, so the direction goes through the same swap a model does.
  assert.deepEqual(
    [light.direction.x, light.direction.y, light.direction.z].map((value) => Math.round(value * 1000) / 1000),
    [0.707, 0, -0.707],
  );

  // A shorter list is not a light: the corpus' own default in `newModel` has all thirteen.
  assert.equal(glueModelLight([]), undefined);
  assert.equal(glueModelLight([1, 0, 0]), undefined);

  // A zero direction would make `lookAt` degenerate; it falls back to straight down.
  const flat = glueModelLight([1, 0, 0, 0, 0, 0.7, 1, 1, 1, 1, 1, 1, 1]);
  assert.ok(flat);
  assert.deepEqual([flat.direction.x, flat.direction.y, flat.direction.z], [0, -1, 0]);
});

test("an M2 texture name ends at its terminator, not at the length the file allocated", () => {
  // The nine slots of the owner's `8fx_generic_shadow_debuff.m2`, read straight out of the file:
  // lengths 50/41/20/26/41/52/41/41/42 at offsets 5,832-6,144. Two of them are longer than the
  // string they hold, so the extraction — which strips only *trailing* NULs — handed the gateway
  // the terminator and the next entry's tail. Both are 400s in the live page.
  assert.equal(
    glueTextureName("spells\\7fx_alphamask_glowbright_black.blp\u0000113.blp"),
    "spells\\7fx_alphamask_glowbright_black.blp",
  );
  assert.equal(
    glueTextureName("spells\\7fx_alphamask_glowbright_black.blp\u0000e_128.blp"),
    "spells\\7fx_alphamask_glowbright_black.blp",
  );
  // A name that is already a name is untouched — that is the other seven slots of the same file.
  assert.equal(glueTextureName("spells\\white8x8.blp"), "spells\\white8x8.blp");
  assert.equal(glueTextureName("a.blp\u0000tail"), "a.blp");
  assert.equal(glueTextureName(""), "");
});

test("a texture slot cut short of its extension is not a file name, so it is not asked for", () => {
  // Slot 3 of the same file: its authored length is 26 bytes, which stops *inside* the name, and
  // the bytes that finish it never reached the artifact. It is the last 400 the login screen made —
  // `/texture` refuses a path with no `.blp` on it — and there is nothing on the other end of that
  // request either way, so the slot answers the same empty string a slot the client is supposed to
  // fill answers. `resolveSlot` then leaves the batch without a picture and `buildModelEffects`
  // drops an emitter that has none, which is what emitter 1 of 3 of `8fx_generic_shadow_debuff` is.
  assert.equal(glueTextureName("spells\\7fx_alphamask_glowb"), "");
  // The truncation can land past the last separator or at it; neither names a file.
  assert.equal(glueTextureName("spells\\"), "");
  assert.equal(glueTextureName("white8x8"), "");
  // A directory with a dot in it does not lend its dot to a leaf that has none.
  assert.equal(glueTextureName("spells\\v1.2\\glow"), "");
  assert.equal(glueTextureName("spells\\v1.2\\glow.blp"), "spells\\v1.2\\glow.blp");
});

test("the glue stage deduplicates URL textures and owns their disposal", async () => {
  const source = await readFile(new URL("../src/browser/glue/GlueModelStage.ts", import.meta.url), "utf8");
  const stageStart = source.indexOf("export class GlueModelStage {");
  const constructorStart = source.indexOf("  constructor(", stageStart);
  assert.ok(stageStart >= 0 && constructorStart > stageStart, "stage implementation is present");
  assert.match(
    source.slice(stageStart, constructorStart),
    /readonly #textures = new ModelTextureLoader\(\{\s*cache:\s*true\s*\}\);/,
    "the stage owns a URL-deduplicating texture loader",
  );
  const disposeStart = source.indexOf("  dispose(): void {", constructorStart);
  const disposeEnd = source.indexOf("\n  }", disposeStart);
  assert.ok(disposeStart >= 0 && disposeEnd > disposeStart, "stage disposal is present");
  assert.match(
    source.slice(disposeStart, disposeEnd),
    /this\.\#textures\.clear\(\);/,
    "disposing the stage releases its cached texture bases",
  );

  const originalLoad = THREE.TextureLoader.prototype.load;
  const requests = [];
  THREE.TextureLoader.prototype.load = function (url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    requests.push({ url, texture, onLoad, onError });
    return texture;
  };
  try {
    const loader = new ModelTextureLoader({ cache: true });
    const first = loader.load("login-shared.blp");
    const second = loader.load("login-shared.blp");
    assert.strictEqual(second, first, "two stage consumers share one URL texture");
    assert.equal(requests.length, 1, "the shared URL starts one underlying request");

    let disposals = 0;
    first.addEventListener("dispose", () => { disposals++; });
    requests[0].onLoad?.(first);
    loader.clear();
    assert.equal(disposals, 1, "clear disposes the cached base exactly once");
    loader.clear();
    assert.equal(disposals, 1, "repeated stage disposal does not double-dispose");
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});

test("an additive draw adds light to the widget canvas and takes no coverage from it", () => {
  // A `Model` widget owns its own transparent canvas and the browser composites it over the page
  // with source-over, `Co = Cs + Cb·(1 − αs)`. three uses one factor pair for colour *and* alpha, so
  // `SrcAlpha/One` accumulates α as well — and every bit of that α deletes the login scene behind
  // the glow. `Zero/One` on the alpha pair leaves the canvas's α exactly where it was, and
  // source-over then reduces to `Cs + Cb`. The file's blend table decides which materials that is:
  // 3 and 4 are the additive pair and are the only two `applyBlendMode` gives `blendDst = One`.
  const material = (mode) => {
    const value = new THREE.MeshBasicMaterial();
    applyBlendMode(value, mode);
    return value;
  };
  for (const mode of [BLEND_NO_ALPHA_ADD, BLEND_ADD]) {
    const additive = material(mode);
    assert.equal(glueIsAdditive(additive), true, `blend ${mode} is additive`);
    assert.equal(glueDropAdditiveCoverage(additive), true);
    assert.equal(additive.blendSrcAlpha, THREE.ZeroFactor);
    assert.equal(additive.blendDstAlpha, THREE.OneFactor);
    // The colour half is untouched: this changes what the draw covers, never what it adds.
    assert.equal(additive.blendDst, THREE.OneFactor);
    assert.equal(additive.blendSrc, mode === BLEND_ADD ? THREE.SrcAlphaFactor : THREE.OneFactor);
  }
  // Everything else still writes coverage, including mode 7 — `One/OneMinusSrcAlpha` is
  // premultiplied source-over and really does composite over what is behind it.
  const covering = [BLEND_OPAQUE, BLEND_ALPHA_KEY, BLEND_ALPHA, BLEND_MOD, BLEND_MOD2X, BLEND_BLEND_ADD];
  for (const mode of covering) {
    const other = material(mode);
    assert.equal(glueIsAdditive(other), false, `blend ${mode} covers`);
    assert.equal(glueDropAdditiveCoverage(other), false);
    assert.equal(other.blendSrcAlpha, null);
    assert.equal(other.blendDstAlpha, null);
  }
});

test("the login logo falls back to the file the stock screen names", () => {
  // The owner's `AccountLogin.xml:203` names `Interface\Glues\Common\Glues-WoW-WotLKLogo_lg`; the
  // untouched 3.3.5a ruRU client's own `Interface\GlueXML\AccountLogin.xml:130` names the same
  // widget with the same file minus the suffix. Measured on the live gateway: `…_lg.blp` is 404 and
  // `…WotLKLogo.blp` is 200 with 163,223 bytes, and no `_lg` sibling exists for any of the four
  // logos in that directory. The primary is still asked for first — whether a chain carries a name
  // is the gateway's to answer, not this function's to guess.
  const both = [
    "Interface\\Glues\\Common\\Glues-WoW-WotLKLogo_lg.blp",
    "Interface\\Glues\\Common\\Glues-WoW-WotLKLogo.blp",
  ];
  assert.deepEqual(
    frameXmlTextureCandidates("Interface\\Glues\\Common\\Glues-WoW-WotLKLogo_lg"), both);
  // An already-completed path is the same answer: the cache keys on what the renderer completed.
  assert.deepEqual(
    frameXmlTextureCandidates("Interface\\Glues\\Common\\Glues-WoW-WotLKLogo_lg.blp"), both);
  // Every other name on the screen is one candidate and one request, exactly as before.
  assert.deepEqual(frameXmlTextureCandidates("Interface\\Glues\\Credits\\Parchment8"),
    ["Interface\\Glues\\Credits\\Parchment8.blp"]);
  assert.deepEqual(frameXmlTextureCandidates("Interface\\Glues\\Login\\Glues-KoreanRating-Drugs.tga"),
    ["Interface\\Glues\\Login\\Glues-KoreanRating-Drugs.blp"]);
  // `_lg` inside the name rather than at its end is not the suffix.
  assert.deepEqual(frameXmlTextureCandidates("Interface\\Glues\\Common\\Logo_lgx"),
    ["Interface\\Glues\\Common\\Logo_lgx.blp"]);
  assert.deepEqual(frameXmlTextureCandidates(""), []);
});

test("SetLight's intensities are client units, and the scale that makes three draw them", () => {
  // `MeshStandardMaterial` — what `ModelBuild` gives every lit batch — puts both the ambient and
  // the directional term through `BRDF_Lambert`, which is `RECIPROCAL_PI * diffuseColor`. So the
  // client's `texel * (ambient + N·L * diffuse)` needs the π back. Measured in the live page
  // (three r185, srgb output, NoToneMapping, white texel facing the light) with the corpus' own
  // default light — `lgzg.lua`'s `newModel` falls back to
  // `{1, 0, 0, -0.707, -0.707, 0.7, 1, 1, 1, 0.8, 1, 1, 0.8}` because `mainlight` is never
  // assigned: ambient-only came out 130 against the client's 218, and ambient+diffuse 184 against
  // 255. With the scale below both land on the client's numbers exactly.
  assert.equal(GLUE_LIGHT_INTENSITY_SCALE, Math.PI);
  const authored = glueModelLight([1, 0, 0, -0.707, -0.707, 0.7, 1, 1, 1, 0.8, 1, 1, 0.8]);
  assert.ok(authored);
  // The reader keeps the client's units; only the stage multiplies, so this stays checkable.
  assert.equal(authored.ambientIntensity, 0.7);
  assert.equal(authored.diffuseIntensity, 0.8);
  assert.deepEqual(
    [authored.diffuse.r, authored.diffuse.g, authored.diffuse.b].map((v) => Math.round(v * 100) / 100),
    [1, 1, 0.8],
  );
});

test("a backdrop is lit by the light set the corpus adds, not by a constant", () => {
  // `RaceLights.HUMAN`, copied from `GlueParent.lua:52-56`: a pure ambient 0.27 grey, a cool key at
  // intensity 1 and a warm key at intensity 2. `SetLighting` adds them through `AddLight` after
  // `ResetLights()`, and the stock character screens never call `SetLight` at all.
  const human = [
    [1, 0, 0, 0, -1, 1, 0.27, 0.27, 0.27, 1, 0, 0, 0],
    [1, 0, -0.45756075, -0.58900136, -0.66611975, 1, 0, 0, 0, 1, 0.19882353, 0.34921569, 0.43588236],
    [1, 0, -0.64623469, 0.57582057, -0.50081086, 1, 0, 0, 0, 2, 0.52196085, 0.44, 0.29764709],
  ];
  const lit = glueSceneLighting({ lights: human });
  // The ambient terms merge, which is why two of the three carry a black one.
  assert.deepEqual(
    [lit.ambient.r, lit.ambient.g, lit.ambient.b].map((v) => Math.round(v * 1000) / 1000),
    [0.27, 0.27, 0.27],
  );
  assert.equal(lit.ambientIntensity, 1);
  // A light whose diffuse is black is an ambient contribution and nothing else — it must not take
  // one of the three directional slots away from a key that has a colour.
  assert.equal(lit.directional.length, 2);
  assert.equal(lit.directional[1].diffuseIntensity, 2, "the warm key is authored at intensity 2");

  // A night elf is one light: ambient only, no key at all.
  const nightElf = glueSceneLighting({
    lights: [[1, 0, -0, -0, -1, 1, 0.0902, 0.0902, 0.1702, 1, 0, 0, 0]],
  });
  assert.equal(nightElf.directional.length, 0);
  assert.deepEqual(
    [nightElf.ambient.r, nightElf.ambient.g, nightElf.ambient.b].map((v) => Math.round(v * 10000) / 10000),
    [0.0902, 0.0902, 0.1702],
  );

  // `SetLight` still lights the login models, and its first number finally means something.
  const login = glueSceneLighting({ light: [1, 0, 0, -0.707, -0.707, 0.7, 1, 1, 1, 0.8, 1, 1, 0.8] });
  assert.equal(login.directional.length, 1);
  assert.equal(login.ambient.r, 0.7);
  const off = glueSceneLighting({ light: [0, 0, 0, -0.707, -0.707, 0.7, 1, 1, 1, 0.8, 1, 1, 0.8] });
  assert.deepEqual([off.ambient.r, off.ambient.g, off.ambient.b], [1, 1, 1]);
  assert.equal(off.directional.length, 0);

  // Nothing at all is the fixed-function client with lighting off: the texel, unmodulated.
  const bare = glueSceneLighting({});
  assert.equal(bare.ambientIntensity, 1);
  assert.deepEqual([bare.ambient.r, bare.ambient.g, bare.ambient.b], [1, 1, 1]);
  assert.equal(bare.directional.length, 0);

  // The ceiling is the corpus': «up to four lights per light set», three the most any race uses.
  assert.equal(GLUE_MAX_DIRECTIONAL_LIGHTS, 3);
  const many = glueSceneLighting({
    lights: Array.from({ length: 6 }, () => [1, 0, 0, 0, -1, 0, 0, 0, 0, 1, 1, 1, 1]),
  });
  assert.equal(many.directional.length, 3);
});

/**
 * The backdrop camera.
 *
 * `UI_Human` publishes `fov = 80°` and its sky is one four-vertex quad (batch 5, submesh 22, blend
 * `opaque`, flags `UNLIT|UNFOGGED`) that covers 34.09°/34.95° left and right of the authored camera
 * and reaches 26.09° above its aim. Read as three.js' *vertical* fov, 80° drew 40° of nothing above
 * a quad that stops at 26 — the hard-edged sky rectangle this replaces. Read as a **diagonal** at
 * 4:3 it splits into 33.87° horizontal and 26.72° vertical, which is the quad, to within a degree
 * and a half on every backdrop whose sky is a plain quad (Dwarf 65° wants 27.01/20.92 and covers
 * 27.74/23.41; Tauren 65° covers 29.12/22.14; NightElf 60° wants 24.79/19.11 and covers 23.48/25.36).
 */
const degrees = (value) => Math.round(value * 100) / 100;
const halfTangent = (fov) => Math.tan((fov / 2) * Math.PI / 180);

test("an authored glue camera is a diagonal fov, and the frame it makes covers 4:3", () => {
  // At the authored aspect the split is exactly 0.6 vertical and 0.8 horizontal of the diagonal.
  const vertical = glueSceneVerticalFov(80, GLUE_AUTHORED_ASPECT);
  assert.equal(degrees(vertical), 53.45);
  assert.equal(degrees(vertical / 2), 26.72, "half of it is what UI_Human's sky covers upward");
  const horizontal = 2 * Math.atan(halfTangent(vertical) * GLUE_AUTHORED_ASPECT) * 180 / Math.PI;
  assert.equal(degrees(horizontal / 2), 33.87, "and sideways");

  // 0.6 and 0.8 are the 3-4-5 triangle, so the identity is exact rather than approximate.
  assert.ok(Math.abs(halfTangent(vertical) - halfTangent(80) * 0.6) < 1e-12);
});

test("a wider viewport keeps the authored horizontal angle and loses vertical, never the reverse", () => {
  const authored = halfTangent(glueSceneVerticalFov(80, GLUE_AUTHORED_ASPECT));
  const authoredHorizontal = authored * GLUE_AUTHORED_ASPECT;

  // 16:9. The sky must still fill the box, so the frustum may not grow past the authored frame on
  // either axis: vertical shrinks and horizontal stays exactly where the author put it.
  const wide = glueSceneVerticalFov(80, 16 / 9);
  assert.equal(degrees(wide), 41.37);
  assert.ok(halfTangent(wide) < authored, "the vertical angle shrank");
  assert.ok(Math.abs(halfTangent(wide) * (16 / 9) - authoredHorizontal) < 1e-12,
    "the horizontal angle is the authored one, to the last bit");

  // Narrower than 4:3 is the mirror image: the vertical is kept and the horizontal shrinks.
  const tall = glueSceneVerticalFov(80, 1);
  assert.ok(Math.abs(halfTangent(tall) - authored) < 1e-12);
  assert.ok(halfTangent(tall) * 1 < authoredHorizontal);

  // Every backdrop whose sky is a plain quad, at the aspect this browser was measured in
  // (1280x720). The frustum has to fit inside the quad each set actually carries, and the vertical
  // — which is what the defect was — now fits with room to spare on all four.
  const skies = [
    { name: "UI_Human", fov: 80, up: 26.09, side: 34.09 },
    { name: "UI_Dwarf", fov: 65, up: 23.41, side: 27.74 },
    { name: "UI_Tauren", fov: 65, up: 22.14, side: 28.53 },
    { name: "UI_NightElf", fov: 60, up: 25.36, side: 23.37 },
  ];
  const sideways = [];
  for (const sky of skies) {
    const half = glueSceneVerticalFov(sky.fov, 16 / 9) / 2;
    const halfSide = Math.atan(halfTangent(half * 2) * (16 / 9)) * 180 / Math.PI;
    assert.ok(half <= sky.up, `${sky.name}: vertical ${degrees(half)} vs sky ${sky.up}`);
    sideways.push(degrees(halfSide - sky.side));
  }
  // Sideways, three of the four fit and `UI_NightElf` is 1.42° short — its author left the sky
  // narrower than a 4:3 frame needs, so a sliver of its edge can reach a 16:9 corner. Recorded as a
  // number rather than asserted away: it is a property of the client's art, not of this code.
  assert.deepEqual(sideways, [-0.22, -0.73, -1.52, 1.42]);
});

test("a nonsense aspect falls back to the authored frame rather than to NaN", () => {
  const authored = glueSceneVerticalFov(80, GLUE_AUTHORED_ASPECT);
  assert.equal(glueSceneVerticalFov(80, 0), authored);
  assert.equal(glueSceneVerticalFov(80, Number.NaN), authored);
  assert.ok(Number.isFinite(glueSceneVerticalFov(0, 1.5)));
  assert.ok(Number.isFinite(glueSceneVerticalFov(200, 1.5)));
});

test("the standing figure keeps its authored size past 4:3 instead of growing with the zoom", () => {
  // 4:3 and narrower are the identity: the cover rule does not narrow there either.
  assert.equal(glueFigureScaleCompensation(80, GLUE_AUTHORED_ASPECT), 1);
  assert.equal(glueFigureScaleCompensation(80, 1), 1);
  // 16:9. A human on its authored mark fills ~60% of the frame at 4:3 and ~78% in the covered
  // 16:9 shot; the current-to-authored vertical ratio is the shrink that holds the angular size.
  const wide = glueFigureScaleCompensation(80, 16 / 9);
  const expected = glueSceneVerticalFov(80, 16 / 9) / glueSceneVerticalFov(80, GLUE_AUTHORED_ASPECT);
  assert.ok(Math.abs(wide - expected) < 1e-12);
  assert.ok(wide > 0.7 && wide < 0.85, `16:9 compensation is ${wide}, not a guess`);
  // Past 16:9 the 16:9 value holds: ultrawide staging stretches anyway, and shrinking further
  // would detach the feet from a medallion nobody can see at that width.
  assert.equal(glueFigureScaleCompensation(80, 32 / 9), wide);
  assert.equal(glueFigureScaleCompensation(80, 100), wide);
  // Garbage in, identity out — a sizeless host must not shrink the figure to nothing.
  assert.equal(glueFigureScaleCompensation(80, 0), 1);
  assert.equal(glueFigureScaleCompensation(80, -1), 1);
  assert.equal(glueFigureScaleCompensation(80, Number.NaN), 1);
  assert.equal(glueFigureScaleCompensation(Number.NaN, 16 / 9), 1);
  assert.equal(GLUE_FIGURE_COMPENSATION_MAX_ASPECT, 16 / 9);
});

// The render budget. Two classes, because one number for all of them is what the owner was looking
// at when he called the character screen blurry: every canvas on both screens was 512x307 while the
// widget behind it was 1280x768. Which class a view is on is now decided by *coverage* as well as by
// the rig, and how many pixels the class gets is decided by the last second of frame times.

test("what fills the frame is a subject, whatever it is made of", () => {
  // `CharacterSelect` and `CharacterCreate` declare `<ModelFFX>` as the screen frame itself.
  assert.equal(glueViewIsSubject("ModelFFX", false), true);
  // Archibald and Morethan carry bones.
  assert.equal(glueViewIsSubject("Model", true), true);
  // The sky dome, the nine cloud cards and the two radiation-fog balls carry none, and every one of
  // them is declared `SetSize(LoginScene:GetWidth(), LoginScene:GetHeight())` — the whole stage.
  assert.equal(glueViewIsSubject("Model", false, 1), true);
  assert.equal(glueViewIsSubject("Model", false, GLUE_SUBJECT_COVERAGE + 0.01), true);
  // A prop stays cheap: an inset portrait, a spell icon, a `UI-AutoCastButton`.
  assert.equal(glueViewIsSubject("Model", false, GLUE_SUBJECT_COVERAGE), false);
  assert.equal(glueViewIsSubject("Model", false, 0.02), false);
  assert.equal(glueViewIsSubject("Model", false), false, "no coverage known yet is not a subject");
});

test("coverage is the part of the viewport a box actually shows", () => {
  // `lgzg.lua`'s stage is wider than the window: measured live, a login model's box was 1639x922 at
  // x = −339 in a 961x922 viewport, and only the part on screen counts.
  const viewport = { width: 961, height: 922 };
  assert.equal(glueViewCoverage({ x: -339, y: 0, width: 1639, height: 922 }, viewport), 1);
  assert.equal(glueViewCoverage({ x: 0, y: 0, width: 961, height: 922 }, viewport), 1);
  // A quarter of the frame is a quarter.
  assert.equal(
    Math.round(glueViewCoverage({ x: 0, y: 0, width: 480.5, height: 461 }, viewport) * 1000) / 1000,
    0.25);
  // Entirely off-screen is nothing, not a negative area.
  assert.equal(glueViewCoverage({ x: -2000, y: 0, width: 100, height: 100 }, viewport), 0);
  assert.equal(glueViewCoverage({ x: 0, y: 1200, width: 961, height: 100 }, viewport), 0);
  // A viewport with no area is a ratio of one rather than a division by zero.
  assert.ok(Number.isFinite(glueViewCoverage({ x: 0, y: 0, width: 10, height: 10 },
    { width: 0, height: 0 })));
});

test("a subject renders at its box times the ratio the ladder allows; a prop at the ladder's edge", () => {
  const top = GLUE_QUALITY_STEPS[0];
  const deep = GLUE_QUALITY_STEPS.at(-1);
  // A prop: the long edge is capped and the aspect is kept.
  assert.deepEqual(
    glueViewResolution(1280, 768, { subject: false, dpr: 1, sceneryEdge: top.sceneryEdge }),
    { width: 512, height: 307 });
  assert.deepEqual(
    glueViewResolution(1280, 768, { subject: false, dpr: 2, sceneryEdge: top.sceneryEdge }),
    { width: 512, height: 307 }, "the ratio does not buy a prop any pixels");
  // The deepest rung takes a prop down to 256 on its long edge.
  assert.deepEqual(
    glueViewResolution(1280, 768, { subject: false, dpr: 1, sceneryEdge: deep.sceneryEdge }),
    { width: 256, height: 154 });
  // A prop box already under the cap is rendered as it is rather than blown up.
  assert.deepEqual(glueViewResolution(300, 200, { subject: false, dpr: 1, sceneryEdge: 512 }),
    { width: 300, height: 200 });

  // A subject on the top rung gets its box outright at DPR 1 …
  assert.deepEqual(
    glueViewResolution(1280, 768, { subject: true, dpr: 1, subjectRatioCap: top.subjectRatioCap }),
    { width: 1280, height: 768 });
  // … and its box times the display ratio until the 2,048 ceiling stops it.
  assert.deepEqual(
    glueViewResolution(1280, 768, { subject: true, dpr: 2, subjectRatioCap: top.subjectRatioCap }),
    { width: 2048, height: 1229 });
  // The rungs below one are the ones that bite on a screen made of thirty-two full-stage views.
  assert.deepEqual(glueViewResolution(1920, 969, { subject: true, dpr: 1, subjectRatioCap: 0.5 }),
    { width: 960, height: 485 });
  assert.deepEqual(glueViewResolution(1920, 969, { subject: true, dpr: 1, subjectRatioCap: 0.25 }),
    { width: 480, height: 242 });
  // A cap above the display's ratio never invents pixels the display cannot show.
  assert.deepEqual(glueViewResolution(800, 600, { subject: true, dpr: 1, subjectRatioCap: 2 }),
    { width: 800, height: 600 });

  // The hard ceiling: no single view is ever asked for more than 2,048 on its long edge.
  const huge = glueViewResolution(3840, 2160, { subject: true, dpr: 3, subjectRatioCap: 2 });
  assert.ok(Math.max(huge.width, huge.height) <= 2048, `${huge.width}x${huge.height}`);
  // A nonsense ratio is a ratio of one rather than a NaN-sized canvas.
  assert.deepEqual(glueViewResolution(800, 600, { subject: true, dpr: 0, subjectRatioCap: 2 }),
    { width: 800, height: 600 });
  // With no ladder handed over at all it is the top rung, not a NaN.
  assert.deepEqual(glueViewResolution(1280, 768, { subject: false, dpr: 1 }),
    { width: 512, height: 307 });

  // The memory rail. One full-stage subject keeps its whole box …
  assert.deepEqual(
    glueViewResolution(1920, 969, { subject: true, dpr: 1, subjectRatioCap: 2, subjects: 1 }),
    { width: 1920, height: 969 });
  // … and thirty-two of them share sixteen million canvas pixels rather than allocating 59.5 M.
  const shared = glueViewResolution(1920, 969, {
    subject: true, dpr: 1, subjectRatioCap: 2, subjects: 32,
  });
  assert.ok(shared.width * shared.height * 32 <= 16_000_000 * 1.005,
    `thirty-two subjects fit the rail: ${shared.width}x${shared.height}`);
  assert.ok(shared.width > 512, `and still sharper than the old flat cap: ${shared.width}`);
});

test("somebody never skips a pass and a plate rides the ladder's divisor", () => {
  assert.equal(glueViewTickDivisor(true, 4), 1);
  assert.equal(glueViewTickDivisor(false, 1), 1, "the top rung skips nothing at all");
  assert.equal(glueViewTickDivisor(false, 2), 2);
  assert.equal(glueViewTickDivisor(false, 4), 4);
  // A nonsense divisor is every pass rather than never.
  assert.equal(glueViewTickDivisor(false, 0), 1);
});

test("the quality ladder only ever gives things up, rung by rung", () => {
  assert.ok(GLUE_QUALITY_STEPS.length >= 8, "a ladder with rungs to walk");
  const first = GLUE_QUALITY_STEPS[0];
  assert.equal(first.sceneryTick, 1, "the top rung redraws everything every pass");
  for (let i = 1; i < GLUE_QUALITY_STEPS.length; i += 1) {
    const before = GLUE_QUALITY_STEPS[i - 1];
    const step = GLUE_QUALITY_STEPS[i];
    assert.ok(step.sceneryTick >= before.sceneryTick, `${step.name}: tick never improves`);
    assert.ok(step.sceneryEdge <= before.sceneryEdge, `${step.name}: prop edge never improves`);
    assert.ok(step.subjectRatioCap <= before.subjectRatioCap, `${step.name}: subject never improves`);
    assert.notEqual(step.name, before.name, "every rung is named, and named once");
    // Exactly one knob moves per rung: a ladder that changes two things at once cannot be read off
    // a diagnostic line.
    const moved = Number(step.sceneryTick !== before.sceneryTick)
      + Number(step.sceneryEdge !== before.sceneryEdge)
      + Number(step.subjectRatioCap !== before.subjectRatioCap);
    assert.equal(moved, 1, `${step.name} moves exactly one knob`);
  }
  // The order the brief names: frame rate first, then prop resolution, then the subject class.
  assert.deepEqual(GLUE_QUALITY_STEPS.map((step) => step.sceneryTick).slice(0, 4), [1, 2, 3, 4]);
});

test("the controller degrades under load and recovers slowly, and never on one bad frame", () => {
  const controller = new GlueQualityController(GLUE_QUALITY_TARGET_MS);
  assert.equal(controller.step, 0);
  assert.equal(controller.current.name, GLUE_QUALITY_STEPS[0].name);

  // A pass that is merely over target does not move the ladder until it has been over for two
  // seconds: a texture settling or a character walking on is ridden out, not answered.
  let now = 0;
  assert.equal(controller.sample(GLUE_QUALITY_TARGET_MS + 1, now), undefined);
  now += 1900;
  assert.equal(controller.sample(GLUE_QUALITY_TARGET_MS + 1, now), undefined, "1.9 s is not 2 s");
  now += 200;
  const first = controller.sample(GLUE_QUALITY_TARGET_MS + 1, now);
  assert.ok(first, "two seconds over target is a rung");
  assert.equal(controller.step, 1);

  // Far over target is the boot case — thirty-two full-stage views at native — and 250 ms is the
  // wait there, so the screen settles in about a second instead of in twenty.
  const boot = new GlueQualityController(GLUE_QUALITY_TARGET_MS);
  let bootNow = 0;
  let rungs = 0;
  for (let i = 0; i < 40; i += 1) {
    bootNow += 260;
    if (boot.sample(GLUE_QUALITY_TARGET_MS * 8, bootNow)) rungs += 1;
  }
  assert.equal(boot.step, GLUE_QUALITY_STEPS.length - 1, "it walks all the way down");
  assert.equal(rungs, GLUE_QUALITY_STEPS.length - 1);
  assert.equal(boot.sample(GLUE_QUALITY_TARGET_MS * 8, bootNow + 10_000), undefined,
    "and stops at the bottom rather than falling off it");

  // Recovery needs real headroom, and takes one rung at a time. Half the target is the ordinary
  // case and waits eight seconds a rung.
  const easing = new GlueQualityController(GLUE_QUALITY_TARGET_MS);
  let easeNow = 0;
  for (let i = 0; i < 40; i += 1) { easeNow += 260; easing.sample(GLUE_QUALITY_TARGET_MS * 8, easeNow); }
  assert.equal(easing.step, GLUE_QUALITY_STEPS.length - 1);
  const half = GLUE_QUALITY_TARGET_MS * 0.5;
  for (let i = 0; i < 60; i += 1) easing.sample(half, easeNow);
  let slow = 0;
  for (let i = 0; i < 40; i += 1) { easeNow += 1000; if (easing.sample(half, easeNow)) slow += 1; }
  assert.ok(slow >= 3 && slow <= 5, `eight seconds a rung over forty seconds: ${slow}`);

  // A screen change is the other case: one view at a tenth of the target climbs a rung a second, so
  // the character screen is back at native in ten seconds rather than in a minute and a half.
  const easy = GLUE_QUALITY_TARGET_MS * 0.1;
  let up = 0;
  let upNow = bootNow;
  // A window's worth of cheap passes first, so the rolling mean is actually below the threshold.
  for (let i = 0; i < 40; i += 1) boot.sample(easy, upNow);
  for (let i = 0; i < 40; i += 1) {
    upNow += 1000;
    if (boot.sample(easy, upNow)) up += 1;
  }
  assert.equal(boot.step, 0, "it climbed all the way back to the top rung");
  assert.equal(up, GLUE_QUALITY_STEPS.length - 1);
  // The top rung is the top: it does not walk off that end either.
  const idle = new GlueQualityController(GLUE_QUALITY_TARGET_MS);
  assert.equal(idle.sample(easy, 100_000), undefined);
  assert.equal(idle.step, 0);
  // Rubbish is banked as nothing rather than as a reason to degrade.
  assert.equal(idle.sample(Number.NaN, 200_000), undefined);
  assert.equal(idle.sample(-1, 200_000), undefined);
  assert.equal(idle.step, 0);
});

test("a negative authored scale mirrors the model, so its single-sided batches turn inside out", () => {
  // `lgzg.lua` writes nine `tu_clouds_01` cards at −0.419 … −0.720 and one lightshaft at −1.118.
  for (const scale of [-0.419, -0.428, -0.43, -0.472, -0.5, -0.537, -0.604, -0.688, -0.72, -1.118]) {
    assert.equal(glueScaleMirrors(scale), true, `${scale} mirrors`);
  }
  for (const scale of [0.012, 0.255, 1, 3.933, undefined, Number.NaN]) {
    assert.equal(glueScaleMirrors(scale), false, `${scale} does not mirror`);
  }

  // Read out of the artifacts the gateway serves: `tu_clouds_01.m2` is one batch with material flags
  // 16 — no `MATERIAL_TWO_SIDED` — so three culls it away under a mirroring matrix, while
  // `silvermyst_lightshaft03.m2`'s single batch carries flags 21, and 0x04 of that is two-sided.
  // That is why the negatively-scaled lightshaft kept drawing and the nine cloud cards did not.
  const cloud = new THREE.MeshBasicMaterial();
  const lightshaft = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const inner = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
  assert.equal(glueFlipMaterialSides([cloud, lightshaft, inner]), 2);
  assert.equal(cloud.side, THREE.BackSide);
  assert.equal(inner.side, THREE.FrontSide);
  assert.equal(lightshaft.side, THREE.DoubleSide, "a two-sided batch has no front to lose");
  // An involution: the same call puts them back, so a widget whose scale changes sign twice is where
  // it started rather than two flips deep.
  glueFlipMaterialSides([cloud, lightshaft, inner]);
  assert.equal(cloud.side, THREE.FrontSide);
  assert.equal(inner.side, THREE.BackSide);
  assert.equal(lightshaft.side, THREE.DoubleSide);
});

test("a still view is redrawn only when the widget's own state moved", () => {
  const model = {
    file: "world\\generic\\cloud.m2", sequence: 0, facing: 1.5, modelScale: 0.4,
    position: [1, 2, 3], calls: [], scale: 1,
  };
  const before = glueViewSignature({ model });
  assert.equal(glueViewSignature({ model }), before, "the same state is the same signature");
  assert.notEqual(glueViewSignature({ model: { ...model, facing: 1.6 } }), before);
  assert.notEqual(glueViewSignature({ model: { ...model, position: [1, 2, 4] } }), before);
  assert.notEqual(glueViewSignature({ model: { ...model, sequence: 220 } }), before);
  assert.notEqual(glueViewSignature({ model: { ...model, modelScale: 0.41 } }), before);
  // `SetLight` and `AddLight` both change what the picture looks like, and both are in it.
  assert.notEqual(glueViewSignature({ model: { ...model, light: [1, 0, 0, 0, -1, 1, 0.27] } }), before);
  assert.notEqual(glueViewSignature({ model: { ...model, lights: [[1, 0, 0, 0, -1, 1, 0.27]] } }), before);
  // A widget that never had a position or a light is still a stable signature, not a crash.
  assert.equal(typeof glueViewSignature({ model: { file: "a.m2", scale: 1, calls: [] } }), "string");
});
