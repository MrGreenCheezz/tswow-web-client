import { OPCODE_NAMES } from "../generated/opcodes.js";
import { OPCODE_BACKLOG, type PlanSlice } from "./OpcodeBacklog.js";
import type { WorldPacket } from "./WorldConnection.js";

/** Payloads kept per opcode, as seed material for the phase 10 replay corpus. */
const SAMPLE_LIMIT = 4;
/** Bytes kept per sample: enough to recognise a layout without holding whole object updates. */
const SAMPLE_BYTES = 256;

export interface UnhandledOpcode {
  readonly opcode: number;
  /** Name from the generated table, or `UNKNOWN_0x...` for an opcode TrinityCore does not declare. */
  readonly name: string;
  /**
   * Which implementation slice owns this handler. Undefined means the opcode was not assigned:
   * either the core changed, or the opcode was believed unreachable.
   */
  readonly slice: PlanSlice | undefined;
  /** Packets the world loop dropped: these are the features that are actually missing. */
  count: number;
  /** Packets dropped while a handshake was waiting for one specific reply. */
  droppedDuringLogin: number;
  bytes: number;
  firstSeen: number;
  lastSeen: number;
  readonly samples: Uint8Array[];
}

export interface UnhandledOpcodeSummary {
  opcode: string;
  name: string;
  slice: PlanSlice | "unplanned";
  count: number;
  droppedDuringLogin: number;
  bytes: number;
  samples: string[];
}

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Records the packets no handler claimed. The world loop used to drop them silently, which hid
 * both the list of missing features and the corpus needed to implement them.
 */
export class UnhandledOpcodeLog {
  readonly entries = new Map<number, UnhandledOpcode>();
  /** Fires once per opcode, the first time it is seen. Later packets only update the counters. */
  onFirstSighting: ((entry: UnhandledOpcode) => void) | undefined;

  record(packet: WorldPacket, duringLogin = false): UnhandledOpcode {
    const now = Date.now();
    const existing = this.entries.get(packet.opcode);
    const name = OPCODE_NAMES.get(packet.opcode);
    const entry = existing ?? {
      opcode: packet.opcode,
      name: name ?? `UNKNOWN_0x${packet.opcode.toString(16).toUpperCase()}`,
      slice: name === undefined ? undefined : OPCODE_BACKLOG.get(name),
      count: 0,
      droppedDuringLogin: 0,
      bytes: 0,
      firstSeen: now,
      lastSeen: now,
      samples: [],
    };
    if (duringLogin) entry.droppedDuringLogin++;
    else entry.count++;
    entry.bytes += packet.payload.length;
    entry.lastSeen = now;
    if (entry.samples.length < SAMPLE_LIMIT) entry.samples.push(packet.payload.slice(0, SAMPLE_BYTES));
    if (!existing) {
      this.entries.set(packet.opcode, entry);
      this.onFirstSighting?.(entry);
    }
    return entry;
  }

  /** Distinct opcodes the world loop dropped, ignoring the ones only lost during a handshake. */
  get missingHandlerCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) if (entry.count > 0) total++;
    return total;
  }

  /** Most frequent first, ready for the diagnostics panel, `JSON.stringify` or the console. */
  summary(): UnhandledOpcodeSummary[] {
    return [...this.entries.values()]
      .sort((left, right) => right.count - left.count || right.droppedDuringLogin - left.droppedDuringLogin)
      .map((entry) => ({
        opcode: `0x${entry.opcode.toString(16).toUpperCase().padStart(3, "0")}`,
        name: entry.name,
        slice: entry.slice ?? "unplanned",
        count: entry.count,
        droppedDuringLogin: entry.droppedDuringLogin,
        bytes: entry.bytes,
        samples: entry.samples.map(hex),
      }));
  }

  clear(): void {
    this.entries.clear();
  }
}
