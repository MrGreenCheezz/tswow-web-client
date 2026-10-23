// 23.10 (7.48): the browser asks for HD effect textures only with «Чёткие текстуры эффектов» on, only for the
// effect folders and only once the gateway published an HD generation; off (the default and the faithful/comparison
// profile) every texture URL is byte-identical to what it was.
import assert from "node:assert/strict";
import test from "node:test";
import { textureUrl } from "../dist/code/browser/Wvm.js";
import {
  applyGatewayGenerationPush, gatewayGenerationPush, gatewayHdTextureGeneration, noteGatewayAssetGenerations,
  resetGatewayGeneration,
} from "../dist/code/browser/GatewayGeneration.js";
import {
  hdEffectTexturesEnabled, isHdEffectTexturePath, setHdEffectTexturesEnabled, withHdEffectTexture,
} from "../dist/code/browser/HdEffectTextures.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { defaultSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { applyRendererGraphicsSettings } from "../dist/code/browser/RendererGraphicsSettings.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";

const BASE = "http://127.0.0.1:8090";
const VG = "aaaaaaaaaaaaaaaaaaaa";
const HG = "bbbbbbbbbbbbbbbbbbbb";
const EFFECT = "Spells\\Clouds8x8Fade.blp";
const CREATURE = "Creature\\GolemHarvest\\Red_Glow3.blp";

test("off, every texture URL is what it was; on, only effect paths gain hd= and only with a published generation", () => {
  resetGatewayGeneration();
  setHdEffectTexturesEnabled(false);
  noteGatewayAssetGenerations(BASE, VG, undefined, HG);
  assert.equal(gatewayHdTextureGeneration(), HG);
  const before = [EFFECT, CREATURE, "Tileset\\Elwynn\\ElwynnGrassBase.blp"].map((path) => textureUrl(BASE, path));
  assert.deepEqual(before, [
    `${BASE}/texture?path=${encodeURIComponent(EFFECT)}&vg=${VG}`,
    `${BASE}/texture?v=2&path=${encodeURIComponent(CREATURE)}&vg=${VG}`,
    `${BASE}/texture?path=${encodeURIComponent("Tileset\\Elwynn\\ElwynnGrassBase.blp")}&vg=${VG}`,
  ], "the setting off: no hd= anywhere");

  setHdEffectTexturesEnabled(true);
  assert.equal(hdEffectTexturesEnabled(), true);
  assert.equal(textureUrl(BASE, EFFECT), `${BASE}/texture?path=${encodeURIComponent(EFFECT)}&vg=${VG}&hd=${HG}`);
  assert.equal(textureUrl(BASE, "particles\\GenericGlow.blp").endsWith(`&hd=${HG}`), true);
  assert.equal(textureUrl(BASE, CREATURE), before[1], "creature art is never asked for in HD");
  assert.equal(textureUrl(BASE, "Tileset\\Elwynn\\ElwynnGrassBase.blp"), before[2], "world textures are a later step");

  // The gateway stops publishing a generation (switched off, set deleted): no hd= again.
  noteGatewayAssetGenerations(BASE, VG, undefined, undefined);
  assert.equal(textureUrl(BASE, EFFECT), before[0]);
  // Another gateway's URL is never decorated.
  noteGatewayAssetGenerations(BASE, VG, undefined, HG);
  assert.equal(withHdEffectTexture(`http://other:1/texture?path=x`, EFFECT), "http://other:1/texture?path=x");
  setHdEffectTexturesEnabled(false);
  resetGatewayGeneration();
});

test("the effect folders are matched case-blind on the backslashed path", () => {
  assert.equal(isHdEffectTexturePath("SPELLS\\X.BLP"), true);
  assert.equal(isHdEffectTexturePath("Particles\\x.blp"), true);
  assert.equal(isHdEffectTexturePath("world\\spells\\x.blp"), false);
});

test("the HD generation travels to the renderer's realm with the rest of the generation state", () => {
  resetGatewayGeneration();
  noteGatewayAssetGenerations(BASE, VG, undefined, HG);
  const push = gatewayGenerationPush();
  assert.equal(push.hd, HG);
  resetGatewayGeneration();
  assert.equal(gatewayHdTextureGeneration(), undefined);
  applyGatewayGenerationPush(push);
  assert.equal(gatewayHdTextureGeneration(), HG);
  resetGatewayGeneration();
});

// 23.10 (7.48): opt-in, not part of the enhanced preset — at play distance the HD set changed
// 0–0.6 % of a spell's pixels (1.8 % on a close-up Fireball) while each spell costs ≈5 MB of GPU memory.
test("«Чёткие текстуры эффектов»: off by default, in the comparison profile and in the enhanced preset, sent to the renderer", () => {
  const definition = settingDefinition("experimentalSharpEffectTextures");
  assert.equal(definition?.label, "Чёткие текстуры эффектов");
  assert.equal(definition?.fallback, false);
  assert.equal(defaultSettings().experimentalSharpEffectTextures, false);
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalSharpEffectTextures, undefined);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalSharpEffectTextures, false);
  assert.equal(RENDER_WORKER_COMMANDS.setHdEffectTextures, "setting");
  const calls = [];
  const renderer = new Proxy({}, {
    get: (_target, name) => (...args) => { if (name === "setHdEffectTextures") calls.push(args[0]); },
  });
  applyRendererGraphicsSettings(renderer, { ...defaultSettings(), experimentalSharpEffectTextures: true }, undefined);
  applyRendererGraphicsSettings(renderer, { ...defaultSettings() }, undefined);
  assert.deepEqual(calls, [true, false]);
});
