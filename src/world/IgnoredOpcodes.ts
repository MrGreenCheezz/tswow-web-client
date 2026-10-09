import { OPCODE_NAMES, type OpcodeName } from "../generated/opcodes.js";
import type { WorldPacket } from "./WorldConnection.js";

/**
 * Why an inbound opcode is accepted and deliberately left without an effect (WORK_PLAN 5.29,
 * CLIENT_PARITY_PLAN §5: an ignored message needs a documented reason and its own counter).
 * * `by-design` — nothing to do: this core never builds it, sends a constant with nothing in it,
 *   or Wow.exe itself does nothing a player could see with it; or its only effect is outside the
 *   plan (sound, chat).
 * * `planned` — Wow.exe reacts and a plan item (`plan`, "N.MM") will make this client react too;
 *   the entry is struck off in the same change that gives the branch its effect.
 * * `unplanned` — Wow.exe reacts and no plan item covers it yet: a gap, counted rather than hidden.
 */
export type IgnoredOpcodeKind = "by-design" | "planned" | "unplanned";

export interface IgnoredOpcodeReason {
  readonly kind: IgnoredOpcodeKind;
  readonly reason: string;
  /** The WORK_PLAN item that will give the opcode its effect, for `planned`. */
  readonly plan?: string;
}

const byDesign = (reason: string): IgnoredOpcodeReason => ({ kind: "by-design", reason });
const planned = (plan: string, reason: string): IgnoredOpcodeReason => ({ kind: "planned", reason, plan });
const unplanned = (reason: string): IgnoredOpcodeReason => ({ kind: "unplanned", reason });

/**
 * Every inbound opcode `WorldClient` accepts without an effect, and why. `WorldClient` answers each
 * through `#ignore`, which counts it in `IgnoredOpcodeLog`; `tests/opcode-coverage.test.mjs` keeps
 * this map, those branches and the documents in step (no bare branch outside it, no entry without
 * a branch). Wow.exe handler addresses are from read-only Ghidra notes
 * (`.runtime/re-2026-10-01/a4-world/`, registration scan `push handler; push opcode; call`).
 */
export const IGNORED_OPCODES: ReadonlyMap<OpcodeName, IgnoredOpcodeReason> = new Map<OpcodeName, IgnoredOpcodeReason>([
  // --- by design ---------------------------------------------------------------------------------
  ["SMSG_INSTANCE_SAVE_CREATED", byDesign("the core writes a constant 0 (Player.cpp:19454, Map.cpp:4355); no Wow.exe handler is registered for 0x2CB")],
  ["SMSG_CLEAR_FAR_SIGHT_IMMEDIATE", byDesign("never built: the only writer is commented out (Player.cpp:24989)")],
  ["SMSG_MOVE_SET_CAN_TRANSITION_BETWEEN_SWIM_AND_FLY", byDesign("never built: named only in the commented mapping table of MovementPacketSender.h")],
  ["SMSG_MOVE_UNSET_CAN_TRANSITION_BETWEEN_SWIM_AND_FLY", byDesign("never built: named only in the commented mapping table of MovementPacketSender.h")],
  ["MSG_MOVE_ROOT", byDesign("never built (MovementPacketSender.h comment); rooting arrives as SMSG_SPLINE_MOVE_ROOT or fields")],
  ["MSG_MOVE_UNROOT", byDesign("never built (MovementPacketSender.h comment); unrooting arrives as SMSG_SPLINE_MOVE_UNROOT or fields")],
  ["MSG_MOVE_SET_COLLISION_HGT", byDesign("never built (MovementPacketSender.h comment); the height comes in SMSG_MOVE_SET_COLLISION_HGT")],
  ["MSG_MOVE_UPDATE_CAN_TRANSITION_BETWEEN_SWIM_AND_FLY", byDesign("never built (MovementPacketSender.h comment)")],
  ["MSG_MOVE_TIME_SKIPPED", byDesign("relayed by MovementHandler.cpp:921; Wow.exe 0x71cab0 shifts the mover's movement clock, which this client never reads (it times a neighbour by arrival), so no position changes")],
  ["SMSG_RESURRECT_FAILED", byDesign("never built: no writer in the core")],
  ["SMSG_LEARNED_DANCE_MOVES", byDesign("the core sends two zero words at login (CharacterHandler.cpp:810); Wow.exe 0x5758a0 only stores them")],
  ["SMSG_PET_ACTION_SOUND", byDesign("its only effect is a pet voice line; sound is out of the plan (owner, 2026-09-29)")],
  ["SMSG_SERVER_FIRST_ACHIEVEMENT", byDesign("Wow.exe 0x50b010 only writes (PLAYER_)SERVER_FIRST_ACHIEVEMENT as a chat line (0x509dd0, type 0x30); chat is out of the plan (owner, 2026-09-29; 5.22)")],
  ["SMSG_PET_GUIDS", byDesign("never built: only a comment in SendInitialPacketsBeforeAddToMap names it")],
  ["SMSG_ON_CANCEL_EXPECTED_RIDE_VEHICLE_AURA", byDesign("Wow.exe 0x800510 cancels its own pending-vehicle state (player +0xf60); this client keeps none")],
  ["SMSG_AUCTION_LIST_PENDING_SALES", byDesign("always a count of zero: the entry loop is commented out (AuctionHouseHandler.cpp:826)")],
  ["SMSG_CALENDAR_EVENT_INVITE_NOTES", byDesign("compiled by the core and never constructed")],
  ["SMSG_CALENDAR_EVENT_INVITE_NOTES_ALERT", byDesign("compiled by the core and never constructed")],
  ["SMSG_CALENDAR_EVENT_INVITE_STATUS_ALERT", byDesign("compiled by the core and never constructed")],

  // --- planned -----------------------------------------------------------------------------------
  // 05.10-A7a-H: SMSG_MIRRORIMAGE_DATA struck off — it dresses the unit now (6.11б, MirrorImages.ts).

  // --- unplanned: Wow.exe reacts, no plan item yet -----------------------------------------------
  ["SMSG_RESET_FAILED_NOTIFY", unplanned("Wow.exe 0x50cee0 prints RESET_FAILED_NOTIFY (players still inside)")],
  ["SMSG_UPDATE_LAST_INSTANCE", unplanned("Wow.exe 0x4fe100 records the map with the time it was entered")],
  ["SMSG_UPDATE_INSTANCE_OWNERSHIP", unplanned("Wow.exe 0x4fb990 stores whether the character holds raid/heroic saves")],
  ["SMSG_PRE_RESURRECT", unplanned("Wow.exe 0x716d80 → 0x703a80 acts on the guid before the resurrection lands")],
  ["SMSG_SEND_UNLEARN_SPELLS", unplanned("Wow.exe 0x6e2240 keeps the list of spells to treat as unlearned")],
  ["SMSG_CROSSED_INEBRIATION_THRESHOLD", unplanned("Wow.exe 0x6d01b0 → 0x6cfff0 writes a line naming the drink (chat-like; destination not verified)")],
  ["SMSG_PROPOSE_LEVEL_GRANT", unplanned("Wow.exe 0x526530 asks to accept a Refer-a-Friend level grant (0x513fd0)")],
  ["SMSG_REFER_A_FRIEND_FAILURE", unplanned("Wow.exe 0x526530 prints the Refer-a-Friend error (0x5219e0)")],
  ["SMSG_FEIGN_DEATH_RESISTED", unplanned("Wow.exe 0x7fd950 shows UI message 0x1c6")],
  ["SMSG_PET_LEARNED_SPELL", unplanned("Wow.exe 0x5d4c30 prints that the pet learned the spell (message 0x27f/0x280)")],
  ["SMSG_ARENA_UNIT_DESTROYED", unplanned("Wow.exe 0x54b5e0 updates the arena opponent frames while in an arena")],
]);

/** Payloads kept per opcode, as in `UnhandledOpcodeLog`. */
const SAMPLE_LIMIT = 4;
const SAMPLE_BYTES = 256;

export interface IgnoredOpcode {
  readonly opcode: number;
  readonly name: string;
  /** Undefined only when a branch ignores an opcode the registry does not list — a bug the test catches. */
  readonly reason: IgnoredOpcodeReason | undefined;
  count: number;
  bytes: number;
  firstSeen: number;
  lastSeen: number;
  readonly samples: Uint8Array[];
}

export interface IgnoredOpcodeSummary {
  opcode: string;
  name: string;
  kind: IgnoredOpcodeKind | "unregistered";
  plan: string | undefined;
  reason: string;
  count: number;
  bytes: number;
  samples: string[];
}

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Packets accepted on purpose without an effect: counted beside, not inside, the unhandled ones. */
export class IgnoredOpcodeLog {
  readonly entries = new Map<number, IgnoredOpcode>();

  record(packet: WorldPacket): IgnoredOpcode {
    const now = Date.now();
    let entry = this.entries.get(packet.opcode);
    if (!entry) {
      const name = OPCODE_NAMES.get(packet.opcode) ?? `UNKNOWN_0x${packet.opcode.toString(16).toUpperCase()}`;
      entry = {
        opcode: packet.opcode, name, reason: IGNORED_OPCODES.get(name as OpcodeName),
        count: 0, bytes: 0, firstSeen: now, lastSeen: now, samples: [],
      };
      this.entries.set(packet.opcode, entry);
    }
    entry.count++;
    entry.bytes += packet.payload.length;
    entry.lastSeen = now;
    if (entry.samples.length < SAMPLE_LIMIT) entry.samples.push(packet.payload.slice(0, SAMPLE_BYTES));
    return entry;
  }

  /** Packets ignored so far, by kind (for the diagnostics line). */
  counts(): Record<IgnoredOpcodeKind | "unregistered", number> {
    const totals = { "by-design": 0, planned: 0, unplanned: 0, unregistered: 0 };
    for (const entry of this.entries.values()) totals[entry.reason?.kind ?? "unregistered"] += entry.count;
    return totals;
  }

  /** Most frequent first, for `webclientIgnoredOpcodes()`. */
  summary(): IgnoredOpcodeSummary[] {
    return [...this.entries.values()]
      .sort((left, right) => right.count - left.count)
      .map((entry) => ({
        opcode: `0x${entry.opcode.toString(16).toUpperCase().padStart(3, "0")}`,
        name: entry.name,
        kind: entry.reason?.kind ?? "unregistered",
        plan: entry.reason?.plan,
        reason: entry.reason?.reason ?? "not in IGNORED_OPCODES",
        count: entry.count,
        bytes: entry.bytes,
        samples: entry.samples.map(hex),
      }));
  }

  clear(): void {
    this.entries.clear();
  }
}
