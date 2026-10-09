import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import type { WorldObjectState } from "./WorldState.js";

/**
 * 11.02-I: `PLAYER_FARSIGHT` — the object the server sees the world from for this character — and
 * the `CMSG_FAR_SIGHT` vote the stock client casts on it.
 *
 * Server side, `Player::SetViewpoint` (Player.cpp:24953-24991) writes the field and moves the seer.
 * Its writers: taking a unit's controls, whether or not moving it is allowed (`Player::
 * SetClientControl`, Player.cpp:24594-24604 — Mind Control, Eyes of the Beast, Eye of Kilrogg, a
 * vehicle's driving seat), `SPELL_AURA_BIND_SIGHT` (Mind Vision), a caster's far sight
 * DynamicObject (shaman Far Sight) and a cinematic's camera creature. Clearing the field is the only
 * release there is: `SMSG_CLEAR_FAR_SIGHT_IMMEDIATE` is never built (Player.cpp:24989-24990).
 *
 * Client side (Wow.exe 3.3.5a 12340): the field's change callback is 0x006e4fd0, registered for the
 * player block's offset 0x770 (word 624) at 0x006e5180. It looks the guid up among the objects in
 * view (0x004f7310 → 0x004d4db0, any type) and calls 0x006e2880, which keeps an "engaged" latch in
 * bit 0 of the player's +0x1858:
 * - the object is in view and the latch is clear → `CMSG_FAR_SIGHT` with `u8 1`, latch set, the
 *   camera's target becomes that object (0x004f6f50 → 0x006066e0);
 * - the field is zero and the latch is set → latch cleared, `CMSG_FAR_SIGHT` with `u8 0`, camera home;
 * - the field is set but its object is not in view → camera home, nothing sent, the latch kept;
 * - another object while engaged → the camera moves to it, nothing sent.
 * The same call is made when a far sight DynamicObject of this player's arrives after the field
 * (0x00705230), at world entry for a charm that is the far sight (0x006e7f50), and from the world
 * frame when the camera's target has vanished (0x004fa5f0). So the 1 waits for the object and the 0
 * is never sent while the field still names something: a 0 under a live far sight would take the
 * server's view home (`HandleFarSightOpcode`, MiscHandler.cpp:1251-1273: 1 → `SetSeer(GetViewpoint())`,
 * 0 → `SetSeer(player)`), and both votes as cast here repeat what `SetViewpoint` already did.
 *
 * 11.02-I review: 0x006e2880 called without force (0) toggles — with the latch set it clears it,
 * sends the 0 and takes the camera home even while the field names an object in view. The callers
 * that do so are 0x006e2b00 (the callback's branch for a field whose object is not in view, and the
 * handler of `SMSG_CLEAR_FAR_SIGHT_IMMEDIATE` 0x20D in 0x006e2e90, a packet the core never builds)
 * and 0x004fa5f0 (the camera's target gone): there the field's object is not in view, so it reads
 * as "camera home, nothing sent". The callback (0x006e502f), world entry (0x006e8181) and the far
 * sight DynamicObject's arrival (0x0070538e → 0x006e4940) pass the object as the force. Engaging ends in 0x005fbbc0, which, with walking refused, stops the movement
 * the held keys were making (0x007272c0) — the STOP `syncMovement` sends on the hold's first frame.
 *
 * Not modelled: 0x00802f80 (Spell_C.cpp) is the player's own aura cancel — it ends in
 * `CMSG_CANCEL_AURA` 0x136 (`CMSG_PET_CANCEL_AURA` 0x26B for a pet's aura). For an aura on the
 * player whose spell has AttributesEx 0x2000 (`SPELL_ATTR1_FARSIGHT`) and not 0x4
 * (`SPELL_ATTR1_CHANNELED_1`) it first makes that unforced call, and when the call answers 1 (all
 * but "field set, object not in view") no cancel goes out: with the latch set that is a 0 and the
 * camera home while the field still names the object, and the aura stays. This client sends the
 * cancel (`WorldClient.cancelAura`); the 0 then follows the field the server clears.
 */

const FARSIGHT_LOW = UPDATE_FIELDS.PLAYER_FARSIGHT.offset;
const FARSIGHT_HIGH = FARSIGHT_LOW + 1;

/** One entry of memory, so a held far sight answers the same bigint every frame without building one. */
let cachedLow = 0;
let cachedHigh = 0;
let cachedGuid = 0n;

/**
 * The character's `PLAYER_FARSIGHT`, or undefined while it is empty. Allocation-free while it is
 * empty and while it holds the value it held on the last call — this is read every frame. The memo
 * is a pure function of the two words, so it carries nothing from one world or test to the next.
 */
export function farSightGuid(character: WorldObjectState | undefined): bigint | undefined {
  if (character === undefined) return undefined;
  const low = character.fields.get(FARSIGHT_LOW) ?? 0;
  const high = character.fields.get(FARSIGHT_HIGH) ?? 0;
  if (low === 0 && high === 0) return undefined;
  if (low !== cachedLow || high !== cachedHigh) {
    cachedLow = low;
    cachedHigh = high;
    cachedGuid = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
  }
  return cachedGuid;
}

/** Wow.exe's engaged latch (bit 0 of the player's +0x1858) and the vote 0x006e2880 casts. */
export class FarSightLatch {
  #engaged = false;

  /** Whether a 1 has gone out and no 0 since. */
  get engaged(): boolean {
    return this.#engaged;
  }

  /**
   * The vote this observation owes: true for `u8 1`, false for `u8 0`, undefined for none.
   * `field` is `PLAYER_FARSIGHT` (undefined when zero), `inView` whether its object is known.
   */
  observe(field: bigint | undefined, inView: boolean): boolean | undefined {
    if (field !== undefined) {
      if (!inView || this.#engaged) return undefined;
      this.#engaged = true;
      return true;
    }
    if (!this.#engaged) return undefined;
    this.#engaged = false;
    return false;
  }

  /** A new world or a transfer: the server's view starts at home and nothing is owed. */
  reset(): void {
    this.#engaged = false;
  }
}

/** The parts of `WorldClient` the link reads and the one it calls. */
export interface FarSightWorld {
  readonly state: { readonly selfGuid: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  sendFarSight?(apply: boolean): void;
}

/**
 * The latch over the live world, once a frame. Evaluated by observation rather than on the field's
 * callback, so it also engages when a far sight object of any kind streams in after the field (Wow.exe
 * re-asks only for its own far sight DynamicObject, 0x00705230 — a unit named before its CREATE is
 * not reachable from TrinityCore, which sends the CREATE first, `UpdateVisibilityOf`, Player.cpp:24967).
 * A loading screen, a transfer or another world resets it without a vote: `Player::RemoveFromWorld`
 * clears the viewpoint on the server (Player.cpp:1993-1994, 2022-2026), and the objects are gone here.
 */
export class FarSightLink {
  readonly latch = new FarSightLatch();
  #world: FarSightWorld | undefined;

  update(world: FarSightWorld | undefined, loading: boolean): void {
    if (world !== this.#world || loading) {
      this.#world = world;
      this.latch.reset();
      if (loading) return;
    }
    if (world === undefined) return;
    const self = world.state.selfGuid;
    const character = self === undefined ? undefined : world.state.objects.get(self);
    if (character === undefined) return;
    const field = farSightGuid(character);
    const vote = this.latch.observe(field, field !== undefined && world.state.objects.has(field));
    if (vote !== undefined) world.sendFarSight?.(vote);
  }
}

/** `CMSG_FAR_SIGHT`: one byte, read as a bool (MiscHandler.cpp:1255-1256). */
export function buildFarSight(apply: boolean): Uint8Array {
  return new PacketWriter().u8(apply ? 1 : 0).toUint8Array();
}
