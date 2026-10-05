// The world and the renderer as `SwingReactionCues` needs them (6.06, line A7a, 05.10-A7a-D2).
//
// Kept out of EnterWorld: the session wires one `SwingMeleeReactions` per world entry and disposes it
// with the entry. Every callback here is created once; the per-frame work is the cues' own walk.

import { UPDATE_FIELDS } from "../../generated/updateFields.js";
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

/**
 * 05.10-A7a-D3: what the host reads of a swing's token (the renderer's queue entry): whether its clip
 * ever started, and the clip length the renderer resolved for a swing it could not draw.
 */
export interface SwingToken {
  readonly started?: boolean;
  readonly payload?: { readonly swingSeconds?: number | undefined };
}

/** The renderer methods the cues use. */
export interface SwingReactionRenderer {
  playUnitAction(guid: bigint, action: "attack" | "attackOff"): SwingToken | undefined;
  playUnitReaction(guid: bigint, reaction: CombatReaction): void;
  meleeSwingProgress(guid: bigint, token: object, now: number): number | undefined | null;
  afterUnits: ((now: number) => void) | undefined;
  /** 05.10-6.21: a kit wound's melee-target question (WorldRenderer3D `#setUnitAnimation`). */
  kitWoundCombat?: ((guid: bigint) => boolean) | undefined;
}

/** The world state the cues read: which units the client has, and their fields. */
export interface SwingReactionWorld {
  readonly objects: ReadonlyMap<bigint, { readonly fields: ReadonlyMap<number, number> }>;
}

/** One world entry's melee reactions: swings in, reactions out at the attackers' event moments. */
export class SwingMeleeReactions {
  readonly #cues = new SwingReactionCues();
  readonly #world: SwingReactionWorld;
  readonly #renderer: () => SwingReactionRenderer | undefined;
  #attached: SwingReactionRenderer | undefined;
  readonly #tick = (now: number): void => this.#cues.tick(now, this.#host);
  readonly #kitWoundCombat = (guid: bigint): boolean => this.#cues.hasMeleeTarget(guid, this.#host); // 05.10-6.21
  readonly #host: SwingCueHost = {
    swingProgress: (attacker, token, now) => {
      const progress = token === undefined ? null : this.#renderer()?.meleeSwingProgress(attacker, token, now) ?? null;
      if (typeof progress === "number") return progress;
      // 05.10-A7a-D3: a gone or dead attacker plays no events; neither does a drawn swing cut short.
      if (!this.#present(attacker)) return null;
      if (progress === null && (token as SwingToken | undefined)?.started === true) return null;
      return undefined; // not drawn by us, still swinging in Wow.exe: the cues' nominal clock
    },
    swingDuration: (_attacker, token) => {
      const seconds = (token as SwingToken | undefined)?.payload?.swingSeconds;
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
    this.#attach();
  }

  /** SMSG_ATTACKERSTATEUPDATE: the attacker swings now; its victim reacts at the swing's events. */
  swing(swing: CuedSwing, action: "attack" | "attackOff"): void {
    const renderer = this.#attach();
    // 0x755130 draws no swing for HITINFO_NO_ANIMATION, and without a swing there is no event.
    const token = (swing.hitInfo & HITINFO_NO_ANIMATION) === 0 ? renderer?.playUnitAction(swing.attacker, action) : undefined;
    this.#cues.swing(swing, token, this.#world.objects.has(swing.attacker), this.#host);
  }

  /** SMSG_ATTACK_START / SMSG_ATTACK_STOP of any attacker. */
  meleeAttack(attacker: bigint, victim: bigint | undefined): void {
    this.#attach(); // 05.10-6.21: the renderer asks for `+0xa20` from the first start on
    if (victim === undefined) this.#cues.attackStopped(attacker);
    // 05.10 review D2: 0x756800 case 0x143 looks the attacker up and returns when it is not there:
    // no `+0xa20` for a unit the client does not have (its creation resends the start, Player.cpp:23052).
    // 05.10-A7a-D3: stamped with the unit object, so a unit destroyed and created again (left view
    // while swinging) starts without `+0xa20` until its next SMSG_ATTACK_START.
    else {
      const unit = this.#world.objects.get(attacker);
      if (unit !== undefined) this.#cues.attackStarted(attacker, victim, unit);
    }
  }

  /** 05.10-A7a-D3: the attacker is still in the world and alive. */
  #present(attacker: bigint): boolean {
    const fields = this.#world.objects.get(attacker)?.fields;
    if (fields === undefined) return false;
    const health = fields.get(FIELD_HEALTH);
    return health === undefined || health > 0;
  }

  dispose(): void {
    this.#cues.clear();
    if (this.#attached !== undefined && this.#attached.afterUnits === this.#tick) this.#attached.afterUnits = undefined;
    if (this.#attached?.kitWoundCombat === this.#kitWoundCombat) this.#attached.kitWoundCombat = undefined; // 05.10-6.21
    this.#attached = undefined;
  }

  #attach(): SwingReactionRenderer | undefined {
    const renderer = this.#renderer();
    if (renderer !== undefined && renderer !== this.#attached) {
      this.#attached = renderer;
      renderer.afterUnits = this.#tick;
      renderer.kitWoundCombat = this.#kitWoundCombat; // 05.10-6.21
    }
    return renderer;
  }
}
