import type { WorldClient } from "../../world/WorldClient.js";

type ReportWorld = Pick<WorldClient, "mapId" | "unhandledOpcodes" | "packetErrors" | "customPackets">;

/** A shareable traffic report with counters and names, never packet bodies or decoded values. */
export function buildPacketDiagnosticsReport(world: ReportWorld | undefined, recordedAt = new Date().toISOString()) {
  return {
    recordedAt,
    mapId: world?.mapId ?? null,
    handlerCount: world?.unhandledOpcodes.missingHandlerCount ?? 0,
    opcodes: world?.unhandledOpcodes.summary().map((row) => ({
      opcode: row.opcode,
      name: row.name,
      slice: row.slice,
      count: row.count,
      droppedDuringLogin: row.droppedDuringLogin,
      bytes: row.bytes,
    })) ?? [],
    packetErrorCount: world?.packetErrors.count ?? 0,
    packetErrorsOmitted: world?.packetErrors.omitted ?? 0,
    packetErrors: world?.packetErrors.summary().map((row) => ({
      opcode: row.opcode,
      name: row.name,
      category: row.category,
      count: row.count,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      payloadSizes: row.payloadSizes,
    })) ?? [],
    customPackets: world?.customPackets.summary().map((row) => ({
      opcode: row.opcode,
      name: row.name,
      module: row.module,
      direction: row.direction,
      claimed: row.claimed,
      declared: row.declared,
      received: row.received,
      receivedBytes: row.receivedBytes,
      sent: row.sent,
      sentBytes: row.sentBytes,
      decoded: row.decoded,
      failed: row.failed,
      remainder: row.remainder,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
    })) ?? [],
  };
}
