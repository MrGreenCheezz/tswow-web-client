import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function sourceModule(path) {
  const source = await read(path);
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("taxi routes use authored directed edges and reconstruct the cheapest valid path", async () => {
  const { reachableTaxiRoutes } = await sourceModule("src/browser/TaxiMetadata.ts");
  const catalog = {
    nodes: [
      { id: 1, mapId: 0, name: "Начало", x: 0, y: 0, z: 0, mountCreatureIds: [1, 2] },
      { id: 2, mapId: 0, name: "Пересадка", x: 1, y: 0, z: 0, mountCreatureIds: [1, 2] },
      { id: 3, mapId: 0, name: "Финиш", x: 2, y: 0, z: 0, mountCreatureIds: [1, 2] },
      { id: 4, mapId: 0, name: "Нет рейса", x: 3, y: 0, z: 0, mountCreatureIds: [1, 2] },
    ],
    paths: [
      { id: 10, from: 1, to: 2, cost: 5 },
      { id: 11, from: 2, to: 3, cost: 7 },
      { id: 12, from: 1, to: 3, cost: 30 },
      { id: 13, from: 3, to: 1, cost: 1 },
    ],
  };

  const routes = reachableTaxiRoutes(catalog, 1, [1, 2, 3, 4]);
  assert.deepEqual(routes.map(({ destination, nodes, cost }) => [destination.name, nodes, cost]), [
    ["Пересадка", [1, 2], 5],
    ["Финиш", [1, 2, 3], 12],
  ]);
  assert.deepEqual(reachableTaxiRoutes(catalog, 3, [1]).map(({ nodes }) => nodes), [[3, 1]],
    "TaxiPath is directed; the reverse route exists only when authored");
  assert.deepEqual(reachableTaxiRoutes(catalog, 1, [1, 3]).map(({ nodes, cost }) => [nodes, cost]), [
    [[1, 3], 30],
  ], "an undiscovered intermediate node must not become a hidden shortcut");
});

test("the gateway and native flight window are backed by TaxiNodes and TaxiPath metadata", async () => {
  const [gateway, metadata, npc, tables] = await Promise.all([
    read("src/gateway/Gateway.ts"),
    read("src/gateway/TaxiMetadata.ts"),
    read("src/browser/ui/Npc.ts"),
    read("tools/dbd-tables.mjs"),
  ]);
  assert.match(tables, /["']TaxiNodes["']/);
  assert.match(tables, /["']TaxiPath["']/);
  assert.match(metadata, /openDbcFile\(dbcDirectory,\s*["']TaxiNodes["']\)/);
  assert.match(metadata, /openDbcFile\(dbcDirectory,\s*["']TaxiPath["']\)/);
  assert.match(metadata, /SPELL_EFFECT_SEND_TAXI[\s\S]{0,1800}?cost\s*===\s*0\s*&&\s*scriptedPaths\.has\(id\)/,
    "script-owned quest rides must not leak into a regular flight master's route graph");
  assert.match(gateway, /pathname\s*===\s*["']\/dbc\/taxi["']/);
  assert.match(npc, /reachableTaxiRoutes\(catalog,\s*menu\.currentNode,\s*menu\.knownNodes\)/);
  assert.match(npc, /world\.takeTaxi\(menu\.guid,\s*route\.nodes\)/);
  assert.doesNotMatch(npc, /takeTaxi\(menu\.guid,\s*\[menu\.currentNode,\s*node\]\)/,
    "a discovered node is not proof that a direct TaxiPath edge exists");
});
