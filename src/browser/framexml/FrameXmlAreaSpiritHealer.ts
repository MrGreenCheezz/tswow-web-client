/**
 * The battleground spirit guide's resurrection queue, as the stock client drives it (plan items 5.25
 * and 3.14, L3): UIParent's AREA_SPIRIT_HEALER_IN_RANGE answers with `AcceptAreaSpiritHeal()` and
 * the AREA_SPIRIT_HEAL dialog, whose clock is `GetAreaSpiritHealerTime()` and whose button is
 * `CancelAreaSpiritHeal()`; AREA_SPIRIT_HEALER_OUT_OF_RANGE hides it (UIParent.lua:741-749,
 * StaticPopup.lua:2315-2329). Nothing in the client fired either event or answered the three names
 * before this model (`WorldClient.queueForSpiritHealer` had no caller).
 *
 * The original client (Wow.exe 3.3.5a build 12340, read-only Ghidra; registration entries at
 * 0xac86f8/0xac8700/0xac8708; event ids 0x1d1/0x1d2 from the name table), in this file's words:
 * * One guide at a time (GameUI 0x00bd0838) and one clock (0x00bd0840, 0 = none). Every frame
 *   (0x4fa040 → 0x524010) a player who is not a ghost (PLAYER_FLAGS 0x10) drops the guide; a ghost
 *   keeps it while it exists within 22 yards (squared distance ≤ 484, 0xa02d1c), else drops it, and
 *   with none takes a unit in view (0x523f80) that carries UNIT_NPC_FLAGS 0x8000 (spirit guide),
 *   passes the "may assist" test and stands within 20 yards (≤ 400, 0x9e898c). L3-review: the test
 *   is 0x7293d0 with ECX = the guide and the player as its argument (0x523fbd-0x523fc5), i.e.
 *   TrinityCore's Unit::IsValidAssistTarget(guide, player), so the flags it reads are the player's:
 *   not selectable (0x2000000); immune to NPCs (0x200), or to PCs (0x100) for a player-controlled
 *   guide (0x8); the guide's reaction to the player at least friendly; and, for a player-controlled
 *   player, the FFA (0x04) and sanctuary (0x08) bits of UNIT_FIELD_BYTES_2 byte 1 against the
 *   guide's. Not modelled: the duel test (both sides need a player owner, a creature guide has
 *   none), CREATURE_TYPE_FLAG_TREAT_AS_RAID_UNIT lifting the reaction test, and 0x715f90/0x715df0
 *   for a player-controlled guide and a player that is not. 0x523f80 also keeps enumerating after a
 *   match (it returns 1), so with two guides in 20 yards Wow.exe asks each and keeps the last one
 *   its object order gives; this file takes the first in `state.objects` order and asks once.
 * * Changing the guide (0x523eb0): if a clock was running, 0x51f710 (below) runs and the clock
 *   stops; a new guide is asked with CMSG_AREA_SPIRIT_HEALER_QUERY (u64 guid).
 * * SMSG_AREA_SPIRIT_HEALER_TIME (u64 guid, u32 ms; 0x526530 case 0x2e4 → 0x524b10): after the same
 *   validation, an answer for the current guide with more than 0 ms sets the clock to now + ms and
 *   fires AREA_SPIRIT_HEALER_IN_RANGE — every such answer, not only the first. The compare is a
 *   signed int's (L3-review): 2^31 ms and more is no answer.
 * * `GetAreaSpiritHealerTime` (0x516b90): the clock minus now, at least 0, divided by 1000 as an
 *   integer; 0 without a clock.
 * * `AcceptAreaSpiritHeal` (0x5262d0 → 0x524b60): the same validation, then
 *   CMSG_AREA_SPIRIT_HEALER_QUEUE (u64 guid) when a guide is held.
 * * `CancelAreaSpiritHeal` (0x522fa0 → 0x51f710 → the aura-cancel path 0x802f80 for spell 2584,
 *   Waiting to Resurrect): AREA_SPIRIT_HEALER_OUT_OF_RANGE, then CMSG_CANCEL_AURA 2584. The guide and
 *   the clock stay as they are.
 * TrinityCore: the query needs a creature that `IsSpiritService()` and answers `30000 −
 * GetLastResurrectTime()` (MiscHandler.cpp:1479-1500, BattlegroundMgr.cpp:770-778); the queue casts
 * 2584 on the player (MiscHandler.cpp:1502-1523, Battleground.cpp:1561-1570); removing 2584 takes
 * the player out of the queue (SpellAuraEffects.cpp:4521-4527).
 *
 * This client: the scan and the packet edge run on LiveWorldSeam's 60 ms poll; the answer is read
 * from `WorldClient.spiritHealerTimers` (its entry object is replaced per packet, so identity marks a
 * new answer, and its `receivedAt` is the packet's own moment). The model acts only while stock owns
 * the popups (`FrameXmlPopupsModel.popupsOwned`): with the native prompts in charge nothing is asked
 * and nothing is fired, as before. Not done: Wow.exe also re-asks when the player right-clicks a
 * guide without a gossip flag (0x6ddbb0 → 0x6db180); that dispatch is not FrameXML's.
 */
import { isPlayerGhost, readField, unit as unitField } from "../../world/Fields.js"; // L3-review: unitField
import { REACTION_FRIENDLY } from "../../world/FactionRules.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/** Spell 2584, Waiting to Resurrect (Battleground.h:133). */
export const FRAMEXML_WAITING_TO_RESURRECT_SPELL = 2584;
/** 0x9e898c: a guide is taken within 20 yards (squared). */
export const FRAMEXML_AREA_SPIRIT_HEALER_TAKE_SQUARED = 400;
/** 0xa02d1c: a guide is kept within 22 yards (squared, 484.00003 in the binary). */
export const FRAMEXML_AREA_SPIRIT_HEALER_KEEP_SQUARED = 484;
export const FRAMEXML_AREA_SPIRIT_HEALER_IN_RANGE = "AREA_SPIRIT_HEALER_IN_RANGE";
export const FRAMEXML_AREA_SPIRIT_HEALER_OUT_OF_RANGE = "AREA_SPIRIT_HEALER_OUT_OF_RANGE";
/** UNIT_NPC_FLAG_SPIRITGUIDE (the bit 0x523f80 tests). */
const NPC_FLAG_SPIRIT_GUIDE = 0x8000;
/** UNIT_FLAG_NOT_SELECTABLE (0x7293d0 refuses it first — on the player, L3-review). */
const UNIT_FLAG_NOT_SELECTABLE = 0x2000000;
/** L3-review: UNIT_FLAG_PLAYER_CONTROLLED, IMMUNE_TO_PC, IMMUNE_TO_NPC (UnitDefines.h:138-144). */
const UNIT_FLAG_PLAYER_CONTROLLED = 0x8;
const UNIT_FLAG_IMMUNE_TO_PC = 0x100;
const UNIT_FLAG_IMMUNE_TO_NPC = 0x200;
/** L3-review: UNIT_FIELD_BYTES_2 byte 1 — PvP, free-for-all PvP, sanctuary. */
const PVP_FLAG_PVP = 0x01;
const PVP_FLAG_FFA = 0x04;
const PVP_FLAG_SANCTUARY = 0x08;
const TYPEID_UNIT = 3;

export interface FrameXmlAreaSpiritHealerTimer {
  readonly milliseconds: number;
  readonly receivedAt: number;
}

/** The world facts and commands the model reads; `WorldClient` satisfies it structurally. */
export interface FrameXmlAreaSpiritHealerWorld {
  /** SMSG_AREA_SPIRIT_HEALER_TIME by healer guid; a new object per packet. */
  readonly spiritHealerTimers?: ReadonlyMap<bigint, FrameXmlAreaSpiritHealerTimer> | undefined;
  queryAreaSpiritHealer?(healerGuid: bigint): void;
  queueAreaSpiritHealer?(healerGuid: bigint): void;
  cancelAura?(spellId: number): void;
}

export interface FrameXmlAreaSpiritHealerContext {
  world(): FrameXmlAreaSpiritHealerWorld | undefined;
  /** `performance.now()` milliseconds, the clock `spiritHealerTimers[].receivedAt` is stamped in. */
  now(): number;
  /** PLAYER_FLAGS_GHOST on the player. */
  ghost(): boolean;
  /** Stock owns the confirmations (`FrameXmlPopupsModel.popupsOwned`). */
  owned(): boolean;
  /** Squared distance from the player to the unit; undefined when it is not in view. */
  distanceSquared(guid: bigint): number | undefined;
  /** A unit 0x523f80 accepts within the squared limit, or undefined. */
  findGuide(limitSquared: number): bigint | undefined;
}

interface FrameXmlAreaSpiritHealerPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export class FrameXmlAreaSpiritHealerModel {
  readonly #context: FrameXmlAreaSpiritHealerContext;
  #pump: FrameXmlAreaSpiritHealerPump | undefined;
  #world: FrameXmlAreaSpiritHealerWorld | undefined;
  /** 0x00bd0838: the guide in range. */
  #healer: bigint | undefined;
  /** 0x00bd0840: when the next sweep is, in `now()` milliseconds; 0 without one. */
  #deadline = 0;
  /** The timer entry already taken (or already there when the guide was taken). */
  #consumed: FrameXmlAreaSpiritHealerTimer | undefined;

  constructor(context: FrameXmlAreaSpiritHealerContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlAreaSpiritHealerPump): void {
    this.detach();
    this.#pump = pump;
    this.tick();
  }

  detach(): void {
    this.#pump = undefined;
    this.#world = undefined;
    this.#forget();
  }

  /** LiveWorldSeam's 60 ms poll: the per-frame validation of 0x524010 and the packet edge of 0x524b10. */
  tick(): void {
    if (!this.#pump) return;
    const world = this.#current();
    if (!world) return;
    this.#validate(world);
    const healer = this.#healer;
    if (healer === undefined) return;
    const timer = world.spiritHealerTimers?.get(healer);
    if (timer === undefined || timer === this.#consumed) return;
    this.#consumed = timer;
    if (!((timer.milliseconds | 0) > 0)) return; // L3-review: 0x524b10's `0 < (int)ms`
    this.#deadline = timer.receivedAt + timer.milliseconds || 1;
    this.#pump.fire(FRAMEXML_AREA_SPIRIT_HEALER_IN_RANGE);
  }

  /** `GetAreaSpiritHealerTime()` (0x516b90). */
  seconds(): number {
    if (this.#deadline === 0) return 0;
    return Math.trunc(Math.max(0, this.#deadline - this.#context.now()) / 1000);
  }

  /** `AcceptAreaSpiritHeal()` (0x524b60). */
  accept(): void {
    if (!this.#pump) return;
    const world = this.#current();
    if (!world) return;
    this.#validate(world);
    if (this.#healer !== undefined) world.queueAreaSpiritHealer?.(this.#healer);
  }

  /** `CancelAreaSpiritHeal()` (0x51f710). */
  cancel(): void {
    if (!this.#pump) return;
    const world = this.#current();
    if (world) this.#cancelAura(world);
  }

  /** The world while stock owns the popups; a new world or lost ownership forgets without a packet. */
  #current(): FrameXmlAreaSpiritHealerWorld | undefined {
    const world = this.#context.world();
    if (world !== this.#world) {
      this.#world = world;
      this.#forget();
    }
    if (!world || !this.#context.owned()) {
      this.#forget();
      return undefined;
    }
    return world;
  }

  #forget(): void {
    this.#healer = undefined;
    this.#deadline = 0;
    this.#consumed = undefined;
  }

  /** 0x524010. */
  #validate(world: FrameXmlAreaSpiritHealerWorld): void {
    if (!this.#context.ghost()) {
      this.#select(world, undefined);
      return;
    }
    if (this.#healer !== undefined) {
      const distance = this.#context.distanceSquared(this.#healer);
      if (distance === undefined || distance > FRAMEXML_AREA_SPIRIT_HEALER_KEEP_SQUARED) this.#select(world, undefined);
    }
    if (this.#healer === undefined) {
      const guide = this.#context.findGuide(FRAMEXML_AREA_SPIRIT_HEALER_TAKE_SQUARED);
      if (guide !== undefined) this.#select(world, guide);
    }
  }

  /** 0x523eb0. */
  #select(world: FrameXmlAreaSpiritHealerWorld, guid: bigint | undefined): void {
    if (guid === this.#healer) return;
    this.#healer = guid;
    if (this.#deadline !== 0) this.#cancelAura(world);
    this.#deadline = 0;
    if (guid === undefined) return;
    this.#consumed = world.spiritHealerTimers?.get(guid);
    world.queryAreaSpiritHealer?.(guid);
  }

  /** 0x51f710 → 0x802f80 for spell 2584: the event first, then the packet. */
  #cancelAura(world: FrameXmlAreaSpiritHealerWorld): void {
    this.#pump?.fire(FRAMEXML_AREA_SPIRIT_HEALER_OUT_OF_RANGE);
    world.cancelAura?.(FRAMEXML_WAITING_TO_RESURRECT_SPELL);
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlAreaSpiritHealerHost {
  readonly areaSpiritHealer?: FrameXmlAreaSpiritHealerModel | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

export const FRAMEXML_AREA_SPIRIT_HEALER_BINDINGS: Readonly<Record<string,
  (host: FrameXmlAreaSpiritHealerHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetAreaSpiritHealerTime: (host) => [host.areaSpiritHealer?.seconds() ?? 0],
  AcceptAreaSpiritHeal: (host) => {
    host.areaSpiritHealer?.accept();
    return NOTHING;
  },
  CancelAreaSpiritHeal: (host) => {
    host.areaSpiritHealer?.cancel();
    return NOTHING;
  },
});

/** What LiveWorldSeam hands the live context. */
export interface FrameXmlAreaSpiritHealerLiveHost {
  world(): (FrameXmlAreaSpiritHealerWorld & {
    readonly state: { readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  }) | undefined;
  /** The player's own object, as the seam resolves `"player"`. */
  self(): WorldObjectState | undefined;
  /** The mount's FactionTemplate resolver (`reactionBetween`); absent, no unit reads friendly. */
  reaction?(self: WorldObjectState, other: WorldObjectState): number | undefined;
  owned(): boolean;
  monotonic(): number;
}

/**
 * L3-review: 0x7293d0 with the guide as `this` and the player as the target, without the reaction
 * (the caller asks the mount's resolver) — the flag tests in the order the function makes them.
 */
function guideMayAssist(guide: WorldObjectState, player: WorldObjectState): boolean {
  const playerFlags = readField(player, "UNIT_FIELD_FLAGS") ?? 0;
  if ((playerFlags & UNIT_FLAG_NOT_SELECTABLE) !== 0) return false;
  const guideFlags = readField(guide, "UNIT_FIELD_FLAGS") ?? 0;
  const immune = (guideFlags & UNIT_FLAG_PLAYER_CONTROLLED) !== 0 ? UNIT_FLAG_IMMUNE_TO_PC : UNIT_FLAG_IMMUNE_TO_NPC;
  if ((playerFlags & immune) !== 0) return false;
  if ((playerFlags & UNIT_FLAG_PLAYER_CONTROLLED) === 0) return true;
  const playerPvp = unitField.pvpFlags(player) ?? 0;
  const guidePvp = unitField.pvpFlags(guide) ?? 0;
  if ((playerPvp & PVP_FLAG_FFA) !== 0 && (guidePvp & PVP_FLAG_FFA) === 0) return false;
  return !((guidePvp & PVP_FLAG_SANCTUARY) !== 0 && (playerPvp & PVP_FLAG_SANCTUARY) === 0
    && (playerPvp & PVP_FLAG_PVP) !== 0);
}

function squaredDistance(a: WorldObjectState, b: WorldObjectState): number | undefined {
  const from = a.position;
  const to = b.position;
  if (!from || !to) return undefined;
  const x = to.x - from.x;
  const y = to.y - from.y;
  const z = to.z - from.z;
  return x * x + y * y + z * z;
}

/** The model's context over a live world: positions, flags and the reaction the mount resolves. */
export function frameXmlAreaSpiritHealerLiveContext(host: FrameXmlAreaSpiritHealerLiveHost): FrameXmlAreaSpiritHealerContext {
  return {
    world: () => host.world(),
    now: () => host.monotonic(),
    ghost: () => {
      const self = host.self();
      return self !== undefined && isPlayerGhost(self);
    },
    owned: () => host.owned(),
    distanceSquared: (guid) => {
      const self = host.self();
      const unit = host.world()?.state.objects.get(guid);
      return self && unit ? squaredDistance(self, unit) : undefined;
    },
    findGuide: (limitSquared) => {
      const self = host.self();
      const objects = host.world()?.state.objects;
      if (!self || !objects) return undefined;
      for (const unit of objects.values()) {
        if (unit.typeId !== TYPEID_UNIT || unit.guid === self.guid) continue;
        if (((readField(unit, "UNIT_NPC_FLAGS") ?? 0) & NPC_FLAG_SPIRIT_GUIDE) === 0) continue;
        if (!guideMayAssist(unit, self)) continue; // L3-review: the player's flags (0x7293d0)
        const distance = squaredDistance(self, unit);
        if (distance === undefined || distance > limitSquared) continue;
        if (host.reaction?.(self, unit) !== REACTION_FRIENDLY) continue;
        return unit.guid;
      }
      return undefined;
    },
  };
}
