/**
 * A small, best-effort head start for assets the current session is likely to use first.
 *
 * This deliberately does not own another cache. Models still enter `EnvironmentClient`, metadata
 * still enters its existing clients, and texture responses are consumed only so the browser HTTP
 * cache and the gateway's disk cache can answer the real renderer later. Nothing here creates an
 * ImageBitmap, a three.js Texture or a GPU allocation.
 */

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import {
  ACTION_BUTTON_SPELL, type ActionButton,
} from "../world/ActionBarProtocol.js";
import type { CharacterAppearance } from "../gateway/CharacterAppearance.js";
import type { SpellVisualMetadata } from "../gateway/SpellVisual.js";
import type { WorldObjectState } from "../world/WorldState.js";
import type { ItemMetadataClient } from "./ItemMetadata.js";
import type { CreatureModelClient, EquippedItem } from "./CreatureModelClient.js";
import type { SpellVisualClient } from "./SpellVisualClient.js";
import type { EnvironmentClient, EnvironmentModel, EnvironmentObject, ModelLoadPriority } from "./Terrain.js";
import { layerPaths } from "./CharacterAtlas.js";
import { modelOwnTexturePaths, textureUrl } from "./Wvm.js";

export const ASSET_WARMUP_BUDGET = {
  sceneryModels: 6,
  playerModels: 8,
  spellIds: 24,
  spellModels: 12,
  textures: 24,
  playerTextures: 12,
  spellTextures: 8,
  sceneryTextures: 4,
  textureConcurrency: 2,
} as const;

/** Enough for cold metadata to arrive, without turning the whole session into speculative work. */
export const ASSET_WARMUP_SOFT_WINDOW_MS = 5_000;
/** Give self/action-bar metadata a chance to enqueue before background scenery occupies four slots. */
const SCENERY_GRACE_MS = 750;

export type WarmFetchPriority = "scenery" | "spell" | "player";

const WARM_FETCH_PRIORITY: Readonly<Record<WarmFetchPriority, number>> = {
  scenery: 0,
  spell: 1,
  player: 2,
};

type WarmResponse = { ok: boolean; arrayBuffer(): Promise<ArrayBuffer> };
export type WarmFetch = (url: string, init: { signal: AbortSignal }) => Promise<WarmResponse>;

/**
 * A response-only queue: bounded URL ledger, bounded concurrency, no decoded object retention.
 * Exported because its hard limits are important enough to test directly.
 */
export class BoundedWarmFetchQueue {
  readonly #fetcher: WarmFetch;
  readonly #budget: number;
  readonly #concurrency: number;
  readonly #seen = new Set<string>();
  /** Queued URL -> its highest requested category. Map order is FIFO within a category. */
  readonly #queue = new Map<string, WarmFetchPriority>();
  readonly #controller = new AbortController();
  readonly #idleWaiters = new Set<() => void>();
  #active = 0;
  #drainScheduled = false;
  #closed = false;

  constructor(
    fetcher: WarmFetch = (url, init) => fetch(url, init),
    budget = ASSET_WARMUP_BUDGET.textures,
    concurrency = ASSET_WARMUP_BUDGET.textureConcurrency,
  ) {
    this.#fetcher = fetcher;
    this.#budget = finiteWhole(budget, ASSET_WARMUP_BUDGET.textures, 0, ASSET_WARMUP_BUDGET.textures);
    this.#concurrency = finiteWhole(
      concurrency,
      ASSET_WARMUP_BUDGET.textureConcurrency,
      1,
      ASSET_WARMUP_BUDGET.textureConcurrency,
    );
  }

  /** Adds unseen URLs and promotes queued duplicates without spending another budget entry. */
  add(urls: Iterable<string>, priority: WarmFetchPriority = "scenery"): number {
    if (this.#closed) return 0;
    let added = 0;
    for (const url of urls) {
      if (!url) continue;
      if (this.#seen.has(url)) {
        const queued = this.#queue.get(url);
        if (queued !== undefined && WARM_FETCH_PRIORITY[priority] > WARM_FETCH_PRIORITY[queued]) {
          this.#queue.set(url, priority);
        }
        continue;
      }
      if (this.#seen.size >= this.#budget) continue;
      this.#seen.add(url);
      this.#queue.set(url, priority);
      added++;
    }
    this.#scheduleDrain();
    return added;
  }

  get accepted(): number {
    return this.#seen.size;
  }

  /** Test/diagnostic barrier only; world entry never awaits it. */
  waitForIdle(): Promise<void> {
    if (this.#active === 0 && this.#queue.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.clear();
    this.#controller.abort();
    this.#notifyIdle();
  }

  /** Batch one JavaScript turn so late player work can precede scenery from that same turn. */
  #scheduleDrain(): void {
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    while (!this.#closed && this.#active < this.#concurrency) {
      const url = this.#next();
      if (url === undefined) break;
      this.#active++;
      void this.#consume(url).finally(() => {
        this.#active--;
        this.#scheduleDrain();
        this.#notifyIdle();
      });
    }
    this.#notifyIdle();
  }

  #next(): string | undefined {
    let selected: string | undefined;
    let selectedPriority = -1;
    for (const [url, priority] of this.#queue) {
      const rank = WARM_FETCH_PRIORITY[priority];
      if (rank <= selectedPriority) continue;
      selected = url;
      selectedPriority = rank;
    }
    if (selected !== undefined) this.#queue.delete(selected);
    return selected;
  }

  async #consume(url: string): Promise<void> {
    try {
      const response = await this.#fetcher(url, { signal: this.#controller.signal });
      // A successful body has to be consumed for the browser HTTP cache to retain the response.
      // The ArrayBuffer is deliberately not stored and becomes collectible immediately.
      if (response.ok) await response.arrayBuffer();
    } catch {
      // Warm-up is optional. The real renderer keeps its ordinary retry/error path.
    }
  }

  #notifyIdle(): void {
    if (this.#active !== 0 || this.#queue.size !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}

function finiteWhole(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

/** First occurrence wins, up to an explicit limit. */
export function boundedUnique<T>(values: Iterable<T>, limit: number): T[] {
  const result: T[] = [];
  const seen = new Set<T>();
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
  if (maximum === 0) return result;
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= maximum) break;
  }
  return result;
}

/** Occupied spell slots in server slot order; macros and items cannot have spell VFX. */
export function actionBarWarmSpellIds(buttons: readonly ActionButton[], limit = ASSET_WARMUP_BUDGET.spellIds): number[] {
  return boundedUnique(
    [...buttons]
      .filter((button) => button.type === ACTION_BUTTON_SPELL && button.action > 0)
      .sort((left, right) => left.slot - right.slot)
      .map((button) => button.action),
    limit,
  );
}

/** Authored model paths in the order a normal cast is most likely to need them. */
export function spellVisualModelPaths(visual: SpellVisualMetadata): string[] {
  const paths: string[] = [];
  for (const phase of [
    visual.precast, visual.cast, visual.channel, visual.missileTargeting,
    visual.missile, visual.impact, visual.casterImpact, visual.targetImpact,
    visual.instantArea, visual.impactArea, visual.persistentArea, visual.state, visual.stateDone,
  ]) {
    if (!phase) continue;
    if ("path" in phase) paths.push(phase.path);
    else for (const effect of phase.effects) paths.push(effect.path);
  }
  return boundedUnique(paths.filter(Boolean), paths.length);
}

/** Nearest distinct scenery paths, using a WMO's box rather than its often-distant origin. */
export function nearestSceneryModelPaths(
  objects: readonly EnvironmentObject[],
  at: { x: number; y: number },
  limit = ASSET_WARMUP_BUDGET.sceneryModels,
): string[] {
  const nearest = new Map<string, number>();
  for (const object of objects) {
    if (!object.name) continue;
    const distance = object.bounds
      ? boxDistance(object.bounds, at.x, at.y)
      : Math.hypot(object.x - at.x, object.y - at.y);
    if (distance < (nearest.get(object.name) ?? Number.POSITIVE_INFINITY)) nearest.set(object.name, distance);
  }
  return [...nearest]
    .sort((left, right) => left[1] - right[1])
    .slice(0, Math.max(0, Math.trunc(limit)))
    .map(([path]) => path);
}

function boxDistance(box: { minX: number; minY: number; maxX: number; maxY: number }, x: number, y: number): number {
  return Math.hypot(Math.max(box.minX - x, 0, x - box.maxX), Math.max(box.minY - y, 0, y - box.maxY));
}

function visibleItems(player: WorldObjectState): Array<{ slot: number; entry: number }> {
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  const result: Array<{ slot: number; entry: number }> = [];
  for (let slot = 0; slot < 19; slot++) {
    const entry = player.fields.get(first + slot * stride) ?? 0;
    if (entry > 0) result.push({ slot, entry });
  }
  return result;
}

function appearanceTextures(appearance: CharacterAppearance): string[] {
  const paths = appearance.body.map((layer) => layerPaths(layer)[0] ?? "");
  paths.push(appearance.hair, appearance.cloak, appearance.skinExtra ?? "");
  for (const attached of appearance.attached) paths.push(attached.texture);
  return boundedUnique(paths.filter(Boolean), paths.length);
}

function modelTextureUrls(model: EnvironmentModel, baseUrl: string): string[] {
  const urls = [model.textureUrl ?? "", ...(model.textureUrls ?? []), ...(model.wmo?.textureUrls ?? [])];
  if (model.wvm) {
    for (const path of modelOwnTexturePaths(model.wvm)) urls.push(textureUrl(baseUrl, path));
  }
  return boundedUnique(urls.filter(Boolean), urls.length);
}

export interface AssetWarmupClients {
  environment: EnvironmentClient;
  creatureModels: CreatureModelClient;
  itemMetadata: ItemMetadataClient;
  spellVisuals: SpellVisualClient;
}

export interface AssetWarmupFrame {
  player: WorldObjectState;
  environment: readonly EnvironmentObject[];
  actionButtons: readonly ActionButton[];
}

/**
 * Lifetime-bounded controller for one world session. `tick` is synchronous and cheap after each
 * category fills; every network operation it starts remains fire-and-forget.
 */
export class SessionAssetWarmup {
  readonly #clients: AssetWarmupClients;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #textures: BoundedWarmFetchQueue;
  readonly #playerModels = new Set<string>();
  readonly #spellIds = new Set<number>();
  readonly #spellModels = new Set<string>();
  readonly #sceneryModels = new Set<string>();
  readonly #modelsWithTextures = new Set<string>();
  /** Lifetime unique URL ledger, mirroring the fetch queue's fixed total budget. */
  readonly #textureUrls = new Set<string>();
  readonly #textureCategories = new Map<string, WarmFetchPriority>();
  readonly #playerTextures = new Set<string>();
  readonly #spellTextures = new Set<string>();
  readonly #sceneryTextures = new Set<string>();
  /** Entries with a request currently in flight, or metadata already present. */
  readonly #itemsAsked = new Set<number>();
  #actionButtons: readonly ActionButton[] | undefined;
  #sceneryEnvironment: readonly EnvironmentObject[] | undefined;
  #closed = false;

  constructor(
    clients: AssetWarmupClients,
    options: { now?: () => number; fetcher?: WarmFetch } = {},
  ) {
    this.#clients = clients;
    this.#now = options.now ?? (() => performance.now());
    this.#startedAt = this.#now();
    this.#textures = new BoundedWarmFetchQueue(options.fetcher);
  }

  tick(frame: AssetWarmupFrame): void {
    if (this.#closed) return;
    const now = this.#now();
    if (now - this.#startedAt > ASSET_WARMUP_SOFT_WINDOW_MS) return;

    this.#warmPlayer(frame.player);
    this.#warmSpells(frame.actionButtons);
    // Background scenery is held briefly so a cold display/visual metadata response can put self
    // and action-bar models into the same microtask-batched priority queue first.
    if (now - this.#startedAt >= SCENERY_GRACE_MS
      && this.#sceneryModels.size < ASSET_WARMUP_BUDGET.sceneryModels
      && frame.environment !== this.#sceneryEnvironment) {
      this.#sceneryEnvironment = frame.environment;
      this.#addModels(
        this.#sceneryModels,
        nearestSceneryModelPaths(frame.environment, frame.player.position ?? { x: 0, y: 0 }),
        ASSET_WARMUP_BUDGET.sceneryModels,
      );
    }

    this.#probeModels(
      this.#playerModels, "critical", this.#playerTextures, ASSET_WARMUP_BUDGET.playerTextures, "player",
    );
    this.#probeModels(
      this.#spellModels, "normal", this.#spellTextures, ASSET_WARMUP_BUDGET.spellTextures, "spell",
    );
    this.#probeModels(
      this.#sceneryModels, "background", this.#sceneryTextures, ASSET_WARMUP_BUDGET.sceneryTextures, "scenery",
    );
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#textures.close();
  }

  #warmPlayer(player: WorldObjectState): void {
    const displayId = player.fields.get(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset) ?? 0;
    if (displayId <= 0) return;
    this.#clients.creatureModels.request(displayId);
    // The mount is a second model of the same size class as the character's own, and the frame it
    // has to be ready for is the one the player presses the button on. `request` ignores a zero.
    const mountDisplayId = player.fields.get(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset) ?? 0;
    this.#clients.creatureModels.request(mountDisplayId);
    const mount = mountDisplayId > 0 ? this.#clients.creatureModels.get(mountDisplayId) : undefined;
    if (mount) this.#addModels(this.#playerModels, [mount.model], ASSET_WARMUP_BUDGET.playerModels);

    const worn = visibleItems(player);
    const itemsToAsk: number[] = [];
    for (const entry of boundedUnique(worn.map(({ entry: value }) => value), worn.length)) {
      if (this.#clients.itemMetadata.get(entry)) {
        this.#itemsAsked.add(entry);
      } else if (!this.#itemsAsked.has(entry)) itemsToAsk.push(entry);
    }
    if (itemsToAsk.length > 0) {
      for (const entry of itemsToAsk) this.#itemsAsked.add(entry);
      void this.#clients.itemMetadata.load(itemsToAsk).then(() => {
        // `ItemMetadataClient.load` owns its retry cooldown. Leave resolved entries alone, but
        // re-arm an unanswered/failing one so a later warm-up tick can invoke that policy again.
        for (const entry of itemsToAsk) {
          if (!this.#clients.itemMetadata.get(entry)) this.#itemsAsked.delete(entry);
        }
      }).catch(() => {
        for (const entry of itemsToAsk) this.#itemsAsked.delete(entry);
      });
    }

    const metadata = this.#clients.creatureModels.get(displayId);
    if (!metadata) return;
    this.#addModels(this.#playerModels, [metadata.model], ASSET_WARMUP_BUDGET.playerModels);
    if (player.typeId !== 4) return;

    const equipment: EquippedItem[] = [];
    for (const { slot, entry } of worn) {
      const item = this.#clients.itemMetadata.get(entry);
      // Wait for the complete outfit: asking with a partial list creates and retains a second,
      // obsolete appearance while the remaining item rows arrive.
      if (!item) return;
      if (item.displayId > 0) equipment.push({ slot, inventoryType: item.inventoryType, displayId: item.displayId });
    }

    const bytes = player.fields.get(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset) ?? 0;
    const look = player.fields.get(UPDATE_FIELDS.PLAYER_BYTES.offset) ?? 0;
    const look2 = player.fields.get(UPDATE_FIELDS.PLAYER_BYTES_2.offset) ?? 0;
    const appearance = this.#clients.creatureModels.playerAppearance(
      bytes & 0xff, (bytes >>> 16) & 0xff,
      look & 0xff, (look >>> 8) & 0xff, (look >>> 16) & 0xff, (look >>> 24) & 0xff,
      look2 & 0xff, equipment,
    );
    if (!appearance) return;
    this.#addModels(
      this.#playerModels,
      appearance.attached.map((item) => item.model),
      ASSET_WARMUP_BUDGET.playerModels,
    );
    this.#addTextures(
      this.#playerTextures,
      appearanceTextures(appearance).map((path) => textureUrl(this.#clients.environment.baseUrl, path)),
      ASSET_WARMUP_BUDGET.playerTextures,
      "player",
    );
  }

  #warmSpells(buttons: readonly ActionButton[]): void {
    if (this.#spellIds.size < ASSET_WARMUP_BUDGET.spellIds && buttons !== this.#actionButtons) {
      this.#actionButtons = buttons;
      this.#addValues(this.#spellIds, actionBarWarmSpellIds(buttons), ASSET_WARMUP_BUDGET.spellIds);
    }
    if (this.#spellModels.size >= ASSET_WARMUP_BUDGET.spellModels) return;
    for (const id of this.#spellIds) {
      const visual = this.#clients.spellVisuals.get(id);
      if (!visual) continue;
      this.#addModels(this.#spellModels, spellVisualModelPaths(visual), ASSET_WARMUP_BUDGET.spellModels);
      if (this.#spellModels.size >= ASSET_WARMUP_BUDGET.spellModels) return;
    }
  }

  #probeModels(
    paths: ReadonlySet<string>, priority: ModelLoadPriority, textureCategory: Set<string>, textureLimit: number,
    texturePriority: WarmFetchPriority,
  ): void {
    for (const path of paths) {
      if (this.#modelsWithTextures.has(path)) continue;
      const model = this.#clients.environment.model(path, priority);
      if (!model) continue;
      this.#modelsWithTextures.add(path);
      this.#addTextures(
        textureCategory, modelTextureUrls(model, this.#clients.environment.baseUrl), textureLimit, texturePriority,
      );
    }
  }

  #addTextures(
    category: Set<string>, urls: Iterable<string>, limit: number, priority: WarmFetchPriority,
  ): void {
    const accepted: string[] = [];
    for (const url of urls) {
      if (!url) continue;
      const previous = this.#textureCategories.get(url);
      if (previous !== undefined) {
        if (WARM_FETCH_PRIORITY[priority] <= WARM_FETCH_PRIORITY[previous] || category.size >= limit) continue;
        this.#textureSet(previous).delete(url);
      } else {
        if (category.size >= limit || this.#textureUrls.size >= ASSET_WARMUP_BUDGET.textures) continue;
        this.#textureUrls.add(url);
      }
      this.#textureCategories.set(url, priority);
      category.add(url);
      accepted.push(url);
    }
    this.#textures.add(accepted, priority);
  }

  #textureSet(priority: WarmFetchPriority): Set<string> {
    if (priority === "player") return this.#playerTextures;
    if (priority === "spell") return this.#spellTextures;
    return this.#sceneryTextures;
  }

  #addModels(target: Set<string>, paths: Iterable<string>, limit: number): void {
    this.#addValues(target, [...paths].filter(Boolean), limit);
  }

  #addValues<T>(target: Set<T>, values: Iterable<T>, limit: number): void {
    for (const value of values) {
      if (target.size >= limit) return;
      target.add(value);
    }
  }
}
