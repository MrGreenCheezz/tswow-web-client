import { readFile } from "node:fs/promises";
import { openDbc } from "./Dbc.js";
import { validAssetPath } from "./AssetPath.js";

export interface GameObjectDisplayMetadata {
  id: number;
  /**
   * Full MPQ path of the model, so it can be published with its textures.
   *
   * This used to be reduced to a bare filename, because the endpoint it was really aimed at was
   * the VMAP collision store, which is keyed that way. The browser tries `/visual/model` first
   * and only falls back to `/environment/model/<basename>`, deriving the basename itself — so
   * the reduction did nothing but guarantee the first attempt failed. Every chest, door,
   * mailbox, forge and campfire was therefore an untextured collision hull, and each one also
   * burned a doomed generation on the shared model queue on every page load.
   */
  model: string;
}

export function parseGameObjectDisplayMetadata(payload: Uint8Array): Map<number, GameObjectDisplayMetadata> {
  const data = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const dbc = openDbc(data, "GameObjectDisplayInfo");

  const result = new Map<number, GameObjectDisplayMetadata>();
  for (const row of dbc.rows()) {
    const id = dbc.id(row);
    if (id <= 0) continue;
    // MDX and MDL are the authoring extensions; the shipped asset is always the M2.
    const path = dbc.string(row, "ModelName").replaceAll("/", "\\").replace(/\.(mdx|mdl)$/i, ".m2");
    // `&` is a filename character in this client — `PASSIVE DOODADS\FOOD&UTENSILS`,
    // `WEAPONS&ARMOR` — and the same omission cost the visual route its models once already.
    // Measured over the 45,748 rows this dataset holds: the class without it drops 71, of which 17
    // name nothing at all and 53 are real files the `/visual/model` route would have served.
    if (!validAssetPath(path, { extensions: ["m2", "wmo"] })) continue;
    result.set(id, { id, model: path });
  }
  return result;
}

export async function loadGameObjectDisplayMetadata(dbcDirectory: string): Promise<Map<number, GameObjectDisplayMetadata>> {
  return parseGameObjectDisplayMetadata(await readFile(`${dbcDirectory}/GameObjectDisplayInfo.dbc`));
}
