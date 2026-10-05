import type { ActiveAura } from "../world/AuraProtocol.js";
import type { WorldPacketEvents } from "../world/EventBus.js";
import type { SpellGo } from "../world/SpellProtocol.js";
import {
  CAST_END_GRACE_MS,
  planSpellAuraDone,
  planSpellAuraState,
  planSpellCastStart,
  planSpellVisual,
  planSpellVisualKitEvent,
  spellAuraPrewarmPaths,
  spellCastPrewarmPaths,
  spellVisualKitPaths,
  type Point,
  type SpellCast,
  type SpellVisualPlan,
  type VisualSound,
} from "./SpellVisuals.js";
import type {
  SpellVisualEffectTransform, SpellVisualKitRecord, SpellVisualMetadata,
} from "../gateway/SpellVisual.js";
import { DynamicObjectAreas } from "./DynamicObjectVisual.js"; // 05.10-A7a-G2 6.05б

/** The finite effects the renderer owns while an aura is present. */
export interface StateVisualDescriptor {
  spellId: number;
  path: string;
  attachment: number;
  scale: number;
  /** Stable authored occurrence for duplicate model-attach rows; never an array position. */
  occurrence?: string;
  transform?: SpellVisualEffectTransform;
}

/** The deliberately small renderer surface used by the lifecycle coordinator. */
export interface SpellVisualLifecycleRenderer {
  playSpellVisual(plan: SpellVisualPlan): unknown;
  setStateVisuals(byUnit: ReadonlyMap<bigint, readonly StateVisualDescriptor[]>): void;
  cancelSpellVisual?(handle: unknown): void;
  retimeSpellVisual?(handle: unknown, absoluteEndsAt: number): void;
  cancelUnitAction?(guid: bigint): void;
  clearSpellVisuals?(): void;
  playUnitAction?(guid: bigint, action: "precast" | "channel" | "cast" | "shoot", hold?: number): void;
  /**
   * Asks the renderer to start fetching these models and their textures now.
   *
   * The coordinator knows two things the renderer cannot: which spell is being cast, and — from
   * `SPELL_CAST_START` — how long the bar is. That cast time is the entire head start available
   * for the three serial round trips a cold spell used to pay after the cast had already happened.
   * Optional, and deliberately answerless: a prewarm that fails changes nothing.
   */
  prewarmSpellModels?(paths: readonly string[]): void;
}

export interface SpellVisualMetadataSource {
  get(spellId: number): SpellVisualMetadata | undefined;
}

/**
 * The other way in: a `SpellVisualKit` by its own id.
 *
 * Optional on purpose. A coordinator built without it keeps doing exactly what it did before slice
 * S3 — the packet still reaches the sound path in `EnterWorld`, and nothing is drawn — so a test
 * or a caller that has no kit route is not broken by there being one.
 */
export interface SpellVisualKitMetadataSource {
  get(kitId: number): SpellVisualKitRecord | undefined;
}

/** A sound sink returns false while audio is not ready; the coordinator keeps it queued then. */
export type SpellVisualSoundSink = (
  soundId: number,
  point: Point,
  guard: () => boolean,
) => boolean | void;

/** The part of WorldClient that is intentionally sufficient for pure lifecycle tests. */
export interface SpellVisualLifecycleWorld {
  readonly events: {
    on<Name extends keyof WorldPacketEvents>(
      name: Name,
      listener: (payload: WorldPacketEvents[Name]) => void,
    ): () => void;
  };
    readonly state: {
    readonly selfGuid: bigint | undefined;
    readonly objects: ReadonlyMap<bigint, {
      position: (Point & { orientation?: number }) | undefined;
      targetGuid: bigint | undefined;
      /** 05.10-A7a-G2 6.05б: what a DynamicObject is read from (DynamicObjectVisual.ts); absent in pure fakes. */
      typeId?: number | undefined;
      fields?: ReadonlyMap<number, number>;
    }>;
  };
  readonly auras: ReadonlyMap<bigint, ReadonlyMap<number, ActiveAura>>;
  readonly targetGuid: bigint | undefined;
}

/**
 * The only stock 3.3.5 SPELL_GO rows whose missing visual is itself the ranged release.
 *
 * `SPELL_ATTR2_AUTOREPEAT_FLAG` is broader than the client action: the local DBC also marks a
 * handful of NPC/non-weapon rows (for example 1485, 31317 and 38196). Treating that bit alone as
 * permission to invent a bow/gun/wand pose makes those casts visibly wrong. Keep the DBC bit in
 * metadata for the spellbook/repeat-container logic, but make this visual fallback an explicit,
 * bounded stock mapping until a server-side ranged-release semantic is available.
 */
export function usesStockRangedRelease(spellId: number, metadata: SpellVisualMetadata): boolean {
  return metadata.autoRepeat === true && (spellId === 75 || spellId === 5019);
}

interface PendingVisual {
  kind: "go" | "start" | "aura";
  spellId: number;
  key: string;
  receivedAt: number;
  epoch: number;
  replay: (now: number) => void;
}

interface PendingAura extends PendingVisual {
  kind: "aura";
  /** `${guid}:${slot}:${spellId}`: the aura state this entry applies (`state:`) or ends (`done:`). */
  stateKey: string;
  /** A StateDone waiting for its row. Several may wait on one key; a StateKit never does. */
  done: boolean;
}

/**
 * A kit packet waiting for its own metadata batch.
 *
 * Its own queue rather than a fourth `kind` on the one above, because the number it waits on is an
 * id in another table: a `SpellVisualKit` id and a `Spell` id collide freely, and one queue keyed
 * by a field called `spellId` would let a loaded spell replay a kit that is still on the wire.
 */
interface PendingKit {
  kitId: number;
  key: string;
  receivedAt: number;
  epoch: number;
  replay: (now: number) => void;
}

interface PendingSound {
  sound: number;
  point: Point;
  at: number;
  epoch: number;
  guard: () => boolean;
  stateKey?: string;
  stateExpectedPresent?: boolean;
}

interface StateDeferredGuard {
  key: string;
  guid: bigint;
  slot: number;
  spellId: number;
  expectedPresent: boolean;
}

interface DeferredPlan {
  plan: SpellVisualPlan;
  receivedAt: number;
  epoch: number;
  world: SpellVisualLifecycleWorld;
  state?: StateDeferredGuard;
}

interface StateVisualOwnership {
  key: string;
  epoch: number;
  world: SpellVisualLifecycleWorld;
  handle: unknown;
}

interface PendingFallback {
  key: string;
  guid: bigint;
  /** An explicit DBC-authored semantic action; ordinary spells never enter this queue. */
  action: "shoot";
  epoch: number;
  world: SpellVisualLifecycleWorld;
  receivedAt: number;
}

interface ActiveStart {
  casterGuid: bigint;
  spellId: number;
  channel: boolean;
  startedAt: number;
  casterPoint: Point | undefined;
  /** Last authoritative update, used only for bounded metadata TTL; plan times stay startedAt. */
  receivedAt: number;
  duration: number;
  handle: unknown;
  /** Sound-only start plans have no renderer handle; remember that their one dispatch happened. */
  soundDispatched: boolean;
}

interface Options {
  metadata: SpellVisualMetadataSource;
  /** Absent means the kit packets keep their pre-S3 sound-only behaviour. */
  kitMetadata?: SpellVisualKitMetadataSource;
  renderer: SpellVisualLifecycleRenderer | (() => SpellVisualLifecycleRenderer | undefined);
  playSound?: SpellVisualSoundSink;
  now?: () => number;
  ttlMs?: number;
  queueCaps?: Partial<{ go: number; start: number; aura: number; kit: number; sounds: number }>;
}

const DEFAULT_TTL = 3_500;
const DEFAULT_CAPS = { go: 128, start: 128, aura: 256, kit: 128, sounds: 128 } as const;
/**
 * Pending-visual queue names, hoisted so the per-frame expiry pass allocates nothing. The aura
 * entries wait in their own indexed queue, {@link PendingAuraQueue}.
 */
const PENDING_VISUAL_KINDS = ["go", "start"] as const;

function copyPoint(point: Point | undefined): Point | undefined {
  return point ? { x: point.x, y: point.y, z: point.z } : undefined;
}

function addToIndex<Key>(index: Map<Key, Set<string>>, at: Key, key: string): void {
  const keys = index.get(at);
  if (keys) keys.add(key);
  else index.set(at, new Set([key]));
}

function removeFromIndex<Key>(index: Map<Key, Set<string>>, at: Key, key: string): void {
  const keys = index.get(at);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) index.delete(at);
}

/**
 * The aura half of the metadata wait, indexed by the questions the lifecycle asks of it.
 *
 * Every reconcile asks, for each aura of a unit, whether that aura's StateKit is already waiting
 * and whether a StateDone for the same slot is still waiting to be superseded. As one flat array
 * those were two scans per aura, and a crowd arriving while its rows were in flight paid them for
 * every aura of every unit on every packet. Here each question is one lookup. Insertion order is
 * still the eviction order, and a metadata batch still replays one spell's entries newest first.
 */
class PendingAuraQueue {
  readonly #entries = new Map<string, PendingAura>();
  readonly #bySpell = new Map<number, Set<string>>();
  readonly #doneByState = new Map<string, Set<string>>();

  get size(): number {
    return this.#entries.size;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** Queues `entry` unless its key is already waiting; past `cap` the oldest entries give way. */
  add(entry: PendingAura, cap: number): void {
    if (this.#entries.has(entry.key)) return;
    this.#entries.set(entry.key, entry);
    addToIndex(this.#bySpell, entry.spellId, entry.key);
    if (entry.done) addToIndex(this.#doneByState, entry.stateKey, entry.key);
    if (this.#entries.size <= cap) return;
    for (const oldest of this.#entries.keys()) {
      this.delete(oldest);
      if (this.#entries.size <= cap) break;
    }
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    removeFromIndex(this.#bySpell, entry.spellId, key);
    if (entry.done) removeFromIndex(this.#doneByState, entry.stateKey, key);
  }

  /** Forgets every StateDone still waiting on this aura state: the aura is live again. */
  deleteDone(stateKey: string): void {
    const keys = this.#doneByState.get(stateKey);
    if (!keys) return;
    for (const key of [...keys]) this.delete(key);
  }

  /** Removes one spell's entries and returns them newest first, the order a batch replays them in. */
  take(spellId: number): PendingAura[] {
    const keys = this.#bySpell.get(spellId);
    if (!keys) return [];
    const taken: PendingAura[] = [];
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (entry) taken.push(entry);
    }
    for (const entry of taken) this.delete(entry.key);
    return taken.reverse();
  }

  /** Drops what belongs to another epoch or has outlived `ttl`. */
  expire(epoch: number, now: number, ttl: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.epoch !== epoch || now - entry.receivedAt > ttl) this.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bySpell.clear();
    this.#doneByState.clear();
  }
}

/** A release plan must not steal the caster's held channel action slot. */
function suppressCasterActionAnimations(plan: SpellVisualPlan, casterGuid: bigint): SpellVisualPlan {
  const animations = plan.animations.filter((animation) => animation.guid !== casterGuid);
  return animations.length === plan.animations.length ? plan : { ...plan, animations };
}

/**
 * When a cast or channel start stops being drawn without its end packet: the cast time plus the
 * grace `planSpellCastStart` gives the stance, so the coordinator, the retimes and the renderer's
 * hold all agree on one moment.
 */
function startEnd(active: { startedAt: number; duration: number }): number {
  return active.startedAt + active.duration + CAST_END_GRACE_MS;
}

/**
 * Owns the lifetime of spell visuals between packet events, metadata fetches and world changes.
 *
 * It is deliberately independent of three.js and GameContext. Packet fixtures can therefore
 * drive it with a clock and a recording renderer, while EnterWorld supplies the real renderer and
 * sound sink. A world epoch is captured in every replay and sound guard, making a late fetch or
 * decoded buffer harmless after a teleport or logout.
 */
export class SpellVisualCoordinator {
  readonly #metadataSource: SpellVisualMetadataSource;
  readonly #kitMetadataSource: SpellVisualKitMetadataSource | undefined;
  readonly #rendererSource: Options["renderer"];
  readonly #playSound: SpellVisualSoundSink | undefined;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #caps: { go: number; start: number; aura: number; kit: number; sounds: number };
  #world: SpellVisualLifecycleWorld | undefined;
  #active = false;
  #epoch = 0;
  #unsubscribes: Array<() => void> = [];
  #pending: { go: PendingVisual[]; start: PendingVisual[] } = { go: [], start: [] };
  #pendingAura = new PendingAuraQueue();
  #pendingKits: PendingKit[] = [];
  #sounds: PendingSound[] = [];
  #deferred: DeferredPlan[] = [];
  #pendingFallbacks: PendingFallback[] = [];
  #seenEvents = new WeakSet<object>();
  #receiptSequence = 0;
  #knownNoVisual = new Set<number>();
  /** Kit ids the route has answered for and that resolve to nothing at all. */
  #knownEmptyKits = new Set<number>();
  #starts = new Map<bigint, ActiveStart>();
  #stateShown = new Set<string>();
  #stateOwnership = new Map<string, StateVisualOwnership>();
  /**
   * Aura state keys that a deferred plan or a queued sound may still carry.
   *
   * `#addState` runs for every aura of a unit on each of its packets and must cancel a superseded
   * StateDone first; walking the deferred and sound queues for each of those keys is what made a
   * unit's packet cost grow with everybody else's queued effects. Nearly every key has nothing
   * queued, and this answers that in one lookup. It may over-remember — that only costs the old
   * walk — and it is added to wherever such an entry is queued, so it never under-remembers.
   */
  #stateQueued = new Set<string>();
  /** Written only through `#setUnitAuras` and `#clearAuraSnapshot`, which keep everything below in step. */
  #auraSnapshot = new Map<bigint, ReadonlyMap<number, ActiveAura>>();
  /** Which units wear each spell, and in how many slots: a metadata batch touches only them. */
  #spellUnits = new Map<number, Map<bigint, number>>();
  /** Spells a live aura is still waiting on, asked for again each frame until their row lands. */
  #unresolvedSpells = new Set<number>();
  /** Each unit's persistent state descriptors as last built; a unit that has none is absent. */
  #stateByUnit = new Map<bigint, readonly StateVisualDescriptor[]>();
  /** Units whose descriptors must be rebuilt before the renderer next hears about them. */
  #stateDirty = new Set<bigint>();
  /** Whether the renderer is owed a `setStateVisuals`: the old per-packet call, coalesced. */
  #stateVisualsDue = false;
  #lastRenderer: SpellVisualLifecycleRenderer | undefined;
  /** 05.10-A7a-G2 6.05б: the areas of DynamicObjects no seen cast draws (DynamicObjectVisual.ts). */
  readonly #areas = new DynamicObjectAreas({
    visual: (spellId) => this.#getVisual(spellId),
    renderer: () => this.#renderer(),
  });

  constructor(options: Options) {
    this.#metadataSource = options.metadata;
    this.#kitMetadataSource = options.kitMetadata;
    this.#rendererSource = options.renderer;
    this.#playSound = options.playSound;
    this.#now = options.now ?? (() => performance.now());
    this.#ttl = Math.max(2_000, Math.min(5_000, options.ttlMs ?? DEFAULT_TTL));
    this.#caps = {
      go: Math.max(1, options.queueCaps?.go ?? DEFAULT_CAPS.go),
      start: Math.max(1, options.queueCaps?.start ?? DEFAULT_CAPS.start),
      aura: Math.max(1, options.queueCaps?.aura ?? DEFAULT_CAPS.aura),
      kit: Math.max(1, options.queueCaps?.kit ?? DEFAULT_CAPS.kit),
      sounds: Math.max(1, options.queueCaps?.sounds ?? DEFAULT_CAPS.sounds),
    };
  }

  /** A monotonically increasing identity for tests and for sound/decode guards. */
  get epoch(): number {
    return this.#epoch;
  }

  /** Binds one world packet stream. Calling it again first retires the previous stream. */
  bindWorld(world: SpellVisualLifecycleWorld): void {
    if (this.#world === world && this.#active) return;
    this.#active = false;
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    this.#clearEffects();
    this.#world = undefined;
    this.#clearAuraSnapshot();
    this.#world = world;
    this.#active = true;
    // Rebinding is one logical world transition, so one epoch increment is enough. clear() is
    // reserved for logout and increments separately to invalidate already-captured guards.
    this.#epoch++;
    this.#unsubscribes.push(
      world.events.on("SPELL_GO", (event) => this.#onSpellGo(world, event)),
      world.events.on("SPELL_CAST_START", (event) => this.#onCastStart(world, event)),
      world.events.on("SPELL_CAST_DELAYED", (event) => this.#onCastDelayed(world, event)),
      world.events.on("SPELL_CHANNEL_UPDATE", (event) => this.#onChannelUpdate(world, event)),
      world.events.on("SPELL_CAST_STOP", (event) => this.#onCastStop(world, event)),
      world.events.on("AURA_CHANGED", (event) => this.#onAuraChanged(world, event)),
    );
    for (const [guid, auras] of world.auras) {
      if (auras.size > 0) this.#setUnitAuras(guid, new Map(auras));
    }
    // Auras already present in the initial snapshot belong to the world state, not a new add;
    // restore their persistent instances without replaying StateKit's one-shot sound/animation.
    this.#reconcileAll(world, false);
  }

  /** Retires effects at the beginning of a teleport, while retaining the packet subscriptions. */
  worldChanged(world: SpellVisualLifecycleWorld): void {
    if (!this.#active || this.#world !== world) return;
    this.#epoch++;
    this.#clearEffects();
    this.#clearAuraSnapshot();
    for (const [guid, auras] of world.auras) {
      if (auras.size > 0) this.#setUnitAuras(guid, new Map(auras));
    }
    this.#reconcileAll(world, false);
  }

  /** Invalidates callbacks and buffers when clearWorldContext/log out drops the world. */
  clear(): void {
    this.#epoch++;
    this.#active = false;
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    this.#clearEffects();
    this.#world = undefined;
    this.#clearAuraSnapshot();
  }

  /** Called by SpellVisualClient only after a successful metadata batch. */
  onLoaded(ids: readonly number[]): void {
    if (!this.#active) return;
    const now = this.#now();
    let stateMayHaveChanged = false;
    let affected: Set<bigint> | undefined;
    for (const id of ids) {
      const visual = this.#metadataSource.get(id);
      if (!visual) this.#knownNoVisual.add(id);
      this.#unresolvedSpells.delete(id);
      for (const kind of PENDING_VISUAL_KINDS) {
        const queue = this.#pending[kind];
        for (let index = queue.length - 1; index >= 0; index--) {
          const entry = queue[index]!;
          if (entry.spellId !== id) continue;
          queue.splice(index, 1);
          if (entry.epoch !== this.#epoch || now - entry.receivedAt > this.#ttl) continue;
          // A missing row is itself a resolved result. Replaying it makes every event a no-op;
          // absence of authored animation data is not permission to invent an attack pose.
          if (!visual && !this.#knownNoVisual.has(id)) continue;
          entry.replay(now);
        }
      }
      for (const entry of this.#pendingAura.take(id)) {
        if (entry.epoch !== this.#epoch || now - entry.receivedAt > this.#ttl) continue;
        if (!visual && !this.#knownNoVisual.has(id)) continue;
        entry.replay(now);
        stateMayHaveChanged = true;
      }
      // Everybody wearing this spell may show it now — also a unit whose own entry fell to the
      // queue cap or the TTL, which a batch has no other way to find.
      const units = this.#spellUnits.get(id);
      if (units) for (const guid of units.keys()) (affected ??= new Set()).add(guid);
    }
    if (stateMayHaveChanged || affected) this.#reconcileLoaded(ids, affected);
  }

  /**
   * A kit the server named by number, on the unit it named.
   *
   * `SMSG_PLAY_SPELL_VISUAL` and `SMSG_PLAY_SPELL_IMPACT` are the two packets that arrive with no
   * spell attached, and until slice S3 the picture half of them was unreachable — the kit tables
   * were only keyed by spell. The metadata path is the same one a cast takes: ask, and if the
   * answer is not in memory yet, queue the packet under the same TTL and replay it when the batch
   * lands. The caller keeps playing the sound itself; this adds the models and the pose.
   */
  playVisualKit(guid: bigint, kitId: number, impact: boolean): void {
    const world = this.#world;
    const source = this.#kitMetadataSource;
    if (!this.#active || !world || !source || guid === 0n || !(kitId > 0)) return;
    const now = this.#now();
    const key = `kit:${this.#receiptSequence++}:${guid}:${kitId}:${impact ? 1 : 0}`;
    // Snapshotted at receipt for the same reason a cast's is: metadata can arrive after the unit
    // has walked away, and the kit belongs where the packet happened.
    const capturedPoint = this.#objectPoint(world, guid);
    const replay = (replayNow: number): void => {
      const record = source.get(kitId);
      if (!record?.kit) return;
      // The S1 seam, reached from the one event that has no cast bar to spend: the metadata that
      // has just landed already names every file, so warming costs one walk of an object in memory.
      this.#renderer()?.prewarmSpellModels?.(spellVisualKitPaths(record.kit));
      const point = capturedPoint ?? this.#objectPoint(world, guid);
      if (!point) return;
      this.#dispatchPlan(planSpellVisualKitEvent(record.kit, { guid, point }, now, impact),
        now, replayNow, world);
    };
    if (!source.get(kitId)) {
      if (!this.#knownEmptyKits.has(kitId)) {
        this.#enqueueKit({ kitId, key, receivedAt: now, epoch: this.#epoch, replay });
      }
      return;
    }
    replay(now);
  }

  /** Called by SpellVisualKitClient after a successful kit batch, mirroring {@link onLoaded}. */
  onKitsLoaded(ids: readonly number[]): void {
    if (!this.#active) return;
    const now = this.#now();
    const source = this.#kitMetadataSource;
    for (const id of ids) {
      // An answered id with no kit behind it is a resolved result, not a pending one: remembering
      // it here is what stops a scripted emote from re-queuing on every repeat.
      if (!source?.get(id)) this.#knownEmptyKits.add(id);
      for (let index = this.#pendingKits.length - 1; index >= 0; index--) {
        const entry = this.#pendingKits[index]!;
        if (entry.kitId !== id) continue;
        this.#pendingKits.splice(index, 1);
        if (entry.epoch !== this.#epoch || now - entry.receivedAt > this.#ttl) continue;
        entry.replay(now);
      }
    }
  }

  #enqueueKit(entry: PendingKit): void {
    if (this.#pendingKits.some((candidate) => candidate.key === entry.key
      && candidate.epoch === entry.epoch)) return;
    this.#pendingKits.push(entry);
    while (this.#pendingKits.length > this.#caps.kit) this.#pendingKits.shift();
  }

  /** Frame-driven expiry and sound scheduling; it never allocates a timer per visual. */
  tick(now = this.#now()): void {
    if (!this.#active) return;
    const renderer = this.#renderer();
    if (renderer !== this.#lastRenderer) {
      this.#lastRenderer = renderer;
      if (renderer && this.#world) {
        this.#drainDeferred(now);
        this.#drainFallbacks(now);
        this.#reconcileAll(this.#world, false);
        for (const active of this.#starts.values()) this.#renderStart(this.#world, active, now);
      }
    }
    // Every aura packet since the last frame, handed to the renderer once. The loop ticks before
    // it draws, so the first frame after a packet shows exactly what a per-packet call showed.
    this.#flushStateVisuals();
    this.#askUnresolvedSpells();
    this.#expireQueues(now);
    this.#drainSounds(now);
    if (this.#world) this.#areas.sync(this.#world.state.objects, now); // 05.10-A7a-G2 6.05б
    if (this.#starts.size === 0) return;
    for (const [guid, active] of this.#starts) {
      // The end packet finishes a cast; the local clock only bounds a lost one (CAST_END_GRACE_MS).
      if (now < startEnd(active)) continue;
      this.#cancelStart(active);
      this.#starts.delete(guid);
    }
  }

  /** Exposed for pure tests and diagnostics; callers should use metadata onLoaded in production. */
  pendingCounts(): { go: number; start: number; aura: number; kit: number; sounds: number } {
    return {
      go: this.#pending.go.length,
      start: this.#pending.start.length,
      aura: this.#pendingAura.size,
      kit: this.#pendingKits.length,
      sounds: this.#sounds.length,
    };
  }

  #renderer(): SpellVisualLifecycleRenderer | undefined {
    return typeof this.#rendererSource === "function" ? this.#rendererSource() : this.#rendererSource;
  }

  #guard(epoch: number, world: SpellVisualLifecycleWorld): () => boolean {
    return () => this.#active && this.#epoch === epoch && this.#world === world;
  }

  #clearEffects(): void {
    const renderer = this.#renderer();
    this.#areas.clear(); // 05.10-A7a-G2 6.05б
    for (const active of this.#starts.values()) this.#cancelStart(active);
    this.#starts.clear();
    this.#pending.go.length = 0;
    this.#pending.start.length = 0;
    this.#pendingAura.clear();
    this.#pendingKits.length = 0;
    this.#sounds.length = 0;
    this.#deferred.length = 0;
    this.#stateQueued.clear();
    this.#pendingFallbacks.length = 0;
    this.#seenEvents = new WeakSet<object>();
    this.#receiptSequence = 0;
    this.#stateShown.clear();
    for (const ownership of this.#stateOwnership.values()) {
      renderer?.cancelSpellVisual?.(ownership.handle);
    }
    this.#stateOwnership.clear();
    renderer?.clearSpellVisuals?.();
    renderer?.setStateVisuals(new Map());
    this.#stateByUnit.clear();
    this.#stateDirty.clear();
    this.#stateVisualsDue = false;
    this.#lastRenderer = renderer;
  }

  #expireQueues(now: number): void {
    // Empty queues are the common case outside combat: filtering them anyway allocates five
    // arrays and five closures per frame for nothing.
    for (const kind of PENDING_VISUAL_KINDS) {
      const queue = this.#pending[kind];
      if (queue.length === 0) continue;
      this.#pending[kind] = queue.filter((entry) =>
        entry.epoch === this.#epoch && now - entry.receivedAt <= this.#ttl);
    }
    if (this.#pendingAura.size > 0) this.#pendingAura.expire(this.#epoch, now, this.#ttl);
    if (this.#pendingKits.length > 0) {
      this.#pendingKits = this.#pendingKits.filter((entry) =>
        entry.epoch === this.#epoch && now - entry.receivedAt <= this.#ttl);
    }
    if (this.#sounds.length > 0) {
      this.#sounds = this.#sounds.filter((sound) =>
        sound.epoch === this.#epoch && now - sound.at <= this.#ttl);
    }
    this.#settleStateQueued();
  }

  #drainSounds(now: number): void {
    const sink = this.#playSound;
    if (!sink) return;
    for (let index = 0; index < this.#sounds.length;) {
      const sound = this.#sounds[index]!;
      if (sound.epoch !== this.#epoch || now - sound.at > this.#ttl || !sound.guard()) {
        this.#sounds.splice(index, 1);
        continue;
      }
      if (sound.at > now) {
        index++;
        continue;
      }
      const accepted = sink(sound.sound, { ...sound.point }, sound.guard);
      if (accepted === false) {
        index++;
      } else {
        this.#sounds.splice(index, 1);
      }
    }
    this.#settleStateQueued();
  }

  /** Once both queues are empty no key can be carried by either, whatever the set remembers. */
  #settleStateQueued(): void {
    if (this.#stateQueued.size > 0 && this.#deferred.length === 0 && this.#sounds.length === 0) {
      this.#stateQueued.clear();
    }
  }

  #enqueue(entry: PendingVisual & { kind: "go" | "start" }): void {
    const queue = this.#pending[entry.kind];
    if (queue.some((candidate) => candidate.key === entry.key && candidate.epoch === entry.epoch)) return;
    queue.push(entry);
    const cap = entry.kind === "go" ? this.#caps.go : this.#caps.start;
    while (queue.length > cap) queue.shift();
  }

  #dropPendingStarts(casterGuid: bigint, spellId?: number): void {
    const prefix = `start:${casterGuid}:`;
    this.#pending.start = this.#pending.start.filter((entry) => {
      if (!entry.key.startsWith(prefix)) return true;
      if (spellId === undefined) return false;
      return entry.spellId !== spellId;
    });
  }

  #refreshPendingStart(casterGuid: bigint, spellId: number, now: number): void {
    for (const entry of this.#pending.start) {
      if (entry.spellId === spellId && entry.key.startsWith(`start:${casterGuid}:`)) {
        entry.receivedAt = now;
      }
    }
  }

  #getVisual(spellId: number): SpellVisualMetadata | undefined {
    if (this.#knownNoVisual.has(spellId)) return undefined;
    return this.#metadataSource.get(spellId);
  }

  #objectPoint(world: SpellVisualLifecycleWorld, guid: bigint): Point | undefined {
    return copyPoint(world.state.objects.get(guid)?.position);
  }

  #spellCast(world: SpellVisualLifecycleWorld, cast: SpellGo): SpellCast | undefined {
    const casterGuid = cast.casterUnit !== 0n ? cast.casterUnit : cast.casterGuid;
    const casterObject = world.state.objects.get(casterGuid) ?? world.state.objects.get(cast.casterGuid);
    let casterPoint = copyPoint(casterObject?.position)
      ?? copyPoint(cast.targets?.source)
      ?? copyPoint(cast.targets?.destination);
    const targets: Array<{ guid: bigint; point: Point }> = [];
    const guids = [...cast.hits, ...cast.misses.map((miss) => miss.guid)];
    const seen = new Set<bigint>();
    let missingTarget = false;
    for (const guid of guids) {
      if (seen.has(guid)) continue;
      seen.add(guid);
      const point = this.#objectPoint(world, guid);
      if (point) targets.push({ guid, point });
      else missingTarget = true;
    }
    // Origin is not a meaningful world fallback. A known target is a bounded fallback for a
    // packet whose caster object has not arrived yet; otherwise the event remains safely visual-
    // free instead of drawing a missile across the map.
    if (!casterPoint && targets.length > 0) casterPoint = { ...targets[0]!.point };
    if (!casterPoint) return undefined;
    const destination = copyPoint(cast.targets?.destination);
    if (destination && (missingTarget || targets.length === 0)) {
      // guid 0 is intentionally a static target: SpellVisuals keeps area/impact effects at this
      // point rather than anchoring them to a unit that is absent from the client's object store.
      targets.push({ guid: 0n, point: destination });
    }
    if (targets.length === 0) {
      const preferred = casterObject?.targetGuid ?? world.targetGuid;
      const targetPoint = preferred === undefined ? undefined : this.#objectPoint(world, preferred);
      if (preferred !== undefined && targetPoint) targets.push({ guid: preferred, point: targetPoint });
      else {
        const orientation = casterObject?.position && "orientation" in casterObject.position
          ? casterObject.position.orientation ?? 0 : 0;
        const fallback = {
          x: casterPoint.x + Math.cos(orientation) * 6,
          y: casterPoint.y + Math.sin(orientation) * 6,
          z: casterPoint.z,
        };
        const visual = this.#getVisual(cast.spellId);
        if (visual?.missile || visual?.impact || visual?.targetImpact || visual?.casterImpact) {
          targets.push({ guid: 0n, point: fallback });
        }
      }
    }
    return {
      caster: casterGuid,
      casterPoint,
      targets,
      ...(destination ? { destination, areaPoint: destination } : {}),
    };
  }

  #onSpellGo(world: SpellVisualLifecycleWorld, cast: SpellGo): void {
    if (!this.#active || this.#world !== world) return;
    const now = this.#now();
    // EventBus can legally deliver the same packet object to a chained callback more than once;
    // suppress that identity only. Equal-looking NPC casts (often castId=0) remain distinct.
    if (this.#seenEvents.has(cast as unknown as object)) return;
    this.#seenEvents.add(cast as unknown as object);
    const receipt = ++this.#receiptSequence;
    const active = this.#starts.get(cast.casterUnit) ?? this.#starts.get(cast.casterGuid);
    // A channel's SPELL_GO is the release/impact packet, not its end. Keep the channel start
    // alive until the authoritative zero CHANNEL_UPDATE so its held pose and visual are retimed.
    // In particular, retain a metadata-pending channel start: SPELL_GO can arrive before the
    // visual row, and dropping that queue here would make the channel permanently invisible.
    const matchingChannel = active !== undefined
      && active.spellId === cast.spellId && active.channel;
    if (!matchingChannel) {
      this.#dropPendingStarts(cast.casterUnit, cast.spellId);
      this.#dropPendingStarts(cast.casterGuid, cast.spellId);
    }
    if (active && active.spellId === cast.spellId && !active.channel) {
      this.#cancelStart(active);
      this.#starts.delete(active.casterGuid);
    }
    this.#areas.noteCast(cast.casterUnit !== 0n ? cast.casterUnit : cast.casterGuid, cast.spellId, now); // 05.10-A7a-G2 6.05б: its area is this cast's
    const visual = this.#getVisual(cast.spellId);
    const key = `go:${receipt}:${cast.casterGuid}:${cast.casterUnit}:${cast.spellId}`;
    // Snapshot anchor positions at receipt. Metadata may arrive after the unit has moved, but the
    // missile and its sounds belong to where this packet happened, not where the next frame finds it.
    const capturedCast = this.#spellCast(world, cast);
    let rangedReleasePlayed = false;
    const releaseCaster = cast.casterUnit !== 0n ? cast.casterUnit : cast.casterGuid;
    const playRangedRelease = (): void => {
      if (rangedReleasePlayed) return;
      const renderer = this.#renderer();
      if (!renderer?.playUnitAction) {
        this.#queueFallback({
          key, guid: releaseCaster, action: "shoot", epoch: this.#epoch, world, receivedAt: now,
        });
        return;
      }
      this.#forgetFallback(key);
      renderer.playUnitAction(releaseCaster, "shoot");
      rangedReleasePlayed = true;
    };
      const replay = (replayNow: number): void => {
        const metadata = this.#getVisual(cast.spellId);
        const spellCast = capturedCast ?? this.#spellCast(world, cast);
        if (!metadata) return;
        if (!spellCast) {
          if (usesStockRangedRelease(cast.spellId, metadata)) playRangedRelease();
        return;
      }
      const plan = planSpellVisual(metadata, spellCast, now);
      const currentActive = this.#starts.get(cast.casterUnit) ?? this.#starts.get(cast.casterGuid);
      const channelStillOwnsCaster = currentActive?.spellId === cast.spellId && currentActive.channel;
      const hasAuthoredCasterAnimation = plan.animations.some((animation) =>
        animation.guid === cast.casterUnit || animation.guid === cast.casterGuid);
      this.#dispatchPlan(
        channelStillOwnsCaster ? suppressCasterActionAnimations(plan, currentActive.casterGuid) : plan,
        now, replayNow, world,
      );
      // Stock Auto Shot and wand Shoot have no SpellVisualID, so the repeat flag supplies their
      // ranged release. Other DBC rows carry the same repeat bit together with a real caster kit;
      // that authored pose wins instead of being replaced by a generic weapon shot.
      if (usesStockRangedRelease(cast.spellId, metadata) && !hasAuthoredCasterAnimation) {
        playRangedRelease();
      }
    };
    if (!visual) {
      this.#metadataSource.get(cast.spellId);
      if (!this.#knownNoVisual.has(cast.spellId)) {
        this.#enqueue({ kind: "go", spellId: cast.spellId, key, receivedAt: now, epoch: this.#epoch, replay });
      }
      return;
    }
    replay(now);
  }

  #onCastStart(world: SpellVisualLifecycleWorld, event: WorldPacketEvents["SPELL_CAST_START"]): void {
    if (!this.#active || this.#world !== world) return;
    const now = this.#now();
    const prior = this.#starts.get(event.casterGuid);
    if (prior) this.#cancelStart(prior);
    const active: ActiveStart = {
      casterGuid: event.casterGuid, spellId: event.spellId, channel: event.channel,
      startedAt: now, receivedAt: now, casterPoint: this.#objectPoint(world, event.casterGuid),
      duration: Math.max(0, event.castTime), handle: undefined, soundDispatched: false,
    };
    this.#starts.set(event.casterGuid, active);
    this.#dropPendingStarts(event.casterGuid);
    const key = `start:${event.casterGuid}:${event.spellId}:${event.channel ? 1 : 0}:${this.#receiptSequence++}`;
    const render = (replayNow: number): void => this.#renderStart(world, active, replayNow);
    const visual = this.#getVisual(active.spellId);
    if (!visual) {
      this.#metadataSource.get(active.spellId);
      if (!this.#knownNoVisual.has(active.spellId)) {
        this.#enqueue({ kind: "start", spellId: active.spellId, key, receivedAt: now, epoch: this.#epoch, replay: render });
      }
    } else {
      render(now);
    }
  }

  #renderStart(world: SpellVisualLifecycleWorld, active: ActiveStart, now: number): void {
    if (!this.#active || this.#world !== world || this.#starts.get(active.casterGuid) !== active) return;
    if (now >= startEnd(active)) {
      this.#cancelStart(active);
      this.#starts.delete(active.casterGuid);
      return;
    }
    const visual = this.#getVisual(active.spellId);
    if (!visual) return;
    // Before every other guard below, and before the plan: this is the moment the client first
    // knows which files this cast will need, and the cast bar is the only head start there is. A
    // start with no caster position and a start whose renderer refuses the plan still want the
    // assets — the SPELL_GO that follows will draw them either way.
    this.#renderer()?.prewarmSpellModels?.(spellCastPrewarmPaths(visual));
    const objectPoint = active.casterPoint ?? this.#objectPoint(world, active.casterGuid);
    if (!objectPoint) return;
    const plan = planSpellCastStart(visual, {
      caster: active.casterGuid, casterPoint: objectPoint, targets: [],
      castTime: active.duration, channel: active.channel,
    }, active.startedAt);

    const hasRenderable = plan.instances.length > 0 || plan.animations.length > 0
      || (plan.beams?.length ?? 0) > 0; // 05.10-A7a-E: a channel's beam alone is renderable
    // A sound-only start has no renderer handle to retime. It is still a one-shot event, so a
    // later pushback/channel refresh must not dispatch the same sound again.
    if (!hasRenderable && active.soundDispatched) {
      return;
    }

    const renderer = this.#renderer();
    // Keep the entire start plan pending while the renderer is unavailable. Dispatching only its
    // sounds here would leave no handle, so a later delay packet could enqueue the same sound
    // again before the renderer-ready frame renders the visual.
    if (!renderer) return;

    this.#cancelHandle(active);
    if (plan.instances.length > 0 || plan.animations.length > 0 || plan.sounds.length > 0
      || (plan.beams?.length ?? 0) > 0) { // 05.10-A7a-E
      active.handle = this.#dispatchPlan(plan, active.receivedAt, now, world, false);
      if (plan.sounds.length > 0 && !hasRenderable) active.soundDispatched = true;
    }
  }

  #cancelHandle(active: ActiveStart): void {
    if (active.handle === undefined) return;
    this.#renderer()?.cancelSpellVisual?.(active.handle);
    active.handle = undefined;
  }

  #cancelStart(active: ActiveStart): void {
    this.#cancelHandle(active);
  }

  #onCastDelayed(world: SpellVisualLifecycleWorld, event: WorldPacketEvents["SPELL_CAST_DELAYED"]): void {
    if (!this.#active || this.#world !== world) return;
    const active = this.#starts.get(event.casterGuid);
    if (!active || active.channel) return;
    const now = this.#now();
    active.duration = Math.max(active.duration, now - active.startedAt) + Math.max(0, event.delay);
    active.receivedAt = now;
    this.#refreshPendingStart(event.casterGuid, active.spellId, now);
    if (active.handle !== undefined && this.#renderer()?.retimeSpellVisual) {
      this.#renderer()?.retimeSpellVisual?.(active.handle, startEnd(active));
    } else {
      this.#renderStart(world, active, now);
    }
  }

  #onChannelUpdate(world: SpellVisualLifecycleWorld, event: WorldPacketEvents["SPELL_CHANNEL_UPDATE"]): void {
    if (!this.#active || this.#world !== world) return;
    if (event.remaining <= 0) this.#dropPendingStarts(event.casterGuid, event.spellId > 0 ? event.spellId : undefined);
    const active = this.#starts.get(event.casterGuid);
    if (!active || !active.channel) return;
    if (event.remaining <= 0) {
      this.#cancelStart(active);
      this.#starts.delete(event.casterGuid);
      return;
    }
    const now = this.#now();
    active.duration = Math.max(0, now - active.startedAt) + event.remaining;
    active.receivedAt = now;
    this.#refreshPendingStart(event.casterGuid, active.spellId, now);
    if (active.handle !== undefined && this.#renderer()?.retimeSpellVisual) {
      this.#renderer()?.retimeSpellVisual?.(active.handle, startEnd(active));
    } else {
      this.#renderStart(world, active, now);
    }
  }

  #onCastStop(world: SpellVisualLifecycleWorld, event: WorldPacketEvents["SPELL_CAST_STOP"]): void {
    if (!this.#active || this.#world !== world) return;
    this.#dropPendingStarts(event.casterGuid, event.spellId > 0 ? event.spellId : undefined);
    const active = this.#starts.get(event.casterGuid);
    if (!active || (event.spellId > 0 && active.spellId !== event.spellId)) return;
    this.#cancelStart(active);
    this.#starts.delete(event.casterGuid);
  }

  #onAuraChanged(world: SpellVisualLifecycleWorld, event: WorldPacketEvents["AURA_CHANGED"]): void {
    if (!this.#active || this.#world !== world) return;
    const now = this.#now();
    if (event.current.size > 0) this.#setUnitAuras(event.guid, new Map(event.current));
    else this.#setUnitAuras(event.guid, undefined);
    for (const removed of event.removed) this.#removeState(world, event.guid, removed, now);
    for (const added of event.added) this.#addState(world, event.guid, added, now);
    for (const updated of event.updated) {
      if (updated.before.spellId !== updated.after.spellId) continue;
      const key = this.#stateKey(event.guid, updated.after);
      const endsAt = updated.after.expiresAt ?? Number.POSITIVE_INFINITY;
      this.#retimeStateOwnership(key, endsAt);
      this.#retimeDeferredState(key, endsAt, now);
    }
    // One unit's packet changes one unit's picture. Reconciling every aura of every unit here made
    // a crowd arriving in one burst quadratic; everybody else's state is exactly as the packet that
    // concerned them left it, and a metadata batch finds its own units through `#spellUnits`. The
    // renderer hears about it once, from the next tick.
    this.#reconcileUnit(world, event.guid, true);
  }

  #stateKey(guid: bigint, aura: ActiveAura): string {
    return `${guid}:${aura.slot}:${aura.spellId}`;
  }

  #addState(world: SpellVisualLifecycleWorld, guid: bigint, aura: ActiveAura, now: number, playAnimation = true): void {
    const key = this.#stateKey(guid, aura);
    // A re-add supersedes a deferred StateDone from the preceding remove. Do not cancel a
    // deferred StateKit for the live aura itself; reconciliation may call this method repeatedly
    // while the renderer is still absent.
    this.#cancelStateDeferred(key, false);
    // A remove can be queued while its metadata is still loading. Re-adding the same slot before
    // that batch arrives supersedes the old removal, so its delayed StateDone must not fire after
    // the aura is live again.
    this.#pendingAura.deleteDone(key);
    if (this.#stateShown.has(key) || this.#pendingAura.has(`state:${key}`)) return;
    const visual = this.#getVisual(aura.spellId);
    // A row with no StateKit: nothing to hold and nothing to play, so the replay below would only
    // warm the StateDone. That is most buffs, and every packet of a unit walks all of its auras.
    if (visual && !visual.state) {
      if (this.#auraSnapshot.get(guid)?.get(aura.slot)?.spellId === aura.spellId) {
        this.#renderer()?.prewarmSpellModels?.(spellAuraPrewarmPaths(visual));
      }
      return;
    }
    const capturedPoint = this.#objectPoint(world, guid);
    const replay = (replayNow: number): void => {
      const current = this.#auraSnapshot.get(guid)?.get(aura.slot);
      if (!current || current.spellId !== aura.spellId) return;
      const visual = this.#getVisual(aura.spellId);
      // StateDone is drawn when the aura falls off, which can be a whole minute later and is the
      // one phase with no packet to warn about it; warm both here, while the aura is being applied.
      if (visual) this.#renderer()?.prewarmSpellModels?.(spellAuraPrewarmPaths(visual));
      if (!visual?.state) return;
      const point = capturedPoint ?? this.#objectPoint(world, guid);
      if (!point) {
        // The persistent map can still be reconciled by GUID, but no one-shot animation or sound
        // may be invented at world origin while a destroyed unit is absent.
        this.#stateShown.add(key);
        return;
      }
      const plan = planSpellAuraState(visual, { guid, point }, now, current.expiresAt ?? Number.POSITIVE_INFINITY);
      if (playAnimation) {
        const handle = this.#dispatchStatePlan(plan, now, replayNow, world,
          { key, guid, slot: aura.slot, spellId: aura.spellId, expectedPresent: true });
        if (handle !== undefined) {
          this.#stateOwnership.set(key, { key, epoch: this.#epoch, world, handle });
        }
      }
      this.#stateShown.add(key);
    };
    if (!visual) {
      // A spell the route has already answered "nothing" for stays answered: neither asked again
      // nor waited for, however many packets mention it.
      if (!this.#knownNoVisual.has(aura.spellId)) {
        this.#metadataSource.get(aura.spellId);
        this.#unresolvedSpells.add(aura.spellId);
        this.#pendingAura.add({
          kind: "aura", spellId: aura.spellId, key: `state:${key}`, stateKey: key, done: false,
          receivedAt: now, epoch: this.#epoch, replay,
        }, this.#caps.aura);
      }
      return;
    }
    replay(now);
  }

  #removeState(world: SpellVisualLifecycleWorld, guid: bigint, aura: ActiveAura, now: number): void {
    const key = this.#stateKey(guid, aura);
    this.#cancelStateOwnership(key);
    this.#cancelStateDeferred(key);
    this.#stateShown.delete(key);
    this.#pendingAura.delete(`state:${key}`);
    const capturedPoint = this.#objectPoint(world, guid);
    const replay = (replayNow: number): void => {
      const current = this.#auraSnapshot.get(guid)?.get(aura.slot);
      if (current?.spellId === aura.spellId) return;
      const visual = this.#getVisual(aura.spellId);
      if (!visual?.stateDone) return;
      const point = capturedPoint;
      if (!point) return;
      this.#dispatchStatePlan(planSpellAuraDone(visual, { guid, point }, now), now, replayNow, world,
        { key, guid, slot: aura.slot, spellId: aura.spellId, expectedPresent: false });
    };
    const visual = this.#getVisual(aura.spellId);
    if (!visual) {
      if (!this.#knownNoVisual.has(aura.spellId)) {
        this.#metadataSource.get(aura.spellId);
        this.#pendingAura.add({
          kind: "aura", spellId: aura.spellId, key: `done:${key}:${this.#receiptSequence++}`, stateKey: key,
          done: true, receivedAt: now, epoch: this.#epoch, replay,
        }, this.#caps.aura);
      }
      return;
    }
    replay(now);
  }

  /** Replaces one unit's snapshot, keeping the spell index and the per-unit picture in step. */
  #setUnitAuras(guid: bigint, auras: ReadonlyMap<number, ActiveAura> | undefined): void {
    const previous = this.#auraSnapshot.get(guid);
    if (previous) this.#indexSpells(guid, previous, -1);
    if (auras) {
      this.#auraSnapshot.set(guid, auras);
      this.#indexSpells(guid, auras, 1);
    } else {
      this.#auraSnapshot.delete(guid);
      this.#stateByUnit.delete(guid);
      this.#stateDirty.delete(guid);
    }
    this.#stateVisualsDue = true;
  }

  #indexSpells(guid: bigint, auras: ReadonlyMap<number, ActiveAura>, delta: 1 | -1): void {
    for (const aura of auras.values()) {
      const units = this.#spellUnits.get(aura.spellId);
      if (delta > 0) {
        if (units) units.set(guid, (units.get(guid) ?? 0) + 1);
        else this.#spellUnits.set(aura.spellId, new Map([[guid, 1]]));
        continue;
      }
      if (!units) continue;
      const slots = (units.get(guid) ?? 0) - 1;
      if (slots > 0) {
        units.set(guid, slots);
        continue;
      }
      units.delete(guid);
      if (units.size > 0) continue;
      this.#spellUnits.delete(aura.spellId);
      // Nobody wears it any more, so nobody needs its row asked for again.
      this.#unresolvedSpells.delete(aura.spellId);
    }
  }

  #clearAuraSnapshot(): void {
    this.#auraSnapshot.clear();
    this.#spellUnits.clear();
    this.#unresolvedSpells.clear();
    this.#stateByUnit.clear();
    this.#stateDirty.clear();
  }

  /** One unit's auras through `#addState`, as the old whole-world pass did for it, and marked for the flush. */
  #reconcileUnit(world: SpellVisualLifecycleWorld, guid: bigint, replayAdd: boolean): void {
    const auras = this.#auraSnapshot.get(guid);
    if (auras) {
      for (const aura of auras.values()) this.#addState(world, guid, aura, this.#now(), replayAdd);
      this.#stateDirty.add(guid);
    }
    this.#stateVisualsDue = true;
  }

  /** Every unit at once: a new world, a teleport, a renderer that has just appeared. Rare by nature. */
  #reconcileAll(world: SpellVisualLifecycleWorld | undefined, replayAdd: boolean): void {
    if (!world || !this.#active || this.#world !== world) return;
    for (const guid of this.#auraSnapshot.keys()) this.#reconcileUnit(world, guid, replayAdd);
    this.#stateVisualsDue = true;
    this.#flushStateVisuals();
  }

  /**
   * The auras a metadata batch concerns: those of the spells it answered, on the units that wear
   * them, in snapshot order so that late one-shots go out in the order a full pass met them.
   * Every other aura's outcome depends on rows this batch did not bring, so it is left alone; the
   * units themselves are rebuilt whole at the flush.
   */
  #reconcileLoaded(ids: readonly number[], affected: ReadonlySet<bigint> | undefined): void {
    const world = this.#world;
    if (!world || !this.#active) return;
    if (affected) {
      const loaded = new Set(ids);
      for (const [guid, auras] of this.#auraSnapshot) {
        if (!affected.has(guid)) continue;
        for (const aura of auras.values()) {
          if (loaded.has(aura.spellId)) this.#addState(world, guid, aura, this.#now(), true);
        }
        this.#stateDirty.add(guid);
      }
    }
    this.#stateVisualsDue = true;
    this.#flushStateVisuals();
  }

  /**
   * Hands the renderer the whole persistent picture, rebuilding only the units that changed.
   *
   * Called once a frame from `tick`, and at once where the old code answered at once (a world
   * bind, a teleport, a metadata batch, a renderer that has just appeared). Everyone else's
   * descriptors are reused: a unit's picture depends only on its own auras and on the rows of the
   * spells it wears, and both of those mark it dirty when they change. The map is built in
   * snapshot order and handed over even when nothing in it differs — `setStateVisuals` is also what
   * re-creates a state model the renderer gave up on, so a packet keeps the retry it always gave.
   */
  #flushStateVisuals(): void {
    if (!this.#stateVisualsDue) return;
    const renderer = this.#renderer();
    // No renderer, nobody to tell; the frame that finds one reconciles and hands over everything.
    if (!renderer) return;
    this.#stateVisualsDue = false;
    const byUnit = new Map<bigint, readonly StateVisualDescriptor[]>();
    for (const guid of this.#auraSnapshot.keys()) {
      let effects = this.#stateByUnit.get(guid);
      if (this.#stateDirty.has(guid)) {
        effects = this.#unitStateVisuals(guid);
        if (effects) this.#stateByUnit.set(guid, effects);
        else this.#stateByUnit.delete(guid);
      }
      if (effects) byUnit.set(guid, effects);
    }
    this.#stateDirty.clear();
    renderer.setStateVisuals(byUnit);
  }

  /** One unit's persistent state effects, in slot order; undefined when it shows none. */
  #unitStateVisuals(guid: bigint): StateVisualDescriptor[] | undefined {
    const auras = this.#auraSnapshot.get(guid);
    if (!auras) return undefined;
    let effects: StateVisualDescriptor[] | undefined;
    for (const aura of auras.values()) {
      const visual = this.#getVisual(aura.spellId);
      if (!visual?.state) continue;
      for (const effect of visual.state.effects) {
        (effects ??= []).push({
          spellId: aura.spellId, path: effect.path, attachment: effect.attachment, scale: effect.scale,
          ...(effect.occurrence ? { occurrence: effect.occurrence } : {}),
          ...(effect.transform ? { transform: effect.transform } : {}),
        });
      }
    }
    return effects;
  }

  /**
   * Asks again for the rows that live auras are still waiting on.
   *
   * The whole-world pass used to ask about every aura on every packet, and that was also what
   * retried a failed batch for a unit nobody touched afterwards. Asking once a frame for the few
   * spells still missing keeps the retry without the walk: the metadata client answers from its
   * own cache, in-flight set and backoff, so a spell already on the wire costs a lookup.
   */
  #askUnresolvedSpells(): void {
    if (this.#unresolvedSpells.size === 0) return;
    for (const spellId of this.#unresolvedSpells) {
      if (this.#knownNoVisual.has(spellId) || !this.#spellUnits.has(spellId)
        || this.#metadataSource.get(spellId) !== undefined) {
        this.#unresolvedSpells.delete(spellId);
      }
    }
  }

  #cancelStateOwnership(key: string): void {
    const ownership = this.#stateOwnership.get(key);
    if (!ownership) return;
    this.#renderer()?.cancelSpellVisual?.(ownership.handle);
    this.#stateOwnership.delete(key);
  }

  #retimeStateOwnership(key: string, endsAt: number): void {
    if (!Number.isFinite(endsAt)) return;
    const ownership = this.#stateOwnership.get(key);
    if (!ownership || ownership.epoch !== this.#epoch || ownership.world !== this.#world) return;
    this.#renderer()?.retimeSpellVisual?.(ownership.handle, endsAt);
  }

  #dispatchStatePlan(
    plan: SpellVisualPlan,
    receivedAt: number,
    now: number,
    world: SpellVisualLifecycleWorld,
    state: StateDeferredGuard,
  ): unknown {
    // StateKit instances are owned by setStateVisuals; only its one-shot animations and sound
    // belong to this finite dispatch.
    return this.#dispatchPlan({ instances: [], animations: plan.animations, sounds: plan.sounds }, receivedAt, now, world,
      true, state);
  }

  #dispatchPlan(
    plan: SpellVisualPlan,
    receivedAt: number,
    now: number,
    world: SpellVisualLifecycleWorld,
    deferIfMissingRenderer = true,
    state?: StateDeferredGuard,
  ): unknown {
    if (!this.#active || this.#world !== world || now - receivedAt > this.#ttl) return undefined;
    const instances = plan.instances.filter((instance) => instance.endsAt > now);
    // One-shots are still meaningful when replayed a few milliseconds late (impact flashes and
    // authored sounds use hold=0). Held animations, in contrast, are dropped once their absolute
    // authored end has passed.
    const animations = plan.animations.filter((animation) =>
      animation.hold <= 0 || animation.at + animation.hold > now);
    const filtered: SpellVisualPlan = { instances, animations, sounds: [] };
    // 05.10-A7a-E (6.13): beams and camera shakes travel with the plan's handle.
    const beams = plan.beams?.filter((beam) => beam.endsAt > now);
    if (beams && beams.length > 0) filtered.beams = beams;
    if (plan.shakes && plan.shakes.length > 0) filtered.shakes = plan.shakes;
    const extras = (filtered.beams?.length ?? 0) + (filtered.shakes?.length ?? 0);
    const renderer = this.#renderer();
    if (!renderer) {
      if (deferIfMissingRenderer && (instances.length > 0 || animations.length > 0 || plan.sounds.length > 0 || extras > 0)) {
        this.#deferred.push({ plan, receivedAt, epoch: this.#epoch, world, ...(state ? { state } : {}) });
        if (state) this.#stateQueued.add(state.key);
        while (this.#deferred.length > this.#caps.go + this.#caps.start) this.#deferred.shift();
      } else {
        for (const sound of plan.sounds) {
          if (now - sound.at <= this.#ttl) {
            this.#queueSound(sound, this.#epoch, this.#guard(this.#epoch, world), state);
          }
        }
      }
      return undefined;
    }
    const epoch = this.#epoch;
    const guard = this.#guard(epoch, world);
    for (const sound of plan.sounds) {
      if (now - sound.at > this.#ttl) continue;
      this.#queueSound(sound, epoch, guard, state);
    }
    if (instances.length === 0 && animations.length === 0 && extras === 0) { // 05.10-A7a-E: extras
      this.#drainSounds(now);
      return undefined;
    }
    const handle = renderer.playSpellVisual(filtered);
    this.#drainSounds(now);
    return handle;
  }

  #drainDeferred(now: number): void {
    for (let index = 0; index < this.#deferred.length;) {
      const entry = this.#deferred[index]!;
      if (entry.epoch !== this.#epoch || entry.world !== this.#world || now - entry.receivedAt > this.#ttl) {
        this.#deferred.splice(index, 1);
        continue;
      }
      const state = entry.state;
      if (state) {
        const current = this.#auraSnapshot.get(state.guid)?.get(state.slot);
        const present = current?.spellId === state.spellId;
        if (present !== state.expectedPresent) {
          this.#deferred.splice(index, 1);
          this.#cancelStateSounds(state.key, state.expectedPresent);
          continue;
        }
      }
      if (state?.expectedPresent && !this.#stateShown.has(state.key)) {
        this.#deferred.splice(index, 1);
        continue;
      }
      this.#deferred.splice(index, 1);
      const handle = this.#dispatchPlan(entry.plan, entry.receivedAt, now, entry.world, false, state);
      if (state?.expectedPresent && handle !== undefined && this.#stateShown.has(state.key)) {
        this.#stateOwnership.set(state.key, {
          key: state.key, epoch: this.#epoch, world: entry.world, handle,
        });
      }
    }
    this.#settleStateQueued();
  }

  #queueFallback(entry: PendingFallback): void {
    if (this.#pendingFallbacks.some((pending) => pending.key === entry.key
      && pending.epoch === entry.epoch)) return;
    this.#pendingFallbacks.push(entry);
    while (this.#pendingFallbacks.length > this.#caps.go) this.#pendingFallbacks.shift();
  }

  #forgetFallback(key: string): void {
    for (let index = this.#pendingFallbacks.length - 1; index >= 0; index--) {
      if (this.#pendingFallbacks[index]!.key === key) this.#pendingFallbacks.splice(index, 1);
    }
  }

  #drainFallbacks(now: number): void {
    const renderer = this.#renderer();
    if (!renderer?.playUnitAction) return;
    for (let index = 0; index < this.#pendingFallbacks.length;) {
      const pending = this.#pendingFallbacks[index]!;
      if (pending.epoch !== this.#epoch || pending.world !== this.#world
        || now - pending.receivedAt > this.#ttl) {
        this.#pendingFallbacks.splice(index, 1);
        continue;
      }
      renderer.playUnitAction(pending.guid, pending.action);
      this.#pendingFallbacks.splice(index, 1);
    }
  }

  #cancelStateSounds(key: string, expectedPresent?: boolean): void {
    if (this.#stateQueued.has(key)) this.#removeStateSounds(key, expectedPresent);
  }

  /** Drops the key's queued sounds of that polarity; true when some of the key's sounds remain. */
  #removeStateSounds(key: string, expectedPresent: boolean | undefined): boolean {
    let kept = false;
    for (let index = this.#sounds.length - 1; index >= 0; index--) {
      const sound = this.#sounds[index]!;
      if (sound.stateKey !== key) continue;
      if (expectedPresent !== undefined && sound.stateExpectedPresent !== expectedPresent) {
        kept = true;
        continue;
      }
      this.#sounds.splice(index, 1);
    }
    return kept;
  }

  #cancelStateDeferred(key: string, expectedPresent?: boolean): void {
    // Nearly every aura state has nothing queued behind it, and `#stateQueued` says so in one lookup.
    if (!this.#stateQueued.has(key)) return;
    let kept = false;
    for (let index = this.#deferred.length - 1; index >= 0; index--) {
      const state = this.#deferred[index]!.state;
      if (state?.key !== key) continue;
      if (expectedPresent !== undefined && state.expectedPresent !== expectedPresent) {
        kept = true;
        continue;
      }
      this.#deferred.splice(index, 1);
    }
    if (this.#removeStateSounds(key, expectedPresent)) kept = true;
    // Both queues have just been walked for this key; if nothing of it is left, it can be forgotten.
    if (!kept) this.#stateQueued.delete(key);
  }

  #retimeDeferredState(key: string, endsAt: number, receivedAt: number): void {
    if (!Number.isFinite(endsAt) || !this.#stateQueued.has(key)) return;
    for (const entry of this.#deferred) {
      const state = entry.state;
      if (!state || state.key !== key || !state.expectedPresent) continue;
      for (const animation of entry.plan.animations) {
        const hold = Math.max(0, endsAt - animation.at);
        if (animation.mode === "hold") animation.hold = hold;
        if (animation.followUp?.mode === "hold") animation.followUp.hold = hold;
      }
      entry.receivedAt = receivedAt;
    }
  }

  #queueSound(sound: VisualSound, epoch: number, guard: () => boolean, state?: StateDeferredGuard): void {
    this.#sounds.push({
      sound: sound.sound, point: { ...sound.point }, at: sound.at, epoch, guard,
      ...(state ? { stateKey: state.key, stateExpectedPresent: state.expectedPresent } : {}),
    });
    if (state) this.#stateQueued.add(state.key);
    while (this.#sounds.length > this.#caps.sounds) this.#sounds.shift();
  }
}
