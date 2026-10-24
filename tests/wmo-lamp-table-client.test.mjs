// 24.10 (7.50): the browser half of the buildings' lamp tables (WmoLampTableClient.ts, LightTemplateCatalog.ts,
// PrelitLights.ts). With the table a city's lamp posts are lit when its root is in — at the curtain's lift on a first
// visit — before any of its groups arrives; the curtain waits for the table's first answer; and with a gateway that
// has no route (404), or one that fails, everything is as before: the lamp posts come with their groups.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { FarLightGlows, farLightSources } from "../dist/code/browser/FarLightGlows.js";
import { LightTemplateCatalog } from "../dist/code/browser/LightTemplateCatalog.js";
import { PrelitLights } from "../dist/code/browser/PrelitLights.js";
import { decodeWwm, decodeWwmGroup } from "../dist/code/browser/WmoModel.js";
import { wmoLanterns } from "../dist/code/browser/WmoOpenAirLamps.js";
import {
  LAMP_TABLE_NONE, LAMP_TABLE_PENDING, WmoLampTableClient, wmoLampTableUrl,
} from "../dist/code/browser/WmoLampTableClient.js";
import { buildWmoLampTable } from "../dist/code/world/WmoLampTable.js";
import { buffer, syntheticCity } from "./fixtures/wmo-lamp-city.mjs";

const CITY = "World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo";
const BASE = "http://127.0.0.1:8090";
const KEY = CITY.toLowerCase();

/** The city's placement as a tile lists it, and the renderer's host with its root in or not. */
const building = { id: 10047, kind: "wmo", name: CITY, x: 0, y: 0, z: 0, bounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 } };
const host = (rootIn) => ({ place: (object, target) => target.identity(), openAir: () => undefined, built: () => false,
  buildingKnown: () => rootIn() });

/** A fetch whose answers the test hands out one at a time. */
function scriptedFetch() {
  const calls = [];
  const fetchImpl = (url) => new Promise((resolve, reject) => calls.push({ url, resolve, reject }));
  return { calls, fetchImpl };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The city's root as the browser decodes it: the shop's group came with it, the street and canal did not. */
async function cityRoot() {
  const { root, files } = syntheticCity();
  const table = await buildWmoLampTable(buffer(root), async (index) => buffer(files.get(index)));
  return { model: decodeWwm(buffer(root), ""), files, table };
}

test("a table lights the city's lamp posts with its root, before any of its groups; the curtain waits for its answer", async () => {
  const { model, files, table } = await cityRoot();
  const { calls, fetchImpl } = scriptedFetch();
  const tables = new WmoLampTableClient(BASE, fetchImpl);
  const catalog = new LightTemplateCatalog(null);
  const prelit = new PrelitLights();
  let rootIn = false;
  // A tile lists the city: its table is asked for at once, before its root.
  prelit.update([building], catalog, host(() => rootIn), new THREE.Vector3());
  catalog.pump(undefined, tables);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, wmoLampTableUrl(BASE, CITY));
  assert.match(calls[0].url, /\/visual\/wmo-lamps\?path=World%5Cwmo%5CAzeroth%5CBuildings%5CStormwind%5CStormwind\.wmo&v=1/);
  rootIn = true;
  assert.equal(prelit.pendingNear(catalog, host(() => rootIn), 0, 0, 150), 1, "root in, table on its way: the curtain waits");
  calls[0].resolve(json(200, JSON.parse(JSON.stringify(table))));
  await settle();
  catalog.pump(undefined, tables);
  assert.equal(prelit.pendingNear(catalog, host(() => rootIn), 0, 0, 150), 0, "both known");
  assert.equal(catalog.lampTable(CITY)?.groupCount, 4);
  // The light pass's `syncWmo` seeds the table into the root: the street's lamp post, never the shop's.
  assert.equal(wmoLanterns(model).positions.length, 0, "without the table nothing is found: no group has come");
  catalog.syncWmo(CITY, model);
  const lanterns = wmoLanterns(model);
  assert.deepEqual([...lanterns.positions].map((value) => Math.round(value * 100) / 100), [10, 20, 5]);
  // A far glow at once, as for a lamp found in a group's mesh.
  const placement = { source: building, node: new THREE.Object3D(), wmo: { model, modelToWorld: new THREE.Matrix4() } };
  assert.equal(farLightSources(placement).length, 8); // 24.10 (7.50): FAR_LIGHT_STRIDE
  const glows = new FarLightGlows();
  for (let frame = 0; frame < 40; frame++) glows.update(new Map([[building.id, placement]]), new THREE.Vector3(0, 0, -150), 0);
  assert.equal(glows.sourceCount, 1);
  // When the street's group arrives it is not read again: the lamp post is not doubled.
  model.groups[0].mesh = decodeWwmGroup(buffer(files.get(0))).mesh;
  assert.equal(wmoLanterns(model).positions.length, 3);
  // Asked once per city, however many tiles list it.
  prelit.update([{ ...building, id: 10048 }], catalog, host(() => rootIn), new THREE.Vector3());
  catalog.pump(undefined, tables);
  assert.equal(calls.length, 1);
  assert.equal(tables.stats.tables, 1);
});

test("an older gateway (404): no table, the curtain is not held, the lamp posts come with their groups as before", async () => {
  const { model, files } = await cityRoot();
  const { calls, fetchImpl } = scriptedFetch();
  const tables = new WmoLampTableClient(BASE, fetchImpl);
  const catalog = new LightTemplateCatalog(null);
  const prelit = new PrelitLights();
  prelit.update([building], catalog, host(() => true), new THREE.Vector3());
  catalog.pump(undefined, tables);
  calls[0].resolve(json(404));
  await settle();
  catalog.pump(undefined, tables);
  assert.equal(prelit.pendingNear(catalog, host(() => true), 0, 0, 150), 0);
  assert.equal(tables.lookup(KEY, CITY), LAMP_TABLE_NONE);
  assert.equal(tables.settled(KEY), true, "final: not asked again this session");
  catalog.syncWmo(CITY, model);
  assert.equal(wmoLanterns(model).positions.length, 0, "nothing before the street's group");
  model.groups[0].mesh = decodeWwmGroup(buffer(files.get(0))).mesh;
  assert.equal(wmoLanterns(model).positions.length, 3, "found in the group's mesh, as before");
  for (let frame = 0; frame < 30; frame++) catalog.pump(undefined, tables);
  assert.equal(calls.length, 1, "one request, never repeated");
});

test("a failing gateway: the curtain is not held while the table is retried on the 2 s / 8 s / 30 s ladder", async () => {
  const { table } = await cityRoot();
  const { calls, fetchImpl } = scriptedFetch();
  let now = 0;
  const tables = new WmoLampTableClient(BASE, fetchImpl, () => now);
  const catalog = new LightTemplateCatalog(null);
  const prelit = new PrelitLights();
  prelit.update([building], catalog, host(() => true), new THREE.Vector3());
  catalog.pump(undefined, tables);
  assert.equal(tables.lookup(KEY, CITY), LAMP_TABLE_PENDING);
  calls[0].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(prelit.pendingNear(catalog, host(() => true), 0, 0, 150), 0, "a failure does not hold the curtain");
  catalog.pump(undefined, tables);
  assert.equal(calls.length, 1, "not before the retry is due");
  now = 2_001;
  catalog.pump(undefined, tables);
  assert.equal(calls.length, 2);
  assert.equal(prelit.pendingNear(catalog, host(() => true), 0, 0, 150), 0, "the retry does not hold it either");
  calls[1].resolve(json(500));
  await settle();
  now = 10_002;
  catalog.pump(undefined, tables);
  calls[2].resolve(json(200, JSON.parse(JSON.stringify(table))));
  await settle();
  catalog.pump(undefined, tables);
  assert.equal(catalog.lampTable(CITY)?.groups.length, 3, "a later answer still lights the city");
});

test("a table for another generation of the model, or a body that is not one, is not seeded", async () => {
  const { model, table } = await cityRoot();
  const { calls, fetchImpl } = scriptedFetch();
  const tables = new WmoLampTableClient(BASE, fetchImpl);
  const catalog = new LightTemplateCatalog(null);
  catalog.wantLampTable(CITY);
  catalog.pump(undefined, tables);
  calls[0].resolve(json(200, { ...JSON.parse(JSON.stringify(table)), groupCount: 5 }));
  await settle();
  catalog.pump(undefined, tables);
  catalog.syncWmo(CITY, model);
  assert.equal(wmoLanterns(model).positions.length, 0, "five groups named, four in the root: ignored");

  const other = new WmoLampTableClient(BASE, async () => json(200, { version: 1, groupCount: 4, groups: [[9, []]] }));
  assert.equal(other.lookup(KEY, CITY), LAMP_TABLE_PENDING);
  await settle();
  assert.equal(other.lookup(KEY, CITY), LAMP_TABLE_NONE);
  assert.equal(other.settled(KEY), true);
});
