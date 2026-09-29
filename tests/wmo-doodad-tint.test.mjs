import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import ts from "typescript";

import {
  parseWmoDoodads, parseWmoDoodadSets, validParsedWmoDoodadSets,
} from "../tools/wmo-visual.mjs";

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function oneDoodadRoot(rawBgra) {
  const set = Buffer.alloc(32);
  set.writeUInt32LE(0, 20);
  set.writeUInt32LE(1, 24);
  const placement = Buffer.alloc(40);
  placement.writeFloatLE(1, 28);
  placement.writeFloatLE(1, 32);
  Buffer.from(rawBgra).copy(placement, 36);
  return Buffer.concat([
    chunk("MODS", set),
    chunk("MODN", Buffer.from("World\\Furniture\\Chair.mdx\0")),
    chunk("MODD", placement),
  ]);
}

function groupedDoodadFixture() {
  const set = Buffer.alloc(32);
  set.writeUInt32LE(0, 20);
  set.writeUInt32LE(2, 24);
  const placements = Buffer.alloc(80);
  for (let index = 0; index < 2; index++) {
    const at = index * 40;
    placements.writeUInt32LE(index === 0 ? 0 : "World\\Furniture\\Chair.mdx\0".length, at);
    placements.writeFloatLE(index === 0 ? 1 : 20, at + 4);
    placements.writeFloatLE(2, at + 8);
    placements.writeFloatLE(3, at + 12);
    placements.writeFloatLE(1, at + 28);
    placements.writeFloatLE(1, at + 32);
    Buffer.from(index === 0 ? [91, 168, 255, 255] : [20, 40, 60, 255]).copy(placements, at + 36);
  }
  return Buffer.concat([
    chunk("MODS", set),
    chunk("MODN", Buffer.from("World\\Furniture\\Chair.mdx\0World\\Furniture\\Table.mdx\0")),
    chunk("MODD", placements),
  ]);
}

function doodadGroup({ flags, references, colours = true }) {
  const header = Buffer.alloc(68);
  header.writeUInt32LE(flags, 8);
  const refs = Buffer.alloc(references.length * 2);
  references.forEach((reference, index) => refs.writeUInt16LE(reference, index * 2));
  return chunk("MOGP", Buffer.concat([
    header,
    chunk("MODR", refs),
    ...(colours ? [chunk("MOCV", Buffer.from([255, 255, 255, 255]))] : []),
  ]));
}

test("only an indoor MOCV group's MODR doodads expose authored MODD illumination", () => {
  // Deliberately no MOLT chunk: the 3.3.5 indoor-M2 path uses a fixed client light, not a guessed
  // nearest root light. MODR is ownership; MOCV + indoor is the local-light gate.
  const root = groupedDoodadFixture();
  const indoor = doodadGroup({ flags: 0x2000 | 0x04 | 0x800, references: [0] });
  const parsed = parseWmoDoodads(root, 0, [indoor]);
  assert.deepEqual(parsed[0].localLight, [255, 168, 91, 255],
    "the owned doodad keeps its display-order authored illumination bytes");
  assert.equal(parsed[1].localLight, undefined,
    "a doodad absent from this group's MODR is not silently classified as room-lit");

  const outdoor = doodadGroup({ flags: 0x800, references: [0] });
  assert.equal(parseWmoDoodads(root, 0, [outdoor])[0].localLight, undefined,
    "an outdoor group keeps authored world lighting");
  const noColours = doodadGroup({ flags: 0x2000 | 0x800, references: [0], colours: false });
  assert.equal(parseWmoDoodads(root, 0, [noColours])[0].localLight, undefined,
    "the local-light path follows the reference's indoor + MOCV gate");

  const sets = parseWmoDoodadSets(root, [indoor]);
  assert.equal(validParsedWmoDoodadSets(sets), true);
  assert.equal(validParsedWmoDoodadSets([[null]]), false,
    "JSON shape alone must not admit a corrupt cache entry that crashes worldDoodad");
  assert.equal(validParsedWmoDoodadSets([[{ ...sets[0][0], x: Number.NaN }]]), false);
  assert.equal(validParsedWmoDoodadSets([[{ ...sets[0][0], localLight: [256, 0, 0, 255] }]]), false);
});

test("MODD final BGRA room light survives the visual-tile wire contract as RGBA bytes", () => {
  const indoor = doodadGroup({ flags: 0x2000 | 0x04 | 0x800, references: [0] });
  const [doodad] = parseWmoDoodads(oneDoodadRoot([91, 168, 255, 255]), 0, [indoor]);
  assert.deepEqual(doodad.localLight, [255, 168, 91, 255],
    "raw warm BGRA must not become a cold blue RGB light");

  const generator = readFileSync("tools/generate-visual-tile.mjs", "utf8");
  assert.match(generator, /localLight:\s*doodad\.localLight/,
    "only classified indoor doodads carry MODD illumination onto the wire");
  assert.doesNotMatch(generator, /tint:\s*doodad\.tint/,
    "outdoor MODD must not become an albedo tint multiplied by world light");

  const protocol = readFileSync("src/gateway/VMapProtocol.ts", "utf8");
  assert.match(protocol, /localLight\?:\s*(?:readonly\s*)?\[[^\]]*alpha:\s*number\]/,
    "the fourth MODD byte must remain the stored alpha component at the wire boundary");

  const decoder = readFileSync("src/browser/EnvironmentTileDecode.ts", "utf8");
  assert.match(decoder, /object\.localLight[\s\S]{0,320}Number\.isInteger[\s\S]{0,160}item\s*>=\s*0[\s\S]{0,120}item\s*<=\s*255/,
    "untrusted visual-tile JSON must accept only four finite colour bytes");
});

test("local WMO doodad materials use the traced fixed light and never reapply outdoor world light", () => {
  const source = readFileSync("src/browser/ModelPlacementTint.ts", "utf8")
    .replace(/^import[^\n]*\n/gm, "")
    .replaceAll("export ", "");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const worldTarget = [
    "#include <lights_fragment_begin>",
    "#include <lights_fragment_maps>",
    "#include <lights_fragment_end>",
  ].join("\n\t");
  const cloneMaterialForPortrait = (material) => {
    const clone = material.clone();
    clone.onBeforeCompile = material.onBeforeCompile;
    clone.customProgramCacheKey = () => material.customProgramCacheKey();
    return clone;
  };
  const api = new Function("THREE", "WORLD_LIGHT_TARGET", "cloneMaterialForPortrait", `${javascript}; return {
    MODEL_PLACEMENT_LOCAL_LIGHT_ATTRIBUTE,
    MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION,
    createInstancedModelPlacementLocalLightMaterials,
    createModelPlacementLocalLightMaterials,
  };`)(THREE, worldTarget, cloneMaterialForPortrait);

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const [local] = api.createModelPlacementLocalLightMaterials([material], [255, 168, 91, 7]);
  const shader = {
    uniforms: {},
    vertexShader: "void main() {\n#include <begin_vertex>\n}",
    fragmentShader: `void main() {\n\t${worldTarget}\n}`,
  };
  local.onBeforeCompile(shader, {});
  assert.deepEqual(shader.uniforms.modelPlacementLocalLight.value.toArray(), [1, 168 / 255, 91 / 255],
    "the shader receives MODD in display space so the traced scales are applied before sRGB decoding");
  const direction = shader.uniforms.modelPlacementLocalLightDirection.value;
  assert.ok(Math.abs(direction.length() - 1) < 1e-12);
  assert.deepEqual(api.MODEL_PLACEMENT_LOCAL_LIGHT_DIRECTION, [-0.30822, 0.9, 0.30822],
    "the fixed stock-client direction remains one explicit, independently correctable mapping");
  assert.match(shader.fragmentShader, /96\.0\s*\/\s*255\.0/);
  assert.match(shader.fragmentShader, /168\.0\s*\/\s*255\.0/);
  assert.match(shader.fragmentShader, /dot\(\s*normalize\(\s*normal\s*\),\s*modelPlacementViewLightDirection/);
  assert.match(shader.fragmentShader,
    /modelPlacementAmbient\s*\+\s*modelPlacementDiffuse\s*\*\s*modelPlacementNL/,
    "the traced ambient and directional terms must be combined before display-to-linear conversion");
  assert.match(shader.fragmentShader, /pow\(\s*modelPlacementAuthoredLight,\s*vec3\(\s*2\.2\s*\)\s*\)/);
  assert.doesNotMatch(shader.fragmentShader, /wow(?:SunDirection|Ambient|Diffuse)/,
    "a room-authored placement must not retain the outdoor light uniforms/equation");

  const [instanced] = api.createInstancedModelPlacementLocalLightMaterials([material]);
  const instancedShader = {
    uniforms: {},
    vertexShader: "void main() {\n#include <begin_vertex>\n}",
    fragmentShader: `void main() {\n\t${worldTarget}\n}`,
  };
  instanced.onBeforeCompile(instancedShader, {});
  assert.match(instancedShader.vertexShader,
    new RegExp(`attribute vec3 ${api.MODEL_PLACEMENT_LOCAL_LIGHT_ATTRIBUTE}`));
  assert.match(instancedShader.fragmentShader, /varying vec3 modelPlacementVLocalLight/,
    "instanced furniture gets per-placement MODD RGB rather than sharing the first chair's light");
});

test("M2 placement tint owns one material state per placement and never treats MODD colour alpha as mesh opacity", () => {
  const source = readFileSync("src/browser/ModelPlacementTint.ts", "utf8")
    .replace(/^import[^\n]*\n/gm, "")
    .replaceAll("export ", "");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const api = new Function("THREE", `${javascript}; return {
    createModelPlacementTintMaterials,
    disposeModelPlacementTintMaterials,
    modelPlacementTintColour,
    syncModelPlacementTintMaterials,
  };`)(THREE);

  const material = new THREE.MeshStandardMaterial({ color: 0x8899aa });
  const warmMaterials = api.createModelPlacementTintMaterials([material], [255, 168, 91, 7]);
  const coolMaterials = api.createModelPlacementTintMaterials([material], [91, 168, 255, 255]);
  assert.notEqual(warmMaterials[0].id, coolMaterials[0].id,
    "different placements need different material ids so three uploads both uniforms");
  assert.equal(material.customProgramCacheKey(), "onBeforeCompile( /* shaderobject, renderer */ ) {}",
    "the cached source material must remain untouched for untinted and instanced copies");

  const warmShader = {
    uniforms: {},
    fragmentShader: "void main() {\n#include <color_fragment>\n}",
  };
  const coolShader = {
    uniforms: {},
    fragmentShader: "void main() {\n#include <color_fragment>\n}",
  };
  warmMaterials[0].onBeforeCompile(warmShader, {});
  coolMaterials[0].onBeforeCompile(coolShader, {});
  assert.match(warmShader.fragmentShader, /diffuseColor\.rgb\s*\*=\s*modelPlacementTint/);

  const warmUniform = warmShader.uniforms.modelPlacementTint.value;
  const coolUniform = coolShader.uniforms.modelPlacementTint.value;
  const expected = new THREE.Color().setRGB(1, 168 / 255, 91 / 255, THREE.SRGBColorSpace);
  assert.ok(Math.abs(warmUniform.x - expected.r) < 1e-8);
  assert.ok(Math.abs(warmUniform.y - expected.g) < 1e-8);
  assert.ok(Math.abs(warmUniform.z - expected.b) < 1e-8);
  assert.notDeepEqual(warmUniform.toArray(), coolUniform.toArray(),
    "two consecutive chairs must not share a mutable per-draw uniform");
  assert.equal(warmUniform.isVector3, true,
    "the fourth MODD byte is stored colour alpha, not mesh opacity and not part of the RGB multiplier");

  material.color.setRGB(0.2, 0.3, 0.4);
  material.opacity = 0.35;
  material.visible = false;
  api.syncModelPlacementTintMaterials(material);
  assert.ok(warmMaterials[0].color.equals(material.color));
  assert.equal(warmMaterials[0].opacity, 0.35);
  assert.equal(warmMaterials[0].visible, false,
    "placement copies must follow M2 colour/alpha animation before render-list admission");

  const instanceColour = api.modelPlacementTintColour([255, 168, 91, 255], new THREE.Color());
  assert.ok(instanceColour.equals(expected), "instanced copies must use the same sRGB conversion as individual meshes");

  let disposed = 0;
  warmMaterials[0].addEventListener("dispose", () => disposed++);
  api.disposeModelPlacementTintMaterials(warmMaterials);
  api.disposeModelPlacementTintMaterials(coolMaterials);
  assert.equal(disposed, 1, "placement-owned GPU material state must be released with the placement");
});

test("the world renderer separates local-light and outdoor M2 instances", () => {
  const renderer = readFileSync("src/browser/WorldRenderer3D.ts", "utf8");
  assert.match(renderer, /createModelPlacementLocalLightMaterials\(built\.materials,\s*object\.localLight\)/,
    "animated M2 doodads need placement-owned room-light uniforms");
  assert.match(renderer, /createModelPlacementLocalLightMaterials\(built\.materials,\s*localLight\)/,
    "ordinary M2 doodads need placement-owned room-light uniforms");
  assert.match(renderer, /rendered\.source\.localLight\s*\?\s*["']local["']\s*:\s*["']world["']/,
    "one material bucket must never mix local and outdoor lighting modes");
  assert.match(renderer, /createInstancedModelPlacementLocalLightMaterials\(built\.materials\)/);
  assert.match(renderer, /localLight\.attribute\.setXYZ\(index,\s*localLight\[0\],\s*localLight\[1\],\s*localLight\[2\]\)/,
    "instancing must retain each placement's own authored RGB");
  assert.match(renderer, /localLight\.attribute\.needsUpdate\s*=\s*true/);
});
