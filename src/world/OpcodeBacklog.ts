import type { OpcodeName } from "../generated/opcodes.js";

/**
 * Stable feature slices that own any opcodes still missing a handler.
 */
export type PlanSlice = "spells" | "quests" | "character" | "world" | "social" | "pets" | "pvp" | "system" | "tail";

/**
 * Every live inbound opcode this client does not handle yet, and which slice will handle it.
 *
 * This is the ratchet behind the completeness claim. `tests/opcode-coverage.test.mjs` fails when
 * the core gains a live opcode that is neither handled nor listed here, so nothing can go missing
 * silently; it also fails when an entry here is already handled, so an implemented opcode has to
 * be struck off the list rather than left to rot. The count only ever goes down.
 *
 * Seeded at 347 entries when the coverage report was built and now **empty**: this client handles
 * all 514 live inbound opcodes. The map stays, and so does the test around it — the ratchet's job
 * from here is to fail the build the moment the core gains an opcode nobody has claimed.
 *
 * The count goes down as slices land, and up when the measurement itself is corrected — which is
 * the point of keeping it. Fixing the MSG_ blind spot in `tools/generate-protocol.mjs` raised the
 * live total from 492 to 514 and put nineteen already-missing opcodes on this list; they were
 * always missing, and the report simply could not see them.
 */
export const OPCODE_BACKLOG = new Map<OpcodeName, PlanSlice>([
  // P4 — world and travel: closed. All 71 handled, including the three the core declares and
  // never builds, which are named in WorldClient rather than parsed.

  // P4 — world and travel: the nineteen a correction to the coverage report reopened were closed
  // by P9, which is where they belonged: they are the relay family, not travel. Nine speeds and a
  // knock back carry a whole movement info the SMSG_ and SMSG_SPLINE_ twins do not; three states
  // are the same shape as the movement opcodes and joined that set; the teleport is the only
  // packet in the protocol that means "this was not travel" and so must not be smoothed; the time
  // skip moves nobody. Four — root, unroot, collision height and the swim-fly transition — are
  // named exactly once outside the opcode tables, inside a commented-out mapping table, and have
  // no sender at all.

  // P5 — group, guild and society: closed. All 77 handled. Three of them the core compiles
  // and never constructs — the two calendar note packets and the invite status alert — and
  // one, MSG_PARTY_ASSIGNMENT, the server only ever receives; that one is sent rather than
  // parsed, and the server answers it with a group list.

  // P6 — pets and vehicles: closed. All 15 handled. Two of them the core declares and never
  // builds: SMSG_PET_MODE, whose react and command state this build folds into the pet bar
  // header instead, and SMSG_PET_GUIDS, whose only mention outside the opcode tables is a
  // comment — which is also why the reference scan reads it as live. Both are named rather
  // than parsed.

  // P7 — pvp: closed. All 26 handled. Nothing here is declared and never built: every one of the
  // twenty-six has a sender in the core, including the two the client has to ask for by hand —
  // the scoreboard and the flag carriers share their opcode with the request that fetches them.

  // P8 — session and services: closed. All 44 handled. Two are live only in principle:
  // SMSG_WARDEN_DATA has a sender but this realm sets `Warden.Enabled = 0`, and
  // SMSG_AUCTION_LIST_PENDING_SALES is built with its entry loop commented out, so it always
  // arrives as a count of zero.
]);
