import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { buildModel } from "../dist/code/browser/ModelBuild.js";
import {
  BLEND_ALPHA, MATERIAL_NO_DEPTH_TEST, MATERIAL_NO_DEPTH_WRITE, MATERIAL_UNLIT,
} from "../dist/code/browser/Wvm.js";

const CSS = new URL("../src/browser/style.css", import.meta.url);
const BROWSER = new URL("../src/browser/", import.meta.url);

function quad(materialFlags, blendMode) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return {
    positions,
    normals: new Float32Array(positions.length),
    uv0: new Float32Array(6),
    uv1: new Float32Array(6),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [{
      submesh: 0, textures: [], uvSets: [0, 0], blendMode, materialFlags,
      renderFlags: 0, priority: 0, uvAnimation: -1, colour: -1, alpha: -1,
    }],
    textures: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 0], radius: 1 },
    particleEmitters: [], ribbonEmitters: [],
  };
}

const materialOf = (flags, blend) => buildModel(quad(flags, blend), {
  modelPath: "X.M2", baseUrl: "", loadTexture: () => new THREE.Texture(),
}).materials[0];

test("Ж0.3 the 0x10 bit bans the depth write, it does not switch the depth test off", () => {
  // There is no point light in this scene and no shadow map, so "torchlight through the wall" was
  // never light: it was the flame card. Read as a depth-test switch, 0x10 did two wrong things to
  // it at once — drew the quad over the stone in front of it, and, because the write was left on,
  // punched the quad's own silhouette out of the wall behind it.
  const flame = materialOf(MATERIAL_UNLIT | MATERIAL_NO_DEPTH_TEST, BLEND_ALPHA);
  assert.equal(flame.depthTest, true, "the wall in front still hides it");
  assert.equal(flame.depthWrite, false, "and it stops carving a hole in the wall behind");

  // The other corners of the same two bits, so this is a re-reading and not a blanket.
  assert.equal(materialOf(0, 0).depthTest, true);
  assert.equal(materialOf(0, 0).depthWrite, true);
  assert.equal(materialOf(MATERIAL_NO_DEPTH_WRITE, 0).depthTest, true);
  assert.equal(materialOf(MATERIAL_NO_DEPTH_WRITE, 0).depthWrite, false);
});

/** The stylesheet with its comments taken out, so a comment cannot pass for a selector. */
const bare = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `height` and `min-height` in pixels, with the selector it was declared on. */
function heightRules(css) {
  const rules = [];
  for (const rule of bare(css).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = rule[1].trim();
    for (const declaration of rule[2].matchAll(/(?:^|;)\s*(min-height|height):\s*([\d.]+)px/g)) {
      rules.push({ selector, property: declaration[1], height: Number(declaration[2]) });
    }
  }
  return rules;
}

/** Every `font-size` in pixels, rem resolved against the 16px root. */
function fontRules(css) {
  const rules = [];
  for (const rule of bare(css).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const size = /(?:^|;)\s*font-size:\s*([\d.]+)(rem|px)/.exec(rule[2]);
    if (size) rules.push({ selector: rule[1].trim(), px: size[2] === "rem" ? Number(size[1]) * 16 : Number(size[1]) });
  }
  return rules;
}

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("Ж0.4 no bar is shorter than the number written inside it", async () => {
  // The skills window was 10.88px of text in an 8px track: the baseline fell half a pixel past the
  // bottom edge and the digits stood at 1.99:1 against the gold fill. Windows that wanted a thin
  // bar wrote a height without knowing whether anything was written inside it, which is why the
  // party frames had the same defect at 9px. Enumerated from the call sites, because a rule that
  // held only for the bar somebody happened to look at is not a rule.
  const css = bare(await readFile(CSS, "utf8"));
  const em = fontRules(css).find((rule) => rule.selector === ".ui-bar > em");
  assert.ok(em, "the number inside a bar is `.ui-bar > em`");
  assert.match(css, /\.ui-bar > em \{[^}]*line-height: 1[;\s]/,
    "the height rule is only measurable if the line box is the type size");

  const withText = new Set();
  for (const file of await walk(fileURLToPath(BROWSER))) {
    const code = await readFile(file, "utf8");
    for (const call of code.matchAll(/new Bar\(\{([^}]*)\}\)/g)) {
      const options = call[1];
      if (!/(^|[\s,{])text:/.test(options) || /text:\s*false[\s,]/.test(options)) continue;
      withText.add(/kind:\s*"([a-z-]+)"/.exec(options)?.[1] ?? "");
    }
  }
  assert.ok(withText.size >= 4, `only ${withText.size} kinds of bar carry a number; the walk missed some`);

  // The stylesheet cannot see inside a bar, so the bar has to say it holds a number.
  const widgets = await readFile(new URL("ui/Widgets.ts", BROWSER), "utf8");
  assert.match(widgets, /if \(options\.text\) \{[\s\S]{0,600}?classList\.add\("ui-bar-text"\)/,
    "`Bar` marks itself when it carries a number, or the floor below reaches nothing");

  const heights = heightRules(css);
  const floor = heights.find((rule) => rule.selector === ".ui-bar-text" && rule.property === "min-height");
  assert.ok(floor, "`.ui-bar-text` declares the floor every bar with a number stands on");

  for (const kind of withText) {
    // Every height any rule could hand a bar of this kind — the base class and its own class,
    // under whatever container — and what the floor lifts each of them to.
    const own = new RegExp(`(^|\s)\.ui-bar${kind ? `(-${kind})?` : ""}$`);
    for (const rule of [floor, ...heights.filter((entry) => entry.property === "height" && own.test(entry.selector))]) {
      const effective = Math.max(rule.height, floor.height);
      assert.ok(effective >= em.px * 1.1,
        `\`${rule.selector}\` leaves a ${kind || "plain"} bar at ${effective}px holding ${em.px}px of text, `
        + `where it needs ${(em.px * 1.1).toFixed(2)}px`);
    }
  }
});

test("Ж0.5 the scrollbars are declared once, and not twice in ways that cancel", async () => {
  // Not one of the client's scrolling surfaces named a colour and nothing declared `color-scheme`,
  // so every one of them took the light system look: a white trough down a black panel.
  const css = bare(await readFile(CSS, "utf8"));
  const declarations = [...css.matchAll(/(?:^|[;{])\s*color-scheme:/g)];
  assert.equal(declarations.length, 1, "one declaration darkens every bar, corner and default control");
  assert.match(css, /:root \{[^}]*color-scheme: dark/, "and it belongs on the root, not on a panel");

  // In Chromium `scrollbar-color` disables the `::-webkit-scrollbar` pseudo-elements outright, so
  // a stylesheet carrying both has written one of the two for nothing.
  const modern = /(?:^|[;{])\s*scrollbar-color:/.test(css);
  assert.ok(!(modern && /::-webkit-scrollbar/.test(css)), "the two ways of colouring a scrollbar cancel; pick one");
});
