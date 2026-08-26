// Flight paths: the map of nodes a flight master offers, and taking one.
//
// The guids here are **full** eight-byte ones, which is the trap of the family. In this core a
// bare `data << guid` on an `ObjectGuid` is `buf << uint64(guid.GetRawValue())`
// (`ObjectGuid.cpp:146-150`) — the packed form only happens through `GetPackGUID()`. Three
// senders write the flight master three different-looking ways (`TaxiHandler.cpp:59`,
// `TaxiHandler.cpp:147`, `Player.cpp:22062`) and all three produce the same eight bytes.

import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

/** `ActivateTaxiReply`, `SharedDefines.h:3642-3657`, worded for the player. */
const TAXI_REPLY_TEXT: Readonly<Record<number, string>> = {
  0: "Полёт начат",
  1: "Слишком далеко от базы",
  2: "Не хватает денег",
  3: "Нет такого маршрута",
  4: "Маршрут не открыт",
  6: "Нельзя лететь верхом",
  7: "Нельзя лететь в облике",
  8: "Нельзя лететь мёртвым",
  9: "Нет питомца-перевозчика",
  13: "Занят другим делом",
};

export const TAXI_REPLY_OK = 0;

export interface TaxiMenu {
  /** The flight master being talked to. */
  guid: bigint;
  /** `TaxiNodes.dbc` id of the node the flight master stands at; never zero. */
  currentNode: number;
  /** Every node this character has discovered, as `TaxiNodes.dbc` ids. */
  knownNodes: number[];
}

export function activateTaxiReplyText(reply: number): string {
  return TAXI_REPLY_TEXT[reply] ?? `Отказ ${reply}`;
}

/** `SMSG_ACTIVATETAXIREPLY`: one word from `ActivateTaxiReply`. */
export function parseActivateTaxiReply(payload: Uint8Array): number {
  return new PacketReader(payload).u32();
}

/** `SMSG_TAXINODE_STATUS`: `u64 flightmaster, u8 known`. Nine bytes, and a burst of them at login. */
export function parseTaxiNodeStatus(payload: Uint8Array): { guid: bigint; known: boolean } {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  return { guid, known: reader.u8() !== 0 };
}

/**
 * `SMSG_SHOWTAXINODES`: `u32 window, u64 flightmaster, u32 currentNode`, then the mask of the
 * nodes this character has discovered.
 *
 * The mask has no length field and no fixed length either. `TaxiMask` is a `std::vector<uint32>`
 * sized at load from the row count of `TaxiNodes.dbc` (`DBCStores.cpp:1003-1010`), so it is
 * `ceil(rows / 64) * 8` bytes — 48 with the 364 rows in this dataset, and something else with
 * another patch. The `4 + 8 + 4 + 8 * 4` in the sender is a stale reserve. Read to the end.
 *
 * Bit `nodeId - 1`, little-endian words: node ids are one-based, which is the off-by-one that
 * would otherwise light up the wrong destinations.
 */
export function parseShowTaxiNodes(payload: Uint8Array): TaxiMenu {
  const reader = new PacketReader(payload);
  reader.u32();
  const guid = reader.u64();
  const currentNode = reader.u32();
  const knownNodes: number[] = [];
  for (let word = 0; reader.remaining >= 4; word++) {
    const bits = reader.u32();
    if (bits === 0) continue;
    for (let bit = 0; bit < 32; bit++) {
      if (bits & (1 << bit)) knownNodes.push(word * 32 + bit + 1);
    }
  }
  return { guid, currentNode, knownNodes };
}

/** `CMSG_TAXIQUERYAVAILABLENODES`: the flight master to open the map for. */
export function buildTaxiQuery(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** `CMSG_TAXINODE_STATUS_QUERY`: does this flight master have a node this character knows? */
export function buildTaxiNodeStatusQuery(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** `CMSG_ACTIVATETAXI`: `u64 flightmaster, u32 from, u32 to` — `TaxiHandler.cpp:271`. */
export function buildActivateTaxi(guid: bigint, fromNode: number, toNode: number): Uint8Array {
  return new PacketWriter().u64(guid).u32(fromNode).u32(toNode).toUint8Array();
}

/**
 * `CMSG_ACTIVATETAXIEXPRESS`: `u64 flightmaster, u32 count`, then the nodes — `TaxiHandler.cpp:173`.
 *
 * The multi-hop form, for a route the client plotted itself. The server walks the list and
 * refuses the whole thing if any leg is not a real path.
 */
export function buildActivateTaxiExpress(guid: bigint, nodes: readonly number[]): Uint8Array {
  const writer = new PacketWriter().u64(guid).u32(nodes.length);
  for (const node of nodes) writer.u32(node);
  return writer.toUint8Array();
}
