// 24.10 (7.50): a building's lamp table (src/world/WmoLampTable.ts) — the lamp posts of a WMO's open-air groups, built
// by the gateway from the artifact it published so the browser lights a city's lamp posts with the building's root.
// The finder is the one the browser runs on a group that arrives without a table (WmoOpenAirLamps.ts), so a table and
// a group read give the same lanterns; the few WWM fields the gateway reads are held equal to the browser's decoder.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { decodeWwm, decodeWwmGroup } from "../dist/code/browser/WmoModel.js";
import { WMO_MATERIAL_SIDN } from "../dist/code/browser/WmoMaterials.js";
import { findWmoLanterns as clientFinder, wmoGroupOpenAir } from "../dist/code/browser/WmoOpenAirLamps.js";
import {
  WMO_GROUP_OPEN_AIR, WMO_RUN_SIDN, buildWmoLampTable, findWmoLanterns, parseWmoLampTable, readWwmLampGroups, readWwmLampMesh,
} from "../dist/code/world/WmoLampTable.js";
import { buffer, syntheticCity } from "./fixtures/wmo-lamp-city.mjs";

const cache = new URL("../bench/cache/", import.meta.url);
const noCache = existsSync(new URL("index.json", cache))
  ? false : "bench/cache/index.json is absent: run the benchmark once to populate the asset cache";
const STORMWIND = "WORLD\\WMO\\AZEROTH\\BUILDINGS\\STORMWIND\\STORMWIND.WMO";

test("the shared module is the browser's finder and the browser's open-air and SIDN rules", () => {
  assert.equal(clientFinder, findWmoLanterns, "WmoOpenAirLamps re-exports the one finder");
  assert.equal(WMO_RUN_SIDN, WMO_MATERIAL_SIDN);
  assert.equal(WMO_GROUP_OPEN_AIR, 0x48);
  assert.equal(wmoGroupOpenAir({ flags: 0x2a41 }), true);
  assert.equal(wmoGroupOpenAir({ flags: 0x2a05 }), false);
});

test("a table lists every open-air group with triangles and the lanterns each holds; rooms and windows give none", async () => {
  const { root, files } = syntheticCity();
  const asked = [];
  const table = await buildWmoLampTable(buffer(root), async (index) => { asked.push(index); return buffer(files.get(index)); });
  assert.deepEqual(asked, [0, 2, 3], "only open-air groups are read, and the one the root carries is not");
  assert.equal(table.version, 1);
  assert.equal(table.groupCount, 4);
  assert.deepEqual(table.groups.map(([index]) => index), [0, 2, 3], "the shop (1) is not open air");
  const rounded = (values) => values.map((value) => Math.round(value * 100) / 100);
  assert.deepEqual(rounded(table.groups[0][1]), [10, 20, 5], "the street's lantern, not its window");
  assert.deepEqual(table.groups[1][1], [], "the canal's lantern-shaped panes without the night glow are none");
  assert.deepEqual(table.groups[2][1], []);
  // Exactly what the browser's decoder and finder make of the same bytes.
  const decoded = decodeWwm(buffer(root), "");
  for (const [index, positions] of table.groups) {
    const mesh = decoded.groups[index].mesh ?? decodeWwmGroup(buffer(files.get(index))).mesh;
    assert.deepEqual(positions, Array.from(clientFinder(mesh)));
  }
  // The JSON carries them exactly (float32 values as doubles).
  assert.deepEqual(parseWmoLampTable(JSON.parse(JSON.stringify(table))), JSON.parse(JSON.stringify(table)));
});

test("a group file that is another group's, or missing, fails the table instead of misplacing lamps", async () => {
  const { root, files } = syntheticCity();
  await assert.rejects(buildWmoLampTable(buffer(root), async (index) => buffer(files.get(index === 0 ? 2 : index))), /does not match/);
  await assert.rejects(buildWmoLampTable(buffer(root), async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }),
    /gone/);
  assert.throws(() => readWwmLampGroups(new ArrayBuffer(8)), /truncated/);
});

test("a table body that is not one is refused", () => {
  const good = { version: 1, groupCount: 3, groups: [[0, [1, 2, 3]], [2, []]] };
  assert.ok(parseWmoLampTable(good));
  for (const bad of [
    null, [], { ...good, version: 2 }, { ...good, groupCount: 0 }, { ...good, groupCount: 1.5 },
    { ...good, groups: [[3, []]] }, { ...good, groups: [[1, []], [1, []]] }, { ...good, groups: [[2, []], [0, []]] },
    { ...good, groups: [[0, [1, 2]]] }, { ...good, groups: [[0, [1, 2, "3"]]] }, { ...good, groups: [[0, [1, 2, null]]] },
    { ...good, groups: [[0]] }, { ...good, groups: [[-1, []]] },
  ]) assert.equal(parseWmoLampTable(bad), undefined, JSON.stringify(bad));
});

/** Every cached WMO root with all of its open-air groups' blocks: [path, root bytes, group bytes by index]. */
function cachedWmos() {
  const index = JSON.parse(readFileSync(new URL("index.json", cache), "utf8"));
  const blob = (key) => {
    const entry = index[key];
    return entry?.status === 200 ? buffer(readFileSync(new URL(entry.sha256, cache))) : undefined;
  };
  const out = [];
  for (const key of Object.keys(index)) {
    if (!key.startsWith("/visual/model?") || key.includes("&group=")) continue;
    const url = new URL(key, "http://cache");
    const path = url.searchParams.get("path");
    if (!/\.wmo$/i.test(path ?? "")) continue;
    const root = blob(key);
    if (!root) continue;
    const groupKey = (group) => `/visual/model?path=${encodeURIComponent(path)}&group=${group}&v=${url.searchParams.get("v")}`;
    out.push({ path, root, group: (group) => blob(groupKey(group)) });
  }
  return out;
}

test("the gateway's WWM reading equals the browser's decoder on every cached artifact", { skip: noCache }, () => {
  let roots = 0, blocks = 0;
  for (const { root, group } of cachedWmos()) {
    const decoded = decodeWwm(root, "");
    const read = readWwmLampGroups(root);
    assert.equal(read.length, decoded.groups.length);
    for (const [index, entry] of read.entries()) {
      const full = decoded.groups[index];
      assert.equal(entry.flags, full.flags);
      assert.equal(entry.triangleCount, full.triangleCount);
      assert.equal(entry.vertexCount, full.vertexCount);
      assert.equal(entry.block !== undefined, full.mesh !== undefined);
      const bytes = entry.block ?? group(index);
      if (!bytes) continue;
      const mesh = readWwmLampMesh(bytes);
      const reference = decodeWwmGroup(bytes);
      assert.equal(mesh.index, reference.index);
      assert.deepEqual(mesh.mesh.positions, reference.mesh.positions);
      assert.deepEqual(mesh.mesh.indices, reference.mesh.indices);
      assert.deepEqual(mesh.mesh.runs, reference.mesh.runs.map(({ start, count, materialFlags }) => ({ start, count, materialFlags })));
      blocks++;
    }
    roots++;
  }
  assert.ok(roots > 50 && blocks > 500, `${roots} roots, ${blocks} blocks`);
});

test("on the cached WMOs a table holds what the browser finds group by group: Stormwind's 215 lamp posts, no window",
  { skip: noCache }, async () => {
    let lanterns = 0, complete = 0;
    const holders = new Set();
    let stormwind;
    for (const { path, root, group } of cachedWmos()) {
      const decoded = decodeWwm(root, "");
      const open = decoded.groups.map((entry, index) => [entry, index])
        .filter(([entry]) => wmoGroupOpenAir(entry) && entry.triangleCount > 0);
      if (open.some(([entry, index]) => !entry.mesh && !group(index))) {
        if (path.toUpperCase() === STORMWIND) stormwind = "incomplete";
        continue;
      }
      const table = await buildWmoLampTable(root, async (index) => group(index));
      // The browser's way: each open-air group's mesh, decoded and searched as it arrives.
      const expected = open.map(([entry, index]) => [index, Array.from(clientFinder(entry.mesh ?? decodeWwmGroup(group(index)).mesh))]);
      assert.deepEqual(table.groups, expected, path);
      const count = table.groups.reduce((sum, [, positions]) => sum + positions.length / 3, 0);
      if (count > 0) holders.add(path.toUpperCase());
      if (path.toUpperCase() === STORMWIND) stormwind = count;
      lanterns += count;
      complete++;
    }
    assert.ok(complete > 50, `${complete} complete WMOs`);
    if (stormwind === "incomplete") {
      // The bench streams a city's groups as it needs them; until a run has asked for every open-air group the
      // census stops at the WMOs it holds whole.
      assert.equal(lanterns, 0, "no other cached WMO holds a lantern");
      return;
    }
    assert.equal(stormwind, 215, "the 7.46 census: Stormwind's lamp posts");
    assert.deepEqual([...holders], [STORMWIND], "and none of the ~5,000 window pieces of the other WMOs");
  });
