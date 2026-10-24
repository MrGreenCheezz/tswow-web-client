// 25.10 (7.51): Dalaran's street lamps light, ahead of their builds, in the cinematic profile. Owner, 25.10:
// «свет всё ещё подгружается только рядом с персонажем, хотя Штормград работает отлично». The city's lamps
// are `Dalaran_Sconce_Indoor_01/02/03.m2` doodads of `ND_Dalaran.wmo`, whose only light is two GLOWBALL
// particle emitters (drawn within the 90-yard effect range); the name gate took no sconce, so they had
// no pool, halo, far glow or prelit light at all.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import { fixtureNameCandidate, modelFixtureLights } from "../dist/code/browser/LocalLighting.js";
import { deriveLightTemplates } from "../dist/code/browser/LightTemplates.js";
import { LightTemplateCatalog } from "../dist/code/browser/LightTemplateCatalog.js";
import { fixtureLightSource } from "../dist/code/browser/FixtureLightSources.js";
import { decodeEnvironmentTile } from "../dist/code/browser/EnvironmentTileDecode.js";

const SCONCES = [
  "World\\Expansion02\\Doodads\\Dalaran\\Dalaran_Sconce_Indoor_01.m2",
  "World\\Expansion02\\Doodads\\Dalaran\\Dalaran_Sconce_Indoor_02.m2",
  "World\\Expansion02\\Doodads\\Dalaran\\Dalaran_Sconce_Indoor_03.m2",
];

const cache = new URL("../bench/cache/", import.meta.url);
const index = existsSync(new URL("index.json", cache)) ? JSON.parse(readFileSync(new URL("index.json", cache), "utf8")) : undefined;
const noCache = index ? false : "bench/cache/index.json is absent: run the benchmark once to populate the asset cache";

/** A cached `/visual/model` answer by model path, decoded, or undefined. */
function cachedModel(path) {
  for (const [url, entry] of Object.entries(index ?? {})) {
    const match = /^\/visual\/model\?path=([^&]+)&v=\d+$/.exec(url);
    if (!match || entry.status !== 200 || decodeURIComponent(match[1]).toLowerCase() !== path.toLowerCase()) continue;
    const data = readFileSync(new URL(entry.sha256, cache));
    return decodeWvm9(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return undefined;
}

test("7.51: a sconce passes the lamp catalog's name gate, an unlit one does not", () => {
  for (const name of SCONCES) assert.equal(fixtureNameCandidate(name), true, name);
  assert.equal(new LightTemplateCatalog(null).candidate(SCONCES[0]), true);
  assert.equal(fixtureNameCandidate("World\\Generic\\Sconce_Unlit01.m2"), false);
  assert.equal(fixtureNameCandidate("World\\Generic\\Sconce01_Off.m2"), false);
});

test("7.51: Dalaran's sconce lights by its glow emitters in the cinematic profile only", { skip: noCache }, (t) => {
  const found = SCONCES.map((name) => [name, cachedModel(name)]).filter(([, model]) => model);
  if (found.length === 0) return t.skip("no Dalaran sconce in the bench cache");
  for (const [name, model] of found) {
    // The faithful profile keeps its gate: no sconce there.
    assert.equal(modelFixtureLights(model, name, false).length, 0, `${name} faithful`);
    const lights = modelFixtureLights(model, name, true);
    assert.equal(lights.length, 2, `${name}: its two GLOWBALL emitters`);
    assert.ok(lights.every((light) => light.emitter && !light.batch), name);
    const templates = deriveLightTemplates(model, name);
    assert.equal(templates.length, 2, `${name} templates`);
    assert.ok(templates.every((template) => template.intensity > 0.05 && template.reach > 0 && !template.client), name);
  }
});

test("7.51: Dalaran's tiles name 43 open-air sconces that may light before they are built", { skip: noCache }, (t) => {
  const objects = new Map();
  for (const [url, entry] of Object.entries(index)) {
    if (!/^\/visual\/environment\/571\/\d+\/\d+\?v=7$/.test(url) || entry.status !== 200) continue;
    const data = readFileSync(new URL(entry.sha256, cache));
    for (const object of decodeEnvironmentTile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))) objects.set(object.id, object);
  }
  const dalaran = [...objects.values()].find((object) => object.kind === "wmo" && /\\ND_DALARAN\.WMO$/i.test(object.name));
  if (!dalaran) return t.skip("Dalaran's tiles are not in the bench cache");
  const doodads = [...objects.values()].filter((object) => object.id < 0 && Math.floor((-object.id - 1) / 1_000_000) === dalaran.id);
  const sconces = doodads.filter((object) => /dalaran_sconce_indoor_0[123]\.m2$/i.test(object.name));
  assert.equal(sconces.length, 229);
  // The prelit pass asks the catalog's gate, then the room filter (an open-air sconce is `interior: false`).
  const lit = sconces.filter((object) => fixtureNameCandidate(object.name) && fixtureLightSource(object, true, false));
  assert.equal(lit.length, 43);
  // The other 186 hang in rooms (MODR names only indoor groups; MODD room light): they stay dark.
  assert.equal(sconces.filter((object) => object.localLight !== undefined && object.interior === true).length, 186);
});
