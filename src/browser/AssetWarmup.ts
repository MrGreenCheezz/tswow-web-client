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
import { PLAYER_FLAGS_HIDE_CLOAK, PLAYER_FLAGS_HIDE_HELM } from "../world/CharacterStatFields.js"; // 05.10 review A7a-A 6.09
import type { ItemMetadataClient } from "./ItemMetadata.js";
import type { CreatureModelClient, EquippedItem } from "./CreatureModelClient.js";
import type { SpellVisualClient } from "./SpellVisualClient.js";
import type { EnvironmentClient, EnvironmentModel, EnvironmentObject, ModelLoadPriority } from "./Terrain.js";
import { layerPaths } from "./CharacterAtlas.js";
import { spellVisualAllPhases, spellVisualPhasePaths } from "./SpellVisuals.js";
import { modelOwnTexturePaths, textureUrl, visualAnimationsUrl } from "./Wvm.js";

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
  /**
   * The session-long spell lane's own caps.
   *
   * The action bar is 24 ids because that is what fits on it; the spellbook of a levelled
   * character is several times that, and the spell nobody put on a bar is exactly the one whose
   * first cast is cold. These are the totals for a whole session, not per tick — the per-tick
   * admission below is what keeps a freshly learned tree from landing in one frame.
   */
  sessionSpellIds: 64,
  sessionSpellModels: 32,
  /** New spell ids and models admitted per tick. One tick is one frame; four is not a hitch. */
  spellLaneTickAdmissions: 4,
  /**
   * WVA sidecars warmed per session: the player's own rig and whatever it is riding.
   *
   * One sidecar is 9.4 MiB on this dataset (HumanMale, 182 clips), so this is deliberately the
   * smallest useful number rather than a lane with room to grow.
   */
  playerAnimations: 2,
  /** One sidecar at a time: it is two orders of magnitude larger than a texture. */
  playerAnimationConcurrency: 1,
  /**
   * Model paths warmed from one arriving metadata batch.
   *
   * A batch can legally carry 200 ids, and a levelled spellbook seeds close to that; warming every
   * path of every one of them would put several hundred entries into a model queue whose whole
   * capacity is 256 and whose real work is the scenery in front of the player.
   */
  metadataWarmModels: 16,
} as const;

/**
 * Enough for cold metadata to arrive, without turning the whole session into speculative work.
 *
 * This is the *scenery and player* window, and it stays what it was. The spell lane is no longer
 * inside it: a spell's first cast is cold whenever it happens, and on this client the first cast
 * of anything is almost never within five seconds of the loading screen.
 */
export const ASSET_WARMUP_SOFT_WINDOW_MS = 5_000;
/** Give self/action-bar metadata a chance to enqueue before background scenery occupies four slots. */
const SCENERY_GRACE_MS = 750;
/**
 * How long the session-long lanes wait before they start.
 *
 * Speculative spell and sidecar work must not compete with the terrain, the player's own model and
 * its armour for the four model lanes while the loading screen is still up. Once those have had
 * their window, the queues are mostly idle and this work is free.
 */
export const ASSET_WARMUP_LONG_LANE_START_MS = ASSET_WARMUP_SOFT_WINDOW_MS;

export type WarmFetchPriority = "scenery" | "spell" | "player";

const WARM_FETCH_PRIORITY: Readonly<Record<WarmFetchPriority, number>> = {
  scenery: 0,
  spell: 1,
  player: 2,
};

type WarmResponse = { ok: boolean; arrayBuffer(): Promise<ArrayBuffer> };
export type WarmFetch = (url: string, init: { signal: AbortSignal }) => Promise<WarmResponse>;

export interface WarmFetchQueueStats {
  readonly accepted: number;
  readonly queued: number;
  readonly active: number;
  readonly closed: boolean;
}

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
    // Annotated because the budget object is `as const`: without this the defaults would narrow
    // the parameters to the literals 24 and 2, and a lane with its own smaller cap could not exist.
    budget: number = ASSET_WARMUP_BUDGET.textures,
    concurrency: number = ASSET_WARMUP_BUDGET.textureConcurrency,
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

  get stats(): WarmFetchQueueStats {
    return Object.freeze({
      accepted: this.#seen.size,
      queued: this.#queue.size,
      active: this.#active,
      closed: this.#closed,
    });
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

/**
 * Authored model paths in the order a normal cast is most likely to need them.
 *
 * The walk itself lives in `SpellVisuals` beside the planner that reads the same fields, so the
 * warm-up and the draw cannot disagree about which files a kit is made of.
 */
export function spellVisualModelPaths(visual: SpellVisualMetadata): string[] {
  return spellVisualPhasePaths(spellVisualAllPhases(visual));
}

/**
 * The paths one arriving metadata batch says are worth warming, bounded.
 *
 * The gateway answers a batch of ids at once, and the batch that matters is usually one cast's
 * worth. A spellbook-sized seed arrives in the same shape, so the limit is what keeps the model
 * queue for the scenery in front of the player from being spent on spells nobody has cast yet.
 * `visualOf` is expected to answer from cache: every id in a loaded batch has one.
 */
export function loadedVisualWarmPaths(
  ids: readonly number[],
  visualOf: (id: number) => SpellVisualMetadata | undefined,
  limit = ASSET_WARMUP_BUDGET.metadataWarmModels,
): string[] {
  const paths: string[] = [];
  for (const id of ids) {
    const visual = visualOf(id);
    if (!visual) continue;
    paths.push(...spellVisualModelPaths(visual));
  }
  return boundedUnique(paths, limit);
}

/** The part of a texture lease a warm pool needs; `ModelTextureLease` satisfies it structurally. */
export interface WarmLease {
  readonly url: string;
  readonly released: boolean;
  release(): void;
}

/** Cap and lifetime of the renderer's warm spell-texture pool, stated where they can be tested. */
export const WARM_LEASE_POOL_LIMIT = 24;
export const WARM_LEASE_POOL_TTL_MS = 45_000;

/**
 * Keeps prewarmed texture leases alive across frames.
 *
 * Without this the prewarm is a no-op with extra steps: the renderer's spell texture cache runs
 * `evictUnleased()` at the end of every frame, so a texture that was fetched before its cast has
 * nobody holding it and is a candidate for eviction from the moment it lands — the one thing a
 * prewarm must not be. A lease is a claim, and a claim is what survives the frame boundary.
 *
 * Bounded three ways, because a claim that is never given up is a leak: an LRU cap, a per-entry
 * TTL, and an explicit release on world teardown. Insertion order is the LRU order; re-warming an
 * entry moves it to the back and restarts its clock.
 */
export class WarmLeasePool {
  readonly #acquire: (url: string) => WarmLease | undefined;
  readonly #limit: number;
  readonly #ttl: number;
  readonly #entries = new Map<string, { lease: WarmLease; expiresAt: number }>();

  constructor(
    acquire: (url: string) => WarmLease | undefined,
    limit = WARM_LEASE_POOL_LIMIT,
    ttlMs = WARM_LEASE_POOL_TTL_MS,
  ) {
    this.#acquire = acquire;
    this.#limit = Math.max(0, Math.trunc(Number.isFinite(limit) ? limit : WARM_LEASE_POOL_LIMIT));
    this.#ttl = Math.max(0, Number.isFinite(ttlMs) ? ttlMs : WARM_LEASE_POOL_TTL_MS);
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Current claims, oldest first. Exposed for the residency diagnostics and for tests. */
  get urls(): readonly string[] {
    return Object.freeze([...this.#entries.keys()]);
  }

  /** Warms one URL, or refreshes the claim already held on it. Returns whether a claim is held. */
  warm(url: string, now: number): boolean {
    if (!url || this.#limit === 0) return false;
    const existing = this.#entries.get(url);
    if (existing && !existing.lease.released) {
      this.#entries.delete(url);
      existing.expiresAt = now + this.#ttl;
      this.#entries.set(url, existing);
      return true;
    }
    // A released lease is a dead claim on a record the loader may have replaced; drop it and take
    // a new one rather than reporting warmth nobody is holding.
    if (existing) this.#entries.delete(url);
    const lease = this.#acquire(url);
    if (!lease) return false;
    this.#entries.set(url, { lease, expiresAt: now + this.#ttl });
    this.#evict();
    return true;
  }

  /** Drops claims whose lifetime has run out. Cheap enough to call every frame. */
  expire(now: number): void {
    for (const [url, entry] of this.#entries) {
      if (now < entry.expiresAt && !entry.lease.released) continue;
      entry.lease.release();
      this.#entries.delete(url);
    }
  }

  /** Releases everything. Used on world teardown and disposal; safe to repeat. */
  clear(): void {
    for (const entry of this.#entries.values()) entry.lease.release();
    this.#entries.clear();
  }

  #evict(): void {
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      this.#entries.get(oldest.value)?.lease.release();
      this.#entries.delete(oldest.value);
    }
  }
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

export interface AssetWarmupOptions {
  now?: () => number;
  fetcher?: WarmFetch;
  /**
   * The spellbook, for the lane the action bar cannot cover.
   *
   * A function rather than a list: `SMSG_INITIAL_SPELLS` lands before the first warm-up tick, but
   * training and levelling keep adding to it for the rest of the session, and this lane outlives
   * the five-second window that used to make a snapshot good enough.
   */
  knownSpellIds?: () => Iterable<number>;
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
  /** The WVA sidecar lane. Response-only, like the texture lane, and deliberately its own queue. */
  readonly #animations: BoundedWarmFetchQueue;
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
  /** Model paths whose animation sidecar has been asked for, capped for the session. */
  readonly #animationModels = new Set<string>();
  /** The player's own rig and the one it is riding: the only two models with a sidecar worth warming. */
  readonly #animationRigs = new Set<string>();
  readonly #knownSpellIds: (() => Iterable<number>) | undefined;
  #actionButtons: readonly ActionButton[] | undefined;
  #sceneryEnvironment: readonly EnvironmentObject[] | undefined;
  #closed = false;

  constructor(
    clients: AssetWarmupClients,
    options: AssetWarmupOptions = {},
  ) {
    this.#clients = clients;
    this.#now = options.now ?? (() => performance.now());
    this.#startedAt = this.#now();
    this.#textures = new BoundedWarmFetchQueue(options.fetcher);
    // Its own queue, not a category in the texture queue: one sidecar is larger than all
    // twenty-four textures put together, and a shared lane would let it stand in front of them.
    this.#animations = new BoundedWarmFetchQueue(
      options.fetcher,
      ASSET_WARMUP_BUDGET.playerAnimations,
      ASSET_WARMUP_BUDGET.playerAnimationConcurrency,
    );
    this.#knownSpellIds = options.knownSpellIds;
  }

  /**
   * Combined queue state. The benchmark readiness barrier waits on this, so a lane it cannot see
   * would be a lane whose 9.4 MiB fetch runs underneath a measured frame.
   */
  get stats(): WarmFetchQueueStats {
    const textures = this.#textures.stats;
    const animations = this.#animations.stats;
    return Object.freeze({
      accepted: textures.accepted + animations.accepted,
      queued: textures.queued + animations.queued,
      active: textures.active + animations.active,
      closed: textures.closed && animations.closed,
    });
  }

  tick(frame: AssetWarmupFrame): void {
    if (this.#closed) return;
    const now = this.#now();
    const elapsed = now - this.#startedAt;
    // The lanes are split by lifetime, not by taste. Scenery, the player's own body and its armour
    // are wanted *now* and are pointless later — the renderer has asked for them itself long
    // before then. A spell visual is the opposite: its first cast is cold whenever it happens.
    const openWindow = elapsed <= ASSET_WARMUP_SOFT_WINDOW_MS;
    if (openWindow) {
      this.#warmPlayer(frame.player);
      // Background scenery is held briefly so a cold display/visual metadata response can put self
      // and action-bar models into the same microtask-batched priority queue first.
      if (elapsed >= SCENERY_GRACE_MS
        && this.#sceneryModels.size < ASSET_WARMUP_BUDGET.sceneryModels
        && frame.environment !== this.#sceneryEnvironment) {
        this.#sceneryEnvironment = frame.environment;
        this.#addModels(
          this.#sceneryModels,
          nearestSceneryModelPaths(frame.environment, frame.player.position ?? { x: 0, y: 0 }),
          ASSET_WARMUP_BUDGET.sceneryModels,
        );
      }
    }
    this.#warmSpells(frame.actionButtons, openWindow);
    if (elapsed >= ASSET_WARMUP_LONG_LANE_START_MS) this.#warmPlayerAnimations();

    if (openWindow) {
      this.#probeModels(
        this.#playerModels, "critical", this.#playerTextures, ASSET_WARMUP_BUDGET.playerTextures, "player",
      );
    }
    this.#probeModels(
      this.#spellModels, "normal", this.#spellTextures, ASSET_WARMUP_BUDGET.spellTextures, "spell",
    );
    if (openWindow) {
      this.#probeModels(
        this.#sceneryModels, "background", this.#sceneryTextures, ASSET_WARMUP_BUDGET.sceneryTextures, "scenery",
      );
    }
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#textures.close();
    this.#animations.close();
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
    if (mount) {
      this.#addModels(this.#playerModels, [mount.model], ASSET_WARMUP_BUDGET.playerModels);
      this.#addValues(this.#animationRigs, [mount.model], ASSET_WARMUP_BUDGET.playerAnimations);
    }

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
    // The character's own rig comes first: it is the one whose cast, emote and mount poses all
    // live in the sidecar, and the one every dropped action measured so far belonged to.
    this.#addValues(this.#animationRigs, [metadata.model], ASSET_WARMUP_BUDGET.playerAnimations);
    if (player.typeId !== 4) return;

    const equipment: EquippedItem[] = [];
    // 05.10 review A7a-A 6.09: a helm or cloak the player hid is not worn for the look, exactly as
    // `ui/Frames.ts visibleEquipmentFor` leaves it out — otherwise this asks for a second look.
    const hiddenWorn = (player.fields.get(UPDATE_FIELDS.PLAYER_FLAGS.offset) ?? 0)
      & (PLAYER_FLAGS_HIDE_HELM | PLAYER_FLAGS_HIDE_CLOAK);
    for (const { slot, entry } of worn) {
      if ((slot === 0 && (hiddenWorn & PLAYER_FLAGS_HIDE_HELM) !== 0)
        || (slot === 14 && (hiddenWorn & PLAYER_FLAGS_HIDE_CLOAK) !== 0)) continue; // 05.10 review A7a-A 6.09
      const item = this.#clients.itemMetadata.get(entry);
      // Wait for the complete outfit: asking with a partial list creates and retains a second,
      // obsolete appearance while the remaining item rows arrive.
      if (!item) return;
      if (item.displayId > 0) equipment.push({
        slot, inventoryType: item.inventoryType, displayId: item.displayId,
        ...(item.subClass === undefined ? {} : { subClass: item.subClass }),
      });
    }

    const bytes = player.fields.get(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset) ?? 0;
    const look = player.fields.get(UPDATE_FIELDS.PLAYER_BYTES.offset) ?? 0;
    const look2 = player.fields.get(UPDATE_FIELDS.PLAYER_BYTES_2.offset) ?? 0;
    const appearance = this.#clients.creatureModels.playerAppearance(
      bytes & 0xff, (bytes >>> 16) & 0xff,
      look & 0xff, (look >>> 8) & 0xff, (look >>> 16) & 0xff, (look >>> 24) & 0xff,
      look2 & 0xff, equipment,
      (bytes >>> 8) & 0xff, // 05.10-A7a-A 6.10: the same key `ui/Frames.ts unitModelFor` asks with
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

  /**
   * The one lane that outlives the loading screen.
   *
   * Inside the window it behaves exactly as it did: the action bar, 24 ids, 12 models. After it,
   * the spellbook keeps feeding ids in and models out at a few per tick, because a spell's first
   * cast is cold whenever it happens and the three round trips it pays are the defect this exists
   * to remove.
   */
  #warmSpells(buttons: readonly ActionButton[], openWindow: boolean): void {
    const idLimit = openWindow ? ASSET_WARMUP_BUDGET.spellIds : ASSET_WARMUP_BUDGET.sessionSpellIds;
    const modelLimit = openWindow ? ASSET_WARMUP_BUDGET.spellModels : ASSET_WARMUP_BUDGET.sessionSpellModels;
    if (this.#spellIds.size < idLimit && buttons !== this.#actionButtons) {
      this.#actionButtons = buttons;
      this.#addValues(this.#spellIds, actionBarWarmSpellIds(buttons), idLimit);
    }
    // The spellbook, a few ids per tick. Its own metadata request is batched by the client, so a
    // slow trickle costs no extra round trips — it only keeps one frame from carrying all of them.
    if (!openWindow && this.#knownSpellIds && this.#spellIds.size < idLimit) {
      let admitted = 0;
      for (const id of this.#knownSpellIds()) {
        if (admitted >= ASSET_WARMUP_BUDGET.spellLaneTickAdmissions || this.#spellIds.size >= idLimit) break;
        if (!Number.isSafeInteger(id) || id <= 0 || this.#spellIds.has(id)) continue;
        this.#spellIds.add(id);
        admitted++;
      }
    }
    if (this.#spellModels.size >= modelLimit) return;
    let admittedModels = 0;
    for (const id of this.#spellIds) {
      const visual = this.#clients.spellVisuals.get(id);
      if (!visual) continue;
      const before = this.#spellModels.size;
      this.#addModels(this.#spellModels, spellVisualModelPaths(visual), modelLimit);
      admittedModels += this.#spellModels.size - before;
      if (this.#spellModels.size >= modelLimit) return;
      // Inside the window the old behaviour stands: fill as far as the budget allows in one tick.
      if (!openWindow && admittedModels >= ASSET_WARMUP_BUDGET.spellLaneTickAdmissions) return;
    }
  }

  /**
   * The held-back animation keyframes, warmed into the browser cache before something needs a pose.
   *
   * The sidecar is the largest single asset a character session downloads — measured on this
   * dataset, 9,833,124 bytes for HumanMale's 182 clips — and until now nothing asked for it until
   * a frame wanted a pose that is inside it. The request then had to be made, queued behind two
   * lanes, fetched and decoded (36.0 + 46.7 ms warm here, and the first request for an artifact is
   * the one that publishes it) entirely inside the window a one-shot action waits. This is a
   * response-only warm: the decoded clips still enter through `EnvironmentClient.animations`, and
   * this only makes that request a cache hit.
   */
  #warmPlayerAnimations(): void {
    if (this.#animationModels.size >= ASSET_WARMUP_BUDGET.playerAnimations) return;
    const urls: string[] = [];
    // Rigs only. A shoulder pad and a sword are in `#playerModels` too and have no sidecar at all,
    // so warming those would spend the whole lane on two 404s.
    for (const path of this.#animationRigs) {
      if (this.#animationModels.size >= ASSET_WARMUP_BUDGET.playerAnimations) break;
      if (this.#animationModels.has(path)) continue;
      this.#animationModels.add(path);
      urls.push(visualAnimationsUrl(this.#clients.environment.baseUrl, path));
    }
    if (urls.length > 0) this.#animations.add(urls, "player");
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
