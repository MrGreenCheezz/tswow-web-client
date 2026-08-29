import type { ActiveAura } from "../world/AuraProtocol.js";
import type { WorldPacketEvents } from "../world/EventBus.js";
import type { SpellGo } from "../world/SpellProtocol.js";
import {
  planSpellAuraDone,
  planSpellAuraState,
  planSpellCastStart,
  planSpellVisual,
  type Point,
  type SpellCast,
  type SpellVisualPlan,
  type VisualSound,
} from "./SpellVisuals.js";
import type { SpellVisualEffectTransform, SpellVisualMetadata } from "../gateway/SpellVisual.js";

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
}

export interface SpellVisualMetadataSource {
  get(spellId: number): SpellVisualMetadata | undefined;
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
  renderer: SpellVisualLifecycleRenderer | (() => SpellVisualLifecycleRenderer | undefined);
  playSound?: SpellVisualSoundSink;
  now?: () => number;
  ttlMs?: number;
  queueCaps?: Partial<{ go: number; start: number; aura: number; sounds: number }>;
}

const DEFAULT_TTL = 3_500;
const DEFAULT_CAPS = { go: 128, start: 128, aura: 256, sounds: 128 } as const;

function copyPoint(point: Point | undefined): Point | undefined {
  return point ? { x: point.x, y: point.y, z: point.z } : undefined;
}

/** A release plan must not steal the caster's held channel action slot. */
function suppressCasterActionAnimations(plan: SpellVisualPlan, casterGuid: bigint): SpellVisualPlan {
  const animations = plan.animations.filter((animation) => animation.guid !== casterGuid);
  return animations.length === plan.animations.length ? plan : { ...plan, animations };
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
  readonly #rendererSource: Options["renderer"];
  readonly #playSound: SpellVisualSoundSink | undefined;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #caps: { go: number; start: number; aura: number; sounds: number };
  #world: SpellVisualLifecycleWorld | undefined;
  #active = false;
  #epoch = 0;
  #unsubscribes: Array<() => void> = [];
  #pending: { go: PendingVisual[]; start: PendingVisual[]; aura: PendingVisual[] } = {
    go: [], start: [], aura: [],
  };
  #sounds: PendingSound[] = [];
  #deferred: DeferredPlan[] = [];
  #pendingFallbacks: PendingFallback[] = [];
  #seenEvents = new WeakSet<object>();
  #receiptSequence = 0;
  #knownNoVisual = new Set<number>();
  #starts = new Map<bigint, ActiveStart>();
  #stateShown = new Set<string>();
  #stateOwnership = new Map<string, StateVisualOwnership>();
  #auraSnapshot = new Map<bigint, ReadonlyMap<number, ActiveAura>>();
  #lastRenderer: SpellVisualLifecycleRenderer | undefined;

  constructor(options: Options) {
    this.#metadataSource = options.metadata;
    this.#rendererSource = options.renderer;
    this.#playSound = options.playSound;
    this.#now = options.now ?? (() => performance.now());
    this.#ttl = Math.max(2_000, Math.min(5_000, options.ttlMs ?? DEFAULT_TTL));
    this.#caps = {
      go: Math.max(1, options.queueCaps?.go ?? DEFAULT_CAPS.go),
      start: Math.max(1, options.queueCaps?.start ?? DEFAULT_CAPS.start),
      aura: Math.max(1, options.queueCaps?.aura ?? DEFAULT_CAPS.aura),
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
    this.#auraSnapshot.clear();
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
    for (const [guid, auras] of world.auras) this.#auraSnapshot.set(guid, new Map(auras));
    // Auras already present in the initial snapshot belong to the world state, not a new add;
    // restore their persistent instances without replaying StateKit's one-shot sound/animation.
    this.#reconcileState(world, false);
  }

  /** Retires effects at the beginning of a teleport, while retaining the packet subscriptions. */
  worldChanged(world: SpellVisualLifecycleWorld): void {
    if (!this.#active || this.#world !== world) return;
    this.#epoch++;
    this.#clearEffects();
    this.#auraSnapshot.clear();
    for (const [guid, auras] of world.auras) this.#auraSnapshot.set(guid, new Map(auras));
    this.#reconcileState(world, false);
  }

  /** Invalidates callbacks and buffers when clearWorldContext/log out drops the world. */
  clear(): void {
    this.#epoch++;
    this.#active = false;
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    this.#clearEffects();
    this.#world = undefined;
    this.#auraSnapshot.clear();
  }

  /** Called by SpellVisualClient only after a successful metadata batch. */
  onLoaded(ids: readonly number[]): void {
    if (!this.#active) return;
    const now = this.#now();
    let stateMayHaveChanged = false;
    for (const id of ids) {
      const visual = this.#metadataSource.get(id);
      if (!visual) this.#knownNoVisual.add(id);
      for (const kind of ["go", "start", "aura"] as const) {
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
          if (entry.kind === "aura") stateMayHaveChanged = true;
        }
      }
    }
    if (stateMayHaveChanged) this.#reconcileState(this.#world);
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
        this.#reconcileState(this.#world, false);
        for (const active of this.#starts.values()) this.#renderStart(this.#world, active, now);
      }
    }
    this.#expireQueues(now);
    this.#drainSounds(now);
    for (const [guid, active] of this.#starts) {
      if (now < active.startedAt + active.duration) continue;
      this.#cancelStart(active);
      this.#starts.delete(guid);
    }
  }

  /** Exposed for pure tests and diagnostics; callers should use metadata onLoaded in production. */
  pendingCounts(): { go: number; start: number; aura: number; sounds: number } {
    return {
      go: this.#pending.go.length,
      start: this.#pending.start.length,
      aura: this.#pending.aura.length,
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
    for (const active of this.#starts.values()) this.#cancelStart(active);
    this.#starts.clear();
    this.#pending.go.length = 0;
    this.#pending.start.length = 0;
    this.#pending.aura.length = 0;
    this.#sounds.length = 0;
    this.#deferred.length = 0;
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
    this.#lastRenderer = renderer;
  }

  #expireQueues(now: number): void {
    for (const kind of ["go", "start", "aura"] as const) {
      this.#pending[kind] = this.#pending[kind].filter((entry) =>
        entry.epoch === this.#epoch && now - entry.receivedAt <= this.#ttl);
    }
    this.#sounds = this.#sounds.filter((sound) =>
      sound.epoch === this.#epoch && now - sound.at <= this.#ttl);
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
  }

  #enqueue(entry: PendingVisual): void {
    const queue = this.#pending[entry.kind];
    if (queue.some((candidate) => candidate.key === entry.key && candidate.epoch === entry.epoch)) return;
    queue.push(entry);
    const cap = entry.kind === "go" ? this.#caps.go : entry.kind === "start" ? this.#caps.start : this.#caps.aura;
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
    if (now >= active.startedAt + active.duration) {
      this.#cancelStart(active);
      this.#starts.delete(active.casterGuid);
      return;
    }
    const visual = this.#getVisual(active.spellId);
    if (!visual) return;
    const objectPoint = active.casterPoint ?? this.#objectPoint(world, active.casterGuid);
    if (!objectPoint) return;
    const plan = planSpellCastStart(visual, {
      caster: active.casterGuid, casterPoint: objectPoint, targets: [],
      castTime: active.duration, channel: active.channel,
    }, active.startedAt);

    const hasRenderable = plan.instances.length > 0 || plan.animations.length > 0;
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
    if (plan.instances.length > 0 || plan.animations.length > 0 || plan.sounds.length > 0) {
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
      this.#renderer()?.retimeSpellVisual?.(active.handle, active.startedAt + active.duration);
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
      this.#renderer()?.retimeSpellVisual?.(active.handle, now + event.remaining);
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
    this.#auraSnapshot.set(event.guid, new Map(event.current));
    for (const removed of event.removed) this.#removeState(world, event.guid, removed, now);
    for (const added of event.added) this.#addState(world, event.guid, added, now);
    for (const updated of event.updated) {
      if (updated.before.spellId !== updated.after.spellId) continue;
      const key = this.#stateKey(event.guid, updated.after);
      const endsAt = updated.after.expiresAt ?? Number.POSITIVE_INFINITY;
      this.#retimeStateOwnership(key, endsAt);
      this.#retimeDeferredState(key, endsAt, now);
    }
    this.#reconcileState(world);
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
    const donePrefix = `done:${guid}:${aura.slot}:${aura.spellId}:`;
    for (let index = this.#pending.aura.length - 1; index >= 0; index--) {
      if (this.#pending.aura[index]!.key.startsWith(donePrefix)) this.#pending.aura.splice(index, 1);
    }
    if (this.#stateShown.has(key) || this.#pending.aura.some((entry) => entry.key === `state:${key}`)) return;
    const capturedPoint = this.#objectPoint(world, guid);
    const replay = (replayNow: number): void => {
      const current = this.#auraSnapshot.get(guid)?.get(aura.slot);
      if (!current || current.spellId !== aura.spellId) return;
      const visual = this.#getVisual(aura.spellId);
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
    const visual = this.#getVisual(aura.spellId);
    if (!visual) {
      this.#metadataSource.get(aura.spellId);
      if (!this.#knownNoVisual.has(aura.spellId)) {
        this.#enqueue({ kind: "aura", spellId: aura.spellId, key: `state:${key}`, receivedAt: now, epoch: this.#epoch, replay });
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
    for (let index = this.#pending.aura.length - 1; index >= 0; index--) {
      if (this.#pending.aura[index]!.key === `state:${key}`) this.#pending.aura.splice(index, 1);
    }
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
      this.#metadataSource.get(aura.spellId);
      if (!this.#knownNoVisual.has(aura.spellId)) {
        this.#enqueue({ kind: "aura", spellId: aura.spellId, key: `done:${guid}:${aura.slot}:${aura.spellId}:${this.#receiptSequence++}`, receivedAt: now, epoch: this.#epoch, replay });
      }
      return;
    }
    replay(now);
  }

  #reconcileState(world: SpellVisualLifecycleWorld | undefined, replayAdd = true): void {
    if (!world || !this.#active || this.#world !== world) return;
    const byUnit = new Map<bigint, StateVisualDescriptor[]>();
    for (const [guid, auras] of this.#auraSnapshot) {
      for (const aura of auras.values()) {
        this.#addState(world, guid, aura, this.#now(), replayAdd);
        const visual = this.#getVisual(aura.spellId);
        if (!visual?.state) continue;
        const effects = byUnit.get(guid) ?? [];
        for (const effect of visual.state.effects) {
          effects.push({
            spellId: aura.spellId, path: effect.path, attachment: effect.attachment, scale: effect.scale,
            ...(effect.occurrence ? { occurrence: effect.occurrence } : {}),
            ...(effect.transform ? { transform: effect.transform } : {}),
          });
        }
        if (effects.length > 0) byUnit.set(guid, effects);
      }
    }
    this.#renderer()?.setStateVisuals(byUnit);
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
    const renderer = this.#renderer();
    if (!renderer) {
      if (deferIfMissingRenderer && (instances.length > 0 || animations.length > 0 || plan.sounds.length > 0)) {
        this.#deferred.push({ plan, receivedAt, epoch: this.#epoch, world, ...(state ? { state } : {}) });
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
    if (instances.length === 0 && animations.length === 0) {
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
    for (let index = this.#sounds.length - 1; index >= 0; index--) {
      const sound = this.#sounds[index]!;
      if (sound.stateKey !== key) continue;
      if (expectedPresent !== undefined && sound.stateExpectedPresent !== expectedPresent) continue;
      this.#sounds.splice(index, 1);
    }
  }

  #cancelStateDeferred(key: string, expectedPresent?: boolean): void {
    for (let index = this.#deferred.length - 1; index >= 0; index--) {
      const state = this.#deferred[index]!.state;
      if (state?.key !== key) continue;
      if (expectedPresent !== undefined && state.expectedPresent !== expectedPresent) continue;
      this.#deferred.splice(index, 1);
    }
    this.#cancelStateSounds(key, expectedPresent);
  }

  #retimeDeferredState(key: string, endsAt: number, receivedAt: number): void {
    if (!Number.isFinite(endsAt)) return;
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
    while (this.#sounds.length > this.#caps.sounds) this.#sounds.shift();
  }
}
