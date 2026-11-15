import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  advanceZoneWeights, caveRoom, countZoneTrees, emptyZoneSample, mapSnowShare, MAP_COLOUR_TEXELS, sampleZoneTerrain,
  snowTexel, zeroZoneWeights, zoneKindTargets,
} from "../dist/code/browser/ZoneAtmosphereKinds.js";
import {
  OUTDOOR_FOG_KINDS, CAVE_FOG_KINDS, mistKinds, shapeZoneFog, zoneShaftBoost, zoneStrength,
} from "../dist/code/browser/ZoneAtmosphere.js";
import { GroundMist, MIST_GRID, mistHollow } from "../dist/code/browser/GroundMist.js";
import { AtmosphereEffects, normaliseAtmosphereProfile } from "../dist/code/browser/AtmosphereEffects.js";
import { applyRendererGraphicsSettings } from "../dist/code/browser/RendererGraphicsSettings.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { defaultSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { SETTING_SECTIONS } from "../dist/code/browser/ui/SettingsSections.js";

const TILE = 1600 / 3;

function sample(overrides) {
  return Object.assign(emptyZoneSample(), overrides);
}

test("7.40: each kind is read from its own data, and nothing at all from open dry ground", () => {
  const none = zoneKindTargets(sample({ trees: 2 }));
  for (const kind of ["marsh", "forest", "coast", "cave", "cold"]) assert.equal(none[kind], 0, kind);
  // Swamp of Sorrows measured a shallow share of 0.22, 4 yards above the water.
  assert.ok(zoneKindTargets(sample({ shallow: 0.22, inland: 0.22, aboveInland: 4 })).marsh > 0.7);
  // A deep lake (inland water, nothing shallow) is not a marsh.
  assert.equal(zoneKindTargets(sample({ shallow: 0, inland: 0.9, aboveInland: 0 })).marsh, 0);
  // High above the swamp's water it fades.
  assert.ok(zoneKindTargets(sample({ shallow: 0.22, inland: 0.22, aboveInland: 30 })).marsh < 0.4);
  assert.equal(zoneKindTargets(sample({ ocean: 0.4, aboveOcean: 4 })).coast, 1);
  assert.equal(zoneKindTargets(sample({ ocean: 0.4, aboveOcean: 80 })).coast, 0, "a cliff top over the sea is not a beach");
  assert.equal(zoneKindTargets(sample({ trees: 15 })).forest, 1);
  assert.ok(zoneKindTargets(sample({ snowGround: 0.95 })).cold >= 0.65);
  assert.ok(zoneKindTargets(sample({ snowGround: 0.95, prominence: 40 })).cold > zoneKindTargets(sample({ snowGround: 0.95 })).cold,
    "a snowy height is colder than a snowy valley");
  assert.ok(zoneKindTargets(sample({ snowing: 1 })).cold > 0.5, "falling snow alone");
  const cave = zoneKindTargets(sample({ caveRoom: true, trees: 20, shallow: 0.5, snowGround: 1 }));
  assert.deepEqual(cave, { marsh: 0, forest: 0, coast: 0, cave: 1, cold: 0 }, "under a cave roof only the cave counts");
});

test("7.40: the weights ease toward the target instead of jumping", () => {
  const weights = zeroZoneWeights();
  const target = { ...zeroZoneWeights(), marsh: 1 };
  advanceZoneWeights(weights, target, 0.5);
  assert.ok(weights.marsh > 0.1 && weights.marsh < 0.2, String(weights.marsh));
  for (let i = 0; i < 200; i++) advanceZoneWeights(weights, target, 0.25);
  assert.equal(weights.marsh, 1);
});

test("7.40: the terrain sample tells shallow inland water, deep water and ocean apart", () => {
  const flat = (liquid) => ({ groundAt: () => 10, liquidAt: () => liquid });
  const swamp = sampleZoneTerrain(flat({ height: 11, type: 0x01 }), 0, 0, emptyZoneSample());
  assert.equal(swamp.shallow, 1);
  assert.equal(swamp.inland, 1);
  assert.equal(swamp.ocean, 0);
  const lake = sampleZoneTerrain(flat({ height: 20, type: 0x01 }), 0, 0, emptyZoneSample());
  assert.equal(lake.shallow, 0, "ten yards deep");
  assert.equal(lake.inland, 1);
  const slime = sampleZoneTerrain(flat({ height: 11, type: 0x08 }), 0, 0, emptyZoneSample());
  assert.equal(slime.shallow, 1, "slime is standing water too");
  const sea = sampleZoneTerrain(flat({ height: 11, type: 0x02 }), 0, 0, emptyZoneSample());
  assert.equal(sea.ocean, 1);
  assert.equal(sea.inland, 0);
  // A hill: the centre 30 yards above the ground 60–100 yards round.
  const hill = sampleZoneTerrain({ groundAt: (x, y) => Math.max(0, 30 - Math.hypot(x, y) / 2), liquidAt: () => undefined },
    0, 0, emptyZoneSample());
  assert.ok(hill.prominence > 20, String(hill.prominence));
});

test("7.40: a cave is an indoor group of a WMO named so; a house or an outdoor group is not", () => {
  assert.equal(caveRoom("Md_Goldmine_Varianta.wmo", 0x2000), true);
  assert.equal(caveRoom("World\\wmo\\Dungeon\\KL_WailingCaverns\\WailingCaverns.wmo", 0x2001), true);
  assert.equal(caveRoom("Md_Spidermine.wmo", 0x8), false, "the mine's mouth is an outdoor group");
  assert.equal(caveRoom("Md_Spidermine.wmo", 0x2008), false);
  assert.equal(caveRoom("Goldshireinn.wmo", 0x2000), false);
  assert.equal(caveRoom(undefined, undefined), false);
});

test("7.40: trees are counted by the scenery's own model names within the radius", () => {
  const objects = [
    { kind: "m2", name: "Elwynntreecanopy01.m2", x: 5, y: 5 },
    { kind: "m2", name: "Duskwoodtree03.m2", x: 30, y: 0 },
    { kind: "m2", name: "Generallantern01.m2", x: 1, y: 1 },
    { kind: "m2", name: "Elwynntreemid01.m2", x: 60, y: 0 },
    { kind: "wmo", name: "Treehouse.wmo", x: 0, y: 0 },
  ];
  assert.equal(countZoneTrees(objects, 0, 0), 2);
});

test("7.40: snow in the map's colour picture is bright, grey and cool; sand, grass and stone shade are not", () => {
  assert.ok(snowTexel(225, 232, 240) > 0.9, "snow");
  assert.equal(snowTexel(220, 200, 150), 0, "desert sand is warm");
  assert.equal(snowTexel(70, 110, 50), 0, "grass");
  assert.equal(snowTexel(90, 90, 95), 0, "dark rock");
  // The picture's row is the tile row along world X, its column the one along world Y.
  const width = 64 * MAP_COLOUR_TEXELS;
  const data = new Uint8ClampedArray(width * width * 4);
  const x = -5600;
  const y = -480;
  const row = Math.floor((32 - x / TILE) * MAP_COLOUR_TEXELS);
  const column = Math.floor((32 - y / TILE) * MAP_COLOUR_TEXELS);
  for (let r = row - 2; r <= row + 2; r++) {
    for (let c = column - 2; c <= column + 2; c++) data.set([225, 232, 240, 255], (r * width + c) * 4);
  }
  const picture = { width, height: width, data };
  assert.ok(mapSnowShare(picture, x, y) > 0.9);
  assert.equal(mapSnowShare(picture, y, x), 0, "the axes are not swapped");
});

test("7.40: the fog is shaped from its own colour — pulled in and tinted — and left alone at zero", () => {
  const fog = () => ({ near: 375, far: 2500, color: new THREE.Color(0.5, 0.45, 0.3) });
  const untouched = fog();
  shapeZoneFog(untouched, zeroZoneWeights(), 1, OUTDOOR_FOG_KINDS);
  assert.deepEqual([untouched.near, untouched.far, untouched.color.toArray()], [375, 2500, [0.5, 0.45, 0.3]]);
  const off = fog();
  shapeZoneFog(off, { ...zeroZoneWeights(), marsh: 1 }, 0, OUTDOOR_FOG_KINDS);
  assert.deepEqual([off.near, off.far], [375, 2500], "strength 0");
  const marsh = fog();
  shapeZoneFog(marsh, { ...zeroZoneWeights(), marsh: 1 }, 1, OUTDOOR_FOG_KINDS);
  assert.ok(marsh.near < 200 && marsh.far < 1600 && marsh.far > marsh.near, JSON.stringify(marsh));
  assert.ok(marsh.color.g / marsh.color.r > 0.45 / 0.5, "greener than the zone's own warm fog");
  assert.ok(marsh.color.r < 0.5 && marsh.color.r > 0.4, "a tint of it, not a replacement");
  const dark = { near: 100, far: 400, color: new THREE.Color(0.02, 0.02, 0.04) };
  shapeZoneFog(dark, { ...zeroZoneWeights(), cold: 1 }, 2, OUTDOOR_FOG_KINDS);
  assert.ok(dark.color.r < 0.06 && dark.color.b < 0.06, "a night fog stays a night fog");
  const cave = fog();
  shapeZoneFog(cave, { ...zeroZoneWeights(), cave: 1 }, 1, OUTDOOR_FOG_KINDS);
  assert.equal(cave.far, 2500, "the cave does not act on the outdoor kinds' call");
  shapeZoneFog(cave, { ...zeroZoneWeights(), cave: 1 }, 1, CAVE_FOG_KINDS);
  assert.ok(cave.far < 1500);
});

test("7.40: mist thickens in the cool of the day and in rain; the forest's is a dusk-to-dawn thing", () => {
  const w = { marsh: 1, forest: 1, coast: 1, cave: 0, cold: 1 };
  const noon = mistKinds(w, 1, 1, 0, 0, 0);
  const night = mistKinds(w, 1, 0, 0, 0, 0);
  const rainy = mistKinds(w, 1, 1, 1, 0, 0);
  assert.ok(night.marsh > noon.marsh && rainy.marsh > noon.marsh);
  assert.ok(noon.forest < 0.4 && night.forest > 2.5 * noon.forest, JSON.stringify({ noon, night }));
  assert.ok(mistKinds(w, 1, 1, 0, 1, 1).cold > noon.cold, "snowfall and wind blow the snow");
  assert.equal(mistKinds(w, 0, 0, 1, 1, 1).marsh, 0, "strength 0");
  assert.equal(zoneStrength(5), 2);
  assert.equal(zoneStrength(-1), 0);
  assert.equal(zoneShaftBoost({ ...w, forest: 0 }, 1), 1);
  assert.equal(zoneShaftBoost(w, 1), 1.6);
  assert.ok(zoneShaftBoost({ ...w, forest: 0.5 }, 1) < 1.2, "a few trees barely");
});

test("7.40: the mist grid lies on the surface, marks hollows and water, and draws nothing over ground not in yet", () => {
  assert.equal(mistHollow(10, 10), 0);
  assert.ok(mistHollow(6, 10) > 0.99);
  const mist = new GroundMist();
  // A bowl: ground falls toward the centre; water in the middle; nothing known west of x = -40.
  const probe = {
    groundAt: (x, y) => (x < -40 ? undefined : Math.hypot(x, y) * 0.4),
    liquidAt: (x, y) => (Math.hypot(x, y) < 6 ? { height: 1, type: 0x01 } : undefined),
  };
  const frame = {
    centre: new THREE.Vector3(1, 0, 2), probe, kinds: { marsh: 1, coast: 0, cold: 0, forest: 0 }, seconds: 1,
    windX: 0.5, windZ: 0, light: new THREE.Color(0.6, 0.6, 0.6), sunColour: new THREE.Color(1, 0.9, 0.7),
    sunDirection: new THREE.Vector3(0, 0.3, 1).normalize(), glow: 0.5,
  };
  mist.update(frame, 1 / 60);
  assert.equal(mist.object.visible, true);
  assert.equal(mist.rebuilds, 1);
  const position = mist.geometry.getAttribute("position");
  const attribute = mist.geometry.getAttribute("aMist");
  const centre = (MIST_GRID - 1) / 2 * MIST_GRID + (MIST_GRID - 1) / 2;
  assert.equal(position.getX(centre), 0, "snapped to the eight-yard cell");
  assert.equal(position.getY(centre), 1, "on the water, over the bed");
  assert.equal(attribute.getY(centre), 1, "inland water");
  assert.ok(attribute.getX(centre) > 0.2, "the bottom of the bowl is a hollow");
  assert.equal(attribute.getX(0), -1, "ground not in yet");
  // The bowl's normals lean toward its centre: a sheet on a slope is seen by its own side, not by world height.
  const normal = mist.geometry.getAttribute("aNormal");
  const east = (MIST_GRID - 1) / 2 * MIST_GRID + MIST_GRID - 4;
  assert.ok(normal.getX(east) < -0.2 && normal.getY(east) > 0.8, `${normal.getX(east)} ${normal.getY(east)}`);
  // Mist only lightens what is behind it: additive by its alpha, the target's alpha untouched.
  assert.equal(mist.material.blending, THREE.CustomBlending);
  assert.equal(mist.material.blendSrc, THREE.SrcAlphaFactor);
  assert.equal(mist.material.blendDst, THREE.OneFactor);
  assert.equal(mist.material.blendSrcAlpha, THREE.ZeroFactor);
  assert.equal(mist.material.blendDstAlpha, THREE.OneFactor);
  mist.update({ ...frame, centre: new THREE.Vector3(2, 0, 3) }, 1 / 60);
  assert.equal(mist.rebuilds, 1, "the same cell: no rebuild");
  mist.update({ ...frame, kinds: { marsh: 0, coast: 0, cold: 0, forest: 0 } }, 1 / 60);
  assert.equal(mist.object.visible, false);
  mist.dispose();
});

function atmosphereFrame(enhanced, probe) {
  const camera = new THREE.PerspectiveCamera();
  return {
    camera, feet: new THREE.Vector3(0, 1, 0), heightAt: () => 0, seconds: 1, elapsed: 1 / 60, map: 0,
    weather: undefined, fade: { kind: "fine", density: 0, storm: 0 }, thunder: false, indoors: false,
    underwater: false, sunDirection: new THREE.Vector3(0, 0.2, 1).normalize(), sunColour: new THREE.Color(1, 0.8, 0.6),
    ambient: new THREE.Color(0.4, 0.4, 0.4), daylight: 0.5, skyColour: new THREE.Color(0.5, 0.6, 0.7),
    pixelScale: 600, quality: 1, meadow: 0, forest: 0, enhanced, probe, trees: 0, cameraRoom: undefined,
  };
}

test("7.40: «Атмосфера зон» runs on the enhanced levels only and leaves nothing behind on a faithful one", () => {
  const scene = new THREE.Scene();
  const atmosphere = new AtmosphereEffects(scene, () => undefined);
  const swamp = { groundAt: () => 10, liquidAt: () => ({ height: 11, type: 0x01 }) };
  atmosphere.setProfile({ zoneAtmosphere: true, zoneStrength: 1 });
  atmosphere.update(atmosphereFrame(false, swamp));
  assert.equal(atmosphere.zone, undefined, "a faithful level creates nothing");
  assert.equal(scene.children.length, 0);
  assert.equal(atmosphere.shaftBoost, 1);
  const fog = { near: 300, far: 2000, color: new THREE.Color(0.5, 0.5, 0.5) };
  const room = { near: 300, far: 2000, color: new THREE.Color(0.5, 0.5, 0.5) };
  atmosphere.shapeZoneFogs(fog, room, false);
  assert.deepEqual([fog.near, fog.far], [300, 2000], "and shapes no fog");
  // On an enhanced level the swamp is read, its weight eases in and the mist is drawn.
  for (let i = 0; i < 120; i++) {
    const frame = atmosphereFrame(true, swamp);
    frame.seconds = 1 + i * 0.25;
    frame.elapsed = 0.25;
    atmosphere.update(frame);
  }
  assert.ok(atmosphere.zone.weights.marsh > 0.9, JSON.stringify(atmosphere.zone.weights));
  assert.ok(scene.children.some((child) => child.name === "zone-ground-mist" && child.visible));
  atmosphere.shapeZoneFogs(fog, room, false);
  assert.ok(fog.near < 300 && room.near < 300, "both the scene's fog and the interior fallback");
  // Back to a faithful level: released.
  atmosphere.update(atmosphereFrame(false, swamp));
  assert.equal(atmosphere.zone, undefined);
  assert.equal(scene.children.length, 0);
  atmosphere.dispose();
});

test("7.40: the profile carries the switch and a clamped strength", () => {
  const profile = normaliseAtmosphereProfile({ zoneAtmosphere: true, zoneStrength: 9 });
  assert.equal(profile.zoneAtmosphere, true);
  assert.equal(profile.zoneStrength, 2);
  assert.equal(normaliseAtmosphereProfile(undefined).zoneAtmosphere, false);
  assert.equal(normaliseAtmosphereProfile(undefined).zoneStrength, 1);
});

test("7.40: the setting is off by default and outside the enhanced preset, pinned off for comparison, and pushed", () => {
  const definition = settingDefinition("experimentalZoneAtmosphere");
  assert.equal(definition.label, "Атмосфера зон");
  assert.equal(definition.fallback, false, "off until the owner has judged it");
  assert.equal(definition.group, "Эффекты");
  assert.equal(settingDefinition("zoneAtmosphereStrength").fallback, 100);
  assert.equal("experimentalZoneAtmosphere" in ENHANCED_GRAPHICS_OVERRIDES, false, "the preset leaves it to the player");
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalZoneAtmosphere, false);
  let off;
  const offRenderer = new Proxy({}, {
    get: (_, name) => (name === "setAtmosphereEffects" ? (profile) => { off = profile; } : () => undefined),
  });
  applyRendererGraphicsSettings(offRenderer, defaultSettings(), undefined);
  assert.equal(off.zoneAtmosphere, false, "a default account draws none of it");
  const section = SETTING_SECTIONS["Эффекты"].find((s) => s.ids.includes("experimentalZoneAtmosphere"));
  assert.equal(section.ids[section.ids.indexOf("experimentalZoneAtmosphere") + 1], "zoneAtmosphereStrength");
  let pushed;
  const renderer = new Proxy({}, {
    get: (_, name) => (name === "setAtmosphereEffects" ? (profile) => { pushed = profile; } : () => undefined),
  });
  const values = { ...defaultSettings(), experimentalZoneAtmosphere: true, zoneAtmosphereStrength: 150 };
  applyRendererGraphicsSettings(renderer, values, undefined);
  assert.equal(pushed.zoneAtmosphere, true);
  assert.equal(pushed.zoneStrength, 1.5);
});
