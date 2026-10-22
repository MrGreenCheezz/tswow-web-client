/**
 * 22.10 (6.26): display records (`/dbc/creature-models`) kept between sessions (PersistentAssetStore.ts), the way
 * the real client keeps `creaturecache.wdb`: a unit whose display was seen in an earlier session is answered from
 * the disk at once, and only the ids never seen under this generation go to the gateway.
 *
 * Filed under the gateway's `metadataGeneration` (gateway/AssetGeneration.ts: its code, the dataset's DBCs and
 * dumps, the archive chain) and the record shape (`CREATURE_MODEL_VERSION`), so any of those moving is a miss.
 * Only records the gateway returned are stored; an id it omitted (a negative answer) is asked again next session.
 */

import type { CreatureModelMetadata } from "../gateway/CreatureModelMetadata.js";
import { gatewayGenerationOrigin, gatewayMetadataGeneration } from "./GatewayGeneration.js";
import { persistentAssetStore, type PersistentAssetStore } from "./PersistentAssetStore.js";

export interface DisplayRowPersistence {
  /** The generation records are filed under now; taken before a request, so its answer is filed under it. */
  generation(): string | undefined;
  /** The stored records among `ids` under `generation`, unvalidated (the client validates them like an answer). */
  load(ids: readonly number[], generation: string | undefined): Promise<Map<number, unknown>>;
  /**
   * Stores records the gateway returned to a request made under `generation`: never under a later one, so a
   * record can be newer than its label but never older.
   */
  save(rows: readonly CreatureModelMetadata[], generation: string | undefined): void;
}

export interface DisplayPersistenceSources {
  readonly store: PersistentAssetStore | null;
  readonly generation: () => string | undefined;
  readonly gateway: () => string | undefined;
}

export function displayPersistKind(version: number): string {
  return `creature-display-v${version}`;
}

/** The persistence a CreatureModelClient uses, or undefined where there is no store. */
export function createDisplayRowPersistence(version: number,
  sources: Partial<DisplayPersistenceSources> = {}): DisplayRowPersistence | undefined {
  const store = sources.store !== undefined ? sources.store : persistentAssetStore();
  if (!store) return undefined;
  const generation = sources.generation ?? gatewayMetadataGeneration;
  const gateway = sources.gateway ?? gatewayGenerationOrigin;
  const kind = displayPersistKind(version);
  return {
    generation,
    async load(ids, current) {
      const found = new Map<number, unknown>();
      const origin = gateway();
      if (current === undefined || origin === undefined || ids.length === 0) return found;
      try {
        const values = await store.getMany<unknown>("rows", origin, kind, current, ids.map(String));
        values.forEach((value, index) => { if (value !== undefined) found.set(ids[index]!, value); });
      } catch {
        // Nothing stored is the same as nothing found.
      }
      return found;
    },
    save(rows, current) {
      const origin = gateway();
      if (current === undefined || origin === undefined || rows.length === 0) return;
      store.put("rows", origin, kind, current, rows.map((row) => [String(row.id), row] as const));
    },
  };
}
