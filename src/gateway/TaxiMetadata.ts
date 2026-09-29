import { openDbcFile } from "./Dbc.js";

const SPELL_EFFECT_SEND_TAXI = 123;
const SPELL_EFFECT_SLOTS = 3;

export interface TaxiNodeMetadata {
  id: number;
  mapId: number;
  x: number;
  y: number;
  z: number;
  name: string;
  mountCreatureIds: [number, number];
}

export interface TaxiPathMetadata {
  id: number;
  from: number;
  to: number;
  cost: number;
}

export interface TaxiMetadata {
  nodes: TaxiNodeMetadata[];
  paths: TaxiPathMetadata[];
}

/**
 * Reads the ordinary flight network the 3.3.5 client plots for a flight master.
 *
 * Zero-cost TaxiPath rows referenced by SPELL_EFFECT_SEND_TAXI are scripted quest rides. The
 * server deliberately removes those from its normal taxi-path set, so publishing them here would
 * make a regular flight-master button advertise a route the core will reject (or a script owns).
 */
export async function loadTaxiMetadata(dbcDirectory: string): Promise<TaxiMetadata> {
  const [nodeTable, pathTable, spellTable] = await Promise.all([
    openDbcFile(dbcDirectory, "TaxiNodes"),
    openDbcFile(dbcDirectory, "TaxiPath"),
    openDbcFile(dbcDirectory, "Spell"),
  ]);

  const scriptedPaths = new Set<number>();
  for (const row of spellTable.rows()) {
    for (let effect = 0; effect < SPELL_EFFECT_SLOTS; effect++) {
      if (spellTable.int(row, "Effect", effect) !== SPELL_EFFECT_SEND_TAXI) continue;
      const pathId = spellTable.int(row, "EffectMiscValue", effect);
      if (pathId > 0) scriptedPaths.add(pathId);
    }
  }

  const nodes: TaxiNodeMetadata[] = [];
  const nodeIds = new Set<number>();
  for (const row of nodeTable.rows()) {
    const id = nodeTable.id(row);
    if (id <= 0) continue;
    nodeIds.add(id);
    nodes.push({
      id,
      mapId: nodeTable.int(row, "ContinentID"),
      x: nodeTable.float(row, "Pos", 0),
      y: nodeTable.float(row, "Pos", 1),
      z: nodeTable.float(row, "Pos", 2),
      name: nodeTable.locstring(row, "Name_lang"),
      mountCreatureIds: [
        nodeTable.int(row, "MountCreatureID", 0),
        nodeTable.int(row, "MountCreatureID", 1),
      ],
    });
  }

  const paths: TaxiPathMetadata[] = [];
  for (const row of pathTable.rows()) {
    const id = pathTable.id(row);
    const from = pathTable.int(row, "FromTaxiNode");
    const to = pathTable.int(row, "ToTaxiNode");
    const cost = pathTable.int(row, "Cost");
    if (id <= 0 || from <= 0 || to <= 0 || !nodeIds.has(from) || !nodeIds.has(to)) continue;
    if (cost === 0 && scriptedPaths.has(id)) continue;
    paths.push({ id, from, to, cost });
  }

  nodes.sort((left, right) => left.id - right.id);
  paths.sort((left, right) => left.id - right.id);
  return { nodes, paths };
}
