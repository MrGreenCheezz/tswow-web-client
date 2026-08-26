import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INBOUND_OPCODES, OUTBOUND_OPCODES } from "../dist/code/generated/opcodeCoverage.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { OPCODE_BACKLOG } from "../dist/code/world/OpcodeBacklog.js";

const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Opcodes this client names in its own code. `WorldClient` dispatches through a chain of
 * `packet.opcode === OPCODES.X` comparisons rather than a table, so until that chain becomes a
 * registry, naming an opcode is the closest thing to declaring a handler for it. A name reached
 * only through a dead branch would pass this
 * check; the acceptance run catches those by leaving the packet in
 * `webclientUnhandledOpcodes()`.
 */
async function namedOpcodes(directory = sourceDir, names = new Set()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "generated") await namedOpcodes(path, names);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    for (const match of (await readFile(path, "utf8")).matchAll(/OPCODES\.([A-Z][A-Z0-9_]+)/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

const live = () => [...INBOUND_OPCODES].filter(([, reach]) => reach === "live").map(([name]) => name);

test("every opcode this core sends is either handled or owned by a plan slice", async () => {
  const named = await namedOpcodes();
  const orphans = live().filter((name) => !named.has(name) && !OPCODE_BACKLOG.has(name));

  assert.deepEqual(
    orphans,
    [],
    "these arrive from the server and nothing claims them: handle them, or list them in src/world/OpcodeBacklog.ts",
  );
});

test("the backlog holds only opcodes that are still missing", async () => {
  const named = await namedOpcodes();
  const done = [...OPCODE_BACKLOG.keys()].filter((name) => named.has(name));

  assert.deepEqual(done, [], "strike these off src/world/OpcodeBacklog.ts: the client handles them now");
});

test("the backlog names only opcodes this core actually sends", () => {
  const stale = [...OPCODE_BACKLOG.keys()].filter((name) => INBOUND_OPCODES.get(name) !== "live");

  assert.deepEqual(stale, [], "the core no longer sends these, so they are not work: drop them from the backlog");
});

test("the client sends nothing the server refuses", async () => {
  const named = await namedOpcodes();
  // CMSG_ only: that family is client-to-server by definition, so naming one can only mean sending
  // it. MSG_ goes both ways — MSG_CHANNEL_START is sent by the server and refused from a client —
  // and naming one says nothing about which direction this client uses it in.
  const refused = [...named].filter((name) => name.startsWith("CMSG_") && !OUTBOUND_OPCODES.has(name));

  assert.deepEqual(refused, [], "the core answers these with no handler at all");
});

test("the custom-packet transport names both tswow opcodes, and the core still agrees on them", async () => {
  // tswow's two numbers (`CustomPacketDefines.h:27-31`) are borrowed from the CMSG_ family, which
  // is why nothing else in this file would notice them: the classifier calls both outbound, so the
  // ratchet's inbound walk never asks for a 0x102 handler even though the server sends it. This is
  // the check that says the transport is still wired to the opcodes it thinks it is.
  const named = await namedOpcodes();

  assert.ok(named.has("CMSG_EMOTE"), "nothing in src/ names the opcode tswow sends custom packets on");
  assert.ok(named.has("CMSG_CUSTOM"), "nothing in src/ names the opcode tswow expects them back on");
  assert.equal(OPCODES.CMSG_EMOTE, 0x102);
  assert.equal(OPCODES.CMSG_CUSTOM, 0x51f);
  assert.equal(OUTBOUND_OPCODES.has("CMSG_EMOTE"), true);
  assert.equal(OUTBOUND_OPCODES.has("CMSG_CUSTOM"), true);
  assert.equal(INBOUND_OPCODES.has("CMSG_EMOTE"), false, "if the core starts declaring 0x102 inbound, the branch needs revisiting");
});

test("coverage is measured against a whole protocol, not a fragment", () => {
  // A silently truncated scan would make every check above pass by having nothing to check.
  assert.ok(INBOUND_OPCODES.size > 600, `only ${INBOUND_OPCODES.size} inbound opcodes classified`);
  assert.ok(OUTBOUND_OPCODES.size > 400, `only ${OUTBOUND_OPCODES.size} outbound opcodes classified`);
  assert.ok(live().length > 450, `only ${live().length} inbound opcodes are live`);
});
