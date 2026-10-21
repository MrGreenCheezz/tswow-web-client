// The world and the renderer as `SwingReactionCues` needs them (6.06, line A7a, 05.10-A7a-D2).
//
// Kept out of EnterWorld: the session wires one `SwingMeleeReactions` per world entry and disposes it
// with the entry. Every callback here is created once; the per-frame work is the cues' own walk.
//
// 22.10 ARC-2 S4a: nothing here is called by the renderer any more. A swing is queued under an id this side
// allocates (`playUnitAction(..., id)`); the renderer publishes each watched swing's progress at the moment its
// units have animated (RenderResults.ts `swings`, SwingProgressWatch.ts), and the loop ticks the cues from that
// record once `draw` has returned (`afterDraw`). The `+0xa20` answer for a kit's wound is pushed as data
// (`setMeleeTargets`) before every draw, after every SMSG_ATTACK_START/STOP, and before a spell visual is played.

import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { allocateRenderId } from "../RenderCommandIds.js";
import type { RenderResults } from "../RenderResults.js";
import type { CombatReaction } from "./CombatAnimations.js";
import {
  HITINFO_NO_ANIMATION, SWING_NOMINAL_MS, SwingReactionCues, type CuedSwing, type SwingCueHost,
} from "./SwingReactionCues.js";

const FIELD_HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FIELD_FLAGS_2 = UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset;
const FIELD_BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;
/** `UNIT_FLAG2_FEIGN_DEATH`, `UnitDefines.h:184`. */
const UNIT_FLAG2_FEIGN_DEATH = 0x1;
/** `SHEATH_STATE_UNARMED` (byte 0 of `UNIT_FIELD_BYTES_2`). */
const SHEATH_STATE_UNARMED = 0;

/** The renderer commands the cues send, and the record they read back (22.10 ARC-2 S4a). */
export interface SwingReactionRenderer {
  /** Queues the swing; `id` names it in `results.swings` until {@link releaseUnitAction}. */
  playUnitAction(guid: bigint, action: "attack" | "attackOff", hold: number, id: number): number | undefined;
  playUnitReaction(guid: bigint, reaction: CombatReaction): void;
  /** The cue record of swing `id` is gone: the renderer stops publishing it. */
  releaseUnitAction(id: number): void;
  /** 05.10-6.21: the units with a melee target of their own (`+0xa20`), for a kit's wound; undefined clears `owner`'s. */
  setMeleeTargets(units: ReadonlySet<bigint> | undefined, owner: number): void;
  readonly results: Pick<RenderResults, "swings" | "swingFrame" | "swingNow">;
}

/** The world state the cues read: which units the client has, and their fields. */
export interface SwingReactionWorld {
  readonly objects: ReadonlyMap<bigint, { readonly fields: ReadonlyMap<number, number> }>;
}

/** One world entry's melee reactions: swings in, reactions out at the attackers' event moments. */
export class SwingMeleeReactions {
  readonly #cues = new SwingReactionCues((token) => this.#release(token)); // 22.10 ARC-2 S4a
  readonly #world: SwingReactionWorld;
  readonly #renderer: () => SwingReactionRenderer | undefined;
  /** 22.10 ARC-2 S4a: the swing record the running tick reads (the renderer's last frame). */
  #results: SwingReactionRenderer["results"] | undefined;
  /** 22.10 ARC-2 S4a: the renderer and frame the cues last ticked on — one tick per drawn frame, as `afterUnits` was. */
  #tickedRenderer: SwingReactionRenderer | undefined;
  #tickedFrame = 0;
  /** 22.10 ARC-2 S4a: what was last pushed to which renderer, under this entry's owner id. */
  readonly #owner = allocateRenderId();
  #pushedTo: SwingReactionRenderer | undefined;
  #pushed: ReadonlySet<bigint> = new Set();
  readonly #scratch = new Set<bigint>();
  readonly #host: SwingCueHost = {
    swingProgress: (attacker, token) => {
      // 22.10 ARC-2 S4a: the published row of the swing's id; no row is what an undefined token or a renderer
      // that never queued it answered (`meleeSwingProgress` → null).
      const row = typeof token === "number" ? this.#results?.swings.get(token) : undefined;
      const progress = row?.progress ?? null;
      if (typeof progress === "number") return progress;
      // 05.10-A7a-D3: a gone or dead attacker plays no events; neither does a drawn swing cut short.
      if (!this.#present(attacker)) return null;
      if (row?.started === true) return null;
      return undefined; // not drawn by us, still swinging in Wow.exe: the cues' nominal clock
    },
    swingDuration: (_attacker, token) => {
      const seconds = typeof token === "number" ? this.#results?.swings.get(token)?.swingSeconds : undefined;
      return seconds !== undefined && seconds > 0 ? seconds * 1_000 : SWING_NOMINAL_MS;
    },
    sameUnit: (unit, stamp) => this.#world.objects.get(unit) === stamp, // 05.10-A7a-D3
    canReact: (victim) => {
      const fields = this.#world.objects.get(victim)?.fields;
      if (fields === undefined) return false;
      const health = fields.get(FIELD_HEALTH);
      if (health !== undefined && health <= 0) return false;
      return ((fields.get(FIELD_FLAGS_2) ?? 0) & UNIT_FLAG2_FEIGN_DEATH) === 0;
    },
    sheathed: (victim) => {
      const bytes2 = this.#world.objects.get(victim)?.fields.get(FIELD_BYTES_2);
      return bytes2 !== undefined && (bytes2 & 0xff) === SHEATH_STATE_UNARMED;
    },
    react: (victim, reaction) => this.#renderer()?.playUnitReaction(victim, reaction),
  };

  constructor(world: SwingReactionWorld, renderer: () => SwingReactionRenderer | undefined) {
    this.#world = world;
    this.#renderer = renderer;
    this.syncMeleeTargets();
  }

  /** SMSG_ATTACKERSTATEUPDATE: the attacker swings now; its victim reacts at the swing's events. */
  swing(swing: CuedSwing, action: "attack" | "attackOff"): void {
    // 0x755130 draws no swing for HITINFO_NO_ANIMATION, and without a swing there is no event.
    // 22.10 ARC-2 S4a: the id is this side's; a renderer that refuses or lacks the swing publishes no row for it.
    const id = (swing.hitInfo & HITINFO_NO_ANIMATION) === 0 ? allocateRenderId() : undefined;
    if (id !== undefined) this.#renderer()?.playUnitAction(swing.attacker, action, 0, id);
    const kept = this.#cues.swing(swing, id, this.#world.objects.has(swing.attacker), this.#host);
    // A swing no record waits on (an unknown attacker, a miss) is still drawn; only its progress is not wanted.
    if (!kept && id !== undefined) this.#release(id);
  }

  /** SMSG_ATTACK_START / SMSG_ATTACK_STOP of any attacker. */
  meleeAttack(attacker: bigint, victim: bigint | undefined): void {
    if (victim === undefined) this.#cues.attackStopped(attacker);
    // 05.10 review D2: 0x756800 case 0x143 looks the attacker up and returns when it is not there:
    // no `+0xa20` for a unit the client does not have (its creation resends the start, Player.cpp:23052).
    // 05.10-A7a-D3: stamped with the unit object, so a unit destroyed and created again (left view
    // while swinging) starts without `+0xa20` until its next SMSG_ATTACK_START.
    else {
      const unit = this.#world.objects.get(attacker);
      if (unit !== undefined) this.#cues.attackStarted(attacker, victim, unit);
    }
    this.syncMeleeTargets(); // 05.10-6.21; 22.10 ARC-2 S4a: pushed, not asked
  }

  /**
   * 22.10 ARC-2 S4a: once `draw` has returned — the cues' per-frame walk on the swing record that frame published,
   * at that frame's `now`. A frame that never reached the units (no player, a lost context, a throw before them)
   * published nothing and ticks nothing, as `afterUnits` was not called on it.
   */
  afterDraw(): void {
    const renderer = this.#renderer();
    if (renderer === undefined) return;
    const results = renderer.results;
    if (renderer === this.#tickedRenderer && results.swingFrame === this.#tickedFrame) return;
    this.#tickedRenderer = renderer;
    this.#tickedFrame = results.swingFrame;
    if (results.swingFrame === 0) return; // a renderer that has not drawn its units yet
    this.#results = results;
    try {
      this.#cues.tick(results.swingNow, this.#host);
    } finally {
      this.#results = undefined;
    }
  }

  /**
   * 05.10-6.21, 22.10 ARC-2 S4a: hands the renderer the units whose `+0xa20` counts now, when that changed or the
   * renderer did. Called before every draw and before a spell visual is dispatched, so a unit recreated since the
   * last push (its stamp gone) is never answered from a stale set.
   */
  syncMeleeTargets(): void {
    const renderer = this.#renderer();
    if (renderer === undefined) return;
    const next = this.#scratch;
    next.clear();
    this.#cues.meleeTargetUnits(this.#host, next);
    if (renderer === this.#pushedTo && sameUnits(next, this.#pushed)) return;
    this.#pushed = new Set(next);
    this.#pushedTo = renderer;
    renderer.setMeleeTargets(this.#pushed, this.#owner);
  }

  /** 05.10-A7a-D3: the attacker is still in the world and alive. */
  #present(attacker: bigint): boolean {
    const fields = this.#world.objects.get(attacker)?.fields;
    if (fields === undefined) return false;
    const health = fields.get(FIELD_HEALTH);
    return health === undefined || health > 0;
  }

  /** 22.10 ARC-2 S4a: a cue record left — its swing need not be published any more. */
  #release(token: unknown): void {
    if (typeof token === "number") this.#renderer()?.releaseUnitAction(token);
  }

  dispose(): void {
    this.#cues.clear();
    // 05.10-6.21: only this entry's set is taken back; a later entry's push stays.
    this.#pushedTo?.setMeleeTargets(undefined, this.#owner);
    this.#pushedTo = undefined;
    this.#tickedRenderer = undefined;
  }
}

function sameUnits(a: ReadonlySet<bigint>, b: ReadonlySet<bigint>): boolean {
  if (a.size !== b.size) return false;
  for (const unit of a) if (!b.has(unit)) return false;
  return true;
}
